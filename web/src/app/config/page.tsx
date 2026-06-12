import { db } from "@/db";
import { config } from "@/db/schema";
import { asc } from "drizzle-orm";
import ConfigTable from "./ConfigTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Config | Google Ads Agent",
  description: "Edit configuration and thresholds",
};

export default async function ConfigPage() {
  if (!db) {
    return (
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <p className="text-red-600">Database not configured</p>
      </div>
    );
  }

  const configs = await db
    .select()
    .from(config)
    .orderBy(asc(config.key))
    .limit(500);

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Configuration</h1>
          <p className="text-gray-600 mt-1">
            Edit RULE_* thresholds, targets, and safety rails
          </p>
        </div>

        <div className="mt-8 bg-white rounded-lg shadow p-6">
          <ConfigTable configs={configs} />
        </div>

        <div className="mt-8 bg-blue-50 rounded-lg p-6 border border-blue-200">
          <h3 className="text-lg font-semibold text-blue-900 mb-3">
            Common Config Keys
          </h3>
          <ul className="text-sm text-blue-800 space-y-2">
            <li>
              <strong>RULE_BUDGET_LOST_IS</strong> — budget-capped threshold
              (default 0.30)
            </li>
            <li>
              <strong>RULE_RANK_LOST_IS</strong> — rank-capped threshold
              (default 0.40)
            </li>
            <li>
              <strong>DRY_RUN</strong> — if true, log changes but don&apos;t mutate
              (default true)
            </li>
            <li>
              <strong>MAX_BUDGET_SHIFT_PCT</strong> — max budget change per run
              (default 0.20)
            </li>
            <li>
              <strong>NEGATIVE_MAX_PER_RUN</strong> — max negative keywords per
              run (default 20)
            </li>
            <li>
              <strong>SLACK_WEBHOOK_URL</strong> — Slack notification webhook
              (optional)
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
