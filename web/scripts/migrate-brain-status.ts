import { db } from "@/db";
import { sql } from "drizzle-orm";

async function main() {
  if (!db) { console.error("No DB"); process.exit(1); }
  await db.execute(sql`ALTER TABLE brain_entries ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`);
  console.log("Migration done: brain_entries.status column added (default 'active')");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
