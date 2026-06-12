/**
 * ChangeReporter.js — posts a confirmation to Slack after a live mutate.
 *
 * Called fire-and-forget by ImplementationManager after each change is applied.
 * Uses the incoming webhook (simpler than bot token for one-way notifications).
 *
 * If SLACK_WEBHOOK_URL is not set the call is silently skipped — this keeps
 * dry-run / pre-Slack-setup environments from crashing.
 *
 * Requires Script Property: SLACK_WEBHOOK_URL.
 */

const ChangeReporter = {

  /**
   * @param {Object} change — a Pending_Changes row object (after execution)
   * @param {string} [change.change_type]
   * @param {string} [change.target_name]
   * @param {string} [change.before_value]
   * @param {string} [change.after_value]
   * @param {string} [change.plan_id]
   * @param {boolean} [change.dry_run]
   */
  reportChange(change) {
    const webhookUrl = PROPS.get('SLACK_WEBHOOK_URL');
    if (!webhookUrl) return;  // Slack not configured yet — silent no-op

    const type   = String(change.change_type  || 'change').replace(/_/g, ' ');
    const target = String(change.target_name  || change.target_id || '?');
    const before = String(change.before_value || '?');
    const after  = String(change.after_value  || '?');
    const planId = String(change.plan_id      || '');
    const isDry  = change.dry_run === true || String(change.dry_run).toLowerCase() === 'true';

    const prefix = isDry ? ':pencil: *Dry-run logged:*' : ':white_check_mark: *Done:*';
    const text   =
      `${prefix} ${type} on *${target}*\n` +
      `Before: \`${before}\`  →  After: \`${after}\`\n` +
      (planId ? `_${planId}_` : '');

    try {
      UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ text: text.trim() }),
        muteHttpExceptions: true,
      });
    } catch (e) {
      log_('change_reporter', 'webhook post failed: ' + (e.message || e));
    }
  },
};
