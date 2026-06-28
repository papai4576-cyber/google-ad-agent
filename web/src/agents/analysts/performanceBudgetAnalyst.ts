/**
 * performanceBudgetAnalyst.ts — Performance & Budget Analyst (v2 Analyst #1).
 *
 * Merges v1's PerformanceAnalyst (CPA/ROAS/CTR/pacing), BidBudgetAnalyst
 * (budget/rank caps, bid strategy fit) and ConversionHealthChecker (tracking
 * gaps) into a single rule-based pass + one LLM call. Detection is fully
 * deterministic — the LLM only writes prose for the pre-detected candidates
 * (see runRuleBasedAnalyst in ../runAnalyst.ts).
 *
 * `finding.id` prefixes follow agentNames.ts conventions:
 *   budget-locked-, idle-budget-, rank-locked-, cpa-overage-, roas-shortfall-
 * Other ids (pacing-account, zero-conv-, low-ctr-, capped-underperf-,
 * thin-roas-, thin-cpa-, graduate-tcpa-, manual-to-smart-, troas-no-value-,
 * no-conv-, no-value-, high-cvr-, low-cvr-) are ported 1:1 from v1 and fall
 * back to actionMeta's default (manual / change_bid_strategy).
 * `anomaly-cpa-jump-*` / `anomaly-cvr-drop-*` (v2 addition, no v1 equivalent)
 * — 7-day-vs-prior-14-day trend comparison using campaigns_daily; also falls
 * back to actionMeta's default.
 *
 * Reads: campaigns, campaigns_daily. Brain categories: bidding, scaling, general.
 */

import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { changeLog as changeLogTable } from "@/db/schema";
import type { Candidate, RuleBasedAnalystSpec } from "../runAnalyst";
import { RulesEngine } from "../rules/rulesEngine";
import { AGENTS } from "../synthesis/agentNames";
import { loadAccountData, micros, readCampaignsDaily, type CampaignRow, type CampaignDailyRow } from "../data";

interface PerformanceBudgetData {
  campaigns: CampaignRow[];
  campaignsDaily: CampaignDailyRow[];
  /** Budget changes >=30 days old, not yet reviewed, with enough campaigns_daily history on both sides to trust a before/after comparison. Pre-computed in buildPerformanceBudgetAnalystSpec() (async DB work), detect() just maps them. */
  changeOutcomeCandidates: ChangeOutcomeCandidate[];
}

interface ChangeOutcomeCandidate {
  changeLogId: string;
  campaignId: string;
  campaignName: string;
  changeDate: string;
  beforeBudget: number;
  afterBudget: number;
  beforeCpa: number;
  afterCpa: number;
  beforeRoas: number;
  afterRoas: number;
  beforeConv: number;
  afterConv: number;
}

const RULE_DEFAULTS = {
  CPA_OVERAGE_RATIO: 1.5,
  ROAS_SHORTFALL_RATIO: 0.7,
  PERF_SPEND_FLOOR: 5000,
  CTR_FLOOR_RATIO: 0.4,
  PACING_TOLERANCE: 0.3,
  CAPPED_UNDERPERF_IS: 0.2,
  BUDGET_LOST_IS: 0.3,
  RANK_LOST_IS: 0.4,
  MIN_CONV_ROAS: 50,
  MIN_CONV_CPA: 30,
  IDLE_SPEND_RATIO: 0.5,
  MIN_CONV_FOR_CPA: 5,
  CH_SPEND_NO_CONV: 50,
  CH_SPEND_NO_CONV_P1: 200,
  CH_HIGH_CVR: 0.3,
  CH_HIGH_CVR_CLICKS: 50,
  CH_LOW_CVR: 0.005,
  CH_LOW_CVR_SPEND: 200,
  ANOMALY_CPA_JUMP_RATIO: 1.3,
  ANOMALY_CVR_DROP_RATIO: 0.7,
  ANOMALY_MIN_BASELINE_CONV: 5,
  CHANGE_REVIEW_DAYS: 30,
  CHANGE_REVIEW_WINDOW_DAYS: 14,
  CHANGE_REVIEW_WORSE_RATIO: 1.2,
  CHANGE_REVIEW_BETTER_RATIO: 0.85,
};

/**
 * 30-day change-outcome feedback loop — closes the gap flagged in CLAUDE.md's
 * "Known gaps" section (nothing previously checked whether a past mutation
 * actually helped). Scoped to `adjust_budget` changes only: that's the one
 * change type with genuine before/after data, since `campaigns_daily` has
 * day-level granularity but keyword/ad-level snapshots don't (they're a
 * point-in-time rolling-window aggregate, replaced wholesale each collect
 * run — there's no historical per-day keyword/ad table to diff against).
 * Other change types (adjust_bid, add_keyword, create_rsa, etc.) are left
 * with `reviewed=false` rather than silently closed out with no real signal
 * — a future pass can revisit them if/when finer-grained historical data
 * exists.
 *
 * Does real DB work (this is the async data-prep step, not detect() itself,
 * which must stay a pure function per the existing rule-based analyst
 * pattern) — queries `change_log` for eligible rows, pulls a wide enough
 * `campaigns_daily` window to compare 14 days before vs 14 days after each
 * change, and marks every row it evaluates `reviewed=true` so it isn't
 * re-evaluated indefinitely (even an "insufficient data" outcome is still a
 * terminal verdict — there's no more "after" data coming for a 30+-day-old change).
 */
