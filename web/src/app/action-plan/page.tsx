import { db } from "@/db";
import { actionPlan } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { getTargets } from "@/agents/rules/rulesEngine";
import ApproveButtons from "./ApproveButtons";

type Category = "auto" | "manual" | "insight";
const CATEGORIES: Category[] = ["auto", "manual", "insight"];

const PRIORITY_STYLES: Record<string, string> = {
  P1: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  P2: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  P3: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  approved: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  rejected: "bg-zinc-100 text-zinc-400 line-through dark:bg-zinc-800 dark:text-zinc-500",
};

async function getCounts(): Promise<Record<Category, number>> {
  const counts: Record<Category, number> = { auto: 0, manual: 0, insight: 0 };
  if (!db) return counts;
  const rows = await db
    .select({ category: actionPlan.actionCategory, count: sql<string>`count(*)` })
    .from(actionPlan)
    .groupBy(actionPlan.actionCategory);
  for (const row of rows) {
    if (row.category in counts) counts[row.category as Category] = Number(row.count);
  }
  return counts;
}

async function getRows(category: Category) {
  if (!db) return [];
  return db
    .select()
    .from(actionPlan)
    .where(and(eq(actionPlan.actionCategory, category)))
    .orderBy(desc(actionPlan.score));
}

function fmtCurrency(n: number, symbol: string): string {
  return `${symbol}${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default async function ActionPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab: Category = CATEGORIES.includes(params.tab as Category) ? (params.tab as Category) : "auto";

  if (!db) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">Action Plan</h1>
        <p className="mt-4 text-sm text-amber-600 dark:text-amber-400">
          Not connected to the database. Set <code>DATABASE_URL</code> in <code>.env.local</code>.
        </p>
      </main>
    );
  }

  const [counts, rows, targets] = await Promise.all([getCounts(), getRows(tab), getTargets()]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">Action Plan</h1>

      <div className="mt-6 flex gap-2 border-b border-zinc-200 dark:border-zinc-800">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/action-plan?tab=${c}`}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${
              tab === c
                ? "border-black text-black dark:border-zinc-50 dark:text-zinc-50"
                : "border-transparent text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            }`}
          >
            {c} ({counts[c]})
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">No {tab} items in the action plan.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {rows.map((row) => (
            <li key={row.planId} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${PRIORITY_STYLES[row.priority] || ""}`}>
                    {row.priority}
                  </span>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status] || ""}`}>
                    {row.status}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{row.actionType}</span>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">score {row.score.toFixed(2)}</span>
                </div>
                {row.status === "pending" && <ApproveButtons planId={row.planId} />}
              </div>

              <h3 className="mt-2 font-medium text-black dark:text-zinc-50">{row.title}</h3>
              {row.targetName && (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Target: {row.targetType} — {row.targetName}
                </p>
              )}

              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Details</summary>
                <div className="mt-2 space-y-2 text-zinc-700 dark:text-zinc-300">
                  <p>
                    <span className="font-medium">What: </span>
                    {row.what}
                  </p>
                  <p>
                    <span className="font-medium">Why: </span>
                    {row.why}
                  </p>
                  <p>
                    <span className="font-medium">Action: </span>
                    {row.action}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Plan ID: {row.planId} · Run date: {row.runDate}
                  </p>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-xs text-zinc-400 dark:text-zinc-600">
        Currency: {targets.currency_symbol} · {fmtCurrency(targets.target_cpa, targets.currency_symbol)} target CPA ·{" "}
        {targets.target_roas.toFixed(2)}x target ROAS
      </p>
    </main>
  );
}
