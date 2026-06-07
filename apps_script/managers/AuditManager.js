/**
 * AuditManager.js — runs the 7 audit agents in sequence and reports.
 *
 * Per CLAUDE.md hierarchy:
 *   Audit Manager → [Performance, Bid/Budget, QS, Conversion,
 *                    Audience, Structure, Extensions]
 *
 * The manager is pure orchestration — every agent makes its own LLM call.
 * Sequential (not parallel) because Apps Script doesn't have real
 * concurrency for UrlFetchApp and Groq's 30 RPM cap is the real bottleneck
 * anyway. Per-agent try/catch so one failure does not abort the batch.
 *
 * Returns a structured summary the Campaign Director (and later the
 * Dashboard) can consume.
 */

const AUDIT_AGENTS = [
  ['performance_analyst',        function (o) { return runPerformanceAnalyst(o); }],
  ['bid_budget_analyst',         function (o) { return runBidBudgetAnalyst(o); }],
  ['quality_score_inspector',    function (o) { return runQualityScoreInspector(o); }],
  ['conversion_health_checker',  function (o) { return runConversionHealthChecker(o); }],
  ['audience_analyst',           function (o) { return runAudienceAnalyst(o); }],
  ['account_structure_reviewer', function (o) { return runAccountStructureReviewer(o); }],
  ['extension_auditor',          function (o) { return runExtensionAuditor(o); }],
];

function runAuditManager(opts) {
  const mode = (opts && opts.mode) || 'daily';
  const tStart = Date.now();

  log_('audit_mgr', '═══════════════════════════════════════════');
  log_('audit_mgr', `AuditManager starting (mode=${mode}, ${AUDIT_AGENTS.length} agents)`);
  log_('audit_mgr', '═══════════════════════════════════════════');

  const results = [];
  let totalFindings = 0;
  let totalTokens   = 0;
  let totalDropped  = 0;
  let failures      = 0;

  for (const [name, fn] of AUDIT_AGENTS) {
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
      log_('audit_mgr',
        `  [OK]   ${name.padEnd(28)} findings=${r.findings.length} ` +
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
      log_('audit_mgr', `  [FAIL] ${name.padEnd(28)} ${errMsg}`);
      // If we hit the daily token cap, stop running more agents — they'll
      // all fail the same way and just burn wall time.
      if (/daily token limit|tokens per day/i.test(errMsg)) {
        log_('audit_mgr', '  Daily TPD reached — aborting remaining audit agents.');
        break;
      }
    }
  }

  const totalMs = Date.now() - tStart;
  const summary = {
    manager:        'audit',
    mode:           mode,
    agents_total:   AUDIT_AGENTS.length,
    agents_run:     results.length,
    agents_failed:  failures,
    total_findings: totalFindings,
    total_dropped:  totalDropped,
    total_tokens:   totalTokens,
    run_time_ms:    totalMs,
    results:        results,
  };

  log_('audit_mgr', '');
  log_('audit_mgr',
    `AuditManager done — findings=${totalFindings}, ` +
    `dropped=${totalDropped}, tokens=${totalTokens}, ` +
    `failures=${failures}/${AUDIT_AGENTS.length}, ${Math.round(totalMs / 100) / 10}s`);
  return summary;
}

function testAuditManager() {
  const r = runAuditManager({ mode: 'daily' });
  log_('test', '');
  log_('test', `Result: findings=${r.total_findings}, ` +
              `failures=${r.agents_failed}/${r.agents_total}, ` +
              `tokens=${r.total_tokens}, ${Math.round(r.run_time_ms / 100) / 10}s`);
}
