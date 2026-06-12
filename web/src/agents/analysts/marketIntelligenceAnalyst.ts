/**
 * marketIntelligenceAnalyst.ts — Market Intelligence Analyst (v2 Analyst #5).
 *
 * Merges v1's CompetitiveIntel (brand-defense IS gaps, competitor-comparison
 * query intent, rank-IS loss) and CategoryTrendSpotter (emerging/declining
 * intent themes, brain-informed industry shifts) into one pure-LLM analyst.
 *
 * `finding.id` prefix: "market-intel-<id>" (no dedicated prefix is documented
 * in agentNames.ts for this analyst — competitive/trend findings are
 * `action_category: "insight"` per CLAUDE.md's action classification, which
 * actionMeta.ts falls back to for unrecognised prefixes).
 *
 * Reads: search_terms, campaigns. Brain categories: competitive, brand,
 * general, pmax.
 */

import type { AnalystSpec } from "../runAnalyst";
import { AGENTS } from "../synthesis/agentNames";
import { getTargets } from "../rules/rulesEngine";
import { loadAccountData, readSearchTerms, micros, type SearchTermRow, type CampaignRow } from "../data";

interface MarketIntelligenceData {
  searchTerms: SearchTermRow[];
  campaigns: CampaignRow[];
  cur: string;
}

export async function buildMarketIntelligenceAnalystSpec(): Promise<AnalystSpec<MarketIntelligenceData>> {
  const [searchTerms, { campaigns }, targets] = await Promise.all([readSearchTerms(), loadAccountData(), getTargets()]);

  return {
    agentName: AGENTS.MARKET_INTELLIGENCE,
    persona:
      "You are a senior Google Ads market-intelligence analyst combining two skills: competitive intel (brand defense " +
      "gaps, competitor-comparison query intent, rank-IS loss) and category trend spotting (emerging/declining intent " +
      "themes, brain-informed industry shifts). You cite real numbers from the data — impression share percentages, " +
      "spend amounts, query counts, CTR/CVR. You never fabricate competitor activity or trends. If the data does not " +
      "show a clear signal, you say so and return fewer findings rather than inventing issues.",
    instructions:
      "Every finding must include a specific number from the data as evidence. Do not write generic recommendations. " +
      "If you cannot find evidence for a specific issue, do not invent one — return an empty findings array instead. " +
      "Brand protection is usually the cheapest CPC; defend it first.\n\n" +
      "Surface up to 6 findings total. Focus areas:\n" +
      "  1. Brand defense gaps: BRAND campaigns with search impression share < 90% — cite the exact IS %. Recommend a " +
      "bid or budget increase.\n" +
      '  2. Competitor-comparison queries ("X vs Y", "X alternative", "better than X") in the search-term mix — cite ' +
      "impression and conversion counts. Suggest dedicated comparison landing pages or sitelinks.\n" +
      "  3. Rank IS loss on key non-brand campaigns alongside high CPCs — cite the rank_lost_IS % and current CPC.\n" +
      "  4. Recently emerging query themes in the search-term mix that lack dedicated ad groups — recommend creating " +
      "them before competitors do, citing impression counts.\n" +
      "  5. Industry shifts visible in the BRAIN context (recent rss content) that should inform near-term campaign " +
      "strategy — cite the brain source id.\n" +
      "  6. Categories of intent that are softening (low CTR or CVR relative to the account average) — cite the exact " +
      "CTR/CVR numbers. With one date window trend math is directional only; use confidence=\"medium\" or \"low\" " +
      "appropriately.\n\n" +
      'Honestly flag the data limitation: auction_insight_view is not yet collected; richer share-of-voice findings ' +
      "would require it.\n\n" +
      'Use category="competitive" or "general" or "keywords" as appropriate. target.type = "campaign" or "adgroup".',
    brainCategories: ["competitive", "brand", "general", "pmax"],
    brainLimit: 5,
    maxTokens: 3500,
    data: { searchTerms, campaigns, cur: targets.currency_symbol },
    formatDataForPrompt,
  };
}

function formatDataForPrompt(d: MarketIntelligenceData): string {
  const lines: string[] = [];
  const cur = d.cur;

  // 1. Brand campaigns and their impression share.
  const brandCampaigns = d.campaigns.filter((c) => /brand/i.test(c.campaignName) && c.channelType === "SEARCH");
  if (brandCampaigns.length) {
    lines.push("Brand campaigns and their impression share:");
    lines.push("id | name | spend | conv | search_IS | budget_lost_IS | rank_lost_IS");
    for (const c of brandCampaigns) {
      const is = (Number(c.searchIs) || 0) * 100;
      const budgetLost = (Number(c.searchBudgetLostIs) || 0) * 100;
      const rankLost = (Number(c.searchRankLostIs) || 0) * 100;
      lines.push(
        `${c.campaignId} | ${c.campaignName} | ${cur}${micros(c.costMicros).toFixed(2)} | ${c.conversions} | ` +
          `${is.toFixed(0)}% | ${budgetLost.toFixed(0)}% | ${rankLost.toFixed(0)}%`
      );
    }
  }

  // 2. Comparison / competitor-comparison intent queries.
  const comparisonTerms = d.searchTerms
    .filter((t) => / vs |compare |comparison|alternative |better than /i.test(t.term))
    .sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0))
    .slice(0, 30);
  if (comparisonTerms.length) {
    lines.push("");
    lines.push("Comparison / competitor-comparison intent queries (top 30 by impressions):");
    lines.push("term | impressions | clicks | spend | conv | campaign");
    for (const t of comparisonTerms) {
      lines.push(`"${t.term}" | ${t.impressions} | ${t.clicks} | ${cur}${micros(t.costMicros).toFixed(2)} | ${t.conversions} | ${t.campaignName}`);
    }
  }

  // 3. Top-50-by-impressions trend-proxy table.
  const top = d.searchTerms
    .slice()
    .sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0))
    .slice(0, 50);
  if (top.length) {
    lines.push("");
    lines.push(`Top ${top.length} search terms by IMPRESSIONS this window (proxy for current intent / trends):`);
    lines.push("term | impressions | clicks | conv | ctr | spend | ad_group");
    for (const t of top) {
      const impr = Number(t.impressions) || 0;
      const clicks = Number(t.clicks) || 0;
      const ctr = impr > 0 ? ((clicks / impr) * 100).toFixed(2) + "%" : "n/a";
      lines.push(`"${t.term}" | ${impr} | ${clicks} | ${t.conversions} | ${ctr} | ${cur}${micros(t.costMicros).toFixed(2)} | ${t.adGroupName}`);
    }
  }

  lines.push("");
  lines.push(
    "Note: auction_insight_view is not yet collected; share-of-voice / overlap-rate analysis would be richer with that " +
      "data. A dedicated TrendsFetcher (Raw_Trends) is also planned but not yet wired; use the BRAIN context (recent " +
      "rss content) as the forward signal."
  );
  return lines.join("\n");
}
