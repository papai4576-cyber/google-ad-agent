import { db } from "@/db";
import { sql } from "drizzle-orm";

async function main() {
  if (!db) { console.error("No DB"); process.exit(1); }
  await db.execute(sql`ALTER TABLE findings ADD COLUMN IF NOT EXISTS proposed_changes jsonb DEFAULT '[]'`);
  await db.execute(sql`ALTER TABLE action_plan ADD COLUMN IF NOT EXISTS proposed_changes jsonb DEFAULT '[]'`);
  console.log("Migration done: proposed_changes column added to findings and action_plan");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
