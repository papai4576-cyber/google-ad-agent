/**
 * BrainStore.js — pure data layer over the "Brain" sheet tab.
 *
 * Every audit/copy agent calls BrainStore.query() before building its LLM
 * prompt, so this is on the hot path. Keep it cheap: one Sheet read per call,
 * no LLM, no Drive.
 *
 * Schema (defined in apps_script/config.js as SHEETS.Brain.headers):
 *   id | category | source | source_type | date_added |
 *   title | summary | key_points_json | raw_text
 *
 * The `source` column stores a stable unique key for the source:
 *   - upload      → Drive file ID
 *   - reddit      → Reddit post URL
 *   - manual      → arbitrary string (user-provided)
 */

const BrainStore = {

  /**
   * Return up to `limit` entries matching ANY of the given categories,
   * sorted most-recent first. This is the function every agent calls.
   *
   * @param {string[]} categories  array of categories to match (OR)
   * @param {number}   [limit=5]
   * @returns {Array<{id, category, source, source_type, date_added,
   *                  title, summary, key_points: string[]}>}
   */
  query(categories, limit) {
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('BrainStore.query: categories must be a non-empty array.');
    }
    const cap = typeof limit === 'number' && limit > 0 ? limit : 5;
    const wanted = new Set(categories.map(String));

    const rows = this._readAll_();
    const matches = rows.filter(r => wanted.has(r.category));

    // Newest first. date_added is YYYY-MM-DD string after _readAll_ normalization.
    matches.sort((a, b) => String(b.date_added || '').localeCompare(String(a.date_added || '')));

    return matches.slice(0, cap).map(this._toApi_);
  },

  /**
   * Return all entries (used by BrainCurator to dedup on Drive file ID).
   * Includes raw_text. Avoid calling from agents — use query() instead.
   */
  list() {
    return this._readAll_();
  },

  /**
   * Append a new entry. Auto-generates id ("brain_001", "brain_002", ...).
   * Returns the assigned id.
   *
   * @param {{
   *   category: string,
   *   source: string,
   *   source_type: 'upload'|'reddit'|'manual',
   *   title: string,
   *   summary: string,
   *   key_points: string[],
   *   raw_text: string,
   *   date_added?: string   // defaults to today
   * }} entry
   */
  add(entry) {
    if (!entry || typeof entry !== 'object') throw new Error('BrainStore.add: entry required.');
    const required = ['category', 'source', 'source_type', 'title', 'summary', 'key_points'];
    for (const k of required) {
      if (!entry[k] && entry[k] !== '') throw new Error(`BrainStore.add: missing field "${k}".`);
    }
    if (!VALID.brain_categories.includes(entry.category)) {
      throw new Error(`BrainStore.add: invalid category "${entry.category}". ` +
                      `Allowed: ${VALID.brain_categories.join(', ')}`);
    }
    if (!Array.isArray(entry.key_points)) {
      throw new Error('BrainStore.add: key_points must be an array of strings.');
    }

    const sheet = this._sheet_();
    const headers = SHEETS.Brain.headers;
    const nextId = this._nextId_(sheet);
    const dateAdded = entry.date_added || todayString_();

    const rawText = (entry.raw_text || '').slice(0, 2000);

    const rowMap = {
      id:               nextId,
      category:         entry.category,
      source:           entry.source,
      source_type:      entry.source_type,
      date_added:       dateAdded,
      title:            entry.title,
      summary:          entry.summary,
      key_points_json:  JSON.stringify(entry.key_points),
      raw_text:         rawText,
    };
    const row = headers.map(h => rowMap[h] !== undefined ? rowMap[h] : '');
    sheet.appendRow(row);
    return nextId;
  },

  /**
   * Quick row count (excluding header). Used by status reporting.
   */
  count() {
    const sheet = this._sheet_();
    const last = sheet.getLastRow();
    return Math.max(0, last - 1);
  },

  /**
   * Build a set of existing source values — used by BrainCurator to skip
   * files that are already indexed.
   */
  existingSources() {
    const set = new Set();
    for (const r of this._readAll_()) set.add(r.source);
    return set;
  },

  /* ===== internals ===== */

  _sheet_() {
    const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
    const sheet = ss.getSheetByName('Brain');
    if (!sheet) throw new Error('Brain sheet not found. Run setupEverything() first.');
    return sheet;
  },

  _readAll_() {
    const sheet = this._sheet_();
    const last = sheet.getLastRow();
    if (last < 2) return [];
    const headers = SHEETS.Brain.headers;
    const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
    const out = [];
    for (const row of data) {
      const obj = {};
      for (let i = 0; i < headers.length; i++) {
        let v = row[i];
        // Sheets auto-parses YYYY-MM-DD as Date — normalise back to string.
        if (v instanceof Date) {
          const y  = v.getFullYear();
          const m  = String(v.getMonth() + 1).padStart(2, '0');
          const dd = String(v.getDate()).padStart(2, '0');
          v = `${y}-${m}-${dd}`;
        } else if (v === null || v === undefined) {
          v = '';
        } else if (typeof v !== 'string') {
          v = String(v);
        }
        obj[headers[i]] = v;
      }
      out.push(obj);
    }
    return out;
  },

  /**
   * Convert a raw row (with key_points_json) to the agent-facing shape
   * (with key_points as an array, raw_text omitted to keep prompts small).
   */
  _toApi_(r) {
    let kp = [];
    try { kp = r.key_points_json ? JSON.parse(r.key_points_json) : []; }
    catch (_e) { kp = []; }
    return {
      id:          r.id,
      category:    r.category,
      source:      r.source,
      source_type: r.source_type,
      date_added:  r.date_added,
      title:       r.title,
      summary:     r.summary,
      key_points:  kp,
    };
  },

  _nextId_(sheet) {
    const last = sheet.getLastRow();
    if (last < 2) return 'brain_001';
    const ids = sheet.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0]));
    let max = 0;
    for (const id of ids) {
      const m = /^brain_(\d+)$/.exec(id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return 'brain_' + String(max + 1).padStart(3, '0');
  },
};

