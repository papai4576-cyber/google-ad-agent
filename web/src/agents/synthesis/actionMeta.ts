/**
 * actionMeta.ts — derives `action_category` (auto|manual|insight) and
 * `action_type` for an action_plan row from a scored finding.
 *
 * Ported from `_deriveActionMeta_` in apps_script/agents/synthesis/PlanFormatter.js,
 * remapped from v1's 14 agent names to v2's 6 consolidated Analysts (see
 * agentNames.ts for the `agent` values and finding.id prefix conventions
 * Phase D/E `detect()` functions must follow).
 */

import type { SynthFinding } from "../schema";
import { AGENTS } from "./agentNames";

export interface ActionMeta {
  action_category: "auto" | "manual" | "insight";
  action_type: string;
}

const TYPE_MAP: Record<string, string> = {
  [AGENTS.QUALITY_STRUCTURE]: "fix_quality_score",
  [AGENTS.AUDIENCE_COPY]: "update_copy",
  [AGENTS.SEARCH_INTELLIGENCE]: "add_keywords",
  [AGENTS.LANDING_PAGE]: "fix_landing_page",
};

export function deriveActionMeta(f: SynthFinding): ActionMeta {
  const agent = String(f.agent || "");
  const id = String(f.id || "");

  if (agent === AGENTS.SEARCH_INTELLIGENCE) {
    if (id.startsWith("add-negative-")) return { action_category: "auto", action_type: "add_negatives" };
    if (id.startsWith("new-keyword-")) return { action_category: "manual", action_type: "add_keywords" };
    if (id.startsWith("search-term-pattern-")) return { action_category: "manual", action_type: "restructure" };
    return { action_category: "manual", action_type: "add_keywords" };
  }

  if (agent === AGENTS.PERFORMANCE_BUDGET) {
    if (id.startsWith("budget-locked-")) return { action_category: "auto", action_type: "increase_budget" };
    if (id.startsWith("idle-budget-")) return { action_category: "manual", action_type: "reallocate_budget" };
    return { action_category: "manual", action_type: "change_bid_strategy" };
  }

  if (agent === AGENTS.SYNTHESIS_PATTERN) {
    if (id.startsWith("sp-budget-misalloc-")) return { action_category: "auto", action_type: "increase_budget" };
    return { action_category: "manual", action_type: "fix_quality_score" };
  }

  if (agent === AGENTS.MARKET_INTELLIGENCE) {
    return { action_category: "insight", action_type: "read_insight" };
  }

  const type = TYPE_MAP[agent] || "manual_action";
  return { action_category: "manual", action_type: type };
}
