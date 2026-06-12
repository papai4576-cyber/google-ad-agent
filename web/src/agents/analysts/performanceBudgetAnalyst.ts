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
 *
 * Reads: campaigns. Brain categories: bidding, scaling, general.
 */

import type { Candidate, RuleBasedAnalystSpec } from "../runAnalyst";
import { RulesEngine } from "../rules/rulesEngine";
import { AGENTS } from "../synthesis/agentNames";
import { loadAccountData, micros, type CampaignRow } from "../data";

interface PerformanceBudgetData {
  campaigns: CampaignRow[];
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
};

export async function buildPerformanceBudgetAnalystSpec(): Promise<RuleBasedAnalystSpec<PerformanceBudgetData>> {
  const { campaigns } = await loadAccountData();
  const ruleConfig = await RulesEngine.load(RULE_DEFAULTS);

  return {
    agentName: AGENTS.PERFORMANCE_BUDGET,
    persona:
      "You are a senior Google Ads Performance & Budget Analyst with 10+ years of enterprise PPC experience. " +
      "Every finding must include a specific number from the data as evidence. Do not write generic recommendations.",
    instructions:
      "Explain each flagged issue clearly with the specific numbers from its evidence. Every action must be concrete — " +
      "no generic advice. Respect the safety rails: never recommend a single bid change >30% or a budget shift >20% per run. " +
      "Prefer transitional bid strategies (Maximize Conversions / eCPC) when conversion volume is too low for smart bidding.",
    brainCategories: ["bidding", "scaling", "general"],
    brainLimit: 5,
    data: { campaigns },
    formatDataForPrompt: () => "",
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

  // Account-level pacing: total spend vs monthly budget target.
  if (monthlyBudget > 0) {
    const total = data.campaigns.reduce((s, c) => s + micros(c.costMicros), 0);
    const ratio = total / monthlyBudget;
    if (ratio < 1 - cfg.pacing_tolerance || ratio > 1 + cfg.pacing_tolerance) {
      const dir = ratio < 1 ? "under-pacing" : "over-pacing";
      out.push({
        id: "pacing-account",
        category: "performance",
        severity: ratio < 0.5 || ratio > 1.5 ? "P1" : "P2",
        magnitude: Math.abs(ratio - 1) > 0.4 ? "high" : "medium",
        confidence: "high",
        effort: "medium",
        metric: "spend",
        direction: ratio < 1 ? "up" : "down",
        target: { type: "campaign", id: "account", name: "Account (all campaigns)" },
        hint: `Account is ${dir}: spend ${cur}${total.toFixed(0)} vs monthly target ${cur}${monthlyBudget.toFixed(0)}.`,
        evidence: [
          `total spend ${cur}${total.toFixed(0)}`,
          `monthly target ${cur}${monthlyBudget.toFixed(0)}`,
          `ratio ${(ratio * 100).toFixed(0)}% of target`,
        ],
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