async function loadChangeOutcomeCandidates(cfg: Record<string, number>): Promise<ChangeOutcomeCandidate[]> {
  if (!db) return [];

  const reviewDays = cfg.change_review_days || 30;
  const windowDays = cfg.change_review_window_days || 14;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - reviewDays);

  const eligible = await db
    .select()
    .from(changeLogTable)
    .where(
      and(
        eq(changeLogTable.dryRun, false),
        eq(changeLogTable.success, true),
        eq(changeLogTable.reviewed, false),
        eq(changeLogTable.fieldChanged, "daily_budget"),
        lt(changeLogTable.timestamp, cutoff)
      )
    );
  if (eligible.length === 0) return [];

  // Wide enough campaigns_daily window to cover every eligible change's before+after period.
  const oldestChange = eligible.reduce((min, r) => (r.timestamp < min ? r.timestamp : min), eligible[0].timestamp);
  const daysSinceOldest = Math.ceil((Date.now() - oldestChange.getTime()) / 86400000);
  const daily = await readCampaignsDaily(daysSinceOldest + windowDays + 2);

  const byCampaign = new Map<string, CampaignDailyRow[]>();
  for (const row of daily) {
    const list = byCampaign.get(String(row.campaignId)) ?? [];
    list.push(row);
    byCampaign.set(String(row.campaignId), list);
  }

  const out: ChangeOutcomeCandidate[] = [];
  const reviewedIds: string[] = [];

  for (const row of eligible) {
    reviewedIds.push(row.id);
    const campaignId = row.targetId;
    const rows = byCampaign.get(campaignId) ?? [];
    const changeDateStr = row.timestamp.toISOString().split("T")[0];

    const before = { spend: 0, conv: 0, value: 0 };
    const after = { spend: 0, conv: 0, value: 0 };
    for (const r of rows) {
      const spend = micros(r.costMicros);
      const conv = Number(r.conversions) || 0;
      const value = Number(r.conversionValue) || 0;
      if (r.date < changeDateStr) {
        before.spend += spend;
        before.conv += conv;
        before.value += value;
      } else {
        after.spend += spend;
        after.conv += conv;
        after.value += value;
      }
    }

    out.push({
      changeLogId: row.id,
      campaignId,
      campaignName: row.targetName || campaignId,
      changeDate: changeDateStr,
      beforeBudget: parseFloat(row.beforeValue || "0") || 0,
      afterBudget: parseFloat(row.afterValue || "0") || 0,
      beforeCpa: before.conv > 0 ? before.spend / before.conv : 0,
      afterCpa: after.conv > 0 ? after.spend / after.conv : 0,
      beforeRoas: before.spend > 0 ? before.value / before.spend : 0,
      afterRoas: after.spend > 0 ? after.value / after.spend : 0,
      beforeConv: before.conv,
      afterConv: after.conv,
    });
  }

  // Mark every evaluated row reviewed=true now — a 30+-day-old change has no more "after" data
  // coming, so re-checking it on a future run would produce the exact same (non-)verdict.
  for (const id of reviewedIds) {
    await db.update(changeLogTable).set({ reviewed: true }).where(eq(changeLogTable.id, id));
  }

  return out;
}

