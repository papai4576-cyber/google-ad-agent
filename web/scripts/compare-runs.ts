/**
 * compare-runs.ts — Phase J validation helper.
 *
 * Usage: npx tsx --require ./scripts/load-env.cjs scripts/compare-runs.ts [YYYY-MM-DD]
 *
 * Displays v2 findings and action_plan for the given run_date, formatted for
 * easy manual comparison with v1's Action_Plan sheet.
 *
 * Run this daily and spot-check against v1's Google Sheets tab to verify
 * v2 findings are equivalent or better.
 */

import { db } from "@/db";
import { findings as findingsTable, actionPlan } from "@/db/schema";
import { eq } from "drizzle-orm";

function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function main() {
  if (!db) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const runDate = process.argv[2] || todayUTC();
  console.log(`\n=== v2 Findings & Action Plan for ${runDate} ===\n`);

  // Query findings
  const findings = await db
    .select()
    .from(findingsTable)
    .where(eq(findingsTable.runDate, runDate));

  // Query action plan
  const plans = await db
    .select()
    .from(actionPlan)
    .where(eq(actionPlan.runDate, runDate));

  if (findings.length === 0 && plans.length === 0) {
    console.log("No findings or action items for this date.\n");
    process.exit(0);
  }

  // Summary
  console.log(`Raw Findings: ${findings.length}`);
  console.log(`Action Items: ${plans.length}`);
  if (plans.length > 0) {
    const p1 = plans.filter((p) => p.score >= 2.0).length;
    const p2 = plans.filter((p) => p.score >= 1.0 && p.score < 2.0).length;
    const p3 = plans.filter((p) => p.score < 1.0).length;
    console.log(
      `  Breakdown: P1=${p1}, P2=${p2}, P3=${p3} (total score=${plans.reduce((sum, p) => sum + p.score, 0).toFixed(1)})\n`
    );
  }

  // Action Plan by category
  if (plans.length > 0) {
    console.log("--- ACTION PLAN (grouped by category) ---\n");

    const byCategory = plans.reduce(
      (acc, p) => {
        if (!acc[p.actionCategory]) acc[p.actionCategory] = [];
        acc[p.actionCategory].push(p);
        return acc;
      },
      {} as Record<string, (typeof actionPlan.$inferSelect)[]>
    );

    for (const [category, items] of Object.entries(byCategory)) {
      console.log(`\n[${category.toUpperCase()}] (${items.length} items)`);
      for (const item of items.sort((a, b) => b.score - a.score)) {
        const priority = item.score >= 2.0 ? "P1" : item.score >= 1.0 ? "P2" : "P3";
        console.log(
          `  ${priority} [${item.actionType}] ${item.title} (score=${item.score.toFixed(2)})`
        );
        console.log(`     what: ${item.what}`);
        console.log(`     why:  ${item.why}`);
        console.log(
          `     action: ${item.action.substring(0, 100)}${item.action.length > 100 ? "..." : ""}`
        );
        if (item.targetType && item.targetId) {
          console.log(
            `     target: ${item.targetType} / ${item.targetName || item.targetId}`
          );
        }
        console.log();
      }
    }
  }

  // Raw findings summary
  if (findings.length > 0) {
    console.log("\n--- RAW FINDINGS SUMMARY ---\n");
    const byAgent = findings.reduce(
      (acc, f) => {
        if (!acc[f.agent]) acc[f.agent] = [];
        acc[f.agent].push(f);
        return acc;
      },
      {} as Record<string, (typeof findingsTable.$inferSelect)[]>
    );

    for (const [agent, items] of Object.entries(byAgent)) {
      console.log(`${agent}: ${items.length} finding${items.length !== 1 ? "s" : ""}`);
    }
  }

  console.log("\n=== MANUAL COMPARISON CHECKLIST ===");
  console.log(`1. Open v1 Google Sheet "Action_Plan" tab, filter for date ${runDate}`);
  console.log(`2. Count P1/P2/P3 items and compare totals above`);
  console.log(`3. Sample 3-5 high-priority items and verify:
   - Same target (campaign/ad group) flagged
   - Similar reasoning (what/why)`);
  console.log(`4. Check if v2 found additional insights v1 missed`);
  console.log(`5. Report any major discrepancies in progress notes\n`);
}

main().catch((e) => {
  console.error("[compare-runs] error:", e);
  process.exit(1);
});
