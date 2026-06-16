import { db } from "@/db";
import { actionPlan, brainEntries, campaignsDaily, config } from "@/db/schema";
import { and, eq, gte, desc, sql } from "drizzle-orm";
import { micros } from "./data";

/* ── low-level send ── */
export async function sendSlackNotification(payload: { text: string; blocks?: unknown[] }): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("[slack] SLACK_WEBHOOK_URL not set, skipping");
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log("[slack] Notification sent");
  } catch (err) {
    console.error("[slack] Failed:", err);
  }
}

/* ── helpers ── */
function fmt(n: number) { return n.toLocaleString("en-IN", { maximumFractionDigits: 0 }); }
function fmtC(n: number, sym: string) { return `${sym}${fmt(n)}`; }

function priorityBar(p1: number, p2: number, p3: number): string {
  const parts = [];
  if (p1 > 0) parts.push(`🔴 P1: *${p1}*`);
  if (p2 > 0) parts.push(`🟡 P2: *${p2}*`);
  if (p3 > 0) parts.push(`⚪ P3: *${p3}*`);
  return parts.join("   ");
}

/* ── Daily Audit Digest ── */
export async function notifyActionPlanDigest(
  runDate: string,
  dashboardUrl: string = "https://web-seven-rho-96.vercel.app"
): Promise<void> {
  if (!db || !process.env.SLACK_WEBHOOK_URL) return;

  // Action plan items for this run
  const plans = await db.select().from(actionPlan).where(
    and(eq(actionPlan.runDate, runDate), eq(actionPlan.status, "pending"))
  );
  if (plans.length === 0) {
    console.log("[slack] No pending items, skipping notification");
    return;
  }

  // P1/P2/P3 counts
  const p1 = plans.filter((p) => p.priority === "P1");
  const p2 = plans.filter((p) => p.priority === "P2");
  const p3 = plans.filter((p) => p.priority === "P3");

  // Category breakdown
  const auto = plans.filter((p) => p.actionCategory === "auto").length;
  const manual = plans.filter((p) => p.actionCategory === "manual").length;
  const insight = plans.filter((p) => p.actionCategory === "insight").length;

  // Top P1 actions (max 3)
  const topP1 = p1.slice(0, 3);

  // 30-day KPIs from campaigns_daily
  const since30 = new Date();
  since30.setUTCDate(since30.getUTCDate() - 30);
  const sinceStr = since30.toISOString().split("T")[0];
  const [kpiRow] = await db.select({
    cost: sql<string>`coalesce(sum(${campaignsDaily.costMicros}),0)`,
    conv: sql<string>`coalesce(sum(${campaignsDaily.conversions}),0)`,
    convVal: sql<string>`coalesce(sum(${campaignsDaily.conversionValue}),0)`,
    clicks: sql<string>`coalesce(sum(${campaignsDaily.clicks}),0)`,
  }).from(campaignsDaily).where(gte(campaignsDaily.date, sinceStr));

  const cost = micros(Number(kpiRow?.cost || 0));
  const conv = Number(kpiRow?.conv || 0);
  const convVal = Number(kpiRow?.convVal || 0);
  const roas = cost > 0 && convVal > 0 ? (convVal / cost).toFixed(2) + "x" : "—";
  const cpa = conv > 0 ? fmtC(cost / conv, "₹") : "—";

  // Currency from config
  const cfgRows = await db.select({ key: config.key, value: config.value }).from(config).where(
    sql`${config.key} in ('CURRENCY_SYMBOL', 'LAST_AUDIT_SUMMARY')`
  );
  const cfg = new Map(cfgRows.map((r) => [r.key, r.value]));
  const cur = cfg.get("CURRENCY_SYMBOL") || "₹";
  const auditSummary = cfg.get("LAST_AUDIT_SUMMARY") || "";

  // Brain entries count
  const [brainRow] = await db.select({ n: sql<string>`count(*)` }).from(brainEntries).where(eq(brainEntries.status, "active"));
  const brainCount = Number(brainRow?.n || 0);

  // Format date nicely
  const dateLabel = new Date(runDate + "T00:00:00Z").toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
  });

  const blocks: unknown[] = [
    // Header
    {
      type: "header",
      text: { type: "plain_text", text: `🎯 Daily Ads Audit — ${dateLabel}`, emoji: true },
    },

    // Audit summary line
    ...(auditSummary ? [{
      type: "section",
      text: { type: "mrkdwn", text: `_${auditSummary}_` },
    }] : []),

    { type: "divider" },

    // 30-day KPIs
    {
      type: "section",
      text: { type: "mrkdwn", text: "*📊 Account Performance — Last 30 Days*" },
      fields: [
        { type: "mrkdwn", text: `*Spend*\n${fmtC(cost, cur)}` },
        { type: "mrkdwn", text: `*Conversions*\n${fmt(conv)}` },
        { type: "mrkdwn", text: `*ROAS*\n${roas}` },
        { type: "mrkdwn", text: `*CPA*\n${cpa}` },
      ],
    },

    { type: "divider" },

    // Action plan summary
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📋 Action Plan — ${plans.length} items pending your approval*\n${priorityBar(p1.length, p2.length, p3.length)}\n🤖 Auto: ${auto}   👤 Manual: ${manual}   💡 Insight: ${insight}`,
      },
    },

    // Top P1 actions
    ...(topP1.length > 0 ? [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🚨 Top P1 Actions (act today):*\n${topP1.map((p) =>
          `• *${p.title}*${p.targetName ? `\n  ↳ ${p.targetType}: _${p.targetName}_` : ""}`
        ).join("\n")}`,
      },
    }] : []),

    { type: "divider" },

    // Brain + CTA
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🧠 Brain: *${brainCount} active entries* · findings grounded in Baidyanath-specific strategy`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Review & Approve", emoji: true },
          url: `${dashboardUrl}/action-plan`,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "📊 Dashboard", emoji: true },
          url: dashboardUrl,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🧠 Brain", emoji: true },
          url: `${dashboardUrl}/brain`,
        },
      ],
    },
  ];

  await sendSlackNotification({
    text: `🎯 Daily audit done — ${plans.length} actions pending (P1: ${p1.length}, P2: ${p2.length}, P3: ${p3.length}) | 30d ROAS ${roas} | CPA ${cpa}`,
    blocks,
  });
}

/* ── Brain Learning Agent notification ── */
export async function notifyBrainLearning(
  staged: number,
  skipped: number,
  errors: string[],
  dashboardUrl: string = "https://web-seven-rho-96.vercel.app"
): Promise<void> {
  if (!process.env.SLACK_WEBHOOK_URL || staged === 0) return;

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🧠 Brain Learning Agent — Weekly Run", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Discovered *${staged} new insight${staged !== 1 ? "s" : ""}* from 3 sources:\n• 📊 Account performance patterns\n• ✅ Approved findings feedback\n• 🌐 Web search (Ayurvedic PPC, bidding, copy)\n\n${skipped > 0 ? `_${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped_` : ""}${errors.length > 0 ? `\n⚠️ ${errors.length} error${errors.length !== 1 ? "s" : ""} (check Actions log)` : ""}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Review Staged Entries →", emoji: true },
          url: `${dashboardUrl}/brain?tab=staged`,
          style: "primary",
        },
      ],
    },
  ];

  await sendSlackNotification({
    text: `🧠 Brain Learning Agent staged ${staged} new insights for your review`,
    blocks,
  });
}
