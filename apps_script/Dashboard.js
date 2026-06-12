/**
 * Dashboard.js — performance-marketer dashboard.
 *
 * Two data sources, gracefully degrading:
 *   • Raw_Campaigns_Daily (per-day) → enables the 7d / 30d / This-month window
 *     selector AND period-over-period Δ% trends.
 *   • Raw_Campaigns (current snapshot) → always present; used as a FALLBACK so
 *     the dashboard is fully populated (ROAS, spend, conv value, per-campaign
 *     table) even before the daily collector has run. Snapshot mode shows no
 *     window switching / deltas (there is only one window of data).
 *
 * Budget per campaign always comes from the snapshot (the daily tab has no
 * budget column).
 *
 * Layout is an 8-column grid (A–H). Window selector is cell B1; an installable
 * onEdit trigger (onDashboardEdit) re-renders on change. No LLM, no UrlFetch.
 */

var DASH_SELECTOR_CELL = 'B1';
var DASH_COLS = 8;
var DASH_WINDOWS = {
  '7 days':     { code: '7d',  days: 7,  label: 'last 7 days' },
  '30 days':    { code: '30d', days: 30, label: 'last 30 days' },
  'This month': { code: 'mtd', days: 0,  label: 'this month so far' },
};

function refreshDashboard(opts) {
  const tStart = Date.now();
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const sheet = ss.getSheetByName('Dashboard');
  if (!sheet) throw new Error('Dashboard tab missing. Run setupEverything().');

  const cur = AgentCommon.getCurrency();
  const targets = AgentCommon.getTargets();
  const windowLabel = _resolveWindowLabel_(sheet, opts && opts.window);
  const win = DASH_WINDOWS[windowLabel];

  // Budget + names from the snapshot (always available).
  const snapshot = AgentCommon.readCampaigns();          // enabled only
  const budgetById = {}, nameById = {};
  let totalDailyBudget = 0;
  for (const c of snapshot) {
    budgetById[String(c.campaign_id)] = AgentCommon.micros(c.budget_micros);
    nameById[String(c.campaign_id)]   = c.campaign_name;
    totalDailyBudget += AgentCommon.micros(c.budget_micros);
  }

  const daily = _readDaily_(ss);
  const useDaily = daily.rows.length > 0;

  // Aggregates for the selected window (daily) or the snapshot window (fallback).
  let curAgg, prevAgg, perCampaign, periodLabel, periodNote;
  if (useDaily) {
    const ranges = _windowRanges_(daily.maxDate, win);
    curAgg  = _aggregate_(daily.rows, ranges.curStart, ranges.curEnd);
    prevAgg = _aggregate_(daily.rows, ranges.prevStart, ranges.prevEnd);
    perCampaign = _aggregateByCampaign_(daily.rows, ranges.curStart, ranges.curEnd);
    periodLabel = win.label + '  (' + ranges.curStart + ' → ' + ranges.curEnd + ')';
    periodNote = '';
    if (win.code === 'mtd') periodNote = 'day ' + ranges.elapsedDays + '/' + _daysInMonth_(daily.maxDate);
    curAgg._ranges = ranges;
  } else {
    curAgg = _snapshotAgg_(snapshot);
    prevAgg = null;   // no previous period in snapshot mode
    perCampaign = snapshot.map(c => ({
      id: String(c.campaign_id), name: c.campaign_name,
      spend: AgentCommon.micros(c.cost_micros), value: Number(c.conversion_value) || 0,
      conv: Number(c.conversions) || 0, impr: Number(c.impressions) || 0, clicks: Number(c.clicks) || 0,
    }));
    periodLabel = 'last 30-day snapshot';
    periodNote = 'Re-run the Google Ads collector (updated script) to unlock 7d/30d/this-month + trends.';
  }

  _renderControlBar_(sheet, windowLabel, useDaily);

  const body = [];
  const push = (arr) => { const row = arr.slice(0, DASH_COLS); while (row.length < DASH_COLS) row.push(''); body.push(row); };

  // ===== KPI SUMMARY =====
  const k = curAgg;
  const roas = k.spend > 0 ? k.value / k.spend : 0;
  const cpa  = k.conv > 0 ? k.spend / k.conv : 0;
  const ctr  = k.impr > 0 ? k.clicks / k.impr * 100 : 0;
  const cvr  = k.clicks > 0 ? k.conv / k.clicks * 100 : 0;
  const cpc  = k.clicks > 0 ? k.spend / k.clicks : 0;
  const vpc  = k.conv > 0 ? k.value / k.conv : 0;
  const dlt = (curV, key, dir) => prevAgg ? _delta_(curV, _derive_(prevAgg, key), dir) : '';

  push(['KPI — ' + periodLabel, '', 'Δ vs prev', '', '', '', '', periodNote]);
  push(['Spend',         cur + _n_(k.spend), dlt(k.spend, 'spend', 'neutral'), '', '', '', '', '']);
  push(['Conversion value', cur + _n_(k.value), dlt(k.value, 'value', 'up'), '', '', '', '', '']);
  push(['ROAS',          _n_(roas) + 'x', prevAgg ? _delta_(roas, _ratio_(prevAgg, 'value', 'spend'), 'up') : '',
        '', '', '', '', _goalNote_(roas, targets.target_roas, 'higher', '')]);
  push(['Conversions',   _n_(k.conv), dlt(k.conv, 'conv', 'up'), '', '', '', '', '']);
  push(['CPA',           cur + _n_(cpa), prevAgg ? _delta_(cpa, _ratio_(prevAgg, 'spend', 'conv'), 'down') : '',
        '', '', '', '', _goalNote_(cpa, targets.target_cpa, 'lower', cur)]);
  push(['Conv. rate',    _n_(cvr) + '%', prevAgg ? _delta_(cvr, _ratioPct_(prevAgg, 'conv', 'clicks'), 'up') : '', '', '', '', '', '']);
  push(['CTR',           _n_(ctr) + '%', prevAgg ? _delta_(ctr, _ratioPct_(prevAgg, 'clicks', 'impr'), 'up') : '', '', '', '', '', '']);
  push(['Avg CPC',       cur + _n_(cpc), prevAgg ? _delta_(cpc, _ratio_(prevAgg, 'spend', 'clicks'), 'down') : '', '', '', '', '', '']);
  push(['Value / conv',  cur + _n_(vpc), '', '', '', '', '', '']);
  push(['Impressions',   _n_(k.impr), dlt(k.impr, 'impr', 'up'), '', '', '', '', '']);
  push(['Clicks',        _n_(k.clicks), dlt(k.clicks, 'clicks', 'up'), '', '', '', '', '']);

  // ===== BUDGET & PACING =====
  const monthly = targets.monthly_budget || 0;
  push(['BUDGET & PACING', '', '', '', '', '', '', '']);
  push(['Total daily budget', cur + _n_(totalDailyBudget), '', '', '', '', '', 'sum of enabled campaign daily budgets']);
  if (monthly > 0) {
    const pct = Math.round(k.spend / monthly * 100);
    push(['Monthly target', cur + _n_(monthly), '', '', '', '', '', pct + '% spent this window']);
    if (useDaily && win.code === 'mtd') {
      const elapsed = curAgg._ranges.elapsedDays || 1;
      const dim = _daysInMonth_(daily.maxDate);
      const projected = k.spend / elapsed * dim;
      const pace = projected > monthly * 1.05 ? '⚠️ over' : (projected < monthly * 0.85 ? '⚠️ under' : '✅ on');
      push(['Projected month-end', cur + _n_(projected), '', '', '', '', '', pace + ' pace']);
    }
  } else {
    push(['Monthly target', 'not set', '', '', '', '', '', 'Set MONTHLY_BUDGET_TARGET in Config']);
  }

  // ===== CAMPAIGN BREAKDOWN =====
  perCampaign.sort((a, b) => b.spend - a.spend);
  const shown = perCampaign.slice(0, 25);
  push(['CAMPAIGNS (' + periodLabel + ') — top ' + shown.length + ' of ' + perCampaign.length, '', '', '', '', '', '', '']);
  push(['Campaign', 'Budget/day', 'Spend', 'Conv', 'Conv value', 'ROAS', 'CPA', 'CTR']);
  for (const c of shown) {
    const cRoas = c.spend > 0 ? c.value / c.spend : 0;
    const cCpa  = c.conv > 0 ? c.spend / c.conv : 0;
    const cCtr  = c.impr > 0 ? c.clicks / c.impr * 100 : 0;
    const bud   = budgetById[c.id] != null ? budgetById[c.id] : null;
    push([
      String(c.name).slice(0, 44),
      bud != null ? cur + _n_(bud) : '—',
      cur + _n_(c.spend),
      _n_(c.conv),
      cur + _n_(c.value),
      _n_(cRoas) + 'x',
      c.conv > 0 ? cur + _n_(cCpa) : '—',
      (c.impr > 0 ? _n_(cCtr) + '%' : '—'),
    ]);
  }

  // ===== HEALTH SECTIONS =====
  _appendHealthSections_(ss, push);

  _writeBody_(sheet, body);
  _formatDashboard_(sheet, body);

  const ms = Date.now() - tStart;
  log_('dashboard', `Dashboard refreshed (window=${windowLabel}, source=${useDaily ? 'daily' : 'snapshot'}) — ${body.length} rows, ${ms}ms`);
  return { window: windowLabel, source: useDaily ? 'daily' : 'snapshot', rows: body.length, run_time_ms: ms };
}

