import { db } from "@/db";
import { campaigns, campaignsDaily, actionPlan, tokenUsage, config } from "@/db/schema";
import { eq, gte, sql, desc, and } from "drizzle-orm";
import { getTargets } from "@/agents/rules/rulesEngine";
import { micros } from "@/agents/data";
import { todayUTC, daysAgoUTC, firstOfMonthUTC, dayOfMonthUTC, relativeTimeFromNow } from "@/lib/dates";
import Link from "next/link";
import { SpendChart } from "./components/SpendChart";
import { CampaignTable } from "./components/CampaignTable";
import { PerfTabs } from "./components/PerfTabs";
import type { CampaignRow as CampRow } from "./components/CampaignTable";
import type { WindowStats } from "./components/PerfTabs";

export const dynamic = "force-dynamic";

/* ── helpers ── */
function fmtNum(n: number, d = 0) { return n.toLocaleString(undefined, { maximumFractionDigits: d }); }
function fmtC(n: number, sym: string) { return `${sym}${fmtNum(n)}`; }

async function windowStats(sinceDate: string): Promise<WindowStats> {
  if (!db) return { cost: 0, conversions: 0, conversionValue: 0, clicks: 0, impressions: 0 };
  const [row] = await db.select({
    costMicros: sql<string>`coalesce(sum(${campaignsDaily.costMicros}),0)`,
    conversions: sql<string>`coalesce(sum(${campaignsDaily.conversions}),0)`,
    conversionValue: sql<string>`coalesce(sum(${campaignsDaily.conversionValue}),0)`,
    clicks: sql<string>`coalesce(sum(${campaignsDaily.clicks}),0)`,
    impressions: sql<string>`coalesce(sum(${campaignsDaily.impressions}),0)`,
  }).from(campaignsDaily).where(gte(campaignsDaily.date, sinceDate));
  return {
    cost: micros(Number(row.costMicros)),
    conversions: Number(row.conversions),
    conversionValue: Number(row.conversionValue),
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
  };
}

/* ── data fetch ── */
async function getPageData() {
  if (!db) return null;

  const today = todayUTC();
  const [
    campaignRows,
    stats7d, stats30d, statsMtd,
    targets,
  ] = await Promise.all([
    db.select().from(campaigns),
    windowStats(daysAgoUTC(7)),
    windowStats(daysAgoUTC(30)),
    windowStats(firstOfMonthUTC()),
    getTargets(),
  ]);

  // Daily spend trend (last 30 days, all campaigns aggregated)
  const spendRows = await db.select({
    date: campaignsDaily.date,
    spend: sql<string>`coalesce(sum(${campaignsDaily.costMicros}),0)`,
  })
    .from(campaignsDaily)
    .where(gte(campaignsDaily.date, daysAgoUTC(30)))
    .groupBy(campaignsDaily.date)
    .orderBy(campaignsDaily.date);

  const spendTrend = spendRows.map((r) => ({ date: r.date, spend: micros(Number(r.spend)) }));

  // P1 pending action items
  const p1Items = await db.select({
    planId: actionPlan.planId,
    title: actionPlan.title,
    what: actionPlan.what,
    actionType: actionPlan.actionType,
    actionCategory: actionPlan.actionCategory,
  })
    .from(actionPlan)
    .where(and(eq(actionPlan.priority, "P1"), eq(actionPlan.status, "pending")))
    .orderBy(desc(actionPlan.score))
    .limit(5);

  // Plan counts
  const planCountRows = await db.select({
    priority: actionPlan.priority,
    status: actionPlan.status,
    count: sql<string>`count(*)`,
  }).from(actionPlan).groupBy(actionPlan.priority, actionPlan.status);

  const planCounts = { p1: 0, p2: 0, p3: 0, pending: 0 };
  for (const r of planCountRows) {
    const n = Number(r.count);
    if (r.priority === "P1") planCounts.p1 += n;
    if (r.priority === "P2") planCounts.p2 += n;
    if (r.priority === "P3") planCounts.p3 += n;
    if (r.status === "pending") planCounts.pending += n;
  }

  // Config
  const cfgRows = await db.select({ key: config.key, value: config.value }).from(config).where(
    sql`${config.key} in ('GROQ_DAILY_TOKEN_CEILING','LAST_AUDIT_DATE','LAST_AUDIT_SUMMARY','RULE_PACING_TOLERANCE','MONTHLY_BUDGET_TARGET')`
  );
  const cfg = new Map(cfgRows.map((r) => [r.key, r.value]));

  // Token usage
  const [tokenRow] = await db.select({ total: sql<string>`coalesce(sum(${tokenUsage.totalTokens}),0)` })
    .from(tokenUsage).where(eq(tokenUsage.date, today));

  // Budget summary
  const enabled = campaignRows.filter((c) => c.status === "ENABLED");
  const totalDailyBudget = enabled.reduce((s, c) => s + micros(c.budgetMicros), 0);
  const lastCollected = enabled.reduce((d: Date | null, c) => {
    const t = new Date(c.updatedAt);
    return !d || t > d ? t : d;
  }, null);

  const monthlyBudgetTarget = parseFloat(cfg.get("MONTHLY_BUDGET_TARGET") || "0") || 0;
  const monthlyBudgetIsDefault = monthlyBudgetTarget <= 0;
  const effectiveMonthlyTarget = monthlyBudgetIsDefault ? totalDailyBudget * 30 : monthlyBudgetTarget;
  const dayOfMonth = dayOfMonthUTC();
  const pacingExpected = effectiveMonthlyTarget > 0 ? (effectiveMonthlyTarget / 30) * dayOfMonth : 0;
  const pacingActual = statsMtd.cost;
  const pacingDelta = pacingExpected > 0 ? (pacingActual - pacingExpected) / pacingExpected : 0;
  const pacingTolerance = parseFloat(cfg.get("RULE_PACING_TOLERANCE") || "0.30") || 0.30;

  // Campaign table rows
  const tableRows: CampRow[] = campaignRows.map((c) => ({
    campaignId: c.campaignId,
    campaignName: c.campaignName,
    channelType: c.channelType,
    biddingStrategy: c.biddingStrategy,
    budgetPerDay: micros(c.budgetMicros),
    spend: micros(c.costMicros),
    conversions: Number(c.conversions) || 0,
    conversionValue: Number(c.conversionValue) || 0,
    clicks: Number(c.clicks) || 0,
    impressions: Number(c.impressions) || 0,
    ctr: Number(c.ctr) || 0,
    avgCpc: micros(c.avgCpcMicros),
    budgetLostIs: Number(c.searchBudgetLostIs) || 0,
    rankLostIs: Number(c.searchRankLostIs) || 0,
    searchIs: Number(c.searchIs) || 0,
  }));

  const cur = targets.currency_symbol;

  return {
    cur,
    totalDailyBudget,
    enabledCampaigns: enabled.length,
    totalCampaigns: campaignRows.length,
    lastCollected,
    stats7d, stats30d, statsMtd,
    spendTrend,
    p1Items,
    planCounts,
    pacingExpected,
    pacingActual,
    pacingDelta,
    pacingTolerance,
    effectiveMonthlyTarget,
    monthlyBudgetIsDefault,
    tokenUsed: Number(tokenRow?.total || 0),
    tokenCeiling: parseFloat(cfg.get("GROQ_DAILY_TOKEN_CEILING") || "90000") || 90000,
    lastAuditDate: cfg.get("LAST_AUDIT_DATE") || null,
    lastAuditSummary: cfg.get("LAST_AUDIT_SUMMARY") || null,
    tableRows,
  };
}

