/**
 * CopyIntelManager.js — runs the 7 copy/intel agents in sequence.
 *
 * Per CLAUDE.md hierarchy:
 *   Copy & Intel Manager → [Copy critic, KW miner, Negative KW,
 *                            Search terms, Competitive, Trends, Landing page]
 *
 * Mirrors AuditManager: pure orchestration, sequential, per-agent error
 * isolation, daily-TPD-aware early bail.
 */

const COPY_INTEL_AGENTS = [
  ['ad_copy_critic',                function (o) { return runAdCopyCritic(o); }],
  ['keyword_miner',                 function (o) { return runKeywordMiner(o); }],
  ['negative_kw_hunter',            function (o) { return runNegativeKwHunter(o); }],
  ['search_term_pattern_analyzer',  function (o) { return runSearchTermPatternAnalyzer(o); }],
  ['competitive_intel',             function (o) { return runCompetitiveIntel(o); }],
  ['category_trend_spotter',        function (o) { return runCategoryTrendSpotter(o); }],
  ['landing_page_scorer',           function (o) { return runLandingPageScorer(o); }],
];

function runCopyIntelManager(opts) {
  const mode = (opts && opts.mode) || 'daily';
  const tStart = Date.now();

  log_('copy_mgr', '═══════════════════════════════════════════');
  log_('copy_mgr', `CopyIntelManager starting (mode=${mode}, ${COPY_INTEL_AGENTS.length} agents)`);
  log_('copy_mgr', '═══════════════════════════════════════════');

  const results = [];
  let totalFindings = 0;
  let totalTokens   = 0;
  let totalDropped  = 0;
  let failures      = 0;

  for (const [name, fn] of COPY_INTEL_AGENTS) {
    const tAgent = Date.now();
    try {
      const r = fn({ mode: mode });
      const ms = Date.now() - tAgent;
      results.push({
        agent:        name,
        ok:           true,
        findings:     r.findings.length,
        written:      r.written || r.findings.length,
        dropped:      r.dropped || 0,
        tokens:       r.tokens  || 0,
        summary:      r.summary || '',
        run_time_ms:  ms,
      });
      totalFindings += r.findings.length;
      totalTokens   += r.tokens   || 0;
      totalDropped  += r.dropped  || 0;
      log_('copy_mgr',
        `  [OK]   ${name.padEnd(32)} findings=${r.findings.length} ` +
        `dropped=${r.dropped || 0} tokens=${r.tokens || 0} ${ms}ms`);
    } catch (e) {
      failures++;
      const errMsg = String(e.message || e).slice(0, 300);
      results.push({
        agent:       name,
        ok:          false,
        error:       errMsg,
        run_time_ms: Date.now() - tAgent,
      });
      log_('copy_mgr', `  [FAIL] ${name.padEnd(32)} ${errMsg}`);
      if (/daily token limit|tokens per day/i.test(errMsg)) {
        log_('copy_mgr', '  Daily TPD reached — aborting remaining copy/intel agents.');
        break;
      }
    }
  }

  const totalMs = Date.now() - tStart;
  const summary = {
    manager:        'copy_intel',
    mode:           mode,
    agents_total:   COPY_INTEL_AGENTS.length,
    agents_run:     results.length,
    agents_failed:  failures,
    total_findings: totalFindings,
    total_dropped:  totalDropped,
    total_tokens:   totalTokens,
    run_time_ms:    totalMs,
    results:        results,
  };

  log_('copy_mgr', '');
  log_('copy_mgr',
    `CopyIntelManager done — findings=${totalFindings}, ` +
    `dropped=${totalDropped}, tokens=${totalTokens}, ` +
    `failures=${failures}/${COPY_INTEL_AGENTS.length}, ${Math.round(totalMs / 100) / 10}s`);
  return summary;
}

function testCopyIntelManager() {
  const r = runCopyIntelManager({ mode: 'daily' });
  log_('test', '');
  log_('test', `Result: findings=${r.total_findings}, ` +
              `failures=${r.agents_failed}/${r.agents_total}, ` +
              `tokens=${r.total_tokens}, ${Math.round(r.run_time_ms / 100) / 10}s`);
}