/* ===========================================================================
 * Window resolution + control bar
 * ========================================================================= */

function _resolveWindowLabel_(sheet, explicit) {
  if (explicit) {
    for (const label in DASH_WINDOWS) {
      if (label === explicit || DASH_WINDOWS[label].code === explicit) return label;
    }
  }
  const cell = String(sheet.getRange(DASH_SELECTOR_CELL).getValue() || '').trim();
  if (DASH_WINDOWS[cell]) return cell;
  const cfg = String(getConfig('DASHBOARD_WINDOW', '30d')).trim();
  for (const label in DASH_WINDOWS) if (DASH_WINDOWS[label].code === cfg) return label;
  return '30 days';
}

function _renderControlBar_(sheet, windowLabel, useDaily) {
  sheet.getRange('A1').setValue('GOOGLE ADS — PERFORMANCE DASHBOARD');
  const cell = sheet.getRange(DASH_SELECTOR_CELL);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(DASH_WINDOWS), true).setAllowInvalid(false).build();
  cell.setDataValidation(rule);
  cell.setValue(windowLabel);
  sheet.getRange('C1').setValue(useDaily ? '◀ pick window' : '(snapshot mode — collect daily data for windows)');
  sheet.getRange('H1').setValue('Updated ' + nowIso_().slice(0, 16).replace('T', ' '));
  sheet.getRange(2, 1, 1, DASH_COLS).clearContent();
  sheet.getRange('A1:H1').setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
  cell.setBackground('#fff3cd').setFontColor('#000000');
}

