/**
 * KeywordMiner.js — finds converting search terms that should be promoted
 * to exact-match keywords for control + improved Quality Score.
 *
 * Domain: gap between what searchers actually type (Raw_SearchTerms) and
 * what we explicitly bid on (Raw_Keywords).
 *
 * Logic:
 *   1. Pre-filter search terms with conversions > 0.
 *   2. Cross-reference against keywords: is this term already an exact-match
 *      keyword somewhere? If yes, skip.
 *   3. Pre-filter to terms with at least 2 conversions OR conversion_value > 0
 *      to avoid promoting single-conversion noise.
 *   4. Send the top 100 to the LLM — it picks the most worth-promoting set
 *      and groups by ad group.
 *
 * Reads: Raw_SearchTerms + Raw_Keywords.
 * Brain categories queried: keywords, copy.
 */

function runKeywordMiner(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const searchTerms = AgentCommon.readSearchTerms();
  const keywords    = AgentCommon.readKeywords();
  if (searchTerms.length === 0) {
    log_('agent', 'keyword_miner: no search terms — skipping');
    return { agent: 'keyword_miner', findings: [], summary: 'No search term data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'keyword_miner',
    mode:            mode,
    brainCategories: ['keywords', 'copy', 'structure'],
    brainLimit:      5,
    persona:
      'You are a Google Ads search-term harvesting specialist. You spot ' +
      'high-converting search terms that are not yet exact-match keywords ' +
      'and promote them — gaining bid control and lower CPCs via the ' +
      'exact-match keyword bonus to Quality Score.',
    instructions:
      'Analyze the candidate search terms and surface up to 6 KEYWORD-MINING ' +
      'findings. For each finding, group several related terms into one ' +
      'recommendation per ad group:\n' +
      '  - Identify a coherent intent cluster (3-15 search terms that share theme).\n' +
      '  - Pick the right ad group (use ad_group_id of the term that earned them).\n' +
      '  - In the `action` field, list the EXACT keywords to add (with [exact] ' +
      '    brackets in your text), plus suggested starting bid (no more than +30% ' +
      '    of the ad group default per the safety rail in CLAUDE.md).\n\n' +
      'Skip terms with only 1 conversion AND conversion_value = 0 — too noisy.\n' +
      'Use category="keywords", target.type="adgroup". ' +
      'Severity guide: P1 if combined cluster value > 5 conversions or ' +
      'cost > 5× target_cpa.',
    data: { searchTerms, keywords, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _keywordMinerFormatData(d);
    },
  });
}

function _keywordMinerFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  // Build set of existing exact-match keyword texts (lowercased).
  const exactSet = new Set();
  for (const k of d.keywords) {
    if (String(k.match_type).toUpperCase() === 'EXACT') {
      exactSet.add(String(k.text || '').toLowerCase().trim());
    }
  }

  // Pre-filter: converting terms not already exact, with meaningful signal.
  const candidates = d.searchTerms.filter(t => {
    if (t.conversions <= 0) return false;
    if (t.conversions === 1 && t.cost_micros < 50000000) return false;
    const key = String(t.term || '').toLowerCase().trim();
    return !exactSet.has(key);
  });

  const top = candidates
    .sort((a, b) => b.conversions - a.conversions || b.cost_micros - a.cost_micros)
    .slice(0, 35);

  lines.push(`Promotable search terms (converting, not yet exact-match): ${candidates.length} total`);
  lines.push(`Showing top ${top.length} by conversions:`);
  lines.push('term | clicks | spend | conversions | ad_group_id | ad_group');
  for (const t of top) {
    lines.push(
      `"${t.term}" | ${t.clicks} | ` +
      `${cur}${AgentCommon.micros(t.cost_micros).toFixed(2)} | ${t.conversions} | ` +
      `${t.ad_group_id} | ${t.ad_group_name}`
    );
  }
  if (top.length === 0) {
    lines.push('');
    lines.push('No promotable search terms this period (no converting terms outside exact match).');
  }
  return lines.join('\n');
}

function testKeywordMiner() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'KeywordMiner dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runKeywordMiner({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 200)}`);
  }
}
