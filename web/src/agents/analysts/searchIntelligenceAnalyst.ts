/**
 * searchIntelligenceAnalyst.ts — Search Intelligence Analyst (v2 Analyst #4).
 *
 * Merges v1's KeywordMiner (promote converting search terms to exact-match
 * keywords), NegativeKwHunter (block zero-conversion wasted-spend terms),
 * and SearchTermPatternAnalyzer (account-wide intent-bucket / structural-gap
 * / leakage patterns) into one pure-LLM analyst with a single, structured,
 * multi-section prompt.
 *
 * `finding.id` prefixes follow agentNames.ts conventions:
 *   "add-negative-<id>", "new-keyword-<id>", "search-term-pattern-<id>"
 *
 * Reads: search_terms, keywords, negative_keywords. Brain categories:
 * keywords, structure, audience.
 */

import type { AnalystSpec } from "../runAnalyst";
import { AGENTS } from "../synthesis/agentNames";
import { getConfigValue, getTargets } from "../rules/rulesEngine";
import { readSearchTerms, readNegativeKeywords, loadAccountData, micros, type SearchTermRow, type KeywordRow, type NegativeKeywordRow } from "../data";

interface SearchIntelligenceData {
  searchTerms: SearchTermRow[];
  keywords: KeywordRow[];
  negativeKeywords: NegativeKeywordRow[];
  minWaste: number;
  cur: string;
}

export async function buildSearchIntelligenceAnalystSpec(): Promise<AnalystSpec<SearchIntelligenceData>> {
  const [searchTerms, { keywords }, negativeKeywords, targets] = await Promise.all([
    readSearchTerms(),
    loadAccountData(),
    readNegativeKeywords(),
    getTargets(),
  ]);
  const minWaste = parseFloat(await getConfigValue("NEGATIVE_KW_MIN_WASTE", "50")) || 50;

  return {
    agentName: AGENTS.SEARCH_INTELLIGENCE,
    persona:
      "You are a senior Google Ads search-term specialist combining three skills: harvesting converting queries into " +
      "exact-match keywords, blocking wasted spend with negative keywords, and spotting account-wide intent patterns " +
      "and structural gaps. Every finding must include a specific number from the data as evidence (impressions, clicks, " +
      "conversions, spend) and name at least 1-2 real example queries. Do not write generic recommendations.",
    instructions:
      "This prompt has three data sections. Produce up to 10 findings total across all three, prioritising the most " +
      "actionable:\n\n" +
      'SECTION 1 — PROMOTABLE KEYWORDS (id prefix "new-keyword-<id>"):\n' +
      "  Group several related converting search terms into one recommendation per ad group. In the `action` field, " +
      "list the EXACT keywords to add (with [exact] brackets), plus a suggested starting bid (no more than +30% of the " +
      'ad group default per CLAUDE.md\'s safety rails). category="keywords", target.type="adgroup". Severity P1 if the ' +
      "cluster represents > 5 conversions or cost > 5x target_cpa.\n\n" +
      'SECTION 2 — NEGATIVE KEYWORDS (id prefix "add-negative-<id>"):\n' +
      "  Cluster zero-conversion wasted-spend terms into themes (e.g. \"informational queries containing 'how to'\", " +
      '"free / cheap variants", "wrong product line"). Pick the right scope: campaign-level negative if the theme is ' +
      "universally irrelevant, ad-group-level if specific to one group. In the `action` field, list the exact negative " +
      'keywords to add WITH match type (e.g. -[free trial], -"how to", -how (broad)). Be CONSERVATIVE — never recommend ' +
      "a negative that could also block converting queries; when in doubt, scope to ad group not campaign. Quantify " +
      'wasted spend saved over 30 days. category="keywords", target.type="campaign" or "adgroup". Severity P1 if combined ' +
      "cluster wasted spend > target_cpa x 5.\n\n" +
      'SECTION 3 — SEARCH-TERM PATTERNS (id prefix "search-term-pattern-<id>"):\n' +
      "  Look at the overall query mix for: (1) intent buckets the account is winning/losing on — cite impression counts; " +
      "(2) structural gaps — a high-volume intent theme with no dedicated ad group, name the theme and recommend creating " +
      "one; (3) cross-campaign leakage — brand terms hitting non-brand or vice versa, cite impression count; (4) theme-level " +
      "CVR outliers converting at >2x average — recommend budget reallocation; (5) ad-group name vs dominant-query mismatch " +
      '— cite the top 2-3 mismatched queries. category="structure" or "keywords", target.type="campaign" or "adgroup".\n\n' +
      "If a section has no real candidates, return zero findings for that section rather than inventing one.",
    brainCategories: ["keywords", "structure", "audience"],
    brainLimit: 5,
    maxTokens: 4000,
    data: { searchTerms, keywords, negativeKeywords, minWaste, cur: targets.currency_symbol },
    formatDataForPrompt,
  };
}

