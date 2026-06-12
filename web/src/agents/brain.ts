/**
 * brain.ts — read access to `brain_entries` ("The Brain").
 *
 * Ported from apps_script/brain/BrainStore.js `query()`. Every Analyst calls
 * this before building its Groq prompt (CLAUDE.md: "Brain context is mandatory").
 * Add/edit entries are managed via the /brain dashboard page (Phase I), not here.
 */

import { inArray, desc } from "drizzle-orm";
import { db } from "@/db";
import { brainEntries } from "@/db/schema";
import type { BrainCategory } from "./schema";

export interface BrainContextEntry {
  id: string;
  category: string;
  title: string;
  summary: string | null;
  key_points: string[];
}

/**
 * Return up to `limit` entries matching ANY of the given categories,
 * newest first.
 */
export async function queryBrain(categories: BrainCategory[], limit = 5): Promise<BrainContextEntry[]> {
  if (!categories.length) throw new Error("queryBrain: categories must be a non-empty array.");
  if (!db) return [];

  const rows = await db
    .select({
      id: brainEntries.id,
      category: brainEntries.category,
      title: brainEntries.title,
      summary: brainEntries.summary,
      keyPoints: brainEntries.keyPoints,
      dateAdded: brainEntries.dateAdded,
    })
    .from(brainEntries)
    .where(inArray(brainEntries.category, categories))
    .orderBy(desc(brainEntries.dateAdded))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    title: r.title,
    summary: r.summary,
    key_points: (r.keyPoints as string[] | null) ?? [],
  }));
}

/** Format the BRAIN section of the user prompt. Empty-but-honest if no entries. */
export function formatBrainContext(entries: BrainContextEntry[]): string {
  if (!entries.length) {
    return "--- BRAIN (no relevant strategy context for this run) ---\n";
  }
  const lines = ["--- BRAIN (strategy context — cite ids in brain_sources) ---"];
  for (const e of entries) {
    lines.push(`[${e.id}] (${e.category}) ${e.title}`);
    lines.push(`  summary: ${e.summary ?? ""}`);
    if (e.key_points.length) {
      lines.push("  key_points:");
      for (const kp of e.key_points) lines.push(`    - ${kp}`);
    }
  }
  return lines.join("\n");
}
