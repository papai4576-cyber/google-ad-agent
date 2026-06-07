/**
 * CompetitiveIntel.js — surfaces competitor-related issues + opportunities.
 *
 * Domain: how competitors are showing up in our auction. With full auction
 * insights data this agent flags share-of-voice loss, position-above-rate
 * drops, and conquesting opportunities. Without that data (we do not yet
 * collect auction_insight_view), it falls back to heuristics on search-term
 * data — competitor brand names appearing in queries, brand defense gaps.
 *
 * Reads: Raw_SearchTerms + Raw_Keywords + Raw_Campaigns.
 * Brain categories queried: competitive, brand.
 */

function runCompetitiveIntel(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const searchTerms = AgentCommon.readSearchTerms();
  const keywords    = AgentCommon.readKeywords();
  const campaigns   = AgentCommon.readCampaigns();
  if (searchTerms.length === 0 && campaigns.length === 0) {
    log_('agent', 'competitive_intel: no data — skipping');
    return { agent: 'competitive_intel', findings: [], summary: 'No data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'competitive_intel',
    mode:            mode,
    brainCategories: ['competitive', 'brand', 'keywords'],
    brainLimit:      5,
    persona:
      'You are a Google Ads competitive intel specialist. You spot competitor ' +
      'incursions into the account and brand defense gaps. You read search ' +
      'queries containing competitor brand names and you watch impression-share ' +
      'signals for share-of-voice loss.',
    instructions:
      'Analyze competitive signals and surface up to 5 COMPETITIVE findings. Focus:\n' +
      '  1. Brand defense gaps: if BRAND campaigns have impression_share < 90%, ' +
      '     competitors may be bidding on the brand. Recommend raising bids or ' +
      '     budget on brand specifically (cheapest CPC anyway).\n' +
      '  2. Competitor conquesting opportunities: search terms that look like ' +
      '     known competitor brand names mixed with category terms — flag for ' +
      '     review as potential conquest targets (only if the user explicitly ' +
      '     wants to conquest; be conservative).\n' +
      '  3. Generic terms drawing competitor-comparison queries ("X vs Y") → ' +
      '     suggest dedicated comparison-page ads / sitelinks.\n' +
      '  4. Honestly flag the data limitation: auction_insight_view is not ' +
      '     collected yet; richer competitive findings require it.\n\n' +
      'Use category="competitive". target.type = "campaign".',
    data: { searchTerms, keywords, campaigns, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _competitiveIntelFormatData(d);
    },
  });
}

function _competitiveIntelFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  // Brand-defense view: campaigns whose name contains "brand" with their IS.
  const brandCampaigns = d.campaigns.filter(c =>
    /brand/i.test(c.campaign_name) && c.channel_type === 'SEARCH'
  );
  if (brandCampaigns.length) {
    lines.push('Brand campaigns and their impression share:');
    lines.push('id | name | spend | conv | search_IS | budget_lost_IS | rank_lost_IS');
    for (const c of brandCampaigns) {
      lines.push(
        `${c.campaign_id} | ${c.campaign_name} | ` +
        `${cur}${AgentCommon.micros(c.cost_micros).toFixed(2)} | ${c.conversions} | ` +
        `${(c.search_is * 100).toFixed(0)}% | ${(c.search_budget_lost_is * 100).toFixed(0)}% | ` +
        `${(c.search_rank_lost_is * 100).toFixed(0)}%`
      );
    }
  }

  // Comparison / "vs" queries — easy heuristic for competitor-comparison intent.
  const comparisonTerms = d.searchTerms.filter(t =>
    / vs |compare |comparison|alternative |better than /i.test(t.term)
  ).sort((a, b) => b.impressions - a.impressions).slice(0, 30);
  if (comparisonTerms.length) {
    lines.push('');
    lines.push('Comparison / competitor-comparison intent queries (top 30 by impressions):');
    lines.push('term | impressions | clicks | spend | conv | campaign');
    for (const t of comparisonTerms) {
      lines.push(
        `"${t.term}" | ${t.impressions} | ${t.clicks} | ` +
        `${cur}${AgentCommon.micros(t.cost_micros).toFixed(2)} | ${t.conversions} | ` +
        `${t.campaign_name}`
      );
    }
  }

  lines.push('');
  lines.push('Note: auction_insight_view is not yet collected; share-of-voice / ' +
             'overlap-rate analysis would be richer with that data.');
  return lines.join('\n');
}

function testCompetitiveIntel() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'CompetitiveIntel dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runCompetitiveIntel({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 150)}`);
  }
}