export async function buildPerformanceBudgetAnalystSpec(): Promise<RuleBasedAnalystSpec<PerformanceBudgetData>> {
  const ruleConfig = await RulesEngine.load(RULE_DEFAULTS);
  const [{ campaigns }, campaignsDaily, changeOutcomeCandidates] = await Promise.all([
    loadAccountData(),
    readCampaignsDaily(21),
    loadChangeOutcomeCandidates(ruleConfig),
  ]);

  return {
    agentName: AGENTS.PERFORMANCE_BUDGET,
    persona:
      "You are a senior Google Ads Performance & Budget Analyst with 10+ years of enterprise PPC experience. " +
      "Every finding must include a specific number from the data as evidence. Do not write generic recommendations.",
    instructions:
      "Explain each flagged issue clearly with the specific numbers from its evidence. Every action must be concrete — " +
      "no generic advice. Respect the safety rails: never recommend a single bid change >30% or a budget shift >20% per run. " +
      "Prefer transitional bid strategies (Maximize Conversions / eCPC) when conversion volume is too low for smart bidding. " +
      "If the evidence for a budget-locked candidate also shows this campaign's ROAS or CPA is missing its target, do not " +
      "recommend increasing the budget — say so explicitly and recommend fixing efficiency first (a downstream business-rule " +
      "check will also catch this, but flag it yourself too).",
    brainCategories: ["bidding", "scaling", "general"],
    brainLimit: 5,
    data: { campaigns, campaignsDaily, changeOutcomeCandidates },
    formatDataForPrompt: (data) => {
      const lines = ["CAMPAIGNS (all enabled, latest snapshot):"];
      for (const c of data.campaigns) {
        const budget = micros(c.budgetMicros);
        const spend = micros(c.costMicros);
        const conv = Number(c.conversions) || 0;
        const convVal = Number(c.conversionValue) || 0;
        const roas = spend > 0 && convVal > 0 ? (convVal / spend).toFixed(2) : "n/a";
        const cpa = conv > 0 ? (spend / conv).toFixed(0) : "n/a";
        const ctr = ((Number(c.ctr) || 0) * 100).toFixed(2);
        const bLost = ((Number(c.searchBudgetLostIs) || 0) * 100).toFixed(0);
        const rLost = ((Number(c.searchRankLostIs) || 0) * 100).toFixed(0);
        lines.push(
          `[${c.campaignId}] "${c.campaignName}" | ${c.channelType || "SEARCH"} | ${c.biddingStrategy || "unknown"} | ` +
          `budget=${budget.toFixed(0)}/day spend=${spend.toFixed(0)} conv=${conv} cpa=${cpa} roas=${roas} ` +
          `ctr=${ctr}% is_lost_budget=${bLost}% is_lost_rank=${rLost}%`
        );
      }
      return lines.join("\n");
    },
    ruleConfig,
    detect: detectPerformanceBudget,
    maxCandidates: 8,
    maxTokens: 2500,
  };
}

