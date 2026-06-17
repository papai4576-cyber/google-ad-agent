/**
 * businessRules.ts — deterministic business-outcome gates, applied after
 * cross-agent patterns and before the recommendation validator agent /
 * scoring (see synthesisManager.ts).
 *
 * Generalizes two patterns that previously only fired for one narrow
 * combination each:
 *   - ROAS/CPA gate: ANY `increase_budget`-shaped finding (not just the one
 *     `capped-underperf` rule in performanceBudgetAnalyst.ts) gets demoted
 *     if the same campaign also has an open ROAS-shortfall or CPA-overage
 *     finding — recommending more spend on an already-inefficient campaign
 *     is the exact failure mode this gate exists to catch.
 *   - Rank-vs-budget gate: generalizes the one-off `sp-rank-cpa-trap-*`
 *     cross-agent pattern into a rule applied to every budget-shaped
 *     finding, not just that one hardcoded id combination.
 * Plus an evidence-density floor (caps confidence when a finding has <2
 * numeric evidence points) and an insufficient-data cap for categories the
 * account's current data collection cannot back with real evidence
 * (Auction Insights / competitive share — see CLAUDE.md's documented gap).
 *
 * No LLM calls. The only I/O is one `loadAccountData()` + `getTargets()`
 * call, same pattern every rule-based Analyst already uses.
 */

import type { CampaignRow } from "../data";
import { loadAccountData } from "../data";
import { getTargets } from "../rules/rulesEngine";
import type { Severity, SynthFinding } from "../schema";

const BUDGET_INCREASE_PREFIXES = ["budget-locked-", "sp-budget-misalloc-"];

/** Categories the account's current data collection cannot back with real evidence (CLAUDE.md-documented gaps). */
const INSUFFICIENT_DATA_CATEGORIES: Record<string, string[]> = {
  competitive: ["Auction Insights", "competitor share-of-voice data"],
};

export interface BusinessRuleStats {
  roasGated: number;
  rankGated: number;
  confidenceCapped: number;
  insufficientDataCapped: number;
}

export async function applyBusinessRules(findings: SynthFinding[]): Promise<{ findings: SynthFinding[]; stats: BusinessRuleStats }> {
  const stats: BusinessRuleStats = { roasGated: 0, rankGated: 0, confidenceCapped: 0, insufficientDataCapped: 0 };
  if (findings.length === 0) return { findings, stats };

  const { campaigns } = await loadAccountData();
  await getTargets(); // reserved for future margin-aware gates; not used by the numeric rules below yet

  const campaignById = new Map<string, CampaignRow>(campaigns.map((c) => [String(c.campaignId), c]));

  const findingsByTargetId = new Map<string, SynthFinding[]>();
  for (const f of findings) {
    const tid = String(f.target?.id || "");
    if (!tid) continue;
    if (!findingsByTargetId.has(tid)) findingsByTargetId.set(tid, []);
    findingsByTargetId.get(tid)!.push(f);
  }

  const out = findings.map((f) => {
    let next = gateBudgetIncreaseOnRoas(f, findingsByTargetId, stats);
    next = gateRankLockedBudget(next, campaignById, stats);
    next = capConfidenceOnThinEvidence(next, stats);
    next = capInsufficientDataCategories(next, stats);
    return next;
  });

  return { findings: out, stats };
}

function isBudgetIncreaseFinding(f: SynthFinding): boolean {
  return BUDGET_INCREASE_PREFIXES.some((p) => f.id.startsWith(p));
}

function demoteSeverity(sev: Severity): Severity {
  if (sev === "P1") return "P2";
  if (sev === "P2") return "P3";
  return "P3";
}

function withFlag(f: SynthFinding, flag: string): string[] {
  return [...(f.validation_flags || []), flag];
}

/** Budget increase findings get demoted if the same campaign already has an open ROAS-shortfall or CPA-overage finding. */
function gateBudgetIncreaseOnRoas(f: SynthFinding, byTargetId: Map<string, SynthFinding[]>, stats: BusinessRuleStats): SynthFinding {
  if (!isBudgetIncreaseFinding(f)) return f;

  const siblings = byTargetId.get(String(f.target?.id || "")) || [];
  const roasShortfall = siblings.find((s) => s.id.startsWith("roas-shortfall-"));
  const cpaOverage = siblings.find((s) => s.id.startsWith("cpa-overage-"));
  if (!roasShortfall && !cpaOverage) return f;

  stats.roasGated++;
  const reason = roasShortfall ? `ROAS is below target (see ${roasShortfall.id})` : `CPA is over target (see ${cpaOverage!.id})`;
  return {
    ...f,
    severity: demoteSeverity(f.severity),
    why: `${f.why} ⚠ Budget increase held back — ${reason}; fix efficiency before adding spend.`,
    validation_flags: withFlag(f, `roas_gate: ${reason}`),
  };
}

/** Budget increase findings get redirected away from budget when rank-loss exceeds budget-loss on the same campaign. */
function gateRankLockedBudget(f: SynthFinding, campaignById: Map<string, CampaignRow>, stats: BusinessRuleStats): SynthFinding {
  if (!isBudgetIncreaseFinding(f)) return f;

  const c = campaignById.get(String(f.target?.id || ""));
  if (!c) return f;
  const rankLost = Number(c.searchRankLostIs) || 0;
  const budgetLost = Number(c.searchBudgetLostIs) || 0;
  if (rankLost <= budgetLost || rankLost <= 0) return f;

  stats.rankGated++;
  return {
    ...f,
    severity: demoteSeverity(f.severity),
    why:
      `${f.why} ⚠ Rank-based impression-share loss (${(rankLost * 100).toFixed(0)}%) exceeds budget-based loss ` +
      `(${(budgetLost * 100).toFixed(0)}%) — a budget increase won't fix this; address Quality Score / ad relevance first.`,
    validation_flags: withFlag(f, "rank_exceeds_budget_loss"),
  };
}

function countNumericTokens(evidence: string[]): number {
  return evidence.filter((e) => /\d/.test(e)).length;
}

/** Findings with fewer than 2 numeric evidence points cannot be "high" or "medium" confidence regardless of LLM self-rating. */
function capConfidenceOnThinEvidence(f: SynthFinding, stats: BusinessRuleStats): SynthFinding {
  if (f.confidence === "low") return f;
  if (countNumericTokens(f.evidence || []) >= 2) return f;

  stats.confidenceCapped++;
  return { ...f, confidence: "low", validation_flags: withFlag(f, "thin_evidence_confidence_capped") };
}

/** Findings in categories the account's data collection cannot back with real evidence are capped at P3. */
function capInsufficientDataCategories(f: SynthFinding, stats: BusinessRuleStats): SynthFinding {
  const missing = INSUFFICIENT_DATA_CATEGORIES[f.category];
  if (!missing || f.severity === "P3") return f;

  stats.insufficientDataCapped++;
  return {
    ...f,
    severity: "P3",
    missing_data: Array.from(new Set([...(f.missing_data || []), ...missing])),
    validation_flags: withFlag(f, "insufficient_data_for_category"),
  };
}
