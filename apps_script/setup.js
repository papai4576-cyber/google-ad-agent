/**
 * setup.js — one-shot bootstrap for the Google Ads Agent Fleet.
 *
 * Run setupEverything() ONCE from the Apps Script editor after you have:
 *   1. Created a Google Sheet
 *   2. Attached this Apps Script project to that Sheet
 *   3. Set GROQ_API_KEY in Script Properties
 *
 * It will:
 *   • Auto-detect the parent Spreadsheet and store SPREADSHEET_ID in Script Properties
 *   • Create all 15 tabs with correct headers (idempotent — safe to re-run)
 *   • Freeze + bold each header row
 *   • Pre-fill the Config tab with default values
 *   • Create the "Ads Agent Brain" Drive folder and store its ID
 *   • Verify Groq API key works (1 ping)
 *   • Print a checklist of remaining manual setup
 *
 * Re-running is safe: existing tabs and config rows are left intact.
 */

function setupEverything() {
  log_('setup', '═══════════════════════════════════════════');
  log_('setup', 'Google Ads Agent Fleet — Phase 1 bootstrap');
  log_('setup', '═══════════════════════════════════════════');

  const results = [];

  results.push(safe_(() => attachSpreadsheet_(),       'Attach Spreadsheet'));
  results.push(safe_(() => createAllTabs_(),           'Create 15 tabs'));
  results.push(safe_(() => seedConfigTab_(),           'Seed Config tab'));
  results.push(safe_(() => createBrainFolder_(),       'Create Brain Drive folder'));
  results.push(safe_(() => verifyGroq_(),              'Verify Groq API key'));

  log_('setup', '');
  log_('setup', 'Results:');
  const width = Math.max(...results.map(r => r.label.length));
  let allOk = true;
  for (const r of results) {
    const mark = r.ok ? 'OK  ' : 'FAIL';
    log_('setup', `  [${mark}] ${r.label.padEnd(width)}  ${r.detail}`);
    allOk = allOk && r.ok;
  }

  log_('setup', '');
  log_('setup', allOk
    ? 'Phase 1 bootstrap complete. See SETUP.md for the manual steps that remain.'
    : 'Bootstrap completed with errors. Fix the FAIL items and re-run setupEverything().');

  return allOk;
}

/* ───────────────────────── individual steps ─────────────────────────────── */

function attachSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      'No active Spreadsheet found. Open this Apps Script project FROM your ' +
      'Google Sheet (Extensions → Apps Script), then re-run setupEverything().'
    );
  }
  PROPS.set('SPREADSHEET_ID', ss.getId());
  return `bound to "${ss.getName()}" (${ss.getId()})`;
}

function createAllTabs_() {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));

  const tabNames = Object.keys(SHEETS);
  let created = 0;
  let kept = 0;

  for (const name of tabNames) {
    const schema = SHEETS[name];
    let sheet = ss.getSheetByName(name);
    if (sheet) {
      kept++;
    } else {
      sheet = ss.insertSheet(name);
      created++;
    }

    // Write headers if the sheet is empty or the headers don't match.
    const existing = sheet.getRange(1, 1, 1, Math.max(schema.headers.length, 1))
      .getValues()[0]
      .map(v => String(v).trim());
    const matches =
      existing.length >= schema.headers.length &&
      schema.headers.every((h, i) => existing[i] === h);

    if (!matches) {
      sheet.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
    }

    // Format header row.
    const headerRange = sheet.getRange(1, 1, 1, schema.headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#f1f3f4');
    sheet.setFrozenRows(1);

    // Stash the description in a developer-metadata field on the sheet.
    setSheetDescription_(sheet, schema.description);
  }

  // Delete the default "Sheet1" if it's empty and untouched.
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && def.getLastColumn() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(def);
  }

  return `created=${created}, already-existed=${kept}, total=${tabNames.length}`;
}

function setSheetDescription_(sheet, description) {
  // Use Developer Metadata at sheet level so it persists across renames.
  const existing = sheet.createDeveloperMetadataFinder()
    .withKey('description')
    .find();
  if (existing.length > 0) {
    existing[0].setValue(description);
  } else {
    sheet.addDeveloperMetadata('description', description);
  }
}