function detectPerformanceBudget(data: PerformanceBudgetData, ctx: { targets: { target_cpa: number; target_roas: number; monthly_budget: number }; cur: string; cfg: Record<string, number> }): Candidate[] {
  const cfg = ctx.cfg;
  const cur = ctx.cur;
  const out: Candidate[] = [];

  const targetCpa = ctx.targets.target_cpa || 0;
  const targetRoas = ctx.targets.target_roas || 0;
  const monthlyBudget = ctx.targets.monthly_budget || 0;
  const minConvForCpa = cfg.min_conv_for_cpa || 5;

  // Channel-type CTR medians for the low-CTR rule.
  const channelCtrs: Record<string, number[]> = {};
  for (const c of data.campaigns) {
    const ch = String(c.channelType || "UNKNOWN");
    (channelCtrs[ch] = channelCtrs[ch] || []).push(Number(c.ctr) || 0);
  }
  const channelMedian: Record<string, number> = {};
  for (const ch of Object.keys(channelCtrs)) {
    const arr = channelCtrs[ch].slice().sort((a, b) => a - b);
    channelMedian[ch] = arr[Math.floor(arr.length / 2)];
  }

  out.push(...detectTrendAnomalies(data, cfg, cur));
  out.push(...detectChangeOutcomes(data, cfg, cur));

  // Account-level pacing: total spend vs monthly budget target.
  if (monthlyBudget > 0) {
    const total = data.campaigns.reduce((s, c) => s + micros(c.costMicros), 0);
    const ratio = total / monthlyBudget;
    if (ratio < 1 - cfg.pacing_tolerance || ratio > 1 + cfg.pacing_tolerance) {
      const dir = ratio < 1 ? "under-pacing" : "over-pacing";
      // Use top-spending campaign as representative target (account-level findings must point to a real entity).
      const topCampaign = data.campaigns.slice().sort((a, b) => (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0))[0];
      const topSpend = topCampaign ? micros(topCampaign.costMicros) : 0;
      out.push({
        id: "pacing-account",
        category: "performance",
        severity: ratio < 0.5 || ratio > 1.5 ? "P1" : "P2",
        magnitude: Math.abs(ratio - 1) > 0.4 ? "high" : "medium",
        confidence: "high",
        effort: "medium",
        metric: "spend",
        direction: ratio < 1 ? "up" : "down",
        target: topCampaign
          ? { type: "campaign" as const, id: String(topCampaign.campaignId), name: topCampaign.campaignName }
          : { type: "campaign" as const, id: "account", name: "Account (all campaigns)" },
        hint: `Account is ${dir}: total spend ${cur}${total.toFixed(0)} is ${(ratio * 100).toFixed(0)}% of monthly target ${cur}${monthlyBudget.toFixed(0)}. Top spender is "${topCampaign?.campaignName || "unknown"}" (${cur}${topSpend.toFixed(0)}). Recommend adjusting campaign budgets proportionally to bring account spend to target.`,
        evidence: [
          `account total spend ${cur}${total.toFixed(0)}`,
          `monthly target ${cur}${monthlyBudget.toFixed(0)}`,
          `pacing ratio ${(ratio * 100).toFixed(0)}%`,
          topCampaign ? `top spender "${topCampaign.campaignName}" ${cur}${topSpend.toFixed(0)}` : "",
        ].filter(Boolean),
      });
    }
  }

  for (const c of data.campaigns) {
    const spend = micros(c.costMicros);
    const budget = micros(c.budgetMicros);
    const conv = Number(c.conversions) || 0;
    const convVal = Number(c.conversionValue) || 0;
    const ctr = Number(c.ctr) || 0;
    const impr = Number(c.impressions) || 0;
    const clicks = Number(c.clicks) || 0;
    const ch = String(c.channelType || "UNKNOWN");
    const strat = String(c.biddingStrategy || "").toUpperCase();
    const budgetLost = Number(c.searchBudgetLostIs) || 0;
    const rankLost = Number(c.searchRankLostIs) || 0;
    const tgt = { type: "campaign" as const, id: String(c.campaignId), name: c.campaignName };

    // 1. High spend, zero conversions.
    if (conv === 0 && spend >= cfg.perf_spend_floor) {
      out.push({
        id: `zero-conv-${c.campaignId}`,
        category: "performance",
        severity: spend >= cfg.perf_spend_floor * 3 ? "P1" : "P2",
        magnitude: spend >= cfg.perf_spend_floor * 3 ? "high" : "medium",
        confidence: "high",
        effort: "medium",
        metric: "conversions",
        direction: "up",
        target: tgt,
        hint: `${cur}${spend.toFixed(0)} spent over the period with 0 conversions — check conversion tracking, landing page, or campaign targeting.`,
        evidence: [`spend ${cur}${spend.toFixed(0)}`, "0 conversions", `channel ${c.channelType}`, `bidding ${c.biddingStrategy}`],
      });
      // CPA/ROAS undefined for zero-conv campaigns — skip the rest of this campaign's rules.
      continue;
    }

    // 2. CPA overage.
    if (targetCpa > 0 && conv >= minConvForCpa) {
      const cpa = spend / conv;
      if (cpa > cfg.cpa_overage_ratio * targetCpa) {
        out.push({
          id: `cpa-overage-${c.campaignId}`,
          category: "performance",
          severity: cpa > 2.5 * targetCpa ? "P1" : "P2",
          magnitude: cpa > 2.5 * targetCpa ? "high" : "medium",
          confidence: "high",
          effort: "medium",
          metric: "CPA",
          direction: "down",
          target: tgt,
          hint: `CPA is ${(cpa / targetCpa).toFixed(1)}x above target (${cur}${cpa.toFixed(0)} vs target ${cur}${targetCpa.toFixed(0)}).`,
          evidence: [`spend ${cur}${spend.toFixed(0)}`, `conversions ${conv}`, `actual CPA ${cur}${cpa.toFixed(0)}`, `target CPA ${cur}${targetCpa.toFixed(0)}`],
        });
      }
    }

    // 3. ROAS shortfall.
    if (targetRoas > 0 && conv >= minConvForCpa && spend > 0) {
      const roas = convVal / spend;
      if (roas < cfg.roas_shortfall_ratio * targetRoas) {
        out.push({
          id: `roas-shortfall-${c.campaignId}`,
          category: "performance",
          severity: roas < 0.4 * targetRoas ? "P1" : "P2",
          magnitude: roas < 0.4 * targetRoas ? "high" : "medium",
          confidence: "high",
          effort: "medium",
          metric: "ROAS",
          direction: "up",
          target: tgt,
          hint: `ROAS is ${roas.toFixed(2)} vs target ${targetRoas.toFixed(2)} (${((roas / targetRoas) * 100).toFixed(0)}% of target).`,
          evidence: [`conv_value ${cur}${convVal.toFixed(0)}`, `spend ${cur}${spend.toFixed(0)}`, `ROAS ${roas.toFixed(2)}`, `target ROAS ${targetRoas.toFixed(2)}`],
        });
      }
    }

    // 4. Low CTR vs channel median (min 500 impressions for statistical relevance).
    const median = channelMedian[ch] || 0;
    if (median > 0 && ctr < cfg.ctr_floor_ratio * median && impr > 500) {
      out.push({
        id: `low-ctr-${c.campaignId}`,
        category: "copy",
        severity: "P2",
        magnitude: "medium",
        confidence: "medium",
        effort: "medium",
        metric: "CTR",
        direction: "up",
        target: tgt,
        hint: `CTR ${(ctr * 100).toFixed(2)}% is below ${(cfg.ctr_floor_ratio * 100).toFixed(0)}% of ${ch} channel median ${(median * 100).toFixed(2)}% — likely a copy or targeting issue.`,
        evidence: [`ctr ${(ctr * 100).toFixed(2)}%`, `channel median ${(median * 100).toFixed(2)}%`, `impressions ${impr}`, `channel ${ch}`],
      });
    }

    // 5. Budget-capped + underperforming ROAS ("more budget won't fix this").
    if (targetRoas > 0 && budgetLost > cfg.capped_underperf_is && spend > 0 && conv >= minConvForCpa) {
      const roasHere = convVal / spend;
      if (roasHere < 0.8 * targetRoas) {
        out.push({
          id: `capped-underperf-${c.campaignId}`,
          category: "bidding",
          severity: "P1",
          magnitude: "high",
          confidence: "medium",
          effort: "hard",
          metric: "ROAS",
          direction: "up",
          target: tgt,
          hint: `Budget-capped (${(budgetLost * 100).toFixed(0)}% IS lost to budget) but ROAS is already below target — adding budget without fixing strategy will waste money.`,
          evidence: [`search_budget_lost_is ${(budgetLost * 100).toFixed(0)}%`, `ROAS ${roasHere.toFixed(2)} vs target ${targetRoas.toFixed(2)}`],
        });
      }
    }

    // 6. Budget-capped growth.
    if (budgetLost > cfg.budget_lost_is) {
      out.push({
        id: `budget-locked-${c.campaignId}`,
        category: "performance",
        severity: "P1",
        magnitude: "high",
        confidence: "high",
        effort: "easy",
        metric: "conversions",
        direction: "up",
        target: tgt,
        hint: "Budget-capped: losing impression share to a too-small daily budget. Recommend a budget increase capped at +20% this run.",
        evidence: [`search_budget_lost_is=${(budgetLost * 100).toFixed(0)}%`, `budget ${cur}${budget.toFixed(0)}/day, spend ${cur}${spend.toFixed(0)}`, `${conv} conversions`],
      });
    }

    // 7. Rank-capped (bids or QS too low).
    if (rankLost > cfg.rank_lost_is) {
      out.push({
        id: `rank-locked-${c.campaignId}`,
        category: "bidding",
        severity: "P2",
        magnitude: "medium",
        confidence: "medium",
        effort: "medium",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint: "Rank-capped: bids and/or Quality Score too low to show competitively. Recommend a QS path, or a bid lift capped at +30% this run.",
        evidence: [`search_rank_lost_is=${(rankLost * 100).toFixed(0)}%`, `strategy ${strat}`, `${conv} conversions`],
      });
    }

    // 8. Smart bidding on too little volume.
    const isRoas = strat.includes("ROAS") || strat.includes("CONVERSION_VALUE");
    const isCpa = strat.includes("TARGET_CPA");
    if (isRoas && conv < cfg.min_conv_roas) {
      out.push({
        id: `thin-roas-${c.campaignId}`,
        category: "bidding",
        severity: "P2",
        magnitude: "medium",
        confidence: "high",
        effort: "medium",
        metric: "ROAS",
        direction: "up",
        target: tgt,
        hint: "tROAS with too few conversions to learn from. Recommend a transitional strategy (Maximize Conversions or eCPC) until volume builds.",
        evidence: [strat, `${conv} conv (<${cfg.min_conv_roas} needed for tROAS)`],
      });
    } else if (isCpa && conv < cfg.min_conv_cpa) {
      out.push({
        id: `thin-cpa-${c.campaignId}`,
        category: "bidding",
        severity: "P2",
        magnitude: "medium",
        confidence: "high",
        effort: "medium",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint: "tCPA with too few conversions to learn from. Recommend a transitional strategy (Maximize Conversions or eCPC) until volume builds.",
        evidence: [strat, `${conv} conv (<${cfg.min_conv_cpa} needed for tCPA)`],
      });
    }

    // 9. Mature campaign still on Maximize Conversions → graduate to tCPA.
    if (strat.includes("MAXIMIZE_CONVERSIONS") && conv >= cfg.min_conv_cpa) {
      const cpa = conv > 0 ? spend / conv : 0;
      out.push({
        id: `graduate-tcpa-${c.campaignId}`,
        category: "bidding",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "easy",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint: "Enough conversion history to graduate from Maximize Conversions to Target CPA set near the recent average CPA.",
        evidence: [`${conv} conversions`, `recent CPA ~${cur}${cpa.toFixed(0)}`],
      });
    }

    // 10. Manual CPC with real conversion history.
    if (strat.includes("MANUAL") && conv > cfg.min_conv_cpa) {
      out.push({
        id: `manual-to-smart-${c.campaignId}`,
        category: "bidding",
        severity: "P2",
        magnitude: "medium",
        confidence: "medium",
        effort: "easy",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint: "Manual CPC despite a useful conversion history. Recommend eCPC or tCPA to let smart bidding optimise.",
        evidence: [strat, `${conv} conversions`],
      });
    }

    // 11. Idle / over-allocated budget.
    if (budget > 0 && spend < cfg.idle_spend_ratio * budget && budgetLost < 0.05 && conv > 0) {
      out.push({
        id: `idle-budget-${c.campaignId}`,
        category: "performance",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "medium",
        metric: "spend",
        direction: "down",
        target: tgt,
        hint: "Spending well below its daily budget with no impression-share loss — budget could be reallocated to capacity-constrained campaigns.",
        evidence: [`spend ${cur}${spend.toFixed(0)} of ${cur}${budget.toFixed(0)} budget`, `budget_lost_is=${(budgetLost * 100).toFixed(0)}%`],
      });
    }

    // 12. tROAS with zero conversion value — algorithm has no signal to optimise toward.
    if (isRoas && convVal === 0 && spend > 0) {
      out.push({
        id: `troas-no-value-${c.campaignId}`,
        category: "bidding",
        severity: "P1",
        magnitude: "high",
        confidence: "high",
        effort: "easy",
        metric: "ROAS",
        direction: "up",
        target: tgt,
        hint: "tROAS / Maximize Conversion Value campaign has recorded zero conversion value — the algorithm is bidding blind. Switch to tCPA or Maximize Conversions immediately, and verify conversion value tracking.",
        evidence: [strat, "conversion_value=0", `spend ${cur}${spend.toFixed(0)}`],
      });
    }

    // 13. Spend without conversions → tracking gap / wrong intent.
    if (spend > cfg.ch_spend_no_conv && conv === 0) {
      const big = spend > cfg.ch_spend_no_conv_p1;
      out.push({
        id: `no-conv-${c.campaignId}`,
        category: "performance",
        severity: big ? "P1" : "P2",
        magnitude: big ? "high" : "medium",
        confidence: "medium",
        effort: "medium",
        metric: "conversions",
        direction: "up",
        target: tgt,
        hint: "Real spend with zero conversions — likely a tracking gap, wrong conversion goal, or wrong-intent traffic. Verify the conversion tag fires before touching bids.",
        evidence: [`spend ${cur}${spend.toFixed(0)}`, "0 conversions", `${clicks} clicks`, `strategy ${strat}`],
      });
    }

    // 14. Conversions without value.
    if (conv > 0 && convVal === 0) {
      out.push({
        id: `no-value-${c.campaignId}`,
        category: "performance",
        severity: isRoas ? "P1" : "P2",
        magnitude: isRoas ? "high" : "medium",
        confidence: "high",
        effort: "medium",
        metric: "ROAS",
        direction: "up",
        target: tgt,
        hint: isRoas
          ? "Conversions tracked but with NO value, while this campaign bids on value (tROAS / Max Conversion Value) — smart bidding is flying blind. Configure dynamic conversion values urgently."
          : "Conversions tracked but with no value — ROAS reporting and value-based bidding are impossible until conversion values are passed to the tag.",
        evidence: [`${conv} conversions`, "conversion_value=0", `strategy ${strat}`],
      });
    }

    // 15. Implausibly high CVR → soft-event mis-tag.
    if (clicks > cfg.ch_high_cvr_clicks && conv / clicks > cfg.ch_high_cvr) {
      out.push({
        id: `high-cvr-${c.campaignId}`,
        category: "performance",
        severity: "P2",
        magnitude: "medium",
        confidence: "medium",
        effort: "easy",
        metric: "conversions",
        direction: "down",
        target: tgt,
        hint: "Implausibly high conversion rate — the conversion action may be counting a soft event (page view / add-to-cart). Verify it only counts real conversions.",
        evidence: [`CVR ${((conv / clicks) * 100).toFixed(1)}%`, `${conv} conv / ${clicks} clicks`],
      });
    }

    // 16. Big spender, near-zero CVR.
    if (spend > cfg.ch_low_cvr_spend && clicks > 0 && conv / clicks < cfg.ch_low_cvr) {
      out.push({
        id: `low-cvr-${c.campaignId}`,
        category: "performance",
        severity: "P2",
        magnitude: "medium",
        confidence: "medium",
        effort: "medium",
        metric: "conversions",
        direction: "up",
        target: tgt,
        hint: "High spend but near-zero conversion rate — tracking may fire late or on the wrong goal, or the traffic intent is off. Verify tracking before optimising bids.",
        evidence: [`spend ${cur}${spend.toFixed(0)}`, `CVR ${((conv / clicks) * 100).toFixed(2)}%`, `${conv} conv / ${clicks} clicks`],
      });
    }
  }

  return out;
}

