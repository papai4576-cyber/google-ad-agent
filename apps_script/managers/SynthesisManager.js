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

  // 2b. Cross-agent patterns — add synthesised findings after dedup.
  const patterns = _detectCrossAgentPatterns_(dedup.deduped, runDate);
  if (patterns.length > 0) {
    log_('synth_mgr', `Cross-agent patterns: ${patterns.length} new synthetic findings added.`);
    for (const p of patterns) log_('synth_mgr', `  [${p.severity}] ${p.title}`);
    dedup.deduped.push(...patterns);
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
 * Cross-agent pattern detection — runs after dedup, before scoring.
 * Generates synthetic P1 findings where multiple agents surface the same
 * root cause on the same entity from different angles.
 *
 * All findings at this point are flat Sheets rows with these key fields:
 *   agent, finding_id, target_type, target_id, target_name,
 *   impact_magnitude, confidence, effort, severity, evidence_json
 * ========================================================================= */
function _detectCrossAgentPatterns_(findings, runDate) {
  const out  = [];
  const date = runDate || todayString_();

  // Index: finding_id prefix → array of findings matching that prefix pattern.
  function byIdPrefix(agent, prefix) {
    return findings.filter(function(f) {
      return String(f.agent || '') === agent &&
             String(f.finding_id || '').indexOf(prefix) === 0;
    });
  }

  // ── Pattern 1: Rank-locked AND high CPA on the same campaign ─────────────
  // Bid raises will increase waste, not performance — structural fix required.
  const rankLocked = byIdPrefix('bid_budget_analyst', 'rank-locked-');
  const cpaOverage = byIdPrefix('performance_analyst', 'cpa-overage-');
  for (const rl of rankLocked) {
    const tid   = String(rl.target_id || '').trim();
    const match = cpaOverage.find(function(f) { return String(f.target_id || '').trim() === tid; });
    if (match) {
      out.push({
        finding_id:         'sp-rank-cpa-trap-' + tid,
        agent:              'synthesis_pattern',
        run_date:           date,
        mode:               rl.mode || 'daily',
        category:           'structure',
        severity:           'P1',
        title:              'Bid raises won\'t fix ' + (rl.target_name || tid) + ' — QS fix first',
        what:               'Campaign is both rank-locked (bids/QS too low for competitive auctions) AND over-target CPA. Raising bids here increases cost without winning better placements.',
        why:                'Rank IS loss driven by low QS means the issue is ad relevance or landing-page experience — not bid level. Adding budget into this state is waste.',
        action:             '1. Diagnose the QS root cause on the top-spend keywords in this campaign. 2. Fix ad relevance or landing page first. 3. Only re-evaluate bids once expected CTR component improves.',
        target_type:        rl.target_type || 'campaign',
        target_id:          tid,
        target_name:        rl.target_name || tid,
        impact_metric:      'CPA',
        impact_direction:   'down',
        impact_magnitude:   'high',
        confidence:         'high',
        effort:             'hard',
        evidence_json:      JSON.stringify(['rank-locked finding: ' + rl.finding_id, 'cpa-overage finding: ' + match.finding_id]),
        brain_sources_json: '[]',
      });
    }
  }

  // ── Pattern 2: Budget misallocation — idle donor + budget-locked receiver ─
  const idleBudget   = byIdPrefix('bid_budget_analyst', 'idle-budget-');
  const budgetLocked = byIdPrefix('bid_budget_analyst', 'budget-locked-');
  if (idleBudget.length > 0 && budgetLocked.length > 0) {
    const donors    = idleBudget.map(function(f)   { return f.target_name || f.target_id; }).join(', ');
    const receivers = budgetLocked.map(function(f) { return f.target_name || f.target_id; }).join(', ');
    out.push({
      finding_id:         'sp-budget-misalloc-' + date,
      agent:              'synthesis_pattern',
      run_date:           date,
      mode:               budgetLocked[0].mode || 'daily',
      category:           'performance',
      severity:           'P1',
      title:              'Budget misallocation: idle budget while other campaigns are starved',
      what:               'Budget sits under-spent on [' + donors + '] while [' + receivers + '] are budget-capped and losing impression share.',
      why:                'Moving budget from idle campaigns to budget-locked performers increases total conversions at the same total spend.',
      action:             'Move up to 20% of daily budget from idle campaign(s) to budget-locked campaign(s). Monitor IS and conversion rate for 7 days before further increases.',
      target_type:        'campaign',
      target_id:          budgetLocked[0].target_id || 'account',
      target_name:        'Multiple campaigns',
      impact_metric:      'conversions',
      impact_direction:   'up',
      impact_magnitude:   'high',
      confidence:         'medium',
      effort:             'easy',
      evidence_json:      JSON.stringify([
        'idle donors: ' + idleBudget.map(function(f) { return f.finding_id; }).join(', '),
        'budget-locked receivers: ' + budgetLocked.map(function(f) { return f.finding_id; }).join(', '),
      ]),
      brain_sources_json: '[]',
    });
  }

  // ── Pattern 3: Account-wide copy quality + QS expected-CTR drag ──────────
  // Low-CTR ads and below-average expected CTR keywords coexist → systemic.
  const lowCtrAds = findings.filter(function(f) {
    return String(f.agent || '') === 'ad_copy_critic' &&
           String(f.finding_id || '').indexOf('low-ctr-ad') === 0;
  });
  const lowExpCtrKws = findings.filter(function(f) {
    if (String(f.agent || '') !== 'quality_score_inspector') return false;
    var ev = String(f.evidence_json || '');
    return ev.indexOf('expCTR=BELOW_AVERAGE') >= 0;
  });
  if (lowCtrAds.length >= 2 && lowExpCtrKws.length >= 2) {
    out.push({
      finding_id:         'sp-copy-qs-systemic-' + date,
      agent:              'synthesis_pattern',
      run_date:           date,
      mode:               lowCtrAds[0].mode || 'daily',
      category:           'copy',
      severity:           'P1',
      title:              'Systemic copy quality issue: low-CTR ads driving below-average expected CTR',
      what:               lowCtrAds.length + ' ads have below-median CTR and ' + lowExpCtrKws.length + ' keywords show below-average expected CTR in QS — the same root cause across the account.',
      why:                'Expected CTR is the most changeable QS component and is primarily driven by ad copy. Fixing copy at scale improves CTR, QS, and CPC efficiency account-wide.',
      action:             '1. Prioritise AdCopyCritic recommendations for the flagged ads. 2. Aim to move Expected CTR component from Below Average to Average within 14 days. 3. Track QS sub-component distribution weekly.',
      target_type:        'account',
      target_id:          'account',
      target_name:        'Account-wide',
      impact_metric:      'CTR',
      impact_direction:   'up',
      impact_magnitude:   'high',
      confidence:         'medium',
      effort:             'medium',
      evidence_json:      JSON.stringify([
        lowCtrAds.length + ' low-CTR ads flagged by ad_copy_critic',
        lowExpCtrKws.length + ' keywords with expCTR=BELOW_AVERAGE',
        'sample ads: ' + lowCtrAds.slice(0, 3).map(function(f) { return f.finding_id; }).join(', '),
      ]),
      brain_sources_json: '[]',
    });
  }

  return out;
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