/* ── stat card ── */
function StatCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: "red" | "amber" | "green" }) {
  const subColor = highlight === "red" ? "text-red-500" : highlight === "amber" ? "text-amber-500" : highlight === "green" ? "text-emerald-500" : "text-zinc-400";
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">{label}</p>
      <p className="mt-1.5 text-2xl font-bold text-zinc-900 dark:text-zinc-50">{value}</p>
      {sub && <p className={`mt-1 text-xs ${subColor}`}>{sub}</p>}
    </div>
  );
}

/* ── section header ── */
function SectionHeader({ title }: { title: string }) {
  return <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-3">{title}</h2>;
}

/* ── main page ── */
export default async function Home() {
  const d = await getPageData();

  if (!d) {
    return (
      <main className="mx-auto max-w-7xl px-6 py-16">
        <p className="text-sm text-amber-600">Not connected — set DATABASE_URL in .env.local.</p>
      </main>
    );
  }

  const pacingOutOfBounds = Math.abs(d.pacingDelta) > d.pacingTolerance;
  const pacingHighlight = pacingOutOfBounds ? (d.pacingDelta > 0 ? "red" : "amber") : "green";
  const pacingSub = `${d.pacingDelta >= 0 ? "+" : ""}${(d.pacingDelta * 100).toFixed(1)}% vs expected ${fmtC(d.pacingExpected, d.cur)}`;

  const roas30 = d.stats30d.cost > 0 ? (d.stats30d.conversionValue / d.stats30d.cost).toFixed(2) + "x" : "—";
  const cpa30 = d.stats30d.conversions > 0 ? fmtC(d.stats30d.cost / d.stats30d.conversions, d.cur) : "—";
  const ctr30 = d.stats30d.impressions > 0 ? ((d.stats30d.clicks / d.stats30d.impressions) * 100).toFixed(2) + "%" : "—";

  const tokenPct = d.tokenCeiling > 0 ? Math.round((d.tokenUsed / d.tokenCeiling) * 100) : 0;

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 py-8 space-y-8">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">Google Ads Dashboard</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {d.enabledCampaigns} of {d.totalCampaigns} campaigns enabled
            {d.lastCollected ? ` · Data collected ${relativeTimeFromNow(d.lastCollected)}` : ""}
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <Link href="/action-plan" className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-white font-medium hover:bg-indigo-700">
            Action Plan
            {d.planCounts.pending > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-white text-indigo-700 font-bold w-4 h-4 text-[10px]">
                {d.planCounts.pending}
              </span>
            )}
          </Link>
        </div>
      </div>

      {/* ── Monthly budget warning ── */}
      {d.monthlyBudgetIsDefault && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Monthly budget target not set — pacing is estimated from daily budgets × 30.{" "}
          <Link href="/config" className="font-medium underline">Set MONTHLY_BUDGET_TARGET in /config</Link> for accurate pacing.
        </div>
      )}

      {/* ── P1 Alerts ── */}
      {d.p1Items.length > 0 ? (
        <div>
          <SectionHeader title={`⚠ P1 Actions — ${d.p1Items.length} pending`} />
          <div className="space-y-2">
            {d.p1Items.map((item) => (
              <div key={item.planId} className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-red-700 dark:text-red-400">{item.title}</p>
                  <p className="text-xs text-red-600 dark:text-red-500 mt-0.5 line-clamp-2">{item.what}</p>
                </div>
                <Link href="/action-plan" className="shrink-0 text-xs font-medium text-red-700 dark:text-red-400 border border-red-300 dark:border-red-700 rounded px-2 py-1 hover:bg-red-100 dark:hover:bg-red-900/40">
                  Review →
                </Link>
              </div>
            ))}
          </div>
        </div>
      ) : d.lastAuditDate ? (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
          All P1 actions resolved or no audit issues found.
        </div>
      ) : null}

      {/* ── 6 KPI cards (30d) ── */}
      <div>
        <SectionHeader title="30-Day KPIs" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Spend" value={fmtC(d.stats30d.cost, d.cur)} />
          <StatCard label="Conversions" value={fmtNum(d.stats30d.conversions, 1)} />
          <StatCard label="Conv. Value" value={fmtC(d.stats30d.conversionValue, d.cur)} />
          <StatCard label="ROAS" value={roas30} />
          <StatCard label="CPA" value={cpa30} />
          <StatCard label="CTR" value={ctr30} />
        </div>
      </div>

      {/* ── Budget + Pacing ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Total daily budget"
          value={`${fmtC(d.totalDailyBudget, d.cur)}/day`}
          sub={`${fmtC(d.effectiveMonthlyTarget, d.cur)}/month target${d.monthlyBudgetIsDefault ? " (estimated)" : ""}`}
        />
        <StatCard
          label="MTD pacing"
          value={fmtC(d.pacingActual, d.cur)}
          sub={pacingSub}
          highlight={pacingHighlight}
        />
      </div>

      {/* ── Tabbed performance ── */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <SectionHeader title="Performance by Window" />
        <PerfTabs stats7d={d.stats7d} stats30d={d.stats30d} statsMtd={d.statsMtd} currency={d.cur} />
      </div>

      {/* ── Spend trend chart ── */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <SectionHeader title="Daily Spend — Last 30 Days" />
        <SpendChart data={d.spendTrend} currency={d.cur} />
      </div>

      {/* ── Campaign breakdown ── */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <SectionHeader title="Campaign Breakdown" />
        <p className="text-xs text-zinc-400 mb-3">Metrics are for the last collect window. Click column headers to sort.</p>
        <CampaignTable rows={d.tableRows} currency={d.cur} />
      </div>

      {/* ── Audit + System status ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <SectionHeader title="Latest Audit" />
          {d.lastAuditDate ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{d.lastAuditDate}</p>
              <p className="text-xs text-zinc-500">{d.lastAuditSummary}</p>
              <div className="flex gap-3 mt-3">
                {(["P1", "P2", "P3"] as const).map((p, i) => {
                  const count = [d.planCounts.p1, d.planCounts.p2, d.planCounts.p3][i];
                  const color = p === "P1" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" : p === "P2" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
                  return (
                    <span key={p} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
                      {p} <span className="font-bold">{count}</span>
                    </span>
                  );
                })}
                <span className="text-xs text-zinc-400">{d.planCounts.pending} pending approval</span>
              </div>
              <Link href="/action-plan" className="mt-2 inline-block text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                View Action Plan →
              </Link>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No audit has run yet.</p>
          )}
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <SectionHeader title="Groq Token Usage" />
          <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
            {fmtNum(d.tokenUsed)} <span className="text-sm font-normal text-zinc-400">/ {fmtNum(d.tokenCeiling)}</span>
          </p>
          <div className="mt-2 h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${tokenPct > 90 ? "bg-red-500" : tokenPct > 70 ? "bg-amber-400" : "bg-indigo-500"}`}
              style={{ width: `${Math.min(tokenPct, 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-zinc-400">{tokenPct}% used today · Resets at 00:00 UTC</p>
        </div>
      </div>

    </main>
  );
}
