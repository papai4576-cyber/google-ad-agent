/**
 * ImplementationManager.js — the WRITE side (Phase 12).  *** DRY_RUN-FIRST ***
 *
 * Turns APPROVED Action_Plan items into structured, rail-validated changes and
 * queues them for the Google Ads Script (execute mode) to apply. NOTHING here
 * mutates the account directly — Apps Script can't (Workspace OAuth). It only:
 *   1. Reads approvals (the SACRED gate — no change is queued without one).
 *   2. Derives a concrete change from each approved item + live data.
 *   3. Validates every change against the NON-NEGOTIABLE safety rails.
 *   4. In DRY_RUN: logs the intended change to Change_Log, queues nothing.
 *      Live:        writes the change to Pending_Changes (status=queued) for
 *                   the Ads Script to pull, apply, and report back.
 *
 * Approval source (Phase-12 manual mode): set a row's `status` to "approved"
 * (or "rejected") in the Action_Plan tab — _ingestManualApprovals_ mirrors that
 * into the Approvals tab so the gate stays canonical and Slack-ready. You can
 * also call approvePlan('plan_..') / rejectPlan('plan_..') from the editor.
 *
 * Increment 1 derivers: add_negatives, adjust_budget (both reversible & derived
 * deterministically from live data). Bid adjustments + keyword pausing land in
 * increment 2 (they return [] here, logged as skipped — never an unsafe guess).
 */

function runImplementationManager(opts) {
  const tStart = Date.now();
  const dryRun = isDryRun();

  log_('impl_mgr', '═══════════════════════════════════════════');
  log_('impl_mgr', `ImplementationManager — ${dryRun ? 'DRY RUN (no mutations)' : 'LIVE'}`);
  log_('impl_mgr', '═══════════════════════════════════════════');

  // 1. Mirror any manual Action_Plan approvals into the Approvals tab.
  const ingested = _ingestManualApprovals_();
  if (ingested.added) log_('impl_mgr', `Mirrored ${ingested.added} manual approval(s) into Approvals.`);

  // 2. Approved + not-yet-actioned plan items, enriched with agent/category.
  const items = _readApprovedPlanItems_();
  log_('impl_mgr', `${items.length} approved plan item(s) to action.`);
  if (items.length === 0) {
    return { manager: 'implementation', dry_run: dryRun, approved: 0, queued: 0, skipped: 0, changes: [], run_time_ms: Date.now() - tStart };
  }

  // Live context for derivation + validation.
  const ctx = {
    campaigns:    AgentCommon.readCampaigns(),
    searchTerms:  AgentCommon.readSearchTerms(),
    negatives:    AgentCommon.readNegativeKeywords(),
    targets:      AgentCommon.getTargets(),
    maxBudgetPct: parseFloat(getConfig('MAX_BUDGET_SHIFT_PCT', '0.20')) || 0.20,
    maxBidPct:    parseFloat(getConfig('MAX_BID_CHANGE_PCT', '0.30')) || 0.30,
    maxNegatives: parseFloat(getConfig('NEGATIVE_MAX_PER_RUN', '20')) || 20,
  };

  // 3+4. Derive → validate → queue/log.
  const queued = [];
  let skipped = 0, seq = 0;
  for (const item of items) {
    let changes;
    try { changes = _deriveChanges_(item, ctx); }
    catch (e) { changes = []; log_('impl_mgr', `  derive failed for ${item.plan_id}: ${e.message || e}`); }

    if (!changes.length) {
      skipped++;
      log_('impl_mgr', `  [skip] ${item.plan_id} (${item.agent || '?'}/${item.category || '?'}) — no v1 deriver`);
      continue;
    }
    for (const ch of changes) {
      const v = _validateChange_(ch, ctx);
      if (!v.ok) { skipped++; log_('impl_mgr', `  [reject] ${item.plan_id} ${ch.change_type}: ${v.reason}`); continue; }
      ch.change_id = 'chg_' + Date.now() + '_' + (++seq);
      ch.plan_id = item.plan_id; ch.finding_id = item.finding_id; ch.run_date = todayString_();
      ch.dry_run = dryRun;
      _persistChange_(ch, dryRun);
      queued.push(ch);
      log_('impl_mgr', `  [${dryRun ? 'dry-run' : 'queued'}] ${ch.change_type} on ${ch.target_type} ` +
                       `"${ch.target_name}" : ${ch.before_value} → ${ch.after_value}`);
      try { ChangeReporter.reportChange(ch); } catch (_e) {}
    }
  }

  const ms = Date.now() - tStart;
  log_('impl_mgr', '');
  log_('impl_mgr', `Done — ${queued.length} change(s) ${dryRun ? 'logged (DRY RUN)' : 'queued for the Ads Script'}, ` +
                   `${skipped} skipped, ${Math.round(ms / 100) / 10}s.`);
  if (dryRun) log_('impl_mgr', 'DRY_RUN=true in Config. Review Change_Log, then set DRY_RUN=false to allow execution.');
  return { manager: 'implementation', dry_run: dryRun, approved: items.length, queued: queued.length, skipped: skipped, changes: queued, run_time_ms: ms };
}

