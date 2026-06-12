import { db } from "@/db";
import { campaigns, campaignsDaily, actionPlan, tokenUsage, config } from "@/db/schema";
import { eq, gte, sql } from "drizzle-orm";
import { getTargets } from "@/agents/rules/rulesEngine";
import { micros } from "@/agents/data";
import { todayUTC, daysAgoUTC, firstOfMonthUTC, dayOfMonthUTC, relativeTimeFromNow } from "@/lib/dates";

export const dynamic = "force-dynamic";

interface WindowStats {
  cost: number;
  conversions: number;
  conversionValue: number;
  clicks: number;
  impressions: number;
}

async function windowStats(sinceDate: string): Promise<WindowStats> {
  if (!db) return { cost: 0, conversions: 0, conversionValue: 0, clicks: 0, impressions: 0 };
  const [row] = await db
    .select({
      costMicros: sql<string>`coalesce(sum(${campaignsDaily.costMicros}), 0)`,
      conversions: sql<string>`coalesce(sum(${campaignsDaily.conversions}), 0)`,
      conversionValue: sql<string>`coalesce(sum(${campaignsDaily.conversionValue}), 0)`,
      clicks: sql<string>`coalesce(sum(${campaignsDaily.clicks}), 0)`,
      impressions: sql<string>`coalesce(sum(${campaignsDaily.impressions}), 0)`,
    })
    .from(campaignsDaily)
    .where(gte(campaignsDaily.date, sinceDate));

  return {
    cost: micros(Number(row.costMicros)),
    conversions: Number(row.conversions),
    conversionValue: Number(row.conversionValue),
    clicks: Number(row.clicks),
    impressions: Number(row.impressions),
  };
}

interface OverviewData {
  totalDailyBudget: number;
  enabledCampaigns: number;
  totalCampaigns: number;
  lastCollected: Date | null;
  stats7d: WindowStats;
  stats30d: WindowStats;
  statsMtd: WindowStats;
  pacingExpected: number;
  pacingActual: number;
  pacingTolerance: number;
  tokensUsedToday: number;
  tokenCeiling: number;
  lastAuditDate: string | null;
  lastAuditSummary: string | null;
  planCounts: { p1: number; p2: number; p3: number; pending: number };
  currency: string;
}

async function getOverviewData(): Promise<OverviewData | null> {
  if (!db) return null;

  const [budgetRow] = await db
    .select({
      totalBudgetMicros: sql<string>`coalesce(sum(${campaigns.budgetMicros}), 0)`,
      lastUpdated: sql<Date | null>`max(${campaigns.updatedAt})`,
      enabledCount: sql<string>`count(*)`,
    })
    .from(campaigns)
    .where(eq(campaigns.status, "ENABLED"));

  const [{ totalCount }] = await db
    .select({ totalCount: sql<string>`count(*)` })
    .from(campaigns);

  const [stats7d, stats30d, statsMtd, targets] = await Promise.all([
    windowStats(daysAgoUTC(7)),
    windowStats(daysAgoUTC(30)),
    windowStats(firstOfMonthUTC()),
    getTargets(),
  ]);

  const totalDailyBudget = micros(Number(budgetRow.totalBudgetMicros));
  const dayOfMonth = dayOfMonthUTC();
  const pacingExpected = totalDailyBudget * dayOfMonth;
  const pacingActual = statsMtd.cost;

  const [tokenRow] = await db
    .select({ totalTokens: sql<string>`coalesce(sum(${tokenUsage.totalTokens}), 0)` })
    .from(tokenUsage)
    .where(eq(tokenUsage.date, todayUTC()));

  const configRows = await db
    .select({ key: config.key, value: config.value })
    .from(config)
    .where(sql`${config.key} in ('GROQ_DAILY_TOKEN_CEILING', 'LAST_AUDIT_DATE', 'LAST_AUDIT_SUMMARY', 'RULE_PACING_TOLERANCE')`);
  const configMap = new Map(configRows.map((r) => [r.key, r.value]));

  const planCountRows = await db
    .select({
      priority: actionPlan.priority,
      status: actionPlan.status,
      count: sql<string>`count(*)`,
    })
    .from(actionPlan)
    .groupBy(actionPlan.priority, actionPlan.status);

  const planCounts = { p1: 0, p2: 0, p3: 0, pending: 0 };
  for (const row of planCountRows) {
    const n = Number(row.count);
    if (row.priority === "P1") planCounts.p1 += n;
    if (row.priority === "P2") planCounts.p2 += n;
    if (row.priority === "P3") planCounts.p3 += n;
    if (row.status === "pending") planCounts.pending += n;
  }

  return {
    totalDailyBudget,
    enabledCampaigns: Number(budgetRow.enabledCount),
    totalCampaigns: Number(totalCount),
    lastCollected: budgetRow.lastUpdated ? new Date(budgetRow.lastUpdated) : null,
    stats7d,
    stats30d,
    statsMtd,
    pacingExpected,
    pacingActual,
    pacingTolerance: parseFloat(configMap.get("RULE_PACING_TOLERANCE") || "0.30") || 0.30,
    tokensUsedToday: Number(tokenRow?.totalTokens || 0),
    tokenCeiling: parseFloat(configMap.get("GROQ_DAILY_TOKEN_CEILING") || "90000") || 90000,
    lastAuditDate: configMap.get("LAST_AUDIT_DATE") || null,
    lastAuditSummary: configMap.get("LAST_AUDIT_SUMMARY") || null,
    planCounts,
    currency: targets.currency_symbol,
  };
}

