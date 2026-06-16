import { db } from "@/db";
import { actionPlan, findings } from "@/db/schema";

async function main() {
  if (!db) { console.error("no db"); process.exit(1); }
  const d1 = await db.delete(actionPlan).returning({ id: actionPlan.planId });
  const d2 = await db.delete(findings).returning({ id: findings.id });
  console.log(`Deleted ${d1.length} action_plan rows`);
  console.log(`Deleted ${d2.length} findings rows`);
  console.log("Done — run the daily-audit to get fresh results.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
