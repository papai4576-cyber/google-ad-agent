/**
 * qualityStructureAnalyst.ts — Quality & Structure Analyst (v2 Analyst #2).
 *
 * Merges v1's QualityScoreInspector (low-QS keywords), AccountStructureReviewer
 * (account topology debt) and ExtensionAuditor (missing/weak extensions) into a
 * single rule-based pass + one LLM call. Detection is fully deterministic — the
 * LLM only writes prose for the pre-detected candidates (see runRuleBasedAnalyst
 * in ../runAnalyst.ts).
 *
 * `finding.id` prefixes follow agentNames.ts conventions:
 *   low-qs-, structure-, extension-
 * (no-qs-spend- is ported 1:1 from v1 and falls back to actionMeta's default).
 * v2 additions (no v1 equivalent): `structure-low-volume-*` / `structure-tiny-budget-*`
 * (campaigns structurally too small to ever optimize), `structure-utm-*` (missing/
 * malformed UTM params on ad final URLs) — all fall back to actionMeta's default.
 *
 * Reads: keywords, ad_groups, ads, extensions, campaigns.
 * Brain categories: structure, copy, landing_page.
 */

import type { Candidate, RuleBasedAnalystSpec } from "../runAnalyst";
import { RulesEngine, getConfigValue } from "../rules/rulesEngine";
import { AGENTS } from "../synthesis/agentNames";
import { loadAccountData, micros, type AdGroupRow, type AdRow, type CampaignRow, type ExtensionRow, type KeywordRow } from "../data";

interface QualityStructureData {
  campaigns: CampaignRow[];
  adGroups: AdGroupRow[];
  keywords: KeywordRow[];
  ads: AdRow[];
  extensions: ExtensionRow[];
  brandKeywords: string[];
}

const RULE_DEFAULTS = {
  QS_MIN_COST: 5,
  QS_MAX: 5,
  QS_BRAND_MAX: 8,
  QS_P1_COST: 50,
  MAX_ADGROUPS_PER_CAMPAIGN: 30,
  MAX_KEYWORDS_PER_ADGROUP: 20,
  MIN_ACTIVE_ADS: 2,
  MIN_SPEND_CONCENTRATION: 1000,
  EXT_MIN_SPEND: 10,
  EXT_HIGH_SPEND: 50,
  MIN_VIABLE_CONVERSIONS: 10,
  MIN_BUDGET_CPC_MULTIPLE: 5,
  BID_OPP_MIN_CLICKS: 10,
  BID_OPP_MIN_CONV: 3,
  BID_OPP_INCREASE_PCT: 0.2,
};