function seedConfigTab_() {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const sheet = ss.getSheetByName('Config');
  if (!sheet) throw new Error('Config sheet missing — re-run createAllTabs_ first.');

  // Map of key → [defaultValue, description].
  const seed = {
    DRY_RUN:                ['true',  'When true, no API mutations happen. Set to false ONLY after end-to-end testing.'],
    CURRENCY_SYMBOL:        ['₹',     'Account currency symbol used in agent prompts and findings (e.g. ₹, $, €, £).'],
    MONTHLY_BUDGET_TARGET:  ['100000','Target monthly spend in account currency. Used for pacing alerts.'],
    TARGET_CPA:             ['200',   'Target cost per acquisition. Used by Performance & Bid agents.'],
    TARGET_ROAS:            ['4.0',   'Target return on ad spend (revenue / cost). e.g. 4.0 means 4× revenue per 1× spend.'],
    MAX_BID_CHANGE_PCT:     ['0.30',  'Safety rail: max bid change in a single run (+/-30%). NEVER raise above 0.30.'],
    MAX_BUDGET_SHIFT_PCT:   ['0.20',  'Safety rail: max budget moved per run (20%). NEVER raise above 0.20.'],
    MIN_ACTIVE_ADS:         ['2',     'Safety rail: keep at least this many active ads per ad group at all times.'],
    DAILY_RUN_HOUR:         ['2',     'Hour (0–23) for daily collect job. Set in Google Ads Script scheduler too.'],
    WEEKLY_RUN_DAY:         ['SUN',   'Day of week for the weekly deep audit run.'],
    SLACK_CHANNEL_NAME:     ['#ads-agent', 'Display name only — actual channel ID is in Script Properties.'],
    BRAIN_REFRESH_HOUR:     ['3',     'Hour for nightly Brain Drive folder re-index.'],
    REDDIT_SUBS:            ['PPC,googleads,marketing,Entrepreneur', 'Comma-separated subreddit list for Reddit Hunter (only used if you wire Reddit OAuth).'],
    REDDIT_MIN_UPVOTES:     ['50',    'Filter: ignore Reddit posts below this upvote threshold.'],
    CONTENT_LOOKBACK_DAYS:  ['7',     'ContentHunter: index RSS items published within this many days.'],
    CONTENT_FEEDS_JSON:     ['',      'ContentHunter: optional JSON array [{"name":"...","url":"..."}] to override default PPC blog feeds.'],
    NEGATIVE_KW_MIN_WASTE:  ['50',    'NegativeKwHunter: minimum spend (in account currency) for a zero-conversion term to be considered for negation.'],
  };

  // Read existing config keys so we don't overwrite the user's edits.
  const existing = sheet.getDataRange().getValues();
  const existingKeys = new Set(existing.slice(1).map(r => String(r[0]).trim()));

  const newRows = [];
  for (const [key, [val, desc]] of Object.entries(seed)) {
    if (!existingKeys.has(key)) newRows.push([key, val, desc]);
  }

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 3).setValues(newRows);
  }

  // Tighten column widths for readability.
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 520);

  return `seeded ${newRows.length} new key(s), preserved ${existingKeys.size} existing`;
}

