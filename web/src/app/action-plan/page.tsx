import { db } from "@/db";
import { actionPlan, findings } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { getTargets } from "@/agents/rules/rulesEngine";
import ApproveButtons from "./ApproveButtons";
import { BulkApproveButton } from "./BulkApproveButton";
import ProposedChangesEditor from "./ProposedChangesEditor";

export const dynamic = "force-dynamic";

type Category = "all" | "auto" | "manual" | "insight";
type Priority = "all" | "P1" | "P2" | "P3";
type StatusFilter = "pending" | "approved" | "rejected" | "all";

const CATEGORIES: Category[] = ["all", "auto", "manual", "insight"];
const PRIORITIES: Priority[] = ["all", "P1", "P2", "P3"];

/* ── data ── */
async function getRows(category: Category, priority: Priority, status: StatusFilter) {
  if (!db) return [];
  const conditions = [];
  if (category !== "all") conditions.push(eq(actionPlan.actionCategory, category));
  if (priority !== "all") conditions.push(eq(actionPlan.priority, priority));
  if (status !== "all") conditions.push(eq(actionPlan.status, status));

  return db
    .select({
      planId: actionPlan.planId,
      runDate: actionPlan.runDate,
      priority: actionPlan.priority,
      title: actionPlan.title,
      what: actionPlan.what,
      why: actionPlan.why,
      action: actionPlan.action,
      actionCategory: actionPlan.actionCategory,
      actionType: actionPlan.actionType,
      targetType: actionPlan.targetType,
      targetName: actionPlan.targetName,
      score: actionPlan.score,
      status: actionPlan.status,
      missingData: actionPlan.missingData,
      alternativeExplanations: actionPlan.alternativeExplanations,
      validationFlags: actionPlan.validationFlags,
      proposedChanges: actionPlan.proposedChanges,
      evidence: findings.evidence,
      impactMetric: findings.impactMetric,
      impactDirection: findings.impactDirection,
      impactMagnitude: findings.impactMagnitude,
      confidence: findings.confidence,
      effort: findings.effort,
      agent: findings.agent,
      brainSources: findings.brainSources,
    })
    .from(actionPlan)
    .leftJoin(findings, eq(actionPlan.findingId, findings.findingId))
    .where(conditions.length ? and(...(conditions as [typeof conditions[0], ...typeof conditions])) : undefined)
    .orderBy(
      sql`CASE ${actionPlan.priority} WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END`,
      desc(actionPlan.score)
    );
}

async function getCounts() {
  if (!db) return { byCategory: {} as Record<string, number>, byPriority: {} as Record<string, number>, pending: 0 };
  const [catRows, priRows, pendingRows] = await Promise.all([
    db.select({ k: actionPlan.actionCategory, n: sql<string>`count(*)` }).from(actionPlan).groupBy(actionPlan.actionCategory),
    db.select({ k: actionPlan.priority, n: sql<string>`count(*)` }).from(actionPlan).groupBy(actionPlan.priority),
    db.select({ n: sql<string>`count(*)` }).from(actionPlan).where(eq(actionPlan.status, "pending")),
  ]);
  return {
    byCategory: Object.fromEntries(catRows.map((r) => [r.k, Number(r.n)])),
    byPriority: Object.fromEntries(priRows.map((r) => [r.k, Number(r.n)])),
    pending: Number(pendingRows[0]?.n || 0),
  };
}

/* ── chips ── */
function PriorityBadge({ p }: { p: string }) {
  const s = p === "P1"
    ? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 ring-1 ring-red-300 dark:ring-red-700"
    : p === "P2"
    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300 ring-1 ring-amber-300 dark:ring-amber-700"
    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${s}`}>{p}</span>;
}

function ImpactChip({ metric, direction, magnitude }: { metric?: string | null; direction?: string | null; magnitude?: string | null }) {
  if (!metric) return null;
  const arrow = direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  const color = magnitude === "high"
    ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
    : magnitude === "medium"
    ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${color}`}>
      {metric} {arrow} {magnitude}
    </span>
  );
}

