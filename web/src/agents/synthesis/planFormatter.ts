/**
 * planFormatter.ts — turns scored, deduped findings into `action_plan` rows.
 *
 * Ported from `PlanFormatter.run` in apps_script/agents/synthesis/PlanFormatter.js.
 * `_deriveActionMeta_` already lives in actionMeta.ts (Phase C). `_clearRunDate_`
 * becomes a `DELETE ... WHERE run_date = $1` in synthesisManager.ts — this module
 * is a pure function: scored findings in, action_plan row objects out.
 *
 * plan_id format: `plan_YYYYMMDD_NNN` (zero-padded sequence within a date),
 * sorted P1 first then by score desc, matching the v1 ordering exactly.
 */

import type { SynthFinding } from "../schema";
import { deriveActionMeta } from "./actionMeta";

export interface ActionPlanRow {
  planId: string;
  runDate: string;
  findingId: string;
  priority: string;
  title: string;
  what: string;
  why: string;
  action: string;
  actionCategory: string;
  actionType: string;
  targetType: string;
  targetId: string;
  targetName: string;
  score: number;
  status: "pending";
}

const PRIORITY_RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3 };

export function formatActionPlan(scored: SynthFinding[], runDate: string): ActionPlanRow[] {
  const sorted = scored.slice().sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority ?? a.severity] ?? 9;
    const pb = PRIORITY_RANK[b.priority ?? b.severity] ?? 9;
    if (pa !== pb) return pa - pb;
    return (Number(b.score) || 0) - (Number(a.score) || 0);
  });

  const datePart = runDate.replace(/-/g, "");

  return sorted.map((f, i) => {
    const seq = String(i + 1).padStart(3, "0");
    const meta = deriveActionMeta(f);
    return {
      planId: `plan_${datePart}_${seq}`,
      runDate,
      findingId: f.id,
      priority: f.priority ?? f.severity,
      title: f.title,
      what: f.what,
      why: f.why,
      action: f.action,
      actionCategory: meta.action_category,
      actionType: meta.action_type,
      targetType: f.target.type,
      targetId: f.target.id,
      targetName: f.target.name,
      score: Number(f.score) || 0,
      status: "pending",
    };
  });
}
