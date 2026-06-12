/**
 * PlanFormatter.js — writes the scored, deduped findings to Action_Plan.
 *
 * The Action_Plan tab is the canonical "what to do today" list. One row per
 * action item, sorted by score desc. Phase 11 reads from this tab to drive
 * the Slack approval gate.
 *
 * Idempotent for a given run_date: every PlanFormatter call REPLACES all
 * rows whose `run_date` matches. Other dates' rows are preserved (so you
 * can keep historical plans without losing them).
 *
 * plan_id format: `plan_YYYYMMDD_NNN` (zero-padded sequence within a date).
 */

const PlanFormatter = {

  /**
   * @param {Array} scored — array of finding objects (with .priority + .score
   *                         already set by ImpactScorer)
   * @param {string} runDate — YYYY-MM-DD, e.g. "2026-06-04"
   * @returns {{ written: number, plan_ids: string[], cleared: number }}
   */
  run(scored, runDate) {
    if (!runDate) throw new Error('PlanFormatter.run: runDate required (YYYY-MM-DD).');

    const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
    const sheet = ss.getSheetByName('Action_Plan');
    if (!sheet) throw new Error('Action_Plan sheet missing. Run setupEverything().');

    const headers = SHEETS.Action_Plan.headers;
    const cleared = PlanFormatter._clearRunDate_(sheet, headers, runDate);

    if (!scored.length) {
      return { written: 0, plan_ids: [], cleared: cleared };
    }

    // Sort: P1 first (by score), then P2, then P3. Within priority, score desc.
    const sorted = scored.slice().sort((a, b) => {
      const pa = PlanFormatter._priorityRank_(a.priority);
      const pb = PlanFormatter._priorityRank_(b.priority);
      if (pa !== pb) return pa - pb;
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    });

    const datePart = runDate.replace(/-/g, '');
    const planIds = [];
    const rows = sorted.map((f, i) => {
      const seq = String(i + 1).padStart(3, '0');
      const planId = `plan_${datePart}_${seq}`;
      planIds.push(planId);

      const meta = PlanFormatter._deriveActionMeta_(f);
      const map = {
        run_date:          runDate,
        plan_id:           planId,
        finding_id:        f.finding_id,
        priority:          f.priority,
        title:             f.title,
        what:              f.what,
        why:               f.why,
        action:            f.action,
        action_category:   meta.action_category,
        action_type:       meta.action_type,
        target_type:       f.target_type,
        target_id:         f.target_id,
        target_name:       f.target_name,
        score:             f.score,
        slack_message_ts:  '',
        status:            'pending',
      };
      return headers.map(h => (map[h] !== undefined ? map[h] : ''));
    });

    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
    return { written: rows.length, plan_ids: planIds, cleared: cleared };
  },

  /* ===== internals ===== */

  /**
   * Derive action_category (auto/manual/insight) and action_type from the
   * agent name + finding_id prefix.
   *
   * auto   = ImplementationManager can execute this today (add_negatives, increase_budget)
   * manual = human must do it; system describes what to do
   * insight = informational only; no approval queue, no Slack ping
   */
  _deriveActionMeta_(f) {
    const agent = String(f.agent || '');
    const fid   = String(f.finding_id || '');

    if (agent === 'negative_kw_hunter') {
      return { action_category: 'auto', action_type: 'add_negatives' };
    }
    if (agent === 'bid_budget_analyst') {
      if (fid.indexOf('budget-locked-') === 0) return { action_category: 'auto',   action_type: 'increase_budget' };
      if (fid.indexOf('idle-budget-')   === 0) return { action_category: 'manual', action_type: 'reallocate_budget' };
      return { action_category: 'manual', action_type: 'change_bid_strategy' };
    }
    if (agent === 'synthesis_pattern') {
      if (fid.indexOf('sp-budget-misalloc-') === 0) return { action_category: 'auto',   action_type: 'increase_budget' };
      return { action_category: 'manual', action_type: 'fix_quality_score' };
    }
    if (agent === 'competitive_intel' || agent === 'category_trend_spotter') {
      return { action_category: 'insight', action_type: 'read_insight' };
    }

    const TYPE_MAP = {
      performance_analyst:          'investigate_performance',
      quality_score_inspector:      'fix_quality_score',
      conversion_health_checker:    'fix_tracking',
      audience_analyst:             'setup_audience',
      account_structure_reviewer:   'restructure',
      extension_auditor:            'add_extensions',
      ad_copy_critic:               'update_copy',
      keyword_miner:                'add_keywords',
      search_term_pattern_analyzer: 'restructure',
      landing_page_scorer:          'fix_landing_page',
    };
    const type = TYPE_MAP[agent] || 'manual_action';
    return { action_category: 'manual', action_type: type };
  },

  /**
   * Delete every row in Action_Plan whose run_date matches.
   * Returns rows cleared. Header row (row 1) is never touched.
   */
  _clearRunDate_(sheet, headers, runDate) {
    const last = sheet.getLastRow();
    if (last < 2) return 0;
    const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
    const runDateIdx = headers.indexOf('run_date');

    // Build the list of row indices to delete, bottom-up so indices don't shift.
    const toDelete = [];
    for (let i = data.length - 1; i >= 0; i--) {
      const v = data[i][runDateIdx];
      const s = (v instanceof Date)
        ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(v).trim();
      if (s === runDate) toDelete.push(i + 2);  // +2 because rows are 1-indexed and skip header
    }
    for (const rowNum of toDelete) sheet.deleteRow(rowNum);
    return toDelete.length;
  },

  _priorityRank_(p) {
    if (p === 'P1') return 1;
    if (p === 'P2') return 2;
    if (p === 'P3') return 3;
    return 9;
  },
};
