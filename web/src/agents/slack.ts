import { db } from "@/db";
import { actionPlan } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export interface SlackNotificationPayload {
  text: string;
  blocks?: unknown[];
}

export async function sendSlackNotification(
  payload: SlackNotificationPayload
): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("[slack] SLACK_WEBHOOK_URL not set, skipping notification");
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack API error: ${response.status}`);
    }

    console.log("[slack] Notification sent");
  } catch (err) {
    console.error("[slack] Failed to send notification:", err);
    throw err;
  }
}

export async function notifyActionPlanDigest(
  runDate: string,
  dashboardUrl: string = "https://web-seven-rho-96.vercel.app"
): Promise<void> {
  if (!db) {
    console.log("[slack] Database not configured, skipping notification");
    return;
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("[slack] SLACK_WEBHOOK_URL not set, skipping notification");
    return;
  }

  try {
    const plans = await db
      .select()
      .from(actionPlan)
      .where(
        and(
          eq(actionPlan.runDate, runDate),
          eq(actionPlan.status, "pending")
        )
      );

    if (plans.length === 0) {
      console.log("[slack] No pending items for notification");
      return;
    }

    // Count by category
    const byCategory = plans.reduce(
      (acc, p) => {
        acc[p.actionCategory] = (acc[p.actionCategory] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const blocks: unknown[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*New Action Items Ready for Review* (${plans.length} total)\n_Run date: ${runDate}_`,
        },
      },
      { type: "divider" },
      {
        type: "section",
        fields: Object.entries(byCategory).map(([cat, count]) => ({
          type: "mrkdwn",
          text: `*${cat.toUpperCase()}*\n${count} item${count !== 1 ? "s" : ""}`,
        })),
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Review in Dashboard" },
            url: `${dashboardUrl}/action-plan`,
            style: "primary",
          },
        ],
      },
    ];

    await sendSlackNotification({
      text: `New action items ready: ${plans.length} total`,
      blocks,
    });
  } catch (err) {
    console.error("[slack] Failed to send digest notification:", err);
    // Don't throw — logging failure is enough for a non-critical notification
  }
}