function Chip({ label, color = "zinc" }: { label: string; color?: "zinc" | "green" | "blue" }) {
  const s = color === "green" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
    : color === "blue" ? "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${s}`}>{label}</span>;
}

function StatusDot({ status }: { status: string }) {
  if (status === "approved") return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />approved</span>;
  if (status === "rejected") return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400"><span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />rejected</span>;
  return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />pending</span>;
}

type ProposedChange = { type: string; params: Record<string, unknown> };

/**
 * Renders `proposed_changes` verbatim — the exact structured change implementation.ts will execute,
 * not the free-text `action` prose (which is capped at 1000 chars by normalizeFinding and isn't
 * reliable for "what exactly goes live", especially for create_rsa headlines/descriptions).
 */
function ProposedChangesPanel({ changes }: { changes: ProposedChange[] }) {
  if (!changes || changes.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-emerald-100 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20 px-3 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1.5">
        Exact change to execute ({changes.length})
      </p>
      <div className="space-y-2">
        {changes.map((c, i) => (
          <ProposedChangeEntry key={i} change={c} />
        ))}
      </div>
    </div>
  );
}

function ProposedChangeEntry({ change }: { change: ProposedChange }) {
  const p = change.params || {};
  const s = (v: unknown) => (v == null ? "" : String(v));

  switch (change.type) {
    case "create_rsa": {
      const headlines = Array.isArray(p.headlines) ? (p.headlines as string[]) : [];
      const descriptions = Array.isArray(p.descriptions) ? (p.descriptions as string[]) : [];
      return (
        <div className="text-xs text-zinc-700 dark:text-zinc-300">
          <p className="font-medium">New RSA (created PAUSED) — ad group {s(p.ad_group_id)}</p>
          <p className="mt-1"><span className="text-zinc-400">Headlines:</span> {headlines.map((h) => `“${h}”`).join("  ")}</p>
          <p className="mt-0.5"><span className="text-zinc-400">Descriptions:</span> {descriptions.map((d) => `“${d}”`).join("  ")}</p>
        </div>
      );
    }
    case "add_sitelink":
      return (
        <div className="text-xs text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">+ Sitelink:</span> “{s(p.link_text)}” {p.description1 ? `— ${s(p.description1)}` : ""} {p.description2 ? `/ ${s(p.description2)}` : ""}
          <span className="text-zinc-400"> → {s(p.final_url)}</span>
        </div>
      );
    case "add_callout":
      return (
        <div className="text-xs text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">+ Callout:</span> “{s(p.text)}”
        </div>
      );
    case "add_keyword":
      return (
        <div className="text-xs text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">+ Keyword:</span> [{s(p.text)}] ({s(p.match_type)}) — ad group {s(p.ad_group_id)}
        </div>
      );
    case "add_negative":
      return (
        <div className="text-xs text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">− Negative:</span> {s(p.text)} ({s(p.match_type)}) — {s(p.scope)} {s(p.scope_id)}
        </div>
      );
    case "adjust_bid":
      return (
        <div className="text-xs text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">Bid:</span> criterion {s(p.criterion_id)} — {((Number(p.current_cpc_bid_micros) || 0) / 1e6).toFixed(2)} → {((Number(p.new_cpc_bid_micros) || 0) / 1e6).toFixed(2)}
        </div>
      );
    case "adjust_budget":
      return (
        <div className="text-xs text-zinc-700 dark:text-zinc-300">
          <span className="font-medium">Budget:</span> campaign {s(p.campaign_id)} → {((Number(p.new_budget_micros) || 0) / 1e6).toFixed(2)}/day
        </div>
      );
    case "create_ad_group": {
      const keywords = Array.isArray(p.keywords) ? (p.keywords as Array<{ text: string; match_type?: string }>) : [];
      return (
        <div className="text-xs text-zinc-700 dark:text-zinc-300">
          <p className="font-medium">New ad group: &quot;{s(p.new_ad_group_name)}&quot; — campaign {s(p.campaign_id)}</p>
          <p className="mt-1">
            <span className="text-zinc-400">Keywords ({keywords.length}):</span>{" "}
            {keywords.map((k, i) => `[${k.text}]${i < keywords.length - 1 ? ", " : ""}`)}
          </p>
        </div>
      );
    }
    default:
      return <div className="text-xs text-zinc-500">{change.type}: {JSON.stringify(p)}</div>;
  }
}

