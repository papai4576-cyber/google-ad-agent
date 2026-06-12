/**
 * crossAgentPatterns.ts — synthetic P1 findings generated where multiple
 * Analysts surface the same root cause on the same entity from different
 * angles. Runs AFTER dedup, BEFORE scoring (see synthesisManager.ts).
 *
 * Ported from `_detectCrossAgentPatterns_` in apps_script/managers/SynthesisManager.js,
 * remapped to v2's 6-Analyst names + finding.id prefix conventions
 * (see agentNames.ts). All 3 patterns carried over unchanged in spirit:
 *
 *   1. Rank-locked AND high CPA on the same campaign — bid raises won't help,
 *      QS/landing-page fix needed first.
 *   2. Budget misallocation — idle-budget donor(s) + budget-locked receiver(s).
 *   3. Account-wide copy quality + QS expected-CTR drag.
 */

import type { SynthFinding } from "../schema";
import { AGENTS } from "./agentNames";

export function detectCrossAgentPatterns(findings: SynthFinding[], runDate: string): SynthFinding[] {
  const out: SynthFinding[] = [];

  const byAgentAndPrefix = (agent: string, prefix: string) =>
    findings.filter((f) => f.agent === agent && String(f.id || "").startsWith(prefix));

  /* ---- Pattern 1: rank-locked + cpa-overage on the same campaign --------- */
  const rankLocked = byAgentAndPrefix(AGENTS.PERFORMANCE_BUDGET, "rank-locked-");
  const cpaOverage = byAgentAndPrefix(AGENTS.PERFORMANCE_BUDGET, "cpa-overage-");
  for (const rl of rankLocked) {
    const tid = String(rl.target?.id || "").trim();
    const match = cpaOverage.find((f) => String(f.target?.id || "").trim() === tid);
    if (!match) continue;

    out.push({
      id: `sp-rank-cpa-trap-${tid}`,
      agent: AGENTS.SYNTHESIS_PATTERN,
      runDate,
      mode: rl.mode || "daily",
      category: "structure",
      severity: "P1",
      title: `Bid raises won't fix ${rl.target?.name || tid} — QS fix first`,
      what: "Campaign is both rank-locked (bids/QS too low for competitive auctions) AND over-target CPA. Raising bids here increases cost without winning better placements.",
      why: "Rank IS loss driven by low QS means the issue is ad relevance or landing-page experience — not bid level. Adding budget into this state is waste.",
      action: "1. Diagnose the QS root cause on the top-spend keywords in this campaign. 2. Fix ad relevance or landing page first. 3. Only re-evaluate bids once the expected-CTR component improves.",
      target: { type: rl.target?.type || "campaign", id: tid, name: rl.target?.name || tid },
      estimated_impact: { metric: "CPA", direction: "down", magnitude: "high" },
      confidence: "high",
      effort: "hard",
      evidence: [`rank-locked finding: ${rl.id}`, `cpa-overage finding: ${match.id}`],
      brain_sources: [],
    });
  }

  /* ---- Pattern 2: budget misallocation — idle donor + budget-locked receiver */
  const idleBudget = byAgentAndPrefix(AGENTS.PERFORMANCE_BUDGET, "idle-budget-");
  const budgetLocked = byAgentAndPrefix(AGENTS.PERFORMANCE_BUDGET, "budget-locked-");
  if (idleBudget.length > 0 && budgetLocked.length > 0) {
    const donors = idleBudget.map((f) => f.target?.name || f.target?.id).join(", ");
    const receivers = budgetLocked.map((f) => f.target?.name || f.target?.id).join(", ");
    const receiver = budgetLocked[0];

    out.push({
      id: `sp-budget-misalloc-${runDate}`,
      agent: AGENTS.SYNTHESIS_PATTERN,
      runDate,
      mode: receiver.mode || "daily",
      category: "performance",
      severity: "P1",
      title: "Budget misallocation: idle budget while other campaigns are starved",
      what: `Budget sits under-spent on [${donors}] while [${receivers}] are budget-capped and losing impression share.`,
      why: "Moving budget from idle campaigns to budget-locked performers increases total conversions at the same total spend.",
      action: "Move up to 20% of daily budget from idle campaign(s) to budget-locked campaign(s). Monitor IS and conversion rate for 7 days before further increases.",
      target: { type: receiver.target?.type || "campaign", id: receiver.target?.id || "", name: "Multiple campaigns" },
      estimated_impact: { metric: "conversions", direction: "up", magnitude: "high" },
      confidence: "medium",
      effort: "easy",
      evidence: [
        `idle donors: ${idleBudget.map((f) => f.id).join(", ")}`,
        `budget-locked receivers: ${budgetLocked.map((f) => f.id).join(", ")}`,
      ],
      brain_sources: [],
    });
  }

  /* ---- Pattern 3: account-wide copy quality + QS expected-CTR drag -------- */
  const lowCtrAds = findings.filter((f) => f.agent === AGENTS.AUDIENCE_COPY && String(f.id || "").startsWith("low-ctr-ad"));
  const lowExpCtrKws = findings.filter(
    (f) => f.agent === AGENTS.QUALITY_STRUCTURE && f.evidence.some((e) => e.includes("expCTR=BELOW_AVERAGE"))
  );
  if (lowCtrAds.length >= 2 && lowExpCtrKws.length >= 2) {
    const rep = lowCtrAds[0];
    out.push({
      id: `sp-copy-qs-systemic-${runDate}`,
      agent: AGENTS.SYNTHESIS_PATTERN,
      runDate,
      mode: rep.mode || "daily",
      category: "copy",
      severity: "P1",
      title: "Systemic copy quality issue: low-CTR ads driving below-average expected CTR",
      what: `${lowCtrAds.length} ads have below-median CTR and ${lowExpCtrKws.length} keywords show below-average expected CTR in QS — the same root cause across the account.`,
      why: "Expected CTR is the most changeable QS component and is primarily driven by ad copy. Fixing copy at scale improves CTR, QS, and CPC efficiency account-wide.",
      action: "1. Prioritise the Audience & Copy Analyst's recommendations for the flagged ads. 2. Aim to move the Expected CTR component from Below Average to Average within 14 days. 3. Track QS sub-component distribution weekly.",
      target: rep.target,
      estimated_impact: { metric: "CTR", direction: "up", magnitude: "high" },
      confidence: "medium",
      effort: "medium",
      evidence: [
        `${lowCtrAds.length} low-CTR ads flagged by ${AGENTS.AUDIENCE_COPY}`,
        `${lowExpCtrKws.length} keywords with expCTR=BELOW_AVERAGE`,
        `sample ads: ${lowCtrAds.slice(0, 3).map((f) => f.id).join(", ")}`,
      ],
      brain_sources: [],
    });
  }

  return out;
}