/**
 * 17. Trend anomaly detection — last 7 days vs the prior 14-day baseline, using
 * the daily time series (campaigns_daily) the rest of this analyst doesn't
 * touch (it only reads the latest campaign-level snapshot). Catches CPA
 * spikes and CVR collapses that a point-in-time snapshot can't see at all —
 * there was previously no period-over-period comparison anywhere in this
 * system. Requires a minimum conversion count in the baseline window so a
 * low-volume campaign's normal noise doesn't get reported as an "anomaly".
 */
function detectTrendAnomalies(data: PerformanceBudgetData, cfg: Record<string, number>, cur: string): Candidate[] {
  const out: Candidate[] = [];
  if (data.campaignsDaily.length === 0) return out;

  const today = new Date();
  const recentCutoff = new Date(today);
  recentCutoff.setUTCDate(recentCutoff.getUTCDate() - 7);
  const baselineCutoff = new Date(today);
  baselineCutoff.setUTCDate(baselineCutoff.getUTCDate() - 21);

  const recentCutoffStr = recentCutoff.toISOString().split("T")[0];
  const baselineCutoffStr = baselineCutoff.toISOString().split("T")[0];

  interface Agg {
    spend: number;
    conv: number;
    clicks: number;
  }
  const recentByCampaign = new Map<string, Agg>();
  const baselineByCampaign = new Map<string, Agg>();

  for (const row of data.campaignsDaily) {
    const cid = String(row.campaignId);
    const spend = micros(row.costMicros);
    const conv = Number(row.conversions) || 0;
    const clicks = Number(row.clicks) || 0;
    if (row.date >= recentCutoffStr) {
      const agg = recentByCampaign.get(cid) || { spend: 0, conv: 0, clicks: 0 };
      agg.spend += spend;
      agg.conv += conv;
      agg.clicks += clicks;
      recentByCampaign.set(cid, agg);
    } else if (row.date >= baselineCutoffStr && row.date < recentCutoffStr) {
      const agg = baselineByCampaign.get(cid) || { spend: 0, conv: 0, clicks: 0 };
      agg.spend += spend;
      agg.conv += conv;
      agg.clicks += clicks;
      baselineByCampaign.set(cid, agg);
    }
  }

  const campaignById = new Map(data.campaigns.map((c) => [String(c.campaignId), c]));

  for (const [cid, recent] of recentByCampaign) {
    const baseline = baselineByCampaign.get(cid);
    if (!baseline || baseline.conv < cfg.anomaly_min_baseline_conv) continue; // not enough baseline volume to trust the comparison
    const c = campaignById.get(cid);
    const tgt = { type: "campaign" as const, id: cid, name: c?.campaignName || cid };

    // CPA jump: baseline daily-average CPA vs recent daily-average CPA (normalized per day so the two windows, 7d vs 14d, are comparable).
    const baselineDailyCpa = baseline.conv > 0 ? baseline.spend / 14 / (baseline.conv / 14) : 0;
    const recentDailyCpa = recent.conv > 0 ? recent.spend / 7 / (recent.conv / 7) : 0;
    if (baselineDailyCpa > 0 && recentDailyCpa > 0 && recentDailyCpa / baselineDailyCpa >= cfg.anomaly_cpa_jump_ratio) {
      const jumpRatio = recentDailyCpa / baselineDailyCpa;
      out.push({
        id: `anomaly-cpa-jump-${cid}`,
        category: "performance",
        severity: jumpRatio >= 2 ? "P1" : "P2",
        magnitude: jumpRatio >= 2 ? "high" : "medium",
        confidence: "high",
        effort: "medium",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint: `CPA jumped ${((jumpRatio - 1) * 100).toFixed(0)}% in the last 7 days (${cur}${recentDailyCpa.toFixed(0)}/day-equivalent) vs the prior 14-day baseline (${cur}${baselineDailyCpa.toFixed(0)}). Investigate recent changes: bid/budget edits, auction competition, ad disapprovals, landing page changes.`,
        evidence: [
          `recent 7d CPA ${cur}${recentDailyCpa.toFixed(0)}`,
          `baseline 14d CPA ${cur}${baselineDailyCpa.toFixed(0)}`,
          `${(jumpRatio).toFixed(2)}x jump`,
          `baseline conv ${baseline.conv.toFixed(0)}`,
        ],
      });
    }

    // CVR collapse: same normalization.
    const baselineCvr = baseline.clicks > 0 ? baseline.conv / baseline.clicks : 0;
    const recentCvr = recent.clicks > 0 ? recent.conv / recent.clicks : 0;
    if (baselineCvr > 0 && recent.clicks >= 20 && recentCvr / baselineCvr <= cfg.anomaly_cvr_drop_ratio) {
      const dropPct = (1 - recentCvr / baselineCvr) * 100;
      out.push({
        id: `anomaly-cvr-drop-${cid}`,
        category: "performance",
        severity: dropPct >= 50 ? "P1" : "P2",
        magnitude: dropPct >= 50 ? "high" : "medium",
        confidence: "high",
        effort: "medium",
        metric: "conversions",
        direction: "up",
        target: tgt,
        hint: `Conversion rate dropped ${dropPct.toFixed(0)}% in the last 7 days (${(recentCvr * 100).toFixed(2)}% vs baseline ${(baselineCvr * 100).toFixed(2)}%) on ${recent.clicks} recent clicks. Check conversion tracking first (tag firing, goal changes), then landing page / checkout for breakage.`,
        evidence: [
          `recent 7d CVR ${(recentCvr * 100).toFixed(2)}%`,
          `baseline 14d CVR ${(baselineCvr * 100).toFixed(2)}%`,
          `${recent.clicks} recent clicks`,
          `${dropPct.toFixed(0)}% drop`,
        ],
      });
    }
  }

  return out;
}