function formatDataForPrompt(d: SearchIntelligenceData): string {
  const sections: string[] = [];
  sections.push(formatPromotableKeywords(d));
  sections.push(formatNegativeCandidates(d));
  sections.push(formatSearchTermPatterns(d));
  return sections.join("\n\n");
}

/* ===========================================================================
 * Section 1 — promotable keywords (ported from KeywordMiner._keywordMinerFormatData)
 * ========================================================================= */

function formatPromotableKeywords(d: SearchIntelligenceData): string {
  const lines: string[] = [];
  const cur = d.cur;

  const exactSet = new Set<string>();
  for (const k of d.keywords) {
    if (String(k.matchType).toUpperCase() === "EXACT") {
      exactSet.add(String(k.text || "").toLowerCase().trim());
    }
  }

  const candidates = d.searchTerms.filter((t) => {
    const conv = Number(t.conversions) || 0;
    if (conv <= 0) return false;
    if (conv === 1 && (Number(t.costMicros) || 0) < 50000000) return false;
    const key = String(t.term || "").toLowerCase().trim();
    return !exactSet.has(key);
  });

  const top = candidates
    .slice()
    .sort((a, b) => (Number(b.conversions) || 0) - (Number(a.conversions) || 0) || (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0))
    .slice(0, 35);

  lines.push("=== SECTION 1: PROMOTABLE SEARCH TERMS (converting, not yet exact-match) ===");
  lines.push(`${candidates.length} total candidates. Showing top ${top.length} by conversions:`);
  lines.push("term | clicks | spend | conversions | ad_group_id | ad_group");
  for (const t of top) {
    lines.push(`"${t.term}" | ${t.clicks} | ${cur}${micros(t.costMicros).toFixed(2)} | ${t.conversions} | ${t.adGroupId} | ${t.adGroupName}`);
  }
  if (top.length === 0) {
    lines.push("");
    lines.push("No promotable search terms this period (no converting terms outside exact match).");
  }
  return lines.join("\n");
}

/* ===========================================================================
 * Section 2 — negative-keyword candidates (ported from NegativeKwHunter)
 * ========================================================================= */

function formatNegativeCandidates(d: SearchIntelligenceData): string {
  const lines: string[] = [];
  const cur = d.cur;
  const minWaste = d.minWaste;

  const wasted = d.searchTerms.filter((t) => (Number(t.conversions) || 0) === 0 && micros(t.costMicros) >= minWaste);

  const isAlreadyBlocked = buildNegativeMatcher(d.negativeKeywords);

  const stillCandidates: SearchTermRow[] = [];
  let alreadyBlockedCount = 0;
  for (const t of wasted) {
    if (isAlreadyBlocked(t)) {
      alreadyBlockedCount++;
      continue;
    }
    stillCandidates.push(t);
  }

  const top = stillCandidates
    .slice()
    .sort((a, b) => (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0))
    .slice(0, 40);

  const totalWastedTop = top.reduce((s, t) => s + micros(t.costMicros), 0);
  const totalWastedAll = stillCandidates.reduce((s, t) => s + micros(t.costMicros), 0);

  lines.push("=== SECTION 2: ZERO-CONVERSION WASTED-SPEND SEARCH TERMS ===");
  lines.push(`Threshold: spend >= ${cur}${minWaste}.`);
  lines.push(
    `${wasted.length} initially wasted, ${alreadyBlockedCount} already blocked by existing negatives, ` +
      `${stillCandidates.length} still candidates (${cur}${totalWastedAll.toFixed(2)} wasted).`
  );
  lines.push(`Showing top ${top.length} candidates (${cur}${totalWastedTop.toFixed(2)} of those) by wasted spend:`);
  lines.push("term | clicks | spend | ad_group_id | ad_group");
  for (const t of top) {
    lines.push(`"${t.term}" | ${t.clicks} | ${cur}${micros(t.costMicros).toFixed(2)} | ${t.adGroupId} | ${t.adGroupName}`);
  }
  if (top.length === 0) {
    lines.push("");
    lines.push("No new candidates after dedup against existing negatives. Negatives are well-managed.");
  }
  return lines.join("\n");
}

