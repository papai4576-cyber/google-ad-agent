/**
 * synthesisManager.ts — turns the day's raw findings into the action plan.
 *
 * Ported from apps_script/managers/SynthesisManager.js. The Sheets-era version
 * read the Findings tab, deduped, scored, and wrote Action_Plan rows in one
 * pass; this version takes the in-memory `SynthFinding[]` produced by
 * runDailyAudit.ts (after the 6 Analysts have run) and:
 *
 *   1. Dedup (DeduplicationAgent / dedup.ts)
 *   2. Cross-agent patterns (crossAgentPatterns.ts) — appended after dedup
 *   3. Score + assign priority (ImpactScorer / impactScorer.ts)
 *   4. Format action_plan rows (planFormatter.ts) and replace all rows for
 *      `runDate` in the `action_plan` table (idempotent re-runs, same as v1's
 *      `_clearRunDate_`)
 *
 * Zero LLM calls. Pure transformation + one DB write.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { actionPlan } from "@/db/schema";
import type { SynthFinding } from "../schema";
import { Dedup, type MergeLogEntry } from "./dedup";
import { detectCrossAgentPatterns } from "./crossAgentPatterns";
import { ImpactScorer } from "./impactScorer";
import { formatActionPlan, type ActionPlanRow } from "./planFormatter";

export interface SynthesisResult {
  runDate: string;
  input: number;
  deduped: number;
  merged: number;
  mergeLog: MergeLogEntry[];
  patterns: number;
  p1: number;
  p2: number;
  p3: number;
  severityOverrides: number;
  written: number;
  cleared: number;
  planRows: ActionPlanRow[];
}

export async function runSynthesis(findings: SynthFinding[], runDate: string): Promise<SynthesisResult> {
  if (findings.length === 0) {
    const cleared = await clearActionPlan(runDate);
    return {
      runDate,
      input: 0,
      deduped: 0,
      merged: 0,
      mergeLog: [],
      patterns: 0,
      p1: 0,
      p2: 0,
      p3: 0,
      severityOverrides: 0,
      written: 0,
      cleared,
      planRows: [],
    };
  }

  // 1. Dedup.
  const dedup = Dedup.run(findings);

  // 2. Cross-agent patterns — synthesised findings added after dedup.
  const patterns = detectCrossAgentPatterns(dedup.deduped, runDate);
  const withPatterns = [...dedup.deduped, ...patterns];

  // 3. Score + assign priority.
  const { scored, stats } = ImpactScorer.run(withPatterns);

  // 4. Format + write action_plan rows.
  const planRows = formatActionPlan(scored, runDate);
  const cleared = await clearActionPlan(runDate);
  let written = 0;
  if (db && planRows.length > 0) {
    await db.insert(actionPlan).values(planRows);
    written = planRows.length;
  }

  return {
    runDate,
    input: findings.length,
    deduped: dedup.stats.kept,
    merged: dedup.stats.merged,
    mergeLog: dedup.mergeLog,
    patterns: patterns.length,
    p1: stats.p1,
    p2: stats.p2,
    p3: stats.p3,
    severityOverrides: stats.overrides,
    written,
    cleared,
    planRows,
  };
}

async function clearActionPlan(runDate: string): Promise<number> {
  if (!db) return 0;
  const deleted = await db.delete(actionPlan).where(eq(actionPlan.runDate, runDate)).returning({ planId: actionPlan.planId });
  return deleted.length;
}
