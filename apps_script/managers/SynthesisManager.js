/**
 * SynthesisManager.js — turns the Findings tab into the Action_Plan tab.
 *
 * The pipeline:
 *   1. Read findings rows for the requested run_date (default today)
 *   2. Dedup (DeduplicationAgent)
 *   3. Score + assign priority (ImpactScorer)
 *   4. Write Action_Plan rows (PlanFormatter)
 *
 * Zero LLM calls. Pure Sheet-to-Sheet transformation. Fast.
 *
 * Designed to be re-runnable: PlanFormatter replaces all rows for run_date
 * each time, so you can re-synthesise after adding more findings without
 * worrying about duplicate plan rows.
 */

function runSynthesisManager(opts) {
  const runDate = (opts && opts.run_date) || todayString_();
  const tStart = Date.now();

  log_('synth_mgr', '═══════════════════════════════════════════');
  log_('synth_mgr', `SynthesisManager starting (run_date=${runDate})`);
  log_('synth_mgr', '═══════════════════════════════════════════');

  // 1. Read findings for the run_date.
  const findings = _readFindingsForDate_(runDate);
  log_('synth_mgr', `Read ${findings.length} findings rows from Findings tab.`);
  if (findings.length === 0) {
    log_('synth_mgr', 'No findings to synthesise. Did you run CampaignDirector first?');
    return {
      manager:        'synthesis',
      run_date:       runDate,
      input:          0,
      deduped:        0,
      written:        0,
      cleared:        0,
      p1:             0,
      p2:             0,
      p3:             0,
      run_time_ms:    Date.now() - tStart,
    };
  }

  // 2. Dedup.
  const dedup = Dedup.run(findings);
  log_('synth_mgr',
    `Dedup: ${dedup.stats.input} → ${dedup.stats.kept} ` +
    `(${dedup.stats.merged} merged into others).`);
  for (const m of dedup.merge_log.slice(0, 5)) {
    log_('synth_mgr', `  merged ${m.merged_finding_ids.join(', ')} → ${m.primary_finding_id}`);
  }

  // 3. Score + assign priority.
  const score = ImpactScorer.run(dedup.deduped);
  log_('synth_mgr',
    `Score: P1=${score.stats.p1}, P2=${score.stats.p2}, P3=${score.stats.p3} ` +
    `(${score.stats.overrides} severity overrides vs LLM labels).`);

  // 4. Format + write to Action_Plan.
  const plan = PlanFormatter.run(score.scored, runDate);
  log_('synth_mgr',
    `Wrote ${plan.written} Action_Plan rows (cleared ${plan.cleared} old rows for ${runDate}).`);

  const totalMs = Date.now() - tStart;
  log_('synth_mgr', '');
  log_('synth_mgr', `SynthesisManager done in ${Math.round(totalMs / 100) / 10}s.`);

  return {
    manager:        'synthesis',
    run_date:       runDate,
    input:          findings.length,
    deduped:        dedup.stats.kept,
    merged:         dedup.stats.merged,
    written:        plan.written,
    cleared:        plan.cleared,
    p1:             score.stats.p1,
    p2:             score.stats.p2,
    p3:             score.stats.p3,
    severity_overrides: score.stats.overrides,
    run_time_ms:    totalMs,
  };
}

/* ===========================================================================
 * Read findings from the Findings sheet for a given run_date.
 * ========================================================================= */
function _readFindingsForDate_(runDate) {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const sheet = ss.getSheetByName('Findings');
  if (!sheet) throw new Error('Findings sheet missing. Run setupEverything().');

  const last = sheet.getLastRow();
  if (last < 2) return [];

  const headers = SHEETS.Findings.headers;
  const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  const runDateIdx = headers.indexOf('run_date');

  const out = [];
  for (const row of data) {
    // Normalise the date — Sheets sometimes parses YYYY-MM-DD as a Date object.
    let rd = row[runDateIdx];
    if (rd instanceof Date) {
      rd = Utilities.formatDate(rd, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } else {
      rd = String(rd).trim();
    }
    if (rd !== runDate) continue;

    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
    out.push(obj);
  }
  return out;
}

/* ===========================================================================
 * Convenience tests.
 * ========================================================================= */

function testSynthesisManager() {
  const r = runSynthesisManager();
  log_('test', '');
  log_('test',
    `Synthesised: input=${r.input}, deduped=${r.deduped}, ` +
    `P1=${r.p1}, P2=${r.p2}, P3=${r.p3}, written=${r.written}.`);
}

/**
 * Run synthesis on a specific historical date. Useful for testing on past
 * findings (e.g. yesterday's 74-row test data).
 *
 * Usage from the editor:
 *   - Edit the date below, save, run testSynthesisOnDate.
 */
function testSynthesisOnDate() {
  // EDIT THIS LINE to the date you want to synthesise.
  const runDate = '2026-06-03';
  const r = runSynthesisManager({ run_date: runDate });
  log_('test', '');
  log_('test',
    `Synthesised ${runDate}: input=${r.input}, deduped=${r.deduped}, ` +
    `P1=${r.p1}, P2=${r.p2}, P3=${r.p3}, written=${r.written}.`);
}