function createBrainFolder_() {
  // If we already have a folder ID and it still exists, keep it.
  const existingId = PROPS.get('BRAIN_DRIVE_FOLDER_ID');
  if (existingId) {
    try {
      const folder = DriveApp.getFolderById(existingId);
      return `already exists: "${folder.getName()}" (${existingId})`;
    } catch (e) {
      // Folder id was set but folder is gone — fall through and create a new one.
      log_('setup', `Stored BRAIN_DRIVE_FOLDER_ID (${existingId}) is invalid; creating a new folder.`);
    }
  }

  // Look for an existing folder named "Ads Agent Brain" before creating.
  const FOLDER_NAME = 'Ads Agent Brain';
  const matches = DriveApp.getFoldersByName(FOLDER_NAME);
  let folder;
  if (matches.hasNext()) {
    folder = matches.next();
  } else {
    folder = DriveApp.createFolder(FOLDER_NAME);
    // Drop a readme so the user knows what to do here.
    folder.createFile(
      'README.txt',
      'Drop strategy resources here (PDFs, Google Docs, notes, screenshots).\n' +
      'The Brain Curator agent indexes this folder nightly into the "Brain"\n' +
      'tab of the Sheet. Every audit agent uses these as strategy context.\n\n' +
      'Categories you can mention in filenames to help routing:\n' +
      '  copy, bidding, structure, scaling, brand, keywords, audience,\n' +
      '  competitive, landing_page, pmax, general\n',
      MimeType.PLAIN_TEXT,
    );
  }

  PROPS.set('BRAIN_DRIVE_FOLDER_ID', folder.getId());
  return `${matches.hasNext ? 'using existing' : 'created'} "${folder.getName()}" (${folder.getId()})`;
}

function verifyGroq_() {
  const key = PROPS.get('GROQ_API_KEY');
  if (!key) {
    return 'skipped — GROQ_API_KEY not set yet. Add it in Project Settings → Script Properties.';
  }

  // Groq is OpenAI-compatible — same request shape as openai.com/v1/chat/completions.
  const payload = {
    model: LLM.model,
    messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    max_tokens: 8,
    temperature: 0,
  };

  const resp = UrlFetchApp.fetch(LLM.endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error(`Groq returned HTTP ${code}: ${resp.getContentText().slice(0, 300)}`);
  }
  const body = JSON.parse(resp.getContentText());
  const text = ((body.choices && body.choices[0]
                 && body.choices[0].message
                 && body.choices[0].message.content) || '').trim();
  return `reached Groq ${LLM.model} (replied "${text || '<empty>'}")`;
}

/* ───────────────────────── helpers ──────────────────────────────────────── */

function safe_(fn, label) {
  try {
    const detail = fn();
    return { ok: true, label, detail: String(detail) };
  } catch (e) {
    return {
      ok: false,
      label,
      detail: `${e.name || 'Error'}: ${String(e.message || e).slice(0, 300)}`,
    };
  }
}

/**
 * Helper: print the current state of setup. Useful for re-checking without
 * running the full bootstrap.
 */
function showSetupStatus() {
  const props = PropertiesService.getScriptProperties().getProperties();
  log_('status', `LLM provider           = ${LLM.provider} (model: ${LLM.model})`);
  log_('status', `SPREADSHEET_ID         = ${props.SPREADSHEET_ID || '(not set)'}`);
  log_('status', `BRAIN_DRIVE_FOLDER_ID  = ${props.BRAIN_DRIVE_FOLDER_ID || '(not set)'}`);
  log_('status', `GROQ_API_KEY           = ${props.GROQ_API_KEY ? '(set, ' + props.GROQ_API_KEY.length + ' chars)' : '(not set)'}`);
  log_('status', `SLACK_BOT_TOKEN        = ${props.SLACK_BOT_TOKEN ? '(set)' : '(not set, fine for phases 1–10)'}`);
  log_('status', `SLACK_WEBHOOK_URL      = ${props.SLACK_WEBHOOK_URL ? '(set)' : '(not set, fine for phases 1–10)'}`);
  log_('status', `SLACK_CHANNEL_ID       = ${props.SLACK_CHANNEL_ID ? '(set)' : '(not set, fine for phases 1–10)'}`);
  log_('status', `ADS_SCRIPT_EXECUTE_URL = ${props.ADS_SCRIPT_EXECUTE_URL ? '(set)' : '(not set, fine for phases 1–11)'}`);

  const id = props.SPREADSHEET_ID;
  if (id) {
    const ss = SpreadsheetApp.openById(id);
    const tabs = ss.getSheets().map(s => s.getName());
    log_('status', `Tabs in spreadsheet (${tabs.length}): ${tabs.join(', ')}`);
  }
}
