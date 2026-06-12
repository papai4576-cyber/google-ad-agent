/**
 * PlanSender.js — posts the day's action plan to Slack.
 *
 * AUTO items  (action_category='auto'):
 *   One Slack message per item with ✅/❌ approval buttons.
 *   The message thread_ts is stored in Action_Plan → slack_message_ts
 *   so ReactionListener can retrieve reactions later.
 *   Status set to 'posted'.
 *
 * MANUAL items (action_category='manual'):
 *   Bundled into ONE digest message — no approval needed, just awareness.
 *   Status set to 'notified'.
 *
 * INSIGHT items (action_category='insight'):
 *   Skipped entirely from Slack. Visible only in the Action_Plan tab.
 *
 * Requires Script Properties: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID.
 * Safe to re-run for the same runDate — already-posted items are skipped.
 */

const PlanSender = {

  /**
   * @param {string} runDate — YYYY-MM-DD
   * @returns {{ auto_sent: number, manual_digest_sent: number, skipped: number }}
   */
  sendPlan(runDate) {
    if (!runDate) throw new Error('PlanSender.sendPlan: runDate required.');
    const token     = PROPS.require('SLACK_BOT_TOKEN');
    const channelId = PROPS.require('SLACK_CHANNEL_ID');

    const headers = SHEETS.Action_Plan.headers;
    const sheet   = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'))
                      .getSheetByName('Action_Plan');
    if (!sheet) throw new Error('Action_Plan sheet missing.');

    const last = sheet.getLastRow();
    if (last < 2) return { auto_sent: 0, manual_digest_sent: 0, skipped: 0 };

    const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();

    // Column indices (dynamic — survives future header additions).
    const col = {};
    headers.forEach((h, i) => { col[h] = i; });

    // Filter to today's pending rows.
    const todayRows = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rd = _normaliseDate_(row[col.run_date]);
      if (rd !== runDate) continue;
      const status = String(row[col.status] || '').toLowerCase().trim();
      if (status === 'pending') todayRows.push({ row, rowNum: i + 2 });
    }

    if (todayRows.length === 0) {
      log_('plan_sender', 'No pending items for ' + runDate + ' — nothing to post.');
      return { auto_sent: 0, manual_digest_sent: 0, skipped: 0 };
    }

    const autoItems    = todayRows.filter(r => String(r.row[col.action_category]) === 'auto');
    const manualItems  = todayRows.filter(r => String(r.row[col.action_category]) === 'manual');
    const insightItems = todayRows.filter(r => String(r.row[col.action_category]) === 'insight');

    log_('plan_sender',
      `${todayRows.length} pending items — auto=${autoItems.length}, ` +
      `manual=${manualItems.length}, insight=${insightItems.length}`);

    // ── Auto items — one message each ─────────────────────────────────────
    let autoSent = 0;
    for (const { row, rowNum } of autoItems) {
      try {
        const ts = PlanSender._postAutoItem_(token, channelId, row, col);
        // Update Action_Plan: slack_message_ts + status
        sheet.getRange(rowNum, col.slack_message_ts + 1).setValue(ts);
        sheet.getRange(rowNum, col.status + 1).setValue('posted');
        autoSent++;
      } catch (e) {
        log_('plan_sender', `  auto item ${row[col.plan_id]} failed: ${e.message || e}`);
      }
    }

    // ── Manual items — one bundled digest ─────────────────────────────────
    let manualDigestSent = 0;
    if (manualItems.length > 0) {
      try {
        PlanSender._postManualDigest_(token, channelId, manualItems, col, runDate);
        // Mark all manual rows as notified.
        for (const { rowNum } of manualItems) {
          sheet.getRange(rowNum, col.status + 1).setValue('notified');
        }
        manualDigestSent = 1;
      } catch (e) {
        log_('plan_sender', `Manual digest failed: ${e.message || e}`);
      }
    }

    // ── Insight items — mark notified, no Slack post ───────────────────────
    for (const { rowNum } of insightItems) {
      sheet.getRange(rowNum, col.status + 1).setValue('notified');
    }

    log_('plan_sender',
      `Done — auto_sent=${autoSent}, manual_digest=${manualDigestSent}, ` +
      `insight_skipped=${insightItems.length}`);
    return { auto_sent: autoSent, manual_digest_sent: manualDigestSent, skipped: insightItems.length };
  },

  /* ===== internals ===== */

  _postAutoItem_(token, channelId, row, col) {
    const priority   = String(row[col.priority]    || '');
    const title      = String(row[col.title]       || '');
    const what       = String(row[col.what]        || '');
    const action     = String(row[col.action]      || '');
    const actionType = String(row[col.action_type] || '');
    const targetName = String(row[col.target_name] || '');
    const score      = Number(row[col.score]       || 0).toFixed(2);
    const planId     = String(row[col.plan_id]     || '');

    const text =
      `[${priority}] *${title}* (score: ${score})\n` +
      `*Type:* ${actionType.replace(/_/g, ' ')}\n` +
      `*Target:* ${targetName}\n` +
      `*What:* ${what.slice(0, 300)}\n` +
      `*Action:* ${action.slice(0, 400)}\n` +
      `React ✅ to approve  ❌ to reject\n` +
      `_plan_id: ${planId}_`;

    const resp = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ channel: channelId, text: text }),
      muteHttpExceptions: true,
    });
    const body = JSON.parse(resp.getContentText());
    if (!body.ok) throw new Error('Slack postMessage error: ' + (body.error || JSON.stringify(body)));
    return String(body.ts || '');
  },

  _postManualDigest_(token, channelId, manualItems, col, runDate) {
    const p1 = manualItems.filter(r => String(r.row[col.priority]) === 'P1');
    const p2 = manualItems.filter(r => String(r.row[col.priority]) === 'P2');
    const p3 = manualItems.filter(r => String(r.row[col.priority]) === 'P3');

    let text = `*Manual actions — ${runDate}* (${manualItems.length} items)\n` +
               `_These require your hands-on attention. Full details in the Action_Plan sheet._\n\n`;

    const fmt = (items) => items.map(({ row }) =>
      `• [${row[col.priority]}] *${String(row[col.title] || '').slice(0, 80)}* ` +
      `— ${String(row[col.action_type] || '').replace(/_/g, ' ')} ` +
      `on _${String(row[col.target_name] || '').slice(0, 60)}_`
    ).join('\n');

    if (p1.length) text += `*P1 — Act today:*\n${fmt(p1)}\n\n`;
    if (p2.length) text += `*P2 — This week:*\n${fmt(p2)}\n\n`;
    if (p3.length) text += `*P3 — Consider:*\n${fmt(p3)}\n`;

    const resp = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ channel: channelId, text: text.trim() }),
      muteHttpExceptions: true,
    });
    const body = JSON.parse(resp.getContentText());
    if (!body.ok) throw new Error('Slack digest error: ' + (body.error || JSON.stringify(body)));
  },
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

function _normaliseDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v).trim();
}

/* ── manual test ─────────────────────────────────────────────────────────── */

function testPlanSender() {
  const runDate = todayString_();
  log_('test', 'PlanSender.sendPlan(' + runDate + ')');
  const r = PlanSender.sendPlan(runDate);
  log_('test', JSON.stringify(r));
}
