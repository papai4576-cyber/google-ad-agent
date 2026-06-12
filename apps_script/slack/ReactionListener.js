/**
 * ReactionListener.js — polls Slack for ✅/❌ reactions on auto items.
 *
 * Runs every 30 minutes via a time-driven trigger installed by setup.js.
 * Only looks at Action_Plan rows with status='posted' (i.e. auto items that
 * PlanSender already posted and are awaiting a reaction).
 *
 * On ✅ (white_check_mark):  status → 'approved'  + Approvals row appended
 * On ❌ (x):                 status → 'rejected'  + Approvals row appended
 * No reaction yet:           status unchanged, checked again next poll
 *
 * Requires Script Properties: SLACK_BOT_TOKEN.
 */

/** Entry point called by the time-driven trigger. */
function pollReactions() {
  try {
    const r = ReactionListener.pollReactions();
    log_('reaction_listener', `polled=${r.polled}, approved=${r.approved}, rejected=${r.rejected}`);
  } catch (e) {
    log_('reaction_listener', 'pollReactions error: ' + (e.message || e));
  }
}

const ReactionListener = {

  /**
   * @returns {{ polled: number, approved: number, rejected: number }}
   */
  pollReactions() {
    const token = PROPS.require('SLACK_BOT_TOKEN');

    const ss      = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
    const apSheet = ss.getSheetByName('Action_Plan');
    const apprSh  = ss.getSheetByName('Approvals');
    if (!apSheet || !apprSh) throw new Error('Action_Plan or Approvals sheet missing.');

    const apHeaders   = SHEETS.Action_Plan.headers;
    const apprHeaders = SHEETS.Approvals.headers;

    const last = apSheet.getLastRow();
    if (last < 2) return { polled: 0, approved: 0, rejected: 0 };

    const data = apSheet.getRange(2, 1, last - 1, apHeaders.length).getValues();
    const col  = {};
    apHeaders.forEach((h, i) => { col[h] = i; });

    // Rows awaiting reaction: status='posted' AND slack_message_ts is set.
    const pending = [];
    for (let i = 0; i < data.length; i++) {
      const status = String(data[i][col.status] || '').toLowerCase().trim();
      const ts     = String(data[i][col.slack_message_ts] || '').trim();
      if (status === 'posted' && ts) pending.push({ row: data[i], rowNum: i + 2, ts });
    }

    if (pending.length === 0) return { polled: 0, approved: 0, rejected: 0 };

    const channelId = PROPS.require('SLACK_CHANNEL_ID');
    let approved = 0, rejected = 0;

    for (const { row, rowNum, ts } of pending) {
      try {
        const reaction = ReactionListener._getReaction_(token, channelId, ts);
        if (!reaction) continue;   // no verdict yet

        const newStatus = reaction === 'approved' ? 'approved' : 'rejected';
        apSheet.getRange(rowNum, col.status + 1).setValue(newStatus);

        // Append to Approvals tab.
        const apprMap = {
          timestamp:  nowIso_(),
          plan_id:    String(row[col.plan_id]    || ''),
          finding_id: String(row[col.finding_id] || ''),
          reaction:   reaction === 'approved' ? '✅' : '❌',
          user_id:    'slack_reaction',
          status:     newStatus,
          notes:      'auto-polled by ReactionListener',
        };
        apprSh.appendRow(apprHeaders.map(h => (apprMap[h] !== undefined ? apprMap[h] : '')));

        if (reaction === 'approved') approved++; else rejected++;
        log_('reaction_listener',
          `  ${row[col.plan_id]} → ${newStatus} (ts=${ts})`);
      } catch (e) {
        log_('reaction_listener',
          `  error on ${row[col.plan_id]}: ${String(e.message || e).slice(0, 120)}`);
      }
    }

    return { polled: pending.length, approved, rejected };
  },

  /* ===== internals ===== */

  /**
   * Fetch reactions on a message. Returns 'approved', 'rejected', or null.
   * Prefers ✅ over ❌ if both are present (human may correct a mistake).
   */
  _getReaction_(token, channel, ts) {
    const url = 'https://slack.com/api/reactions.get?' +
      'channel=' + encodeURIComponent(channel) +
      '&timestamp=' + encodeURIComponent(ts) +
      '&full=false';

    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    const body = JSON.parse(resp.getContentText());

    if (!body.ok) {
      if (body.error === 'message_not_found') return null;
      throw new Error('reactions.get error: ' + (body.error || JSON.stringify(body)));
    }

    const reactions = (body.message && body.message.reactions) || [];
    const names     = reactions.map(r => r.name);

    // 'white_check_mark' = ✅, 'x' = ❌.
    if (names.indexOf('white_check_mark') !== -1) return 'approved';
    if (names.indexOf('x')               !== -1) return 'rejected';
    return null;
  },
};

/* ── manual test ─────────────────────────────────────────────────────────── */

function testReactionListener() {
  log_('test', 'ReactionListener.pollReactions()');
  const r = ReactionListener.pollReactions();
  log_('test', JSON.stringify(r));
}