function agentLabel(a?: string | null) {
  if (!a) return "";
  return a.replace(/_analyst$/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── filter link helper ── */
function filterHref(base: { tab: string; priority: string; status: string }, patch: Partial<{ tab: string; priority: string; status: string }>) {
  const p = { ...base, ...patch };
  return `/action-plan?tab=${p.tab}&priority=${p.priority}&status=${p.status}`;
}

/* ── main ── */
export default async function ActionPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; priority?: string; status?: string }>;
}) {
  const params = await searchParams;
  const tab = (CATEGORIES.includes(params.tab as Category) ? params.tab : "all") as Category;
  const priority = (PRIORITIES.includes(params.priority as Priority) ? params.priority : "all") as Priority;
  const status = (["pending", "approved", "rejected", "all"].includes(params.status ?? "") ? params.status : "pending") as StatusFilter;
  const current = { tab, priority, status };

  if (!db) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-sm text-amber-600">Not connected — set DATABASE_URL in .env.local.</p>
      </main>
    );
  }

  const [rows, counts, targets] = await Promise.all([getRows(tab, priority, status), getCounts(), getTargets()]);

  const p1PendingIds = rows.filter((r) => r.priority === "P1" && r.status === "pending").map((r) => r.planId);
  const cur = targets.currency_symbol;

  return (
    <main className="mx-auto max-w-5xl px-4 sm:px-6 py-8">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">Action Plan</h1>
          <p className="text-xs text-zinc-500 mt-0.5">{counts.pending} pending approval · {cur}{targets.target_cpa} CPA target · {targets.target_roas}x ROAS target</p>
        </div>
        {p1PendingIds.length > 0 && <BulkApproveButton planIds={p1PendingIds} />}
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800 mb-4">
        {CATEGORIES.map((c) => {
          const count = c === "all" ? Object.values(counts.byCategory).reduce((s, n) => s + n, 0) : (counts.byCategory[c] || 0);
          return (
            <Link
              key={c}
              href={filterHref(current, { tab: c })}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors ${
                tab === c
                  ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              {c} <span className="ml-1 text-xs opacity-70">{count}</span>
            </Link>
          );
        })}
      </div>

      {/* Priority + Status filters */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 mb-6">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-400 mr-1">Priority</span>
          {PRIORITIES.map((p) => {
            const count = p === "all" ? Object.values(counts.byPriority).reduce((s, n) => s + n, 0) : (counts.byPriority[p] || 0);
            const active = priority === p;
            const color = p === "P1" ? "text-red-600 dark:text-red-400" : p === "P2" ? "text-amber-600 dark:text-amber-400" : "";
            return (
              <Link
                key={p}
                href={filterHref(current, { priority: p })}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  active
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : `bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 ${color}`
                }`}
              >
                {p} {count > 0 && <span className="opacity-70">{count}</span>}
              </Link>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-400 mr-1">Status</span>
          {(["pending", "approved", "rejected", "all"] as StatusFilter[]).map((s) => (
            <Link
              key={s}
              href={filterHref(current, { status: s })}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors capitalize ${
                status === s
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400"
              }`}
            >
              {s}
            </Link>
          ))}
        </div>
      </div>

      {/* Cards */}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-12 text-center">
          <p className="text-sm text-zinc-500">No items match the current filters.</p>
          <Link href="/action-plan" className="mt-2 inline-block text-xs text-indigo-600 dark:text-indigo-400 hover:underline">Clear filters</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const isDone = row.status === "approved" || row.status === "rejected";
            const evidence = (row.evidence as string[] | null) ?? [];
            const brainSources = (row.brainSources as string[] | null) ?? [];
            const missingData = (row.missingData as string[] | null) ?? [];
            const alternativeExplanations = (row.alternativeExplanations as string[] | null) ?? [];
            const validationFlags = (row.validationFlags as string[] | null) ?? [];
            const proposedChanges = (row.proposedChanges as ProposedChange[] | null) ?? [];

            return (
              <div
                key={row.planId}
                className={`rounded-xl border bg-white dark:bg-zinc-900 p-5 transition-opacity ${
                  isDone
                    ? "border-zinc-100 dark:border-zinc-800/50 opacity-60"
                    : row.priority === "P1"
                    ? "border-red-200 dark:border-red-900/60"
                    : "border-zinc-200 dark:border-zinc-800"
                }`}
              >
                {/* Top row: badges + approve buttons */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <PriorityBadge p={row.priority} />
                    <ImpactChip metric={row.impactMetric} direction={row.impactDirection} magnitude={row.impactMagnitude} />
                    <Chip label={row.actionCategory} color={row.actionCategory === "auto" ? "green" : row.actionCategory === "manual" ? "blue" : "zinc"} />
                    {row.confidence && <Chip label={`${row.confidence} confidence`} />}
                    {row.effort && <Chip label={`${row.effort} effort`} />}
                    {validationFlags.length > 0 && (
                      <span
                        title={validationFlags.join(" · ")}
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                      >
                        ⚠ flagged
                      </span>
                    )}
                    <StatusDot status={row.status} />
                  </div>
                  {row.status === "pending" && <ApproveButtons planId={row.planId} />}
                </div>

                {/* Title */}
                <h3 className={`mt-3 font-semibold text-zinc-900 dark:text-zinc-50 leading-snug ${isDone ? "line-through decoration-zinc-400/50" : ""}`}>
                  {row.title}
                </h3>

                {/* Target */}
                {row.targetName && (
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="font-medium">📍 {row.targetType}:</span> {row.targetName}
                  </p>
                )}

                {/* What / Why / Action */}
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1">What</p>
                    <p className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed">{row.what}</p>
                  </div>
                  <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1">Why it matters</p>
                    <p className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed">{row.why}</p>
                  </div>
                  <div className={`rounded-lg px-3 py-2.5 ${row.status === "pending" ? "bg-indigo-50 dark:bg-indigo-950/40" : "bg-zinc-50 dark:bg-zinc-800/60"}`}>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 mb-1">Action</p>
                    <p className="text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed">{row.action}</p>
                  </div>
                </div>

                {/* Evidence */}
                {evidence.length > 0 && (
                  <div className="mt-3 rounded-lg border border-zinc-100 dark:border-zinc-800 px-3 py-2.5">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5">Evidence</p>
                    <ul className="space-y-1">
                      {evidence.slice(0, 4).map((e, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                          {e}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Exact structured change (proposed_changes) — what implementation.ts will actually execute */}
                <ProposedChangesPanel changes={proposedChanges} />
                {row.status === "pending" && proposedChanges.length > 0 && (
                  <ProposedChangesEditor planId={row.planId} changes={proposedChanges} />
                )}

                {/* Missing data / alternative explanations */}
                {(missingData.length > 0 || alternativeExplanations.length > 0) && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {missingData.length > 0 && (
                      <div className="rounded-lg border border-amber-100 dark:border-amber-900/40 px-3 py-2.5">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-amber-500 mb-1.5">Missing data</p>
                        <ul className="space-y-1">
                          {missingData.map((m, i) => (
                            <li key={i} className="text-xs text-zinc-600 dark:text-zinc-400">{m}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {alternativeExplanations.length > 0 && (
                      <div className="rounded-lg border border-zinc-100 dark:border-zinc-800 px-3 py-2.5">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5">Alternative explanations</p>
                        <ul className="space-y-1">
                          {alternativeExplanations.map((a, i) => (
                            <li key={i} className="text-xs text-zinc-600 dark:text-zinc-400">{a}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* Footer */}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
                  {row.agent && <span className="font-medium text-zinc-500">{agentLabel(row.agent)}</span>}
                  <span>·</span>
                  <span>score {row.score.toFixed(2)}</span>
                  <span>·</span>
                  <span>{row.actionType}</span>
                  <span>·</span>
                  <span>{row.runDate}</span>
                  {brainSources.length > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-indigo-400">{brainSources.length} brain source{brainSources.length > 1 ? "s" : ""}</span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
