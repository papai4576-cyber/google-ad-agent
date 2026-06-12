import { db } from "@/db";
import { changeLog } from "@/db/schema";
import { desc } from "drizzle-orm";
import { relativeTimeFromNow } from "@/lib/dates";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "History | Google Ads Agent",
  description: "Past audit runs and change log",
};

interface ChangeLogGrouped {
  planId: string | null;
  runDate: string | null;
  timestamp: Date;
  changes: (typeof changeLog.$inferSelect)[];
}

export default async function HistoryPage() {
  if (!db) {
    return (
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <p className="text-red-600">Database not configured</p>
      </div>
    );
  }

  const logs = await db
    .select()
    .from(changeLog)
    .orderBy(desc(changeLog.timestamp))
    .limit(200);

  // Group by plan_id (or timestamp if no plan_id)
  const grouped: Map<string, ChangeLogGrouped> = new Map();
  for (const log of logs) {
    const key = log.planId || `no-plan-${log.timestamp.getTime()}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        planId: log.planId,
        runDate: null,
        timestamp: log.timestamp,
        changes: [],
      });
    }
    grouped.get(key)!.changes.push(log);
  }

  const groups = Array.from(grouped.values()).sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
  );

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">History</h1>
        <p className="text-gray-600 mb-8">
          Past audit runs and applied changes
        </p>

        {groups.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-6">
            <p className="text-gray-500">No changes recorded yet.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div
                key={group.planId || `no-plan-${group.timestamp.getTime()}`}
                className="bg-white rounded-lg shadow overflow-hidden"
              >
                <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
                  <div className="flex items-center justify-between">
                    <div>
                      {group.planId && (
                        <p className="font-mono text-sm text-gray-600">
                          {group.planId}
                        </p>
                      )}
                      <p className="text-sm text-gray-500">
                        {relativeTimeFromNow(group.timestamp)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-gray-900">
                        {group.changes.length} change{group.changes.length !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-gray-200">
                  {group.changes.map((change) => (
                    <div
                      key={change.id}
                      className="px-6 py-4 hover:bg-gray-50 transition"
                    >
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            Target
                          </p>
                          <p className="text-sm font-medium text-gray-900">
                            {change.targetType}: {change.targetName || change.targetId}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            Agent
                          </p>
                          <p className="text-sm text-gray-900">{change.agent}</p>
                        </div>
                      </div>

                      {change.fieldChanged && (
                        <div className="mt-3 pt-3 border-t border-gray-100">
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                            {change.fieldChanged}
                          </p>
                          <div className="mt-2 flex items-center gap-2 text-sm font-mono">
                            <span className="bg-red-100 text-red-800 px-2 py-1 rounded">
                              {change.beforeValue || "(unset)"}
                            </span>
                            <span className="text-gray-400">→</span>
                            <span className="bg-green-100 text-green-800 px-2 py-1 rounded">
                              {change.afterValue || "(unset)"}
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="mt-3 flex items-center justify-between">
                        <div className="flex gap-2">
                          {change.success ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              Success
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                              Failed
                            </span>
                          )}
                          {change.dryRun && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                              Dry Run
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500">
                          {new Date(change.timestamp).toLocaleString()}
                        </p>
                      </div>

                      {change.errorMessage && (
                        <div className="mt-3 p-3 bg-red-50 rounded border border-red-200">
                          <p className="text-xs text-red-700 font-mono">
                            {change.errorMessage}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
