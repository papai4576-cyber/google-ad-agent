import { db } from "@/db";
import { sql } from "drizzle-orm";

async function main() {
  if (!db) { console.error("No DB"); process.exit(1); }
  await db.execute(sql`ALTER TABLE findings ADD COLUMN IF NOT EXISTS missing_data jsonb DEFAULT '[]'`);
  await db.execute(sql`ALTER TABLE findings ADD COLUMN IF NOT EXISTS alternative_explanations jsonb DEFAULT '[]'`);
  await db.execute(sql`ALTER TABLE action_plan ADD COLUMN IF NOT EXISTS missing_data jsonb DEFAULT '[]'`);
  await db.execute(sql`ALTER TABLE action_plan ADD COLUMN IF NOT EXISTS alternative_explanations jsonb DEFAULT '[]'`);
  await db.execute(sql`ALTER TABLE action_plan ADD COLUMN IF NOT EXISTS validation_flags jsonb DEFAULT '[]'`);
  console.log("Migration done: missing_data/alternative_explanations columns added to findings; missing_data/alternative_explanations/validation_flags added to action_plan");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
