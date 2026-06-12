/**
 * CampaignDirector.js — top-level orchestrator for a full audit run.
 *
 * Per CLAUDE.md hierarchy this sits at the top and dispatches to the
 * specialised managers. For Phase 9 it covers:
 *   1. Pre-flight (do we have data? is Groq reachable?)
 *   2. AuditManager
 *   3. CopyIntelManager
 *
 * Phase 10 will add the SynthesisManager call after copy/intel.
 * Phase 11 will add the Slack gate after synthesis.
 * Phase 12 will add ImplementationManager after the gate.
 *
 * The director returns a single combined report any caller (cron trigger,
 * dashboard refresh, manual run) can rely on without knowing the inner
 * structure of each manager.
 */

function runCampaignDirector(opts) {
  const mode = (opts && opts.mode) || 'daily';
  const tStart = Date.now();

  // Pin ONE run_date for the whole run so every agent + synthesis agree, even
  // if the run crosses local midnight. Cleared in the finally-style block below.
  RUN_CONTEXT.run_date = todayString_();

  log_('director', '╔══════════════════════════════════════════════════════════════╗');
  log_('director', `║  Campaign Director — full ${mode} audit                       ║`);
  log_('director', '╚══════════════════════════════════════════════════════════════╝');

  // ── Pre-flight ──────────────────────────────────────────────────────
  let preflight;
  try {
    preflight = _directorPreflight_();
    if (preflight.errors.length) {
      log_('director', '');
      log_('director', 'PREFLIGHT FAILED:');
      for (const e of preflight.errors) log_('director', `  - ${e}`);
      log_('director', 'Aborting director run — fix the errors above and re-try.');
      return {
        ok:            false,
        stopped_at:    'preflight',
        preflight:     preflight,
        run_time_ms:   Date.now() - tStart,
      };
    }
  } catch (e) {
    log_('director', 'Pre-flight crashed: ' + (e.message || e));
    return {
      ok:          false,
      stopped_at:  'preflight',
      error:       String(e.message || e),
      run_time_ms: Date.now() - tStart,
    };
  }
  log_('director', `Pre-flight OK: ${preflight.note}`);
  log_('director', '');

  // ── Audit Manager ───────────────────────────────────────────────────
  const audit = runAuditManager({ mode: mode });

  // ── Copy & Intel Manager ────────────────────────────────────────────
  const copy_intel = runCopyIntelManager({ mode: mode });

  // ── Synthesis Manager (Phase 10) ────────────────────────────────────
  // Synthesis is pure-JS (no LLM) so it's safe to run even if some agents
  // hit their TPD ceiling. It synthesises whatever findings were written.
  let synthesis = null;
  try {
    synthesis = runSynthesisManager({ run_date: RUN_CONTEXT.run_date });
  } catch (e) {
    log_('director', `Synthesis failed: ${e.message || e}`);
    synthesis = { error: String(e.message || e) };
  }

  // ── Slack gate — post plan to Slack ────────────────────────────────
  let planSent = { auto_sent: 0, manual_digest_sent: 0, skipped: 0 };
  try {
    planSent = PlanSender.sendPlan(RUN_CONTEXT.run_date);
    log_('director',
      `Slack: ${planSent.auto_sent} auto item(s) posted for ✅/❌, ` +
      `manual digest sent=${planSent.manual_digest_sent}.`);
  } catch (e) {
    log_('director', `PlanSender skipped: ${String(e.message || e).slice(0, 120)}`);
  }

  // ── Token usage snapshot + dashboard refresh ────────────────────────
  // Pure-Sheet read/write, no LLM — safe even if agents hit their TPD cap.
  try {
    snapshotTokenUsageToSheet_();
    log_('director', `LLM usage today (UTC): groq=${tokensUsedToday('groq')} tok / ` +
                     `${requestsToday('groq')} req.`);
  } catch (e) {
    log_('director', `Token snapshot failed: ${e.message || e}`);
  }
  try {
    refreshDashboard();
  } catch (e) {
    log_('director', `Dashboard refresh failed: ${e.message || e}`);
  }

  // ── Aggregate ────────────────────────────────────────────────────────
  const totalMs = Date.now() - tStart;
  const totalFindings = audit.total_findings + copy_intel.total_findings;
  const totalTokens   = audit.total_tokens   + copy_intel.total_tokens;
  const totalFailures = audit.agents_failed  + copy_intel.agents_failed;
  const agentsRun     = audit.agents_run     + copy_intel.agents_run;
  const agentsTotal   = audit.agents_total   + copy_intel.agents_total;

  log_('director', '');
  log_('director', '╔══════════════════════════════════════════════════════════════╗');
  log_('director', `║  Director summary                                            ║`);
  log_('director', '╚══════════════════════════════════════════════════════════════╝');
  log_('director', `  agents:    ${agentsRun}/${agentsTotal} ran, ${totalFailures} failed`);
  log_('director', `  findings:  ${totalFindings} written this run`);
  log_('director', `  tokens:    ${totalTokens}`);
  if (synthesis && !synthesis.error) {
    log_('director', `  plan:      ${synthesis.written} action items ` +
                     `(P1=${synthesis.p1}, P2=${synthesis.p2}, P3=${synthesis.p3})`);
  }
  log_('director', `  duration:  ${Math.round(totalMs / 100) / 10}s`);
  log_('director', '');
  log_('director',
    `Slack gate active — ${planSent.auto_sent} auto item(s) await ✅/❌; ` +
    `manual digest posted=${planSent.manual_digest_sent}.`);

  const pinnedRunDate = RUN_CONTEXT.run_date;
  RUN_CONTEXT.run_date = null;   // release the run-scoped date pin

  return {
    ok:             totalFailures === 0,
    stopped_at:     null,
    mode:           mode,
    preflight:      preflight,
    audit:          audit,
    copy_intel:     copy_intel,
    synthesis:      synthesis,
    total_findings: totalFindings,
    total_tokens:   totalTokens,
    total_failures: totalFailures,
    run_time_ms:    totalMs,
  };
}

