/**
 * ingest.js — Apps Script Web App that receives Google Ads Script data POSTs.
 *
 * Deployed as a Web App (Deploy → New deployment → Web app, "Anyone" access),
 * this endpoint accepts JSON POST bodies from the Google Ads Script and
 * writes the rows to the Raw_* tabs of the bound Spreadsheet.
 *
 * Why this exists: Workspace tenants frequently block Google Ads Scripts from
 * obtaining Sheets OAuth scopes. Apps Script Web Apps don't have that issue —
 * the Apps Script owns the Sheet directly and runs under your identity.
 *
 * Security: a shared secret (INGEST_SECRET in Script Properties) must match
 * the value the Ads Script sends. If you didn't set INGEST_SECRET, ingest is
 * disabled and POSTs are rejected with HTTP 401.
 *
 * Idempotency: each Raw_* tab is fully replaced on each successful POST (all
 * data rows cleared, then new rows written). The schema header in row 1 is
 * preserved and validated.
 */

/* ===========================================================================
 * Web App entry points
 * ========================================================================= */

function doPost(e) {
  try {
    const payload = parseJson_(e);
    authorize_(payload);

    // Phase 12: the Ads Script (execute mode) posts execution results back.
    if (payload.cmd === 'execute_result') {
      const summary = handleExecuteResults_(payload);
      log_('execute', `results — ${JSON.stringify(summary)}`);
      return jsonResponse_({ ok: true, applied: summary });
    }

    // Default: data ingest (collect mode).
    if (!payload.data || typeof payload.data !== 'object') throw new Error('Missing "data" object in payload.');
    if (!payload.run_date) throw new Error('Missing "run_date" in payload.');

    const written = writeAllTabs_(payload);

    // Record what data we just received so agents downstream can tell the
    // human "this is N-day data, last collected on YYYY-MM-DD".
    if (payload.date_range) PROPS.set('LAST_COLLECT_DATE_RANGE', payload.date_range);
    if (payload.run_date)   PROPS.set('LAST_COLLECT_DATE', payload.run_date);
    if (payload.mode)       PROPS.set('LAST_COLLECT_MODE', payload.mode);

    log_('ingest', `OK — ${JSON.stringify(written)}`);
    return jsonResponse_({ ok: true, written: written, run_date: payload.run_date });

  } catch (err) {
    log_('ingest', `FAIL — ${err.name || 'Error'}: ${err.message || err}`);
    return jsonResponse_({ ok: false, error: String(err.message || err) }, 200);
    // We respond 200 with ok:false so Ads Script can read the JSON body.
    // Apps Script Web Apps frequently mangle non-200 responses through their
    // redirect proxy, so we encode failure in the body instead.
  }
}

function doGet(e) {
  // Phase 12: the Ads Script (execute mode) pulls the queued-change list.
  // Auth via ?secret=... (GET has no body). Returns only status=queued rows.
  if (e && e.parameter && e.parameter.cmd === 'pending') {
    const expected = PROPS.get('INGEST_SECRET');
    if (!expected || e.parameter.secret !== expected) {
      return jsonResponse_({ ok: false, error: 'Forbidden: INGEST_SECRET mismatch.' });
    }
    return jsonResponse_({ ok: true, changes: readPendingChanges_() });
  }
  // Friendly health-check otherwise.
  return jsonResponse_({
    ok:      true,
    service: 'google-ads-agent-fleet ingest',
    hint:    'POST data here from Google Ads Script. GET is a health check. GET ?cmd=pending&secret=.. lists queued changes.',
    has_secret: PROPS.get('INGEST_SECRET') !== null,
  });
}

/* ===========================================================================
 * Phase 12 — execution queue (pull) + results (push back).
 * ========================================================================= */