/* ===========================================================================
 * Derivers — approved item + live data → concrete change(s).
 * ========================================================================= */

function _deriveChanges_(item, ctx) {
  const agent = String(item.agent || '');
  const cat   = String(item.category || '');
  const fid   = String(item.finding_id || '');

  // ── adjust_budget: budget-capped campaigns get a capped increase ──────
  if (fid.indexOf('budget-locked-') === 0 || (cat === 'performance' && /budget/i.test(item.title || ''))) {
    const camp = ctx.campaigns.filter(c => String(c.campaign_id) === String(item.target_id))[0];
    if (!camp) return [];
    const before = AgentCommon.micros(camp.budget_micros);
    if (before <= 0) return [];
    const after = Math.round(before * (1 + ctx.maxBudgetPct) * 100) / 100;
    return [{
      change_type: 'adjust_budget', target_type: 'campaign',
      target_id: String(camp.campaign_id), target_name: camp.campaign_name,
      field: 'daily_budget', before_value: String(before), after_value: String(after),
      params: { new_budget_micros: Math.round(after * 1e6) },
    }];
  }

  // ── add_negatives: derive exact wasteful terms in the approved scope ───
  if (agent === 'negative_kw_hunter' || cat === 'keywords' && /negat/i.test(item.title || '')) {
    return _deriveNegatives_(item, ctx);
  }

  // bid adjustments + keyword pausing → increment 2.
  return [];
}

function _deriveNegatives_(item, ctx) {
  const minWaste = parseFloat(getConfig('NEGATIVE_KW_MIN_WASTE', '50')) || 50;
  const scopeIsAdGroup = String(item.target_type) === 'adgroup';
  const isBlocked = _buildNegativeMatcher_(ctx.negatives);

  const inScope = ctx.searchTerms.filter(t => {
    if (t.conversions !== 0) return false;
    if (AgentCommon.micros(t.cost_micros) < minWaste) return false;
    if (scopeIsAdGroup) return String(t.ad_group_id) === String(item.target_id);
    return String(t.campaign_id) === String(item.target_id);
  });

  const candidates = inScope
    .filter(t => !isBlocked(t))
    .sort((a, b) => b.cost_micros - a.cost_micros)
    .slice(0, ctx.maxNegatives);

  return candidates.map(t => ({
    change_type: 'add_negative',
    target_type: scopeIsAdGroup ? 'adgroup' : 'campaign',
    target_id: String(scopeIsAdGroup ? item.target_id : (t.campaign_id || item.target_id)),
    target_name: item.target_name,
    field: 'negative_keyword',
    before_value: '(not blocked)',
    after_value: '-"' + String(t.term).trim() + '"  (phrase)',
    params: { term: String(t.term).trim(), match_type: 'PHRASE', scope: scopeIsAdGroup ? 'ad_group' : 'campaign' },
  }));
}

