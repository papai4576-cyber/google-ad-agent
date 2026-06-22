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

// AUDIENCE_COPY and SEARCH_INTELLIGENCE are fully handled by their own `if` blocks below — this
// fallback map only still matters for agents with no explicit block (currently just LANDING_PAGE).
const TYPE_MAP: Record<string, string> = {
  [AGENTS.LANDING_PAGE]: "fix_landing_page",
};

export function deriveActionMeta(f: SynthFinding): ActionMeta {
  const agent = String(f.agent || "");
  const id = String(f.id || "");

  if (agent === AGENTS.SEARCH_INTELLIGENCE) {
    if (id.startsWith("add-negative-")) return { action_category: "auto", action_type: "add_negatives" };
    // Auto since the proposed_changes migration — Section 1 of this analyst's prompt now requires a
    // structured add_keyword entry per term; implementation.ts skips (doesn't silently no-op) any
    // instance where proposed_changes came back empty.
    if (id.startsWith("new-keyword-")) return { action_category: "auto", action_type: "add_keywords" };
    if (id.startsWith("search-term-pattern-")) return { action_category: "manual", action_type: "restructure" };
    if (id.startsWith("cannibalization-")) return { action_category: "manual", action_type: "restructure" };
    return { action_category: "manual", action_type: "add_keywords" };
  }

  if (agent === AGENTS.PERFORMANCE_BUDGET) {
    if (id.startsWith("budget-locked-")) return { action_category: "auto", action_type: "increase_budget" };
    if (id.startsWith("idle-budget-")) return { action_category: "manual", action_type: "reallocate_budget" };
    if (id.startsWith("pacing-")) return { action_category: "manual", action_type: "reallocate_budget" };
    // Stays manual permanently — campaign-level "rank lost" isn't a single keyword-level mutate target.
    // See qualityStructureAnalyst.ts's bid-opportunity-* for the keyword-scoped equivalent that IS auto.
    if (id.startsWith("rank-locked-")) return { action_category: "manual", action_type: "adjust_bid" };
    if (id.startsWith("low-ctr-")) return { action_category: "manual", action_type: "update_copy" };
    if (id.startsWith("anomaly-cvr-drop-")) return { action_category: "manual", action_type: "fix_conversion_tracking" };
    if (id.startsWith("anomaly-cpa-jump-")) return { action_category: "manual", action_type: "change_bid_strategy" };
    if (id.startsWith("troas-no-value-") || id.startsWith("no-conv-") || id.startsWith("no-value-") ||
        id.startsWith("high-cvr-") || id.startsWith("low-cvr-")) {
      return { action_category: "manual", action_type: "fix_conversion_tracking" };
    }
    return { action_category: "manual", action_type: "change_bid_strategy" };
  }

  if (agent === AGENTS.QUALITY_STRUCTURE) {
    // Only the 4 extension sub-types with a real executable change (add_sitelink/add_callout via
    // googleAdsClient.ts) are auto. Structured snippets and "replace weak copy" have no mutate
    // function yet, so they stay manual even though the id prefix is the same family.
    if (
      id.startsWith("extension-no-extensions-account") ||
      id.startsWith("extension-no-sitelinks-") ||
      id.startsWith("extension-few-sitelinks-") ||
      id.startsWith("extension-no-callouts-")
    ) {
      return { action_category: "auto", action_type: "add_extensions" };
    }
    if (id.startsWith("extension-")) return { action_category: "manual", action_type: "add_extensions" };
    // Keyword-level bid headroom on Manual/Enhanced CPC — a single mutate target, unlike rank-locked-* above.
    if (id.startsWith("bid-opportunity-")) return { action_category: "auto", action_type: "adjust_bid" };
    if (id.startsWith("low-qs-") || id.startsWith("no-qs-spend-")) return { action_category: "manual", action_type: "fix_quality_score" };
    if (id.startsWith("structure-")) return { action_category: "manual", action_type: "restructure" };
    return { action_category: "manual", action_type: "fix_quality_score" };
  }

  if (agent === AGENTS.AUDIENCE_COPY) {
    // Copy rewrites are auto since the proposed_changes migration — create_rsa always creates a
    // PAUSED ad (see googleAdsClient.ts), so approval authorizes creation, never going live.
    // audience-* findings (RLSA/Customer Match/lookalike strategy) are NOT a single executable change
    // and stay manual.
    if (id.startsWith("copy-") || id.startsWith("low-ctr-ad-")) return { action_category: "auto", action_type: "update_copy" };
    return { action_category: "manual", action_type: "update_copy" };
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