function readPendingChanges_() {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const sheet = ss.getSheetByName('Pending_Changes');
  if (!sheet) return [];
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const h = SHEETS.Pending_Changes.headers;
  const data = sheet.getRange(2, 1, last - 1, h.length).getValues();
  const out = [];
  for (const row of data) {
    const o = {}; for (let i = 0; i < h.length; i++) o[h[i]] = row[i];
    if (String(o.status).trim() !== 'queued') continue;
    let params = {}; try { params = JSON.parse(o.result || '{}'); } catch (_e) { params = {}; }
    out.push({
      change_id: String(o.change_id), change_type: String(o.change_type),
      target_type: String(o.target_type), target_id: String(o.target_id), target_name: String(o.target_name),
      before_value: String(o.before_value), after_value: String(o.after_value), params: params,
    });
  }
  return out;
}

function handleExecuteResults_(payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const pend = ss.getSheetByName('Pending_Changes');
  const log  = ss.getSheetByName('Change_Log');
  if (!pend) throw new Error('Pending_Changes tab missing. Run setupEverything().');
  const h = SHEETS.Pending_Changes.headers;
  const last = pend.getLastRow();
  const data = last > 1 ? pend.getRange(2, 1, last - 1, h.length).getValues() : [];
  const idIdx = h.indexOf('change_id');

  let done = 0, failed = 0;
  for (const res of results) {
    let rowNum = -1;
    for (let i = 0; i < data.length; i++) { if (String(data[i][idIdx]) === String(res.change_id)) { rowNum = i + 2; break; } }
    if (rowNum < 0) continue;
    const row = data[rowNum - 2];
    const obj = {}; for (let i = 0; i < h.length; i++) obj[h[i]] = row[i];

    obj.status = res.success ? 'done' : 'failed';
    obj.executed_at = nowIso_();
    obj.result = res.success ? 'applied' : '';
    obj.error = res.error || '';
    pend.getRange(rowNum, 1, 1, h.length).setValues([h.map(k => (obj[k] !== undefined ? obj[k] : ''))]);
    if (res.success) done++; else failed++;

    // Mirror into Change_Log (the human-facing audit trail).
    if (log) {
      const lh = SHEETS.Change_Log.headers;
      const lm = {
        timestamp: nowIso_(), plan_id: obj.plan_id, finding_id: obj.finding_id, agent: 'ads_script_execute',
        target_type: obj.target_type, target_id: obj.target_id, target_name: obj.target_name,
        field_changed: obj.field, before_value: obj.before_value,
        after_value: res.success ? obj.after_value : obj.before_value,
        dry_run: false, success: res.success, error_message: res.error || '',
      };
      log.appendRow(lh.map(k => (lm[k] !== undefined ? lm[k] : '')));
    }
  }
  return { done: done, failed: failed };
}

/* ===========================================================================
 * Payload validation
 * ========================================================================= */

function parseJson_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Empty request body. Expected JSON POST.');
  }
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('Body is not valid JSON: ' + err.message);
  }
}

function authorize_(payload) {
  const expected = PROPS.get('INGEST_SECRET');
  if (!expected) {
    throw new Error(
      'INGEST_SECRET is not set in Script Properties. Ingest is disabled until ' +
      'you add it. Go to Project Settings → Script Properties → add INGEST_SECRET ' +
      'with a strong random value, and put the SAME value in your Google Ads ' +
      'Script CONFIG.INGEST_SECRET.'
    );
  }
  if (!payload.secret || payload.secret !== expected) {
    throw new Error('Forbidden: INGEST_SECRET mismatch.');
  }
}

/* ===========================================================================
 * Writing
 *
 * The payload structure (see google_ads_script.js):
 *   payload.data = {
 *     Raw_Campaigns:   [ { run_date, campaign_id, ... }, ... ],
 *     Raw_AdGroups:    [ { ... }, ... ],
 *     Raw_Keywords:    [ ... ],
 *     Raw_Ads:         [ ... ],
 *     Raw_SearchTerms: [ ... ],
 *     Raw_Extensions:  [ ... ],
 *   }
 *
 * Each row-object's keys must match the SHEETS[tab].headers in config.js.
 * Missing keys are written as ''. Extra keys are ignored (with a warning).
 * ========================================================================= */