/* ===========================================================================
 * Data readers + aggregation
 * ========================================================================= */

function _readDaily_(ss) {
  const sheet = ss.getSheetByName('Raw_Campaigns_Daily');
  if (!sheet) return { rows: [], maxDate: null };
  const last = sheet.getLastRow();
  if (last < 2) return { rows: [], maxDate: null };
  const headers = SHEETS.Raw_Campaigns_Daily.headers;
  const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  const idx = {}; headers.forEach((h, i) => idx[h] = i);
  let maxDate = '';
  const rows = data.map(r => {
    let d = r[idx.date];
    if (d instanceof Date) d = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    else d = String(d).trim();
    if (d > maxDate) maxDate = d;
    return {
      date: d, campaign_id: String(r[idx.campaign_id]), campaign_name: String(r[idx.campaign_name]),
      impressions: Number(r[idx.impressions]) || 0, clicks: Number(r[idx.clicks]) || 0,
      cost_micros: Number(r[idx.cost_micros]) || 0, conversions: Number(r[idx.conversions]) || 0,
      conversion_value: Number(r[idx.conversion_value]) || 0,
    };
  });
  return { rows: rows, maxDate: maxDate };
}

function _snapshotAgg_(snapshot) {
  const a = { spend: 0, value: 0, conv: 0, impr: 0, clicks: 0 };
  for (const c of snapshot) {
    a.spend  += AgentCommon.micros(c.cost_micros);
    a.value  += Number(c.conversion_value) || 0;
    a.conv   += Number(c.conversions) || 0;
    a.impr   += Number(c.impressions) || 0;
    a.clicks += Number(c.clicks) || 0;
  }
  return a;
}

