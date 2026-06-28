/**
 * import-auction-insights.ts — imports a Google Ads "Auction insights" report
 * CSV (downloaded manually from the Ads UI: Campaigns > Auction insights >
 * Download) into a single rolling `competitive`-category Brain entry.
 *
 * Why manual: the Google Ads API does not expose per-competitor auction
 * insight metrics for non-allowlisted accounts (confirmed by testing the
 * `auction_insight_search_impression_share` / `auction_insight_domain` GAQL
 * fields directly against this account — both fields are rejected). Google
 * also removed third-party/API access to this report outright in August
 * 2024. The UI export is the only path, so this is a periodic manual step,
 * not part of the automated collect pipeline.
 *
 * Expected columns (Google's standard Auction Insights CSV export; matched
 * case-insensitively, with a couple of known naming variants per column,
 * since Google has changed these labels across UI versions):
 *   Display URL domain | Search Impr. share (Auction Insights) | Search overlap rate
 *   | Position above rate | Top of page rate | Abs. Top of page rate | Search outranking share
 *
 * Run: npx tsx --require ./scripts/load-env.cjs scripts/import-auction-insights.ts path/to/export.csv
 */

import { readFileSync } from "fs";
import { db } from "@/db";
import { brainEntries } from "@/db/schema";
import { eq } from "drizzle-orm";

interface DomainRow {
  domain: string;
  imprShare: number | null;
  overlapRate: number | null;
  positionAboveRate: number | null;
  topOfPageRate: number | null;
  absTopOfPageRate: number | null;
  outrankingShare: number | null;
  rows: number;
}