/* ===========================================================================
 * Safety rails — NON-NEGOTIABLE. Reject (never silently clamp past a cap).
 * ========================================================================= */

function _validateChange_(ch, ctx) {
  if (ch.change_type === 'adjust_budget') {
    const before = parseFloat(ch.before_value) || 0;
    const after  = parseFloat(ch.after_value) || 0;
    if (before <= 0) return { ok: false, reason: 'no current budget' };
    const pct = Math.abs(after - before) / before;
    if (pct > ctx.maxBudgetPct + 1e-9) return { ok: false, reason: `budget shift ${(pct * 100).toFixed(0)}% > cap ${(ctx.maxBudgetPct * 100)}%` };
    return { ok: true };
  }
  if (ch.change_type === 'add_negative') {
    if (!ch.params || !ch.params.term) return { ok: false, reason: 'empty term' };
    return { ok: true };
  }
  if (ch.change_type === 'adjust_bid') {
    const before = parseFloat(ch.before_value) || 0;
    const after  = parseFloat(ch.after_value) || 0;
    if (before <= 0) return { ok: false, reason: 'no current bid' };
    const pct = Math.abs(after - before) / before;
    if (pct > ctx.maxBidPct + 1e-9) return { ok: false, reason: `bid change ${(pct * 100).toFixed(0)}% > cap ${(ctx.maxBidPct * 100)}%` };
    return { ok: true };
  }
  // Unknown type or anything that would DELETE → reject.
  return { ok: false, reason: 'unsupported change type ' + ch.change_type };
}

/* ===========================================================================
 * Persistence — Pending_Changes queue + Change_Log audit.
 * ========================================================================= */

function _persistChange_(ch, dryRun) {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const pend = ss.getSheetByName('Pending_Changes');
  if (pend) {
    const h = SHEETS.Pending_Changes.headers;
    const map = {
      change_id: ch.change_id, created_at: nowIso_(), run_date: ch.run_date,
      plan_id: ch.plan_id, finding_id: ch.finding_id, change_type: ch.change_type,
      target_type: ch.target_type, target_id: ch.target_id, target_name: ch.target_name,
      field: ch.field, before_value: ch.before_value, after_value: ch.after_value,
      status: dryRun ? 'dry_run' : 'queued', dry_run: dryRun, executed_at: '', result: '', error: '',
    };
    // stash params in the result column as JSON so the Ads Script can read them
    map.result = JSON.stringify(ch.params || {});
    pend.appendRow(h.map(k => (map[k] !== undefined ? map[k] : '')));
  }
  // In DRY_RUN we also write the audit row immediately (simulated success).
  if (dryRun) _appendChangeLog_(ch, true, true, '');
}

function _appendChangeLog_(ch, dryRun, success, errMsg) {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const log = ss.getSheetByName('Change_Log');
  if (!log) return;
  const h = SHEETS.Change_Log.headers;
  const map = {
    timestamp: nowIso_(), plan_id: ch.plan_id, finding_id: ch.finding_id, agent: 'implementation_manager',
    target_type: ch.target_type, target_id: ch.target_id, target_name: ch.target_name,
    field_changed: ch.field, before_value: ch.before_value, after_value: ch.after_value,
    dry_run: dryRun, success: success, error_message: errMsg || '',
  };
  log.appendRow(h.map(k => (map[k] !== undefined ? map[k] : '')));
}

/* ===========================================================================
 * Approval gate — read + manual mirror.
 * ========================================================================= */