function _windowRanges_(maxDateStr, win) {
  const anchor = _parseYmd_(maxDateStr);
  let curStart, curEnd, prevStart, prevEnd, elapsedDays;
  if (win.code === 'mtd') {
    const monthStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    curStart = monthStart; curEnd = anchor;
    elapsedDays = Math.round((anchor - monthStart) / 86400000) + 1;
    prevEnd = _addDays_(monthStart, -1); prevStart = _addDays_(prevEnd, -(elapsedDays - 1));
  } else {
    const n = win.days;
    curEnd = anchor; curStart = _addDays_(anchor, -(n - 1));
    prevEnd = _addDays_(anchor, -n); prevStart = _addDays_(anchor, -(2 * n - 1));
    elapsedDays = n;
  }
  return {
    curStart: _fmtYmd_(curStart), curEnd: _fmtYmd_(curEnd),
    prevStart: _fmtYmd_(prevStart), prevEnd: _fmtYmd_(prevEnd), elapsedDays: elapsedDays,
  };
}

function _aggregate_(rows, startStr, endStr) {
  const a = { spend: 0, value: 0, conv: 0, impr: 0, clicks: 0 };
  for (const r of rows) {
    if (r.date < startStr || r.date > endStr) continue;
    a.spend += r.cost_micros / 1e6; a.value += r.conversion_value; a.conv += r.conversions;
    a.impr += r.impressions; a.clicks += r.clicks;
  }
  return a;
}

function _aggregateByCampaign_(rows, startStr, endStr) {
  const map = {};
  for (const r of rows) {
    if (r.date < startStr || r.date > endStr) continue;
    let c = map[r.campaign_id];
    if (!c) c = map[r.campaign_id] = { id: r.campaign_id, name: r.campaign_name, spend: 0, value: 0, conv: 0, impr: 0, clicks: 0 };
    c.spend += r.cost_micros / 1e6; c.value += r.conversion_value; c.conv += r.conversions;
    c.impr += r.impressions; c.clicks += r.clicks;
  }
  return Object.keys(map).map(k => map[k]);
}

function _derive_(agg, key) { return Number(agg[key]) || 0; }
function _ratio_(agg, num, den) { const d = Number(agg[den]) || 0; return d > 0 ? (Number(agg[num]) || 0) / d : 0; }
function _ratioPct_(agg, num, den) { return _ratio_(agg, num, den) * 100; }

/* ===========================================================================
 * Health sections
 * ========================================================================= */