/** Minimal RFC-4180-ish CSV line splitter — handles quoted fields with embedded commas, which Google's exports use for domain/campaign names. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

const COLUMN_ALIASES: Record<keyof Omit<DomainRow, "rows" | "domain">, string[]> = {
  imprShare: ["search impr. share (auction insights)", "search impression share", "impr. share", "impression share"],
  overlapRate: ["search overlap rate", "overlap rate"],
  positionAboveRate: ["position above rate"],
  topOfPageRate: ["top of page rate"],
  absTopOfPageRate: ["abs. top of page rate", "absolute top of page rate"],
  outrankingShare: ["search outranking share", "outranking share"],
};
const DOMAIN_ALIASES = ["display url domain", "domain"];

function findColumnIndex(headerRow: string[], aliases: string[]): number {
  const normalized = headerRow.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parsePct(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace("%", "").replace("<", "").replace(">", "").trim();
  if (cleaned === "" || cleaned === "--" || cleaned.toLowerCase() === "n/a") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function avg(values: Array<number | null>): number | null {
  const real = values.filter((v): v is number => v !== null);
  if (real.length === 0) return null;
  return real.reduce((s, v) => s + v, 0) / real.length;
}

async function main() {
  if (!db) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npx tsx --require ./scripts/load-env.cjs scripts/import-auction-insights.ts <path-to-csv>");
    process.exit(1);
  }

  const text = readFileSync(filePath, "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error("CSV has no data rows");
    process.exit(1);
  }

  // Google's exports sometimes prepend a title/date line before the real header row —
  // scan for the first row containing a recognizable domain column.
  let headerIdx = -1;
  let domainCol = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const idx = findColumnIndex(rows[i], DOMAIN_ALIASES);
    if (idx !== -1) {
      headerIdx = i;
      domainCol = idx;
      break;
    }
  }
  if (headerIdx === -1) {
    console.error(`Could not find a domain column in the first 5 rows. Looked for: ${DOMAIN_ALIASES.join(", ")}`);
    console.error("First row found:", rows[0].join(" | "));
    process.exit(1);
  }

  const header = rows[headerIdx];
  const colIdx: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    colIdx[key] = findColumnIndex(header, aliases);
  }

  const byDomain = new Map<string, DomainRow>();
  for (const row of rows.slice(headerIdx + 1)) {
    const domain = (row[domainCol] || "").trim();
    if (!domain) continue; // skip blank rows only — "Your domain"-style self-rows are still useful context

    const existing = byDomain.get(domain) || {
      domain,
      imprShare: null,
      overlapRate: null,
      positionAboveRate: null,
      topOfPageRate: null,
      absTopOfPageRate: null,
      outrankingShare: null,
      rows: 0,
    };

    const thisRow: Partial<DomainRow> = {
      imprShare: parsePct(row[colIdx.imprShare]),
      overlapRate: parsePct(row[colIdx.overlapRate]),
      positionAboveRate: parsePct(row[colIdx.positionAboveRate]),
      topOfPageRate: parsePct(row[colIdx.topOfPageRate]),
      absTopOfPageRate: parsePct(row[colIdx.absTopOfPageRate]),
      outrankingShare: parsePct(row[colIdx.outrankingShare]),
    };

    // Running average across however many campaign-level rows this domain appears in.
    const n = existing.rows;
    for (const key of Object.keys(COLUMN_ALIASES) as Array<keyof typeof COLUMN_ALIASES>) {
      const v = thisRow[key];
      if (v == null) continue;
      const prev = existing[key];
      existing[key] = prev == null ? v : (prev * n + v) / (n + 1);
    }
    existing.rows = n + 1;
    byDomain.set(domain, existing);
  }

  const domains = Array.from(byDomain.values()).sort((a, b) => (b.imprShare ?? 0) - (a.imprShare ?? 0));
  if (domains.length === 0) {
    console.error("Parsed the CSV but found zero domain rows — check the file format.");
    process.exit(1);
  }

  console.log(`Parsed ${domains.length} domains from ${rows.length - headerIdx - 1} data rows:`);
  for (const d of domains) {
    console.log(
      `  ${d.domain}: impr_share=${d.imprShare?.toFixed(1) ?? "n/a"}% overlap=${d.overlapRate?.toFixed(1) ?? "n/a"}% ` +
        `outranking=${d.outrankingShare?.toFixed(1) ?? "n/a"}%`
    );
  }

  const today = new Date().toISOString().split("T")[0];
  const keyPoints = domains.slice(0, 10).map((d) => {
    const parts: string[] = [];
    if (d.imprShare != null) parts.push(`impression share ${d.imprShare.toFixed(1)}%`);
    if (d.overlapRate != null) parts.push(`overlap rate ${d.overlapRate.toFixed(1)}%`);
    if (d.outrankingShare != null) parts.push(`outranking share ${d.outrankingShare.toFixed(1)}%`);
    if (d.positionAboveRate != null) parts.push(`position-above rate ${d.positionAboveRate.toFixed(1)}%`);
    if (d.topOfPageRate != null) parts.push(`top-of-page rate ${d.topOfPageRate.toFixed(1)}%`);
    return `${d.domain}: ${parts.join(", ") || "no metrics parsed"}`;
  });

  const summary =
    `Real Auction Insights data imported ${today}, covering ${domains.length} competing domains. ` +
    `Top domain by impression share: ${domains[0].domain} (${domains[0].imprShare?.toFixed(1) ?? "n/a"}%). ` +
    "Use overlap rate (how often a competitor's ad showed in the same auction) and outranking share " +
    "(how often they outranked us when both showed) to gauge real competitive pressure, not just brand-name guesses.";

  await db
    .insert(brainEntries)
    .values({
      id: "brain_auction_insights_latest",
      category: "competitive",
      source: `Google Ads UI Auction Insights export, imported ${today}`,
      sourceType: "manual",
      dateAdded: today,
      title: `Real Auction Insights data (as of ${today})`,
      summary,
      keyPoints,
      rawText: JSON.stringify(domains, null, 2),
    })
    .onConflictDoUpdate({
      target: brainEntries.id,
      set: { dateAdded: today, title: `Real Auction Insights data (as of ${today})`, summary, keyPoints, rawText: JSON.stringify(domains, null, 2), source: `Google Ads UI Auction Insights export, imported ${today}` },
    });

  console.log(`\nDone. Brain entry "brain_auction_insights_latest" ${"created/updated"} with real data for ${domains.length} domains.`);
  console.log("Re-run this script whenever you re-export the report (e.g. monthly) to keep it current.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