export async function buildQualityStructureAnalystSpec(): Promise<RuleBasedAnalystSpec<QualityStructureData>> {
  const [loaded, brandRaw] = await Promise.all([loadAccountData(), getConfigValue("BRAND_KEYWORDS", "")]);
  const brandKeywords = brandRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const data: QualityStructureData = { ...loaded, brandKeywords };
  const ruleConfig = await RulesEngine.load(RULE_DEFAULTS);

  return {
    agentName: AGENTS.QUALITY_STRUCTURE,
    largePrompt: true, // account-structure dump across up to 12 campaigns x 8 ad groups x keywords
    persona:
      "You are a Google Ads Quality Score and account-architecture specialist favouring Single-Theme Ad Groups and clean " +
      "brand/non-brand separation. You turn flagged low-QS keywords, structural debt, and extension gaps into specific, " +
      "root-cause-matched actions.",
    instructions:
      "Quantify where useful: raising QS by ~2 points typically cuts CPC ~15-20%. Structural findings are usually P2/P3 — be " +
      "concrete about the restructure: name the split, the consolidation, or the ad to add. For extension gaps, propose CONCRETE " +
      "starting copy: 4-6 sitelink texts, 6-8 callouts, or 1-2 structured-snippet headers+values — tailored to the campaign's " +
      "offering, within Google length limits (sitelink text <= 25 chars).\n\n" +
      'For sitelink findings (id prefixes "extension-no-extensions-account", "extension-no-sitelinks-", "extension-few-sitelinks-"): ' +
      "ALSO populate `proposed_changes` with one entry per NEW sitelink you propose (4-6 for no-sitelinks, enough to reach 4 total " +
      'for few-sitelinks): {"type":"add_sitelink","params":{"campaign_id":"<target.id>","link_text":"<=25 chars","description1":' +
      '"<=90 chars optional","description2":"<=90 chars optional","final_url":"<the URL given in this finding\'s evidence as ' +
      '\'campaign_final_url\'>"}}. If evidence has no campaign_final_url, leave proposed_changes as [] for that finding (cannot ' +
      "auto-create a sitelink without a destination URL).\n" +
      'For callout findings (id prefix "extension-no-callouts-"): ALSO populate `proposed_changes` with one entry per callout: ' +
      '{"type":"add_callout","params":{"campaign_id":"<target.id>","text":"<=25 chars"}}.\n' +
      'Structured-snippet findings ("extension-no-snippets-") and weak-extension-copy findings ("extension-weak-ext-") have no ' +
      "executable change available yet — leave proposed_changes as [] for those.",
    brainCategories: ["structure", "copy", "landing_page", "brand"],
    brainLimit: 4,
    data,
    formatDataForPrompt: (d) => {
      const lines = ["ACCOUNT STRUCTURE:"];
      // Group ad groups by campaign
      const agByCampaign = new Map<string, typeof d.adGroups>();
      for (const ag of d.adGroups) {
        const list = agByCampaign.get(ag.campaignId) ?? [];
        list.push(ag);
        agByCampaign.set(ag.campaignId, list);
      }
      // Keywords by ad group
      const kwByAdGroup = new Map<string, typeof d.keywords>();
      for (const kw of d.keywords) {
        const list = kwByAdGroup.get(kw.adGroupId) ?? [];
        list.push(kw);
        kwByAdGroup.set(kw.adGroupId, list);
      }
      // Active ad count by ad group
      const adsByAdGroup = new Map<string, number>();
      for (const ad of d.ads) {
        adsByAdGroup.set(ad.adGroupId, (adsByAdGroup.get(ad.adGroupId) ?? 0) + 1);
      }
      for (const c of d.campaigns.slice(0, 12)) {
        const ags = agByCampaign.get(c.campaignId) ?? [];
        lines.push(`Campaign "${c.campaignName}" [${c.campaignId}] | ${c.biddingStrategy || ""} | ${ags.length} ad groups`);
        for (const ag of ags.slice(0, 8)) {
          const kws = (kwByAdGroup.get(ag.adGroupId) ?? []).slice(0, 4).map((k) => `"${k.text}"[${k.matchType}]`);
          const adCount = adsByAdGroup.get(ag.adGroupId) ?? 0;
          lines.push(`  AdGroup "${ag.adGroupName}" [${ag.adGroupId}] | qs=${ag.avgQualityScore ?? "n/a"} | ${adCount} ads | keywords: ${kws.join(", ") || "none"}`);
        }
      }
      return lines.join("\n");
    },
    ruleConfig,
    detect: detectQualityStructure,
    maxCandidates: 10, // bumped from 8 — v2 added 3 new candidate-producing rule types (low-volume, tiny-budget, UTM) competing for slots
    maxTokens: 3000,
  };
}

/**
 * Best-effort campaign -> a real, currently-live final URL, derived from this
 * campaign's own ads (never invented) — sitelink assets require their own
 * `final_url`, so extension findings need a concrete URL to be auto-executable.
 * Campaigns with no ENABLED ad carrying an https final URL get no entry, and
 * their extension findings are instructed to leave `proposed_changes` empty.
 */
function buildCampaignFinalUrlMap(data: QualityStructureData): Record<string, string> {
  const agToCampaign: Record<string, string> = {};
  for (const ag of data.adGroups) agToCampaign[String(ag.adGroupId)] = String(ag.campaignId);

  const out: Record<string, string> = {};
  for (const ad of data.ads) {
    const cid = agToCampaign[String(ad.adGroupId)];
    if (!cid || out[cid]) continue;
    const urls = Array.isArray(ad.finalUrls) ? ad.finalUrls : [];
    const url = urls.find((u) => typeof u === "string" && u.startsWith("http"));
    if (url) out[cid] = url;
  }
  return out;
}