function _appendHealthSections_(ss, push) {
  // ===== LLM usage today (Groq) =====
  push(['LLM USAGE TODAY (UTC ' + utcDateString_() + ')', '', '', '', '', '', '', '']);
  const gT = tokensUsedToday('groq'), gR = requestsToday('groq');
  const gCeil = dailyTokenCeiling('groq');
  push(['Groq', _n_(gT) + ' tok' + (gCeil ? ' / ' + _n_(gCeil) : ''), '', '', '', '', '',
        gR + ' requests' + (gCeil ? '  (' + Math.round(gT / gCeil * 100) + '% of daily ceiling)' : '')]);

  const findings = _latestRows_(ss, 'Findings');
  push(['LATEST FINDINGS', '', '', '', '', '', '', findings.runDate || 'n/a']);
  if (findings.rows.length === 0) {
    push(['', 'none yet', '', '', '', '', '', 'Run CampaignDirector']);
  } else {
    const sev = _countBy_(findings.rows, 'severity');
    const byAgent = _countBy_(findings.rows, 'agent');
    push(['Total findings', String(findings.rows.length), '', '', '', '', '',
          `P1=${sev.P1 || 0} P2=${sev.P2 || 0} P3=${sev.P3 || 0}`]);
    push(['Agents reporting', Object.keys(byAgent).length + ' / 14', '', '', '', '', '', _topPairs_(byAgent, 3, '')]);
  }

  const plan = _latestRows_(ss, 'Action_Plan');
  push(['ACTION PLAN', '', '', '', '', '', '', plan.runDate || 'n/a']);
  if (plan.rows.length === 0) {
    push(['', 'none yet', '', '', '', '', '', '']);
  } else {
    const pr = _countBy_(plan.rows, 'priority');
    push(['Plan items', String(plan.rows.length), '', '', '', '', '', `P1=${pr.P1 || 0} P2=${pr.P2 || 0} P3=${pr.P3 || 0}`]);
    const p1s = plan.rows.filter(r => String(r.priority) === 'P1')
      .sort((a, b) => (parseFloat(b.score) || 0) - (parseFloat(a.score) || 0)).slice(0, 5);
    let i = 1;
    for (const r of p1s) push(['P1 #' + (i++), String(r.title).slice(0, 50), '', '', '', '', '',
          r.target_type + ':' + String(r.target_name).slice(0, 30)]);
  }

  push(['BRAIN', '', '', '', '', '', '', todayString_()]);
  let brain = [];
  try { brain = BrainStore.list(); } catch (_e) { brain = []; }
  if (brain.length === 0) {
    push(['Entries', '0', '', '', '', '', '', 'Drop files into the "Ads Agent Brain" Drive folder']);
  } else {
    const byCat = _countBy_(brain, 'category');
    push(['Entries', String(brain.length), '', '', '', '', '', _topPairs_(byCat, 4, 'by category')]);
  }
}

function _latestRows_(ss, tabName) {
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { runDate: '', rows: [] };
  const last = sheet.getLastRow();
  if (last < 2) return { runDate: '', rows: [] };
  const headers = SHEETS[tabName].headers;
  const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  const objs = data.map(row => {
    const o = {};
    for (let i = 0; i < headers.length; i++) {
      let v = row[i];
      if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      o[headers[i]] = v;
    }
    return o;
  });
  let latest = '';
  for (const o of objs) { const rd = String(o.run_date || '').trim(); if (rd > latest) latest = rd; }
  return { runDate: latest, rows: objs.filter(o => String(o.run_date || '').trim() === latest) };
}

function _countBy_(rows, field) {
  const m = {};
  for (const r of rows) { const k = String(r[field] || '').trim() || '(blank)'; m[k] = (m[k] || 0) + 1; }
  return m;
}
function _topPairs_(counts, n, suffix) {
  const pairs = Object.keys(counts).map(k => [k, counts[k]]).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(p => `${p[0]}(${p[1]})`);
  return pairs.length ? pairs.join(', ') + (suffix ? ' ' + suffix : '') : '';
}

/* ===========================================================================
 * Formatting
 * ========================================================================= */

