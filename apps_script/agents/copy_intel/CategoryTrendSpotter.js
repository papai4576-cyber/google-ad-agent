/**
 * CategoryTrendSpotter.js — spots emerging / declining intent in the category.
 *
 * Domain: rising vs falling search interest in the categories the account
 * plays in. A proper implementation reads Google Trends data over time
 * (TrendsFetcher → Raw_Trends). Until that fetcher is built, this agent
 * uses ContentHunter brain entries + recent-week search-term mix as a
 * proxy signal for what is rising in the wider PPC industry conversation.
 *
 * Reads: Raw_SearchTerms (recent-week proxy) + Brain (rss content).
 * Brain categories queried: general (especially recent rss entries).
 */

function runCategoryTrendSpotter(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const searchTerms = AgentCommon.readSearchTerms();
  if (searchTerms.length === 0) {
    log_('agent', 'category_trend_spotter: no search terms — skipping');
    return { agent: 'category_trend_spotter', findings: [], summary: 'No search term data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'category_trend_spotter',
    mode:            mode,
    brainCategories: ['general', 'pmax', 'keywords'],
    brainLimit:      4,
    persona:
      'You are a senior Google Ads category trend analyst. You watch the rising ' +
      'edge of search intent — what queries are appearing that were not ' +
      'last quarter, what themes are decaying. You ground every recommendation in ' +
      'real numbers from the data and industry intelligence from the brain context. ' +
      'You never fabricate trends. If the data does not support a finding, you skip it.',
    instructions:
      'You are a senior PPC analyst. Every finding must include a specific number ' +
      'from the data as evidence (impression count, CTR %, spend amount, etc.). ' +
      'Do not write generic recommendations. If you cannot find evidence for a ' +
      'specific issue, do not invent one — return an empty findings array instead.\n\n' +
      'Account targets: TARGET_CPA=' + getConfig('TARGET_CPA', 50) + ', ' +
      'TARGET_ROAS=' + getConfig('TARGET_ROAS', 4.0) + '. Use these when reasoning about value.\n\n' +
      'Surface up to 4 TREND findings. Focus:\n' +
      '  1. Recently emerging query themes in our search-term mix that lack ' +
      '     dedicated ad groups → recommend creating them before competitors ' +
      '     do. Cite impression counts.\n' +
      '  2. Industry shifts visible in the brain (recent rss content) that ' +
      '     should inform near-term campaign strategy (e.g. a new ad format ' +
      '     or Smart Bidding behaviour change). Cite the brain source.\n' +
      '  3. Categories of intent that are softening (low CTR or CVR relative ' +
      '     to the account average). Cite the exact CTR/CVR numbers.\n' +
      '  4. Be honest: with one date window trend math is directional only. ' +
      '     Use confidence="medium" or "low" appropriately.\n\n' +
      'Use category="general" or "keywords" as appropriate. ' +
      'target.type = "campaign" or "adgroup".',
    data: { searchTerms, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _categoryTrendSpotterFormatData(d);
    },
  });
}

function _categoryTrendSpotterFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  // Top 50 by impressions = where attention is currently flowing.
  // Smaller cap keeps the prompt under ~5K tokens for the daily-quota-safe path.
  const top = d.searchTerms
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 50);

  lines.push(`Top ${top.length} search terms by IMPRESSIONS this window (proxy for current intent):`);
  lines.push('term | impressions | clicks | conv | ctr | spend | ad_group');
  for (const t of top) {
    const ctr = t.impressions > 0 ? (t.clicks / t.impressions * 100).toFixed(2) + '%' : 'n/a';
    lines.push(
      `"${t.term}" | ${t.impressions} | ${t.clicks} | ${t.conversions} | ${ctr} | ` +
      `${cur}${AgentCommon.micros(t.cost_micros).toFixed(2)} | ${t.ad_group_name}`
    );
  }

  lines.push('');
  lines.push('Note: a dedicated TrendsFetcher (Raw_Trends tab) is planned but not yet ' +
             'wired; use the BRAIN context (recent rss content) as the forward signal.');
  return lines.join('\n');
}

function testCategoryTrendSpotter() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'CategoryTrendSpotter dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runCategoryTrendSpotter({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 150)}`);
  }
}