/* ===========================================================================
 * Pre-flight checks — refuse to run if the inputs aren't there.
 * ========================================================================= */
function _directorPreflight_() {
  const errors = [];
  let campaignCount = 0;
  let brainCount = 0;

  // 1. Required Script Properties
  for (const key of ['SPREADSHEET_ID', 'GROQ_API_KEY']) {
    if (!PROPS.get(key)) errors.push(`Script Property ${key} is not set.`);
  }

  // 2. Sheet has data?
  try {
    const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
    const camp = ss.getSheetByName('Raw_Campaigns');
    if (!camp) {
      errors.push('Raw_Campaigns tab missing. Re-run setupEverything().');
    } else {
      const last = camp.getLastRow();
      campaignCount = Math.max(0, last - 1);
      if (campaignCount === 0) {
        errors.push('Raw_Campaigns is empty. Run the Google Ads Script in ' +
                    'collect mode first to populate the Raw_* tabs.');
      }
    }
    const findings = ss.getSheetByName('Findings');
    if (!findings) {
      errors.push('Findings tab missing. Re-run setupEverything().');
    }
  } catch (e) {
    errors.push('Spreadsheet access failed: ' + String(e.message || e));
  }

  // 3. Brain count (informational only — empty Brain is allowed, just noted)
  try {
    brainCount = BrainStore.count();
  } catch (_e) { brainCount = 0; }

  return {
    errors:         errors,
    campaign_count: campaignCount,
    brain_count:    brainCount,
    note:           `${campaignCount} campaigns in Raw_Campaigns, ${brainCount} Brain entries.`,
  };
}

function testCampaignDirector() {
  const r = runCampaignDirector({ mode: 'daily' });
  log_('test', '');
  log_('test', `Director result: ok=${r.ok}, ` +
              `findings=${r.total_findings || 0}, ` +
              `failures=${r.total_failures || 0}, ` +
              `${Math.round((r.run_time_ms || 0) / 100) / 10}s`);
}