function detectQualityStructure(
  data: QualityStructureData,
  ctx: { cur: string; cfg: Record<string, number>; targets?: { target_cpa?: number } }
): Candidate[] {
  const cfg = ctx.cfg;
  const cur = ctx.cur;
  const out: Candidate[] = [];
  const campaignFinalUrl = buildCampaignFinalUrlMap(data);

  /* ---- Quality Score (ported from QualityScoreInspector) ---- */

  for (const k of data.keywords) {
    const cost = micros(k.costMicros);
    const qs = Number(k.qualityScore) || 0;
    if (qs === 0 && cost >= cfg.qs_p1_cost) {
      out.push({
        id: `no-qs-spend-${k.keywordId}`,
        category: "keywords",
        severity: "P2",
        magnitude: "medium",
        confidence: "medium",
        effort: "easy",
        metric: "CPA",
        direction: "down",
        target: { type: "keyword", id: String(k.keywordId), name: k.text },
        hint: `Keyword has no QS assigned yet (new/low volume) but is spending ${cur}${cost.toFixed(0)}. Monitor closely — if QS stays unassigned after significant spend, check match type and ad relevance.`,
        evidence: ["QS=none (new/low volume)", `spend ${cur}${cost.toFixed(0)}`, `match type ${k.matchType || "?"}`, `ad group ${k.adGroupName}`, `${k.clicks} clicks`],
      });
    }
  }

  // Stricter than a substring check: for manufacturer-brand accounts (BRAND_KEYWORDS="baidyanath"
  // and nearly every product query legitimately contains the brand name, e.g. "baidyanath
  // chyawanprash"), a loose `includes` match flags almost the entire keyword list as "brand" —
  // verified against real data: 47/70 candidates before this fix. A keyword only counts as PURE
  // brand/navigational if, after removing the brand term(s) and common navigational stopwords,
  // at most one word remains (e.g. "baidyanath", "baidyanath official", "baidyanath store") —
  // NOT "baidyanath chyawanprash" (a real product search, not a navigational brand search).
  const NAV_STOPWORDS = new Set(["official", "website", "site", "store", "shop", "near", "me", "login", "app", "com", "online", "in"]);
  const isPureBrandKeyword = (text: string): boolean => {
    if (data.brandKeywords.length === 0) return false;
    const words = String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (!words.some((w) => data.brandKeywords.includes(w))) return false;
    const remaining = words.filter((w) => !data.brandKeywords.includes(w) && !NAV_STOPWORDS.has(w));
    return remaining.length === 0;
  };

  for (const k of data.keywords) {
    const cost = micros(k.costMicros);
    const qs = Number(k.qualityScore) || 0;
    if (qs === 0) continue;
    const brand = isPureBrandKeyword(k.text);
    // Brand keywords get a much stricter bar (you're already winning the search — QS should be near-perfect)
    // than non-brand (audit standard: non-brand red flag <5, brand red flag <8).
    const maxForThisKeyword = brand ? cfg.qs_brand_max : cfg.qs_max;
    if (!(cost >= cfg.qs_min_cost && qs <= maxForThisKeyword)) continue;

    const adRel = String(k.creativeQuality || "").toUpperCase();
    const lp = String(k.postClickQuality || "").toUpperCase();
    const expCtr = String(k.searchPredictedCtr || "").toUpperCase();

    let category: Candidate["category"];
    let hint: string;
    if (lp === "BELOW_AVERAGE") {
      category = "landing_page";
      hint = "Low QS driven by below-average landing-page experience — audit message match and page speed for this keyword/ad group.";
    } else if (adRel === "BELOW_AVERAGE") {
      category = "copy";
      hint = "Low QS driven by below-average ad relevance — add ad variants featuring the keyword in headlines 1-2.";
    } else if (expCtr === "BELOW_AVERAGE") {
      category = "copy";
      hint = "Low QS driven by below-average expected CTR — test stronger headlines/CTAs.";
    } else {
      category = "keywords";
      hint = "Persistently low QS without a single below-average component — consider tighter ad-group theming, or pausing if it stays low.";
    }
    if (brand) {
      hint = `BRAND keyword with QS only ${qs}/10 (should be near-perfect — this is your own brand name) — ${hint}`;
    }

    const big = cost > cfg.qs_p1_cost;
    out.push({
      id: `low-qs-${k.keywordId}`,
      category,
      severity: brand || big ? "P1" : "P2",
      magnitude: brand || big ? "high" : "medium",
      confidence: "high",
      effort: "medium",
      metric: "CPA",
      direction: "down",
      target: { type: "keyword", id: String(k.keywordId), name: k.text },
      hint,
      evidence: [
        `QS=${qs}${brand ? " (BRAND keyword)" : ""}`,
        `spend ${cur}${cost.toFixed(0)}`,
        `components adRel=${k.creativeQuality || "?"}, LP=${k.postClickQuality || "?"}, expCTR=${k.searchPredictedCtr || "?"}`,
        `${k.clicks} clicks, ${k.conversions} conv`,
        `ad group ${k.adGroupName}`,
      ],
    });
  }

  /* ---- Keyword-level bid opportunity (v2 addition — no v1 equivalent).
   *
   * `rank-locked-*` (performanceBudgetAnalyst.ts) is campaign-scoped, but Google Ads bids are set
   * per-keyword — a campaign-level "rank lost" signal isn't a single mutate target, so that finding
   * stays manual permanently. This is the keyword-level equivalent that IS a single mutate target:
   * a keyword that's already converting profitably (CPA at or under target) on Manual CPC / Enhanced
   * CPC — i.e. a strategy where the bid we set is the bid that's used, not an algorithmic suggestion —
   * with enough volume to trust the comparison. Proposes raising its bid by BID_OPP_INCREASE_PCT
   * (default +20%, validated against the global MAX_BID_SHIFT_PCT cap of +30% again in implementation.ts).
   * Deterministic end to end (no LLM-authored copy involved), so proposed_changes is built directly here. */

  const campaignById = new Map<string, CampaignRow>();
  for (const c of data.campaigns) campaignById.set(String(c.campaignId), c);
  const MANUAL_STRATEGIES = ["MANUAL_CPC", "ENHANCED_CPC"];

  for (const k of data.keywords) {
    const campaign = campaignById.get(String(k.campaignId));
    const strat = String(campaign?.biddingStrategy || "").toUpperCase();
    if (!MANUAL_STRATEGIES.some((s) => strat.includes(s))) continue;

    const clicks = Number(k.clicks) || 0;
    const conv = Number(k.conversions) || 0;
    const cost = micros(k.costMicros);
    const currentBidMicros = Number(k.cpcBidMicros) || 0;
    if (clicks < cfg.bid_opp_min_clicks || conv < cfg.bid_opp_min_conv || currentBidMicros <= 0) continue;

    const cpa = conv > 0 ? cost / conv : 0;
    const targetCpa = Number(ctx.targets?.target_cpa) || 0;
    if (targetCpa <= 0 || cpa > targetCpa) continue; // only raise bids where we're already efficient

    const newBidMicros = Math.round(currentBidMicros * (1 + cfg.bid_opp_increase_pct));
    out.push({
      id: `bid-opportunity-${k.keywordId}`,
      category: "bidding",
      severity: "P2",
      magnitude: "medium",
      confidence: "high",
      effort: "easy",
      metric: "conversions",
      direction: "up",
      target: { type: "keyword", id: String(k.keywordId), name: k.text },
      hint:
        `Keyword "${k.text}" (ad group "${k.adGroupName}") converts at CPA ${cur}${cpa.toFixed(0)} vs target ${cur}${targetCpa.toFixed(0)} ` +
        `on Manual/Enhanced CPC (${campaign?.biddingStrategy}) — raise its bid from ${cur}${(currentBidMicros / 1e6).toFixed(2)} to ` +
        `${cur}${(newBidMicros / 1e6).toFixed(2)} (+${(cfg.bid_opp_increase_pct * 100).toFixed(0)}%) to capture more volume at the same efficiency.`,
      evidence: [
        `CPA ${cur}${cpa.toFixed(2)} <= target ${cur}${targetCpa.toFixed(2)}`,
        `${clicks} clicks, ${conv} conv`,
        `current bid ${cur}${(currentBidMicros / 1e6).toFixed(2)}`,
        `bidding strategy ${campaign?.biddingStrategy || strat}`,
      ],
      proposedChanges: [
        {
          type: "adjust_bid",
          params: {
            ad_group_id: String(k.adGroupId),
            criterion_id: String(k.keywordId),
            current_cpc_bid_micros: currentBidMicros,
            new_cpc_bid_micros: newBidMicros,
          },
        },
      ],
    });
  }

  /* ---- Account structure (ported from AccountStructureReviewer) ---- */

  const agByCampaign: Record<string, AdGroupRow[]> = {};
  for (const ag of data.adGroups) (agByCampaign[ag.campaignId] = agByCampaign[ag.campaignId] || []).push(ag);
  const kwByAg: Record<string, KeywordRow[]> = {};
  for (const kw of data.keywords) (kwByAg[kw.adGroupId] = kwByAg[kw.adGroupId] || []).push(kw);
  const adsByAg: Record<string, AdRow[]> = {};
  for (const ad of data.ads) {
    if (ad.status === "ENABLED") (adsByAg[ad.adGroupId] = adsByAg[ad.adGroupId] || []).push(ad);
  }

  for (const c of data.campaigns) {
    const ags = agByCampaign[c.campaignId] || [];
    const spend = micros(c.costMicros);
    if (ags.length > cfg.max_adgroups_per_campaign) {
      out.push({
        id: `structure-bloated-campaign-${c.campaignId}`,
        category: "structure",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "hard",
        metric: "CPA",
        direction: "down",
        target: { type: "campaign", id: String(c.campaignId), name: c.campaignName },
        hint: "Campaign has a very large number of ad groups — consider splitting by theme or funnel stage for cleaner budget control and reporting.",
        evidence: [`${ags.length} ad groups`],
      });
    }
    if (ags.length === 1 && spend >= cfg.min_spend_concentration) {
      out.push({
        id: `structure-single-ag-risk-${c.campaignId}`,
        category: "structure",
        severity: "P2",
        magnitude: "medium",
        confidence: "high",
        effort: "medium",
        metric: "CTR",
        direction: "up",
        target: { type: "campaign", id: String(c.campaignId), name: c.campaignName },
        hint: `Campaign with ${cur}${spend.toFixed(0)} spend has only 1 ad group — concentration risk. Split into 2-3 themed ad groups so you can A/B copy, control bids per theme, and isolate QS drivers.`,
        evidence: ["1 ad group", `spend ${cur}${spend.toFixed(0)}`],
      });
    }
  }

  const ags = data.adGroups.slice().sort((a, b) => (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0));
  let understaffedCount = 0;
  const understaffedNames = new Set<string>(); // dedup by name (same ag name in multiple campaigns)
  for (const ag of ags) {
    const kwc = (kwByAg[ag.adGroupId] || []).length;
    const adc = (adsByAg[ag.adGroupId] || []).length;
    const tgt = { type: "adgroup" as const, id: String(ag.adGroupId), name: ag.adGroupName };
    const agSpend = micros(ag.costMicros);

    if (adc < cfg.min_active_ads) {
      if (understaffedCount >= 5) continue; // cap at 5 to avoid flooding
      if (understaffedNames.has(ag.adGroupName)) continue; // skip same-name ag in another campaign
      understaffedNames.add(ag.adGroupName);
      understaffedCount++;
      const zeroAds = adc === 0;
      out.push({
        id: `structure-understaffed-ag-${ag.adGroupId}`,
        category: "structure",
        severity: zeroAds ? "P1" : "P2",
        magnitude: zeroAds ? "high" : "medium",
        confidence: "high",
        effort: "easy",
        metric: "CTR",
        direction: "up",
        target: tgt,
        hint: zeroAds
          ? `Ad group "${ag.adGroupName}" has NO active ads — Google cannot show anything from this ad group. Add at least 2 responsive search ads immediately.`
          : `Ad group "${ag.adGroupName}" has only 1 active ad — below the 2-active-ad safety rail. Add at least one more responsive search ad so Google can rotate and test copy.`,
        evidence: [`${adc} active ads (need ${cfg.min_active_ads})`, `${kwc} keywords`, `spend ${cur}${agSpend.toFixed(0)}`],
      });
    }
    if (kwc > cfg.max_keywords_per_adgroup) {
      out.push({
        id: `structure-bloated-ag-${ag.adGroupId}`,
        category: "structure",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "medium",
        metric: "CTR",
        direction: "up",
        target: tgt,
        hint: "Ad group packs many keywords spanning likely-different themes — split into Single-Theme Ad Groups for tighter message match.",
        evidence: [`${kwc} keywords`, `${adc} ads`],
      });
    }
  }

  // Duplicate keyword text across ad groups (self-competition) — top few.
  const textIndex: Record<string, KeywordRow[]> = {};
  for (const kw of data.keywords) {
    const key = `${String(kw.text || "").toLowerCase()}|${String(kw.matchType || "")}`;
    (textIndex[key] = textIndex[key] || []).push(kw);
  }
  const dupes = Object.entries(textIndex)
    .filter(([, rows]) => rows.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);
  for (const [key, rows] of dupes) {
    const [text, mt] = key.split("|");
    const first = rows[0];
    out.push({
      id: `structure-dup-kw-${text.replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`,
      category: "structure",
      severity: "P3",
      magnitude: "low",
      confidence: "medium",
      effort: "medium",
      metric: "CPA",
      direction: "down",
      target: { type: "adgroup", id: String(first.adGroupId), name: first.adGroupName },
      hint: "Identical keyword text+match appears in multiple ad groups, causing self-competition — consolidate to one owner ad group and negate elsewhere.",
      evidence: [`"${text}" [${mt}]`, `${rows.length} ad groups contain it`],
    });
  }

  /* ---- Low-volume / tiny-budget campaigns (v2 addition — structurally too small to ever optimize,
   * a different failure mode than budget-capped: budget-capped means "give it more budget", this means
   * "this campaign can't gather enough signal regardless of budget level"). ---- */

  const accountAvgCpc = (() => {
    const totalClicks = data.campaigns.reduce((s, c) => s + (Number(c.clicks) || 0), 0);
    const totalCost = data.campaigns.reduce((s, c) => s + micros(c.costMicros), 0);
    return totalClicks > 0 ? totalCost / totalClicks : 0;
  })();

  for (const c of data.campaigns) {
    const conv = Number(c.conversions) || 0;
    const spend = micros(c.costMicros);
    const budget = micros(c.budgetMicros);
    const tgt = { type: "campaign" as const, id: String(c.campaignId), name: c.campaignName };

    if (spend > 0 && conv > 0 && conv < cfg.min_viable_conversions) {
      out.push({
        id: `structure-low-volume-${c.campaignId}`,
        category: "structure",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "hard",
        metric: "conversions",
        direction: "up",
        target: tgt,
        hint: `Campaign "${c.campaignName}" has only ${conv.toFixed(0)} conversions over the collection window — below the ~${cfg.min_viable_conversions} needed for any bid strategy to learn reliably. Consider consolidating into a related campaign, or broadening targeting, rather than tuning bids on too little data.`,
        evidence: [`${conv.toFixed(0)} conversions (need ${cfg.min_viable_conversions}+)`, `spend ${cur}${spend.toFixed(0)}`, `strategy ${c.biddingStrategy || "unknown"}`],
      });
    }

    if (accountAvgCpc > 0 && budget > 0 && budget < accountAvgCpc * cfg.min_budget_cpc_multiple) {
      const clicksPerDay = budget / accountAvgCpc;
      out.push({
        id: `structure-tiny-budget-${c.campaignId}`,
        category: "structure",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "easy",
        metric: "conversions",
        direction: "up",
        target: tgt,
        hint: `Campaign "${c.campaignName}"'s daily budget (${cur}${budget.toFixed(0)}) buys only ~${clicksPerDay.toFixed(1)} clicks/day at the account's average CPC (${cur}${accountAvgCpc.toFixed(0)}) — too small to gather meaningful daily data. Either raise the budget meaningfully or consolidate into a related campaign.`,
        evidence: [`daily budget ${cur}${budget.toFixed(0)}`, `account avg CPC ${cur}${accountAvgCpc.toFixed(0)}`, `~${clicksPerDay.toFixed(1)} clicks/day capacity`],
      });
    }
  }

  /* ---- UTM / tracking parameter check on ad final URLs (v2 addition — uses data already collected, never checked before) ---- */

  const utmFlaggedAdGroups = new Set<string>(); // cap noise: one UTM finding per ad group
  for (const ad of data.ads) {
    if (utmFlaggedAdGroups.size >= 5) break;
    const urls = Array.isArray(ad.finalUrls) ? ad.finalUrls : [];
    const firstUrl = urls.find((u) => typeof u === "string" && u.startsWith("http"));
    if (!firstUrl) continue;
    if (utmFlaggedAdGroups.has(ad.adGroupId)) continue;

    let parsed: URL;
    try {
      parsed = new URL(firstUrl);
    } catch {
      continue;
    }
    const params = parsed.searchParams;
    const hasSource = params.has("utm_source");
    const hasMedium = params.has("utm_medium");
    const sourceVal = (params.get("utm_source") || "").toLowerCase();
    const wrongSource = hasSource && sourceVal !== "" && sourceVal !== "google" && sourceVal !== "adwords" && sourceVal !== "{network}";

    if (!hasSource || !hasMedium || wrongSource) {
      utmFlaggedAdGroups.add(ad.adGroupId);
      const issue = wrongSource ? `utm_source="${sourceVal}" (expected "google")` : !hasSource ? "missing utm_source" : "missing utm_medium";
      out.push({
        id: `structure-utm-${ad.adId}`,
        category: "structure",
        severity: "P3",
        magnitude: "low",
        confidence: "high",
        effort: "easy",
        metric: "conversions",
        direction: "up",
        target: { type: "ad", id: String(ad.adId), name: `${ad.adGroupName} / ad ${ad.adId}` },
        hint: `Ad in "${ad.adGroupName}" final URL has a tracking-tag problem: ${issue}. This breaks attribution in GA4/analytics for this ad's traffic — fix the URL's UTM parameters (utm_source=google&utm_medium=cpc at minimum).`,
        evidence: [`url: ${firstUrl.slice(0, 150)}`, issue],
      });
    }
  }

  /* ---- Extensions (ported from ExtensionAuditor) ---- */

  if (data.extensions.length === 0) {
    const top = data.campaigns.slice().sort((a, b) => (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0))[0];
    if (top) {
      const topSpend = micros(top.costMicros);
      const topCtr = ((Number(top.ctr) || 0) * 100).toFixed(2);
      out.push({
        id: "extension-no-extensions-account",
        category: "extensions",
        severity: "P1",
        magnitude: "high",
        confidence: "high",
        effort: "easy",
        metric: "CTR",
        direction: "up",
        target: { type: "campaign", id: String(top.campaignId), name: top.campaignName },
        hint: "No extensions found anywhere in the account — add sitelinks, callouts and structured snippets to the top campaigns; the cheapest CTR lift available. Propose 4-6 specific Baidyanath sitelinks for this campaign.",
        evidence: [
          "0 extensions across all campaigns",
          `top campaign spend ${cur}${topSpend.toFixed(0)}`,
          `ctr ${topCtr}%`,
          ...(campaignFinalUrl[String(top.campaignId)] ? [`campaign_final_url: ${campaignFinalUrl[String(top.campaignId)]}`] : []),
        ],
      });
    }
  } else {
    const byCampaign: Record<string, Record<string, ExtensionRow[]>> = {};
    for (const e of data.extensions) {
      const cid = String(e.campaignId);
      const c = (byCampaign[cid] = byCampaign[cid] || {});
      (c[e.type] = c[e.type] || []).push(e);
    }

    const isPMax = (c: CampaignRow) => String(c.channelType || "").includes("PERFORMANCE_MAX");

    const camps = data.campaigns.slice().sort((a, b) => (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0));
    for (const c of camps) {
      const spend = micros(c.costMicros);
      if (spend < cfg.ext_min_spend) continue;
      const cov = byCampaign[String(c.campaignId)] || {};
      const n = (t: string) => (cov[t] || []).length;
      const big = spend > cfg.ext_high_spend;
      const tgt = { type: "campaign" as const, id: String(c.campaignId), name: c.campaignName };
      const ctr = ((Number(c.ctr) || 0) * 100).toFixed(2);
      const impr = Number(c.impressions) || 0;
      const conv = Number(c.conversions) || 0;
      const pmax = isPMax(c);
      const perfCtx = `impr=${impr.toLocaleString()} ctr=${ctr}% conv=${conv}`;

      if (n("SITELINK") === 0) {
        out.push({
          id: `extension-no-sitelinks-${c.campaignId}`,
          category: "extensions",
          severity: big ? "P1" : "P2",
          magnitude: big ? "high" : "medium",
          confidence: "high",
          effort: "easy",
          metric: "CTR",
          direction: "up",
          target: tgt,
          hint: pmax
            ? `No sitelinks on Performance Max campaign "${c.campaignName}". Add asset-level sitelinks via Google Ads → Campaigns → Assets. Propose 4-6 specific Baidyanath product sitelinks (e.g. product category, offer, bestseller) tailored to this campaign.`
            : `No sitelinks on "${c.campaignName}" — the single biggest CTR lift for Search. Propose 4-6 specific Baidyanath sitelinks tailored to what this campaign promotes. Each must be ≤25 chars.`,
          evidence: [
            "0 sitelinks",
            `channel=${c.channelType || "SEARCH"}`,
            `spend ${cur}${spend.toFixed(0)}`,
            perfCtx,
            ...(campaignFinalUrl[String(c.campaignId)] ? [`campaign_final_url: ${campaignFinalUrl[String(c.campaignId)]}`] : []),
          ],
        });
      } else if (n("SITELINK") < 4) {
        out.push({
          id: `extension-few-sitelinks-${c.campaignId}`,
          category: "extensions",
          severity: "P3",
          magnitude: "low",
          confidence: "medium",
          effort: "easy",
          metric: "CTR",
          direction: "up",
          target: tgt,
          hint: `Only ${n("SITELINK")} sitelinks on "${c.campaignName}" — propose additional Baidyanath-specific sitelink texts to reach 4+ (each ≤25 chars).`,
          evidence: [
            `${n("SITELINK")} sitelinks (need 4+)`,
            `spend ${cur}${spend.toFixed(0)}`,
            perfCtx,
            ...(campaignFinalUrl[String(c.campaignId)] ? [`campaign_final_url: ${campaignFinalUrl[String(c.campaignId)]}`] : []),
          ],
        });
      }

      if (n("CALLOUT") === 0) {
        out.push({
          id: `extension-no-callouts-${c.campaignId}`,
          category: "extensions",
          severity: big ? "P2" : "P3",
          magnitude: big ? "medium" : "low",
          confidence: "high",
          effort: "easy",
          metric: "CTR",
          direction: "up",
          target: tgt,
          hint: `No callouts on "${c.campaignName}" — propose 6-8 Baidyanath-specific callout phrases (trust signals, benefits, USPs) each ≤25 chars.`,
          evidence: ["0 callouts", `spend ${cur}${spend.toFixed(0)}`, perfCtx],
        });
      }

      if (n("STRUCTURED_SNIPPET") === 0 && big && !pmax) {
        out.push({
          id: `extension-no-snippets-${c.campaignId}`,
          category: "extensions",
          severity: "P3",
          magnitude: "low",
          confidence: "medium",
          effort: "easy",
          metric: "CTR",
          direction: "up",
          target: tgt,
          hint: `No structured snippets on "${c.campaignName}" — propose 1-2 snippet header + values relevant to Baidyanath's product range (e.g. header "Products:" with values like "Chyawanprash, Triphala, Shilajit, Honey").`,
          evidence: ["0 structured snippets", `spend ${cur}${spend.toFixed(0)}`, perfCtx],
        });
      }
    }

    // A few underperforming extensions (lots of impressions, almost no clicks).
    const campName: Record<string, string> = {};
    for (const c of data.campaigns) campName[String(c.campaignId)] = c.campaignName;

    const under = data.extensions
      .filter((e) => (Number(e.impressions) || 0) > 100 && (Number(e.ctr) || 0) < 0.01)
      .sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0))
      .slice(0, 3);
    for (const e of under) {
      const cid = String(e.campaignId);
      out.push({
        id: `extension-weak-ext-${e.extensionId}`,
        category: "extensions",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "easy",
        metric: "CTR",
        direction: "up",
        target: { type: "campaign", id: cid, name: campName[cid] || cid },
        hint: "Extension shown a lot but barely clicked — replace its copy with a stronger variant.",
        evidence: [`${e.type} "${e.text}"`, `${e.impressions} impr`, `${((Number(e.ctr) || 0) * 100).toFixed(2)}% CTR`],
      });
    }
  }

  // Deduplicate by id (guards against duplicate rows in the DB snapshot).
  const seen = new Set<string>();
  return out.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}
