import { db } from "@/db";
import { sql } from "drizzle-orm";

async function main() {
  if (!db) {
    console.error("No DB");
    process.exit(1);
  }
  await db.execute(sql`ALTER TABLE change_log ADD COLUMN IF NOT EXISTS reviewed boolean DEFAULT false NOT NULL`);
  console.log("Migration done: reviewed column added to change_log");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