function fmtCurrency(n: number, symbol: string): string {
  return `${symbol}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function roas(value: number, cost: number): string {
  if (cost <= 0) return "—";
  return (value / cost).toFixed(2) + "x";
}

function cpa(cost: number, conversions: number): string {
  if (conversions <= 0) return "—";
  return (cost / conversions).toFixed(2);
}

function KpiRow({ label, stats, currency }: { label: string; stats: WindowStats; currency: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{label}</h3>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-zinc-500">Spend</dt>
          <dd className="text-lg font-semibold text-black dark:text-zinc-50">{fmtCurrency(stats.cost, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Conversions</dt>
          <dd className="text-lg font-semibold text-black dark:text-zinc-50">{stats.conversions.toFixed(1)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">ROAS</dt>
          <dd className="text-lg font-semibold text-black dark:text-zinc-50">{roas(stats.conversionValue, stats.cost)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">CPA</dt>
          <dd className="text-lg font-semibold text-black dark:text-zinc-50">{cpa(stats.cost, stats.conversions) === "—" ? "—" : currency + cpa(stats.cost, stats.conversions)}</dd>
        </div>
      </dl>
    </div>
  );
}

export default async function Home() {
  const data = await getOverviewData();

  if (!data) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">Overview</h1>
        <p className="mt-4 text-sm text-amber-600 dark:text-amber-400">
          Not connected to the database. Set <code>DATABASE_URL</code> in <code>.env.local</code>.
        </p>
      </main>
    );
  }

  const pacingDelta = data.pacingExpected > 0 ? (data.pacingActual - data.pacingExpected) / data.pacingExpected : 0;
  const pacingOutOfBounds = Math.abs(pacingDelta) > data.pacingTolerance;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">Overview</h1>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Total daily budget</h2>
          <p className="mt-2 text-2xl font-semibold text-black dark:text-zinc-50">
            {fmtCurrency(data.totalDailyBudget, data.currency)}/day
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {data.enabledCampaigns} of {data.totalCampaigns} campaigns enabled — as of{" "}
            {data.lastCollected ? relativeTimeFromNow(data.lastCollected) : "unknown"}
          </p>
        </div>

        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Month-to-date pacing</h2>
          <p className="mt-2 text-2xl font-semibold text-black dark:text-zinc-50">
            {fmtCurrency(data.pacingActual, data.currency)}{" "}
            <span className="text-sm font-normal text-zinc-500">
              vs {fmtCurrency(data.pacingExpected, data.currency)} expected
            </span>
          </p>
          <p className={`mt-1 text-xs ${pacingOutOfBounds ? "text-amber-600 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400"}`}>
            {pacingDelta >= 0 ? "+" : ""}
            {(pacingDelta * 100).toFixed(1)}% vs. budget-implied pace
            {pacingOutOfBounds ? ` (outside ±${(data.pacingTolerance * 100).toFixed(0)}% tolerance)` : ""}
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <KpiRow label="Last 7 days" stats={data.stats7d} currency={data.currency} />
        <KpiRow label="Last 30 days" stats={data.stats30d} currency={data.currency} />
        <KpiRow label="Month to date" stats={data.statsMtd} currency={data.currency} />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Latest audit</h2>
          {data.lastAuditDate ? (
            <>
              <p className="mt-2 text-sm text-black dark:text-zinc-50">{data.lastAuditDate}</p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{data.lastAuditSummary}</p>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                {data.planCounts.pending} pending action(s) — {data.planCounts.p1} P1, {data.planCounts.p2} P2,{" "}
                {data.planCounts.p3} P3
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">No audit has run yet.</p>
          )}
        </div>

        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Groq token usage today</h2>
          <p className="mt-2 text-2xl font-semibold text-black dark:text-zinc-50">
            {data.tokensUsedToday.toLocaleString()}{" "}
            <span className="text-sm font-normal text-zinc-500">/ {data.tokenCeiling.toLocaleString()}</span>
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Resets at 00:00 UTC.</p>
        </div>
      </div>
    </main>
  );
}