/* ===========================================================================
 * MANUAL TEST — add a sample entry, query it, print results.
 *
 * Safe to run multiple times: each call creates one row with a unique id.
 * To clean up after testing: delete those rows in the Brain sheet manually.
 * ========================================================================= */
function testBrainStore() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'BrainStore quick test');
  log_('test', '═══════════════════════════════════════════');

  const before = BrainStore.count();
  log_('test', `Before: ${before} brain entries`);

  const id = BrainStore.add({
    category:    'bidding',
    source:      'manual_test_' + Date.now(),
    source_type: 'manual',
    title:       'Test entry — tROAS for ecommerce',
    summary:     'Set tROAS once a campaign has 50+ conversions in 30 days. ' +
                 'Below that, Maximize Conversions or eCPC is safer.',
    key_points: [
      'Need >=50 conversions/30 days before tROAS',
      'Start conservative (75% of historical ROAS)',
      'Adjust by max ±15% per week to avoid disrupting smart bidding',
    ],
    raw_text:    'This is a test entry created by testBrainStore().',
  });
  log_('test', `Added entry id=${id}`);

  const results = BrainStore.query(['bidding', 'scaling'], 3);
  log_('test', `Query (bidding+scaling, limit 3) → ${results.length} entries:`);
  for (const e of results) {
    log_('test', `  - [${e.id}] (${e.category}) ${e.title}`);
    log_('test', `      summary: ${e.summary.slice(0, 80)}…`);
    log_('test', `      key_points: ${e.key_points.length} items`);
  }
  const after = BrainStore.count();
  log_('test', `After: ${after} brain entries (delta ${after - before})`);
  log_('test', '');
  log_('test', '✅ BrainStore working. You can manually delete the test row ' +
              'from the Brain sheet if you like.');
}