/**
 * Reviews budget changes the system made >=30 days ago — did it actually help? See the
 * doc comment on loadChangeOutcomeCandidates() above for why this is scoped to adjust_budget
 * only. Always produces a finding (never silently discards an evaluated change): low-confidence
 * "insufficient data" if either window's conversion volume is too thin to trust, otherwise a
 * real verdict — worse (recommend reverting, with the revert as a deterministic proposed_change,
 * same pattern as the keyword-level bid-opportunity rule), better (confirm + suggest scaling
 * further), or neutral.
 */
function detectChangeOutcomes(data: PerformanceBudgetData, cfg: Record<string, number>, cur: string): Candidate[] {
  const out: Candidate[] = [];
  const worseRatio = cfg.change_review_worse_ratio || 1.2;
  const betterRatio = cfg.change_review_better_ratio || 0.85;
  const minConv = cfg.anomaly_min_baseline_conv || 5;

  for (const c of data.changeOutcomeCandidates) {
    const tgt = { type: "campaign" as const, id: c.campaignId, name: c.campaignName };
    const thinData = c.beforeConv < minConv || c.afterConv < minConv;

    if (thinData) {
      out.push({
        id: `change-outcome-${c.changeLogId}`,
        category: "performance",
        severity: "P3",
        magnitude: "low",
        confidence: "low",
        effort: "easy",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint:
          `Budget change on "${c.campaignName}" (${c.changeDate}, ${cur}${c.beforeBudget.toFixed(0)} -> ${cur}${c.afterBudget.toFixed(0)}/day) ` +
          `can't be confidently evaluated 30 days later — too little conversion volume on one or both sides ` +
          `(before: ${c.beforeConv.toFixed(0)} conv, after: ${c.afterConv.toFixed(0)} conv) to trust a before/after comparison.`,
        evidence: [`before conv ${c.beforeConv.toFixed(0)}`, `after conv ${c.afterConv.toFixed(0)}`, `need >=${minConv} on each side`],
      });
      continue;
    }

    const cpaRatio = c.beforeCpa > 0 && c.afterCpa > 0 ? c.afterCpa / c.beforeCpa : 0;
    const gotWorse = cpaRatio >= worseRatio;
    const gotBetter = cpaRatio > 0 && cpaRatio <= betterRatio;

    if (gotWorse) {
      out.push({
        id: `change-outcome-${c.changeLogId}`,
        category: "performance",
        severity: cpaRatio >= 1.5 ? "P1" : "P2",
        magnitude: cpaRatio >= 1.5 ? "high" : "medium",
        confidence: "high",
        effort: "easy",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint:
          `Budget increase on "${c.campaignName}" (${c.changeDate}, ${cur}${c.beforeBudget.toFixed(0)} -> ${cur}${c.afterBudget.toFixed(0)}/day) made CPA ` +
          `${((cpaRatio - 1) * 100).toFixed(0)}% WORSE 30 days later (${cur}${c.beforeCpa.toFixed(0)} -> ${cur}${c.afterCpa.toFixed(0)}). Recommend reverting the budget back to ${cur}${c.beforeBudget.toFixed(0)}/day.`,
        evidence: [
          `before CPA ${cur}${c.beforeCpa.toFixed(0)} (${c.beforeConv.toFixed(0)} conv)`,
          `after CPA ${cur}${c.afterCpa.toFixed(0)} (${c.afterConv.toFixed(0)} conv)`,
          `${cpaRatio.toFixed(2)}x worse`,
        ],
        proposedChanges: [
          {
            type: "adjust_budget",
            params: { campaign_id: c.campaignId, new_budget_micros: Math.round(c.beforeBudget * 1e6) },
          },
        ],
      });
    } else if (gotBetter) {
      out.push({
        id: `change-outcome-${c.changeLogId}`,
        category: "performance",
        severity: "P3",
        magnitude: "medium",
        confidence: "high",
        effort: "easy",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint:
          `Budget increase on "${c.campaignName}" (${c.changeDate}, ${cur}${c.beforeBudget.toFixed(0)} -> ${cur}${c.afterBudget.toFixed(0)}/day) improved CPA ` +
          `${((1 - cpaRatio) * 100).toFixed(0)}% 30 days later (${cur}${c.beforeCpa.toFixed(0)} -> ${cur}${c.afterCpa.toFixed(0)}) — this one worked. Consider scaling it further.`,
        evidence: [
          `before CPA ${cur}${c.beforeCpa.toFixed(0)} (${c.beforeConv.toFixed(0)} conv)`,
          `after CPA ${cur}${c.afterCpa.toFixed(0)} (${c.afterConv.toFixed(0)} conv)`,
          `${cpaRatio.toFixed(2)}x (lower is better)`,
        ],
      });
    } else {
      out.push({
        id: `change-outcome-${c.changeLogId}`,
        category: "performance",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "easy",
        metric: "CPA",
        direction: "down",
        target: tgt,
        hint:
          `Budget change on "${c.campaignName}" (${c.changeDate}, ${cur}${c.beforeBudget.toFixed(0)} -> ${cur}${c.afterBudget.toFixed(0)}/day) had a neutral effect on CPA ` +
          `30 days later (${cur}${c.beforeCpa.toFixed(0)} -> ${cur}${c.afterCpa.toFixed(0)}).`,
        evidence: [`before CPA ${cur}${c.beforeCpa.toFixed(0)}`, `after CPA ${cur}${c.afterCpa.toFixed(0)}`],
      });
    }
  }

  return out;
}
