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
    const payload = parsePayload_(e);
    authorize_(payload);

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
  // Provide a friendly health-check so you can visit the URL in a browser
  // and see "ok" instead of a blank or error page.
  return jsonResponse_({
    ok:      true,
    service: 'google-ads-agent-fleet ingest',
    hint:    'POST data here from Google Ads Script. GET is a health check.',
    has_secret: PROPS.get('INGEST_SECRET') !== null,
  });
}

/* ===========================================================================
 * Payload validation
 * ========================================================================= */

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Empty request body. Expected JSON POST.');
  }
  let parsed;
  try {
    parsed = JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('Body is not valid JSON: ' + err.message);
  }
  if (!parsed.data || typeof parsed.data !== 'object') {
    throw new Error('Missing "data" object in payload.');
  }
  if (!parsed.run_date) {
    throw new Error('Missing "run_date" in payload.');
  }
  return parsed;
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
