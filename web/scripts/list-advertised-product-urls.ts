/**
 * list-advertised-product-urls.ts — lists every distinct product final_url
 * currently being advertised (deduped from the `ads` table). Companion to
 * seed-product-catalog-brain.ts: re-run this first to see whether new
 * products have started being advertised since the Brain's `products`
 * category entries were last written, then fetch/seed the new ones the same way.
 *
 * Run: npx tsx --require ./scripts/load-env.cjs scripts/list-advertised-product-urls.ts
 */

import { db } from "@/db";
import { ads } from "@/db/schema";

async function main() {
  if (!db) {
    console.log("no db");
    process.exit(1);
  }
  const rows = await db.select({ finalUrls: ads.finalUrls }).from(ads);
  const set = new Set<string>();
  for (const r of rows) {
    const urls = Array.isArray(r.finalUrls) ? r.finalUrls : [];
    for (const u of urls) {
      if (typeof u === "string" && u.startsWith("http")) {
        set.add(u.split("?")[0]);
      }
    }
  }
  const sorted = Array.from(set).sort();
  console.log(`${sorted.length} distinct product final_urls:`);
  for (const u of sorted) console.log(u);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