function _ingestManualApprovals_() {
  const plan = _readTab_('Action_Plan');
  const appr = _readTab_('Approvals');
  const known = {};
  for (const a of appr) known[String(a.plan_id) + '::' + String(a.status).toLowerCase()] = true;

  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const sheet = ss.getSheetByName('Approvals');
  if (!sheet) return { added: 0 };
  const h = SHEETS.Approvals.headers;

  let added = 0;
  for (const p of plan) {
    const st = String(p.status || '').toLowerCase().trim();
    if (st !== 'approved' && st !== 'rejected') continue;
    if (known[String(p.plan_id) + '::' + st]) continue;
    const map = {
      timestamp: nowIso_(), plan_id: p.plan_id, finding_id: p.finding_id,
      reaction: st === 'approved' ? '✅' : '❌', user_id: 'manual_sheet', status: st, notes: 'mirrored from Action_Plan',
    };
    sheet.appendRow(h.map(k => (map[k] !== undefined ? map[k] : '')));
    added++;
  }
  return { added: added };
}

/** Approved plan items not yet turned into changes, enriched with agent/category. */
function _readApprovedPlanItems_() {
  const appr = _readTab_('Approvals');
  const status = {};   // plan_id → latest status
  for (const a of appr) status[String(a.plan_id)] = String(a.status || '').toLowerCase().trim();

  const plan = _readTab_('Action_Plan');
  const findings = _readTab_('Findings');
  const fIndex = {};
  for (const f of findings) fIndex[String(f.finding_id)] = f;

  // Block re-queuing only for changes already in a REAL queue state. dry_run
  // rows don't block, so you can re-run DRY_RUN repeatedly while reviewing.
  const already = {};
  for (const c of _readTab_('Pending_Changes')) {
    const st = String(c.status).toLowerCase().trim();
    if (st === 'queued' || st === 'executing' || st === 'done') already[String(c.plan_id)] = true;
  }

  const out = [];
  for (const p of plan) {
    if (status[String(p.plan_id)] !== 'approved') continue;
    if (already[String(p.plan_id)]) continue;   // don't double-queue
    const f = fIndex[String(p.finding_id)] || {};
    out.push({
      plan_id: p.plan_id, finding_id: p.finding_id, title: p.title,
      target_type: p.target_type, target_id: p.target_id, target_name: p.target_name,
      agent: f.agent || '', category: f.category || '',
    });
  }
  return out;
}

/* ===========================================================================
 * Manual approval helpers (run from the editor).
 * ========================================================================= */

function approvePlan(planId) { return _appendApproval_(planId, 'approved'); }
function rejectPlan(planId)  { return _appendApproval_(planId, 'rejected'); }

function _appendApproval_(planId, status) {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const sheet = ss.getSheetByName('Approvals');
  if (!sheet) throw new Error('Approvals tab missing. Run setupEverything().');
  const plan = _readTab_('Action_Plan').filter(p => String(p.plan_id) === String(planId))[0];
  const h = SHEETS.Approvals.headers;
  const map = {
    timestamp: nowIso_(), plan_id: planId, finding_id: plan ? plan.finding_id : '',
    reaction: status === 'approved' ? '✅' : '❌', user_id: 'manual_editor', status: status, notes: 'approvePlan()',
  };
  sheet.appendRow(h.map(k => (map[k] !== undefined ? map[k] : '')));
  log_('impl_mgr', `Recorded ${status} for ${planId}.`);
  return status;
}

/* ===========================================================================
 * Tiny tab reader with date normalisation.
 * ========================================================================= */

function _readTab_(tabName) {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return [];
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const headers = SHEETS[tabName].headers;
  const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  return data.map(row => {
    const o = {};
    for (let i = 0; i < headers.length; i++) {
      let v = row[i];
      if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      o[headers[i]] = v;
    }
    return o;
  });
}

function testImplementationManager() {
  const r = runImplementationManager({});
  log_('test', '');
  log_('test', `Implementation: dry_run=${r.dry_run}, approved=${r.approved}, ` +
              `queued=${r.queued}, skipped=${r.skipped}, ${Math.round((r.run_time_ms || 0) / 100) / 10}s`);
  for (const c of r.changes.slice(0, 8)) {
    log_('test', `  ${c.change_type} ${c.target_type} "${c.target_name}": ${c.before_value} → ${c.after_value}`);
  }
}
