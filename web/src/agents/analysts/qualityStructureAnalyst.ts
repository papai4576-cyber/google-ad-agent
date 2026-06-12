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
 *
 * Reads: keywords, ad_groups, ads, extensions, campaigns.
 * Brain categories: structure, copy, landing_page.
 */

import type { Candidate, RuleBasedAnalystSpec } from "../runAnalyst";
import { RulesEngine } from "../rules/rulesEngine";
import { AGENTS } from "../synthesis/agentNames";
import { loadAccountData, micros, type AdGroupRow, type AdRow, type CampaignRow, type ExtensionRow, type KeywordRow } from "../data";

interface QualityStructureData {
  campaigns: CampaignRow[];
  adGroups: AdGroupRow[];
  keywords: KeywordRow[];
  ads: AdRow[];
  extensions: ExtensionRow[];
}

const RULE_DEFAULTS = {
  QS_MIN_COST: 5,
  QS_MAX: 5,
  QS_P1_COST: 50,
  MAX_ADGROUPS_PER_CAMPAIGN: 30,
  MAX_KEYWORDS_PER_ADGROUP: 20,
  MIN_ACTIVE_ADS: 2,
  MIN_SPEND_CONCENTRATION: 1000,
  EXT_MIN_SPEND: 10,
  EXT_HIGH_SPEND: 50,
};

export async function buildQualityStructureAnalystSpec(): Promise<RuleBasedAnalystSpec<QualityStructureData>> {
  const data = await loadAccountData();
  const ruleConfig = await RulesEngine.load(RULE_DEFAULTS);

  return {
    agentName: AGENTS.QUALITY_STRUCTURE,
    persona:
      "You are a Google Ads Quality Score and account-architecture specialist favouring Single-Theme Ad Groups and clean " +
      "brand/non-brand separation. You turn flagged low-QS keywords, structural debt, and extension gaps into specific, " +
      "root-cause-matched actions.",
    instructions:
      "Quantify where useful: raising QS by ~2 points typically cuts CPC ~15-20%. Structural findings are usually P2/P3 — be " +
      "concrete about the restructure: name the split, the consolidation, or the ad to add. For extension gaps, propose CONCRETE " +
      "starting copy: 4-6 sitelink texts, 6-8 callouts, or 1-2 structured-snippet headers+values — tailored to the campaign's " +
      "offering, within Google length limits (sitelink text <= 25 chars).",
    brainCategories: ["structure", "copy", "landing_page"],
    brainLimit: 4,
    data,
    formatDataForPrompt: () => "",
    ruleConfig,
    detect: detectQualityStructure,
    maxCandidates: 8,
    maxTokens: 2500,
  };
}

function detectQualityStructure(data: QualityStructureData, ctx: { cur: string; cfg: Record<string, number> }): Candidate[] {
  const cfg = ctx.cfg;
  const cur = ctx.cur;
  const out: Candidate[] = [];

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

  for (const k of data.keywords) {
    const cost = micros(k.costMicros);
    const qs = Number(k.qualityScore) || 0;
    if (!(cost >= cfg.qs_min_cost && qs >= 1 && qs <= cfg.qs_max)) continue;

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

    const big = cost > cfg.qs_p1_cost;
    out.push({
      id: `low-qs-${k.keywordId}`,
      category,
      severity: big ? "P1" : "P2",
      magnitude: big ? "high" : "medium",
      confidence: "high",
      effort: "medium",
      metric: "CPA",
      direction: "down",
      target: { type: "keyword", id: String(k.keywordId), name: k.text },
      hint,
      evidence: [
        `QS=${qs}`,
        `spend ${cur}${cost.toFixed(0)}`,
        `components adRel=${k.creativeQuality || "?"}, LP=${k.postClickQuality || "?"}, expCTR=${k.searchPredictedCtr || "?"}`,
        `${k.clicks} clicks, ${k.conversions} conv`,
        `ad group ${k.adGroupName}`,
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
  for (const ag of ags) {
    const kwc = (kwByAg[ag.adGroupId] || []).length;
    const adc = (adsByAg[ag.adGroupId] || []).length;
    const tgt = { type: "adgroup" as const, id: String(ag.adGroupId), name: ag.adGroupName };

    if (adc < cfg.min_active_ads) {
      out.push({
        id: `structure-understaffed-ag-${ag.adGroupId}`,
        category: "structure",
        severity: "P2",
        magnitude: "medium",
        confidence: "high",
        effort: "easy",
        metric: "CTR",
        direction: "up",
        target: tgt,
        hint: "Ad group is below the 2-active-ad safety rail — add at least one more responsive search ad so Google can rotate and test.",
        evidence: [`${adc} active ads`, `${kwc} keywords`],
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

  /* ---- Extensions (ported from ExtensionAuditor) ---- */

  if (data.extensions.length === 0) {
    const top = data.campaigns.slice().sort((a, b) => (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0))[0];
    if (top) {
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
        hint: "No extensions found anywhere in the account — add sitelinks, callouts and structured snippets to the top campaigns; the cheapest CTR lift available.",
        evidence: ["0 extensions across all campaigns"],
      });
    }
  } else {
    const byCampaign: Record<string, Record<string, ExtensionRow[]>> = {};
    for (const e of data.extensions) {
      const cid = String(e.campaignId);
      const c = (byCampaign[cid] = byCampaign[cid] || {});
      (c[e.type] = c[e.type] || []).push(e);
    }

    const camps = data.campaigns.slice().sort((a, b) => (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0));
    for (const c of camps) {
      const spend = micros(c.costMicros);
      if (spend < cfg.ext_min_spend) continue;
      const cov = byCampaign[String(c.campaignId)] || {};
      const n = (t: string) => (cov[t] || []).length;
      const big = spend > cfg.ext_high_spend;
      const tgt = { type: "campaign" as const, id: String(c.campaignId), name: c.campaignName };

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
          hint: "No sitelinks — the single biggest extension CTR lift. Propose 4-6 concrete sitelink texts relevant to this campaign.",
          evidence: ["0 sitelinks", String(c.channelType), `spend ${cur}${spend.toFixed(0)}`],
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
          hint: "Below the recommended 4+ sitelinks — propose additional sitelink texts.",
          evidence: [`${n("SITELINK")} sitelinks`, `spend ${cur}${spend.toFixed(0)}`],
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
          hint: "No callouts — propose 6-8 concise callout phrases (benefits, trust signals).",
          evidence: ["0 callouts", `spend ${cur}${spend.toFixed(0)}`],
        });
      }

      if (n("STRUCTURED_SNIPPET") === 0 && big) {
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
          hint: "No structured snippets — propose 1-2 snippet headers + values for the offering.",
          evidence: ["0 structured snippets", `spend ${cur}${spend.toFixed(0)}`],
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

  return out;
}