function buildNegativeMatcher(negatives: NegativeKeywordRow[]) {
  const byCampaign: Record<string, Array<{ text: string; match: string }>> = {};
  const byAdGroup: Record<string, Array<{ text: string; match: string }>> = {};
  const accountWide: Array<{ text: string; match: string }> = [];

  for (const n of negatives) {
    const entry = { text: String(n.text || "").toLowerCase().trim(), match: String(n.matchType || "").toUpperCase().trim() };
    if (!entry.text) continue;
    if (n.scope === "campaign") {
      const k = String(n.campaignId);
      (byCampaign[k] = byCampaign[k] || []).push(entry);
    } else if (n.scope === "ad_group") {
      const k = String(n.adGroupId);
      (byAdGroup[k] = byAdGroup[k] || []).push(entry);
    } else if (n.scope === "shared") {
      accountWide.push(entry);
    }
  }

  return function isAlreadyBlocked(term: SearchTermRow): boolean {
    const text = String(term.term || "").toLowerCase().trim();
    if (!text) return false;
    const candidates = ([] as Array<{ text: string; match: string }>)
      .concat(byCampaign[String(term.campaignId)] || [])
      .concat(byAdGroup[String(term.adGroupId)] || [])
      .concat(accountWide);
    for (const n of candidates) {
      if (negativeMatches(text, n.text, n.match)) return true;
    }
    return false;
  };
}

function negativeMatches(searchTerm: string, negText: string, matchType: string): boolean {
  if (!negText) return false;
  const mt = (matchType || "").toUpperCase();
  if (mt === "EXACT") return searchTerm === negText;
  if (mt === "PHRASE") {
    const re = new RegExp("\\b" + reEscape(negText) + "\\b");
    return re.test(searchTerm);
  }
  const words = negText.split(/\s+/).filter(Boolean);
  return words.every((w) => new RegExp("\\b" + reEscape(w) + "\\b").test(searchTerm));
}

function reEscape(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ===========================================================================
 * Section 3 — search-term patterns (ported from SearchTermPatternAnalyzer)
 * ========================================================================= */

function formatSearchTermPatterns(d: SearchIntelligenceData): string {
  const lines: string[] = [];
  const TOP_BY_IMPRESSIONS = 40;
  const TOP_CONVERTERS = 20;

  const topByImpressions = d.searchTerms
    .slice()
    .sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0))
    .slice(0, TOP_BY_IMPRESSIONS);

  const topConverters = d.searchTerms
    .filter((t) => (Number(t.conversions) || 0) > 0)
    .sort((a, b) => (Number(b.conversions) || 0) - (Number(a.conversions) || 0))
    .slice(0, TOP_CONVERTERS);

  lines.push("=== SECTION 3: SEARCH-TERM MIX FOR PATTERN ANALYSIS ===");
  lines.push(`Top ${topByImpressions.length} search terms by IMPRESSIONS:`);
  lines.push("term | impressions | clicks | conv | ad_group");
  for (const t of topByImpressions) {
    lines.push(`"${t.term}" | ${t.impressions} | ${t.clicks} | ${t.conversions} | ${t.adGroupName}`);
  }

  if (topConverters.length > 0) {
    lines.push("");
    lines.push(`Top ${topConverters.length} search terms by CONVERSIONS:`);
    lines.push("term | impressions | clicks | conv | ad_group");
    for (const t of topConverters) {
      lines.push(`"${t.term}" | ${t.impressions} | ${t.clicks} | ${t.conversions} | ${t.adGroupName}`);
    }
  }
  return lines.join("\n");
}