function _writeBody_(sheet, body) {
  const startRow = 3;
  const last = sheet.getLastRow();
  if (last >= startRow) {
    const r = sheet.getRange(startRow, 1, last - startRow + 1, DASH_COLS);
    r.clearContent(); r.setBackground(null).setFontWeight('normal');
  }
  if (body.length === 0) return;
  sheet.getRange(startRow, 1, body.length, DASH_COLS).setValues(body);
}

function _formatDashboard_(sheet, body) {
  const startRow = 3;
  const SECTION = /^(KPI|BUDGET|CAMPAIGNS|LLM|LATEST|ACTION|BRAIN)/;
  for (let i = 0; i < body.length; i++) {
    const a = String(body[i][0]);
    const isSection = SECTION.test(a) && body[i][1] === '';
    const isTableHeader = a === 'Campaign' && body[i][1] === 'Budget/day';
    if (isSection) sheet.getRange(startRow + i, 1, 1, DASH_COLS).setFontWeight('bold').setBackground('#d9e7fd');
    if (isTableHeader) sheet.getRange(startRow + i, 1, 1, DASH_COLS).setFontWeight('bold').setBackground('#e8eaed');
  }
  sheet.setColumnWidth(1, 280);
  for (let c = 2; c <= 7; c++) sheet.setColumnWidth(c, 95);
  sheet.setColumnWidth(8, 300);
}

/* ===========================================================================
 * Small helpers
 * ========================================================================= */

function _delta_(cur, prev, betterDir) {
  if (!prev || prev === 0) return cur ? 'new' : '';
  const pct = (cur - prev) / Math.abs(prev) * 100;
  if (Math.abs(pct) < 0.5) return '— 0%';
  const up = pct > 0; const arrow = up ? '▲' : '▼';
  let mark = '';
  if (betterDir === 'up')   mark = up ? ' ✅' : ' ⚠️';
  if (betterDir === 'down') mark = up ? ' ⚠️' : ' ✅';
  return arrow + ' ' + Math.abs(pct).toFixed(0) + '%' + mark;
}

function _n_(x) {
  const num = Number(x) || 0;
  const parts = (Math.round(num * 100) / 100).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts[1] === '00' ? parts[0] : parts.join('.');
}

function _goalNote_(actual, target, direction, cur) {
  if (!target) return '';
  const a = Number(actual) || 0;
  const good = direction === 'lower' ? a <= target : a >= target;
  const tgt = (cur || '') + _n_(target) + (direction === 'higher' ? 'x' : '');
  return (good ? '✅' : '⚠️') + ' target ' + tgt;
}

function _parseYmd_(s) { const p = String(s).split('-'); return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))); }
function _fmtYmd_(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}
function _addDays_(d, n) { return new Date(d.getTime() + n * 86400000); }
function _daysInMonth_(ymd) { const d = _parseYmd_(ymd); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }

/* ===========================================================================
 * onEdit re-render + trigger install + test
 * ========================================================================= */

function onDashboardEdit(e) {
  try {
    if (!e || !e.range) return;
    if (e.range.getSheet().getName() !== 'Dashboard') return;
    if (e.range.getA1Notation() !== DASH_SELECTOR_CELL) return;
    refreshDashboard({ window: String(e.range.getValue() || '').trim() });
  } catch (err) {
    log_('dashboard', 'onDashboardEdit error: ' + (err.message || err));
  }
}

function installDashboardTrigger() {
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onDashboardEdit');
  if (existing.length) return 'trigger already installed';
  ScriptApp.newTrigger('onDashboardEdit')
    .forSpreadsheet(SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'))).onEdit().create();
  return 'installed onDashboardEdit onEdit trigger';
}

function testDashboard() {
  const r = refreshDashboard();
  log_('test', `Dashboard refreshed: window=${r.window}, source=${r.source}, ${r.rows} rows in ${r.run_time_ms}ms. Open the Dashboard tab; try the B1 dropdown.`);
}
