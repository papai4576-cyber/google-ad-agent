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
      'You are a senior Google Ads search-term theme analyst. You read large lists ' +
      'of search queries and identify the intent buckets, structural gaps, and ' +
      'cross-campaign leakage that no single-query analysis would catch. You anchor ' +
      'every finding in real query counts, impression numbers, or CVR figures from ' +
      'the data — never in assumptions or industry averages.',
    instructions:
      'You are a senior PPC analyst. Every finding must include a specific number ' +
      'from the data as evidence (impression count, CTR %, conversion count, spend). ' +
      'Name at least 2 real example queries from the data per finding. ' +
      'Do not write generic recommendations. If you cannot find evidence for a ' +
      'specific issue, do not invent one — return an empty findings array instead.\n\n' +
      'Account targets: TARGET_CPA=' + getConfig('TARGET_CPA', 50) + ', ' +
      'TARGET_ROAS=' + getConfig('TARGET_ROAS', 4.0) + '. Use these when ' +
      'prioritising which intent gaps are worth capturing.\n\n' +
      'Analyze the search-term mix and surface up to 6 PATTERN findings. Focus:\n' +
      '  1. Intent buckets the account is winning vs losing on. Cite impression ' +
      '     counts for each bucket to show relative volume.\n' +
      '  2. Structural gaps: high-volume intent theme with no dedicated ad group ' +
      '     → name the theme, cite total impressions, recommend creating the ad group.\n' +
      '  3. Cross-campaign leakage: brand terms hitting non-brand, or vice versa. ' +
      '     Cite impression count for the leaked terms.\n' +
      '  4. Theme-level CVR outliers: a cluster of queries converting at >2× the ' +
      '     average → cite the CVR and recommend budget reallocation.\n' +
      '  5. Mismatch between ad group name and dominant queries hitting it. Cite ' +
      '     the top 2-3 mismatched queries.\n\n' +
      'Use category="structure" or "keywords" depending on the recommendation. ' +
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

  // Trimmed caps — enough breadth to spot themes while staying well under
  // Groq's per-minute token ceiling (which was forcing 30s rate-limit sleeps).
  const TOP_BY_IMPRESSIONS = 40;
  const TOP_CONVERTERS = 20;

  const topByImpressions = d.searchTerms
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, TOP_BY_IMPRESSIONS);

  const topConverters = d.searchTerms
    .filter(t => t.conversions > 0)
    .sort((a, b) => b.conversions - a.conversions)
    .slice(0, TOP_CONVERTERS);

  lines.push(`Top ${topByImpressions.length} search terms by IMPRESSIONS:`);
  lines.push('term | impressions | clicks | conv | ad_group');
  for (const t of topByImpressions) {
    lines.push(
      `"${t.term}" | ${t.impressions} | ${t.clicks} | ${t.conversions} | ${t.ad_group_name}`
    );
  }

  if (topConverters.length > 0) {
    lines.push('');
    lines.push(`Top ${topConverters.length} search terms by CONVERSIONS:`);
    lines.push('term | impressions | clicks | conv | ad_group');
    for (const t of topConverters) {
      lines.push(
        `"${t.term}" | ${t.impressions} | ${t.clicks} | ${t.conversions} | ${t.ad_group_name}`
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
