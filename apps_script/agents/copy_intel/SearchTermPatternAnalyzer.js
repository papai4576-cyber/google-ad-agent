/**
 * SearchTermPatternAnalyzer.js — higher-level pattern analysis on search terms.
 *
 * Where KeywordMiner promotes individual converting terms and NegativeKwHunter
 * blocks individual wasters, this agent looks at the THEMES across the entire
 * search-term mix:
 *   - What intent buckets is the account showing up for?
 *   - Where is high-intent traffic flowing but landing in the wrong ad group?
 *   - Are there structural gaps (whole intent themes with no dedicated ad group)?
 *   - Are there cross-campaign leakage patterns (brand queries hitting non-brand)?
 *
 * Reads: Raw_SearchTerms (top by impressions, plus converters).
 * Brain categories queried: keywords, structure, audience.
 */

function runSearchTermPatternAnalyzer(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const searchTerms = AgentCommon.readSearchTerms();
  if (searchTerms.length === 0) {
    log_('agent', 'search_term_pattern_analyzer: no search terms — skipping');
    return { agent: 'search_term_pattern_analyzer', findings: [], summary: 'No search term data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'search_term_pattern_analyzer',
    mode:            mode,
    brainCategories: ['keywords', 'structure', 'audience'],
    brainLimit:      5,
    persona:
      'You are a Google Ads search-term theme analyst. You read large lists of ' +
      'search queries and identify the intent buckets, structural gaps, and ' +
      'cross-campaign leakage that no single-query analysis would catch.',
    instructions:
      'Analyze the search-term mix and surface up to 6 PATTERN findings. Focus:\n' +
      '  1. Intent buckets the account is winning vs losing on (e.g. "we get a ' +
      '     lot of commercial intent but almost no comparison intent").\n' +
      '  2. Structural gaps: high-volume intent theme with no dedicated ad group ' +
      '     → recommend creating one with tailored ads + LP.\n' +
      '  3. Cross-campaign leakage: brand terms hitting non-brand, generic terms ' +
      '     hitting brand, etc. → recommend tightening negatives or match types.\n' +
      '  4. Theme-level CTR/CVR outliers: a whole theme converting 3× the account ' +
      '     average → suggest doubling down (more budget, broader match types).\n' +
      '  5. Mismatch between ad group name and the queries hitting it → suggests ' +
      '     restructuring or renaming.\n\n' +
      'Be specific: name the theme (with 2-3 example queries), the affected ad ' +
      'group(s), and the structural change recommended.\n' +
      'Use category="structure" or "keywords" depending on the recommendation.\n' +
      'target.type = "campaign" or "adgroup". target.id = a representative real id.',
    data: { searchTerms, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _searchTermPatternFormatData(d);
    },
  });
}

function _searchTermPatternFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  // Top 150 by impressions — visibility into where attention flows.
  const topByImpressions = d.searchTerms
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 150);

  // Top 50 by conversions — what's actually working.
  const topConverters = d.searchTerms
    .filter(t => t.conversions > 0)
    .sort((a, b) => b.conversions - a.conversions)
    .slice(0, 50);

  lines.push(`Top 150 search terms by IMPRESSIONS:`);
  lines.push('term | impressions | clicks | spend | conv | ad_group | campaign');
  for (const t of topByImpressions) {
    lines.push(
      `"${t.term}" | ${t.impressions} | ${t.clicks} | ` +
      `${cur}${AgentCommon.micros(t.cost_micros).toFixed(2)} | ${t.conversions} | ` +
      `${t.ad_group_name} | ${t.campaign_name}`
    );
  }

  if (topConverters.length > 0) {
    lines.push('');
    lines.push(`Top ${topConverters.length} search terms by CONVERSIONS:`);
    lines.push('term | impressions | clicks | spend | conv | ad_group | campaign');
    for (const t of topConverters) {
      lines.push(
        `"${t.term}" | ${t.impressions} | ${t.clicks} | ` +
        `${cur}${AgentCommon.micros(t.cost_micros).toFixed(2)} | ${t.conversions} | ` +
        `${t.ad_group_name} | ${t.campaign_name}`
      );
    }
  }
  return lines.join('\n');
}

function testSearchTermPatternAnalyzer() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'SearchTermPatternAnalyzer dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runSearchTermPatternAnalyzer({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 200)}`);
  }
}

/**
 * Convenience runner for ALL Phase 7 agents. Single-click batch test.
 */
function testAuditBatch2() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'Audit Batch 2 — 4 copy/intel agents in sequence');
  log_('test', '═══════════════════════════════════════════');
  const t0 = Date.now();

  const fns = [
    ['AdCopyCritic',                  runAdCopyCritic],
    ['KeywordMiner',                  runKeywordMiner],
    ['NegativeKwHunter',              runNegativeKwHunter],
    ['SearchTermPatternAnalyzer',     runSearchTermPatternAnalyzer],
  ];

  let totalFindings = 0, totalTokens = 0;
  for (const [name, fn] of fns) {
    try {
      const r = fn({ mode: 'daily' });
      log_('test', `  [OK]   ${name.padEnd(32)} findings=${r.findings.length} tokens=${r.tokens || 0}`);
      totalFindings += r.findings.length;
      totalTokens   += r.tokens || 0;
    } catch (e) {
      log_('test', `  [FAIL] ${name.padEnd(32)} ${e.message || e}`);
    }
  }
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  log_('test', '');
  log_('test', `Batch complete: ${totalFindings} findings, ${totalTokens} tokens, ${seconds}s.`);
  log_('test', 'Check the Findings sheet for the new rows.');
}
