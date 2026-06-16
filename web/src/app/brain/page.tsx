import { db } from "@/db";
import { brainEntries } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import BrainForm from "./BrainForm";
import BrainEntry from "./BrainEntry";
import { BrainApproveButton } from "./BrainApproveButton";

export const dynamic = "force-dynamic";

type Tab = "active" | "staged";

export default async function BrainPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab: Tab = params.tab === "staged" ? "staged" : "active";

  if (!db) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16">
        <p className="text-sm text-amber-600">Not connected — set DATABASE_URL in .env.local.</p>
      </main>
    );
  }

  const [activeEntries, stagedEntries] = await Promise.all([
    db.select().from(brainEntries).where(eq(brainEntries.status, "active")).orderBy(desc(brainEntries.dateAdded)).limit(200),
    db.select().from(brainEntries).where(eq(brainEntries.status, "staged")).orderBy(desc(brainEntries.dateAdded)).limit(50),
  ]);

  const entries = tab === "staged" ? stagedEntries : activeEntries;

  const categoryGroups = entries.reduce((acc, entry) => {
    if (!acc[entry.category]) acc[entry.category] = [];
    acc[entry.category].push(entry);
    return acc;
  }, {} as Record<string, (typeof brainEntries.$inferSelect)[]>);

  const sourceIcon = (sourceType: string | null) => {
    if (sourceType === "agent_web_search") return "🌐";
    if (sourceType === "agent_performance") return "📊";
    if (sourceType === "agent_feedback") return "✅";
    return "✍️";
  };

  return (
    <main className="mx-auto max-w-4xl px-4 sm:px-6 py-8">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">Brain</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {activeEntries.length} active entries · {stagedEntries.length} staged for review
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800 mb-6">
        <Link
          href="/brain?tab=active"
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            tab === "active"
              ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
              : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          }`}
        >
          Active <span className="ml-1 text-xs opacity-70">{activeEntries.length}</span>
        </Link>
        <Link
          href="/brain?tab=staged"
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            tab === "staged"
              ? "border-amber-500 text-amber-600 dark:text-amber-400"
              : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          }`}
        >
          Staged for review
          {stagedEntries.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-[10px] font-bold w-4 h-4">
              {stagedEntries.length}
            </span>
          )}
        </Link>
      </div>

      {/* Staged tab: review queue */}
      {tab === "staged" && (
        <div>
          {stagedEntries.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-12 text-center">
              <p className="text-sm text-zinc-500">No staged entries. The Brain Learning Agent runs every Monday and will stage new insights here.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-zinc-500 mb-4">
                These entries were discovered automatically by the Brain Learning Agent. Review each one and click "Add to Brain" to activate it, or "Discard" to remove it.
              </p>
              {stagedEntries.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-white dark:bg-zinc-900 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-base">{sourceIcon(entry.sourceType)}</span>
                        <span className="rounded-full bg-indigo-100 dark:bg-indigo-900/40 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:text-indigo-400 capitalize">
                          {entry.category}
                        </span>
                        <span className="text-[11px] text-zinc-400">
                          {entry.sourceType === "agent_web_search" ? "web search"
                            : entry.sourceType === "agent_performance" ? "account data"
                            : entry.sourceType === "agent_feedback" ? "approval pattern"
                            : "manual"}
                        </span>
                      </div>
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-50 leading-snug">{entry.title}</h3>
                      {entry.summary && (
                        <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">{entry.summary}</p>
                      )}
                      {entry.keyPoints && (entry.keyPoints as string[]).length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {(entry.keyPoints as string[]).map((p, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                              <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                              {p}
                            </li>
                          ))}
                        </ul>
                      )}
                      {entry.source && (
                        <p className="mt-2 text-[11px] text-zinc-400">Source: {entry.source}</p>
                      )}
                    </div>
                    <div className="shrink-0">
                      <BrainApproveButton id={entry.id} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Active tab: existing brain + add form */}
      {tab === "active" && (
        <div className="space-y-6">
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">Add Entry Manually</h2>
            <BrainForm />
          </div>

          {Object.keys(categoryGroups).length === 0 ? (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-12 text-center">
              <p className="text-sm text-zinc-500">No active entries yet. Add one above or wait for the Brain Learning Agent to run on Monday.</p>
            </div>
          ) : (
            Object.entries(categoryGroups).map(([category, items]) => (
              <div key={category} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 capitalize">{category}</h3>
                  <span className="text-xs text-zinc-400">{items.length} {items.length === 1 ? "entry" : "entries"}</span>
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {items.map((entry) => (
                    <BrainEntry key={entry.id} entry={entry} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </main>
  );
}