function writeAllTabs_(payload) {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const written = {};

  // Only write tabs that the Ads Script actually sent.
  for (const tabName of Object.keys(payload.data)) {
    const rowsFromAds = payload.data[tabName];
    if (!Array.isArray(rowsFromAds)) {
      throw new Error(`Payload.data.${tabName} is not an array.`);
    }
    if (!SHEETS[tabName]) {
      log_('ingest', `Skipping unknown tab "${tabName}" (not in SHEETS schema).`);
      continue;
    }
    written[tabName] = writeTab_(ss, tabName, rowsFromAds);
  }
  return written;
}

function writeTab_(ss, tabName, rowsAsObjects) {
  const schema  = SHEETS[tabName].headers;
  const sheet   = ss.getSheetByName(tabName);
  if (!sheet) {
    throw new Error(
      `Sheet tab "${tabName}" not found. Run setupEverything() in Apps Script first.`
    );
  }

  // Validate header consistency — fail loud if the schema drifted.
  const header = sheet.getRange(1, 1, 1, schema.length).getValues()[0]
    .map(v => String(v).trim());
  for (let i = 0; i < schema.length; i++) {
    if (header[i] !== schema[i]) {
      throw new Error(
        `Header mismatch on "${tabName}" col ${i + 1}: expected "${schema[i]}", ` +
        `found "${header[i]}". Re-run setupEverything() in Apps Script.`
      );
    }
  }

  // Clear all data rows below the header.
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, schema.length).clearContent();
  }

  if (rowsAsObjects.length === 0) return 0;

  // Map objects → 2D array in the exact column order declared in the schema.
  const matrix = new Array(rowsAsObjects.length);
  for (let i = 0; i < rowsAsObjects.length; i++) {
    const obj = rowsAsObjects[i];
    const row = new Array(schema.length);
    for (let c = 0; c < schema.length; c++) {
      const key = schema[c];
      const v = obj[key];
      row[c] = (v === undefined || v === null) ? '' : v;
    }
    matrix[i] = row;
  }

  // One batched write — fast even for thousands of rows.
  sheet.getRange(2, 1, matrix.length, schema.length).setValues(matrix);
  return matrix.length;
}

/* ===========================================================================
 * Helpers
 * ========================================================================= */

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Convenience: test the ingest from the editor without Google Ads.
 * Select this function in the Apps Script dropdown and click Run. It builds
 * a tiny fake payload, calls doPost, and logs the response.
 */
function _testIngestLocally() {
  const secret = PROPS.get('INGEST_SECRET');
  if (!secret) {
    Logger.log('Set INGEST_SECRET in Script Properties first.');
    return;
  }
  const fakePayload = {
    source:     'manual_test',
    secret:     secret,
    customer:   '000-000-0000',
    mode:       'daily',
    run_date:   new Date().toISOString().slice(0, 10),
    date_range: 'LAST_30_DAYS',
    data: {
      Raw_Campaigns: [{
        run_date:               new Date().toISOString().slice(0, 10),
        campaign_id:            'TEST_001',
        campaign_name:          'Manual test row — delete me',
        status:                 'ENABLED',
        channel_type:           'SEARCH',
        bidding_strategy:       'MANUAL_CPC',
        target_cpa_micros:      0,
        target_roas:            0,
        budget_micros:          1000000,
        impressions:            10,
        clicks:                 1,
        cost_micros:            500000,
        conversions:            0,
        conversion_value:       0,
        ctr:                    0.1,
        avg_cpc_micros:         500000,
        search_is:              0.5,
        search_budget_lost_is:  0.1,
        search_rank_lost_is:    0.4,
      }],
    },
  };
  const e = { postData: { contents: JSON.stringify(fakePayload) } };
  const resp = doPost(e);
  Logger.log('Response: ' + resp.getContent());
}
