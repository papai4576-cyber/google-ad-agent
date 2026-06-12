/**
 * impactScorer.ts — score = (magnitude x confidence) / effort, then bucket
 * into P1/P2/P3.
 *
 * Ported from apps_script/agents/synthesis/ImpactScorer.js + the
 * SCORE_WEIGHTS/PRIORITY_THRESHOLDS constants from apps_script/config.js.
 * Reads the nested `f.estimated_impact.magnitude` (the v2 findings shape),
 * matching the corrected `_scoreFinding` in apps_script/agents/_common.js
 * rather than the flattened `f.impact_magnitude` the Sheets-row version used.
 */

import type { Severity, SynthFinding } from "../schema";

export const SCORE_WEIGHTS = {
  magnitude: { high: 3, medium: 2, low: 1 },
  confidence: { high: 1.0, medium: 0.7, low: 0.4 },
  effort: { easy: 1.0, medium: 1.5, hard: 2.5 },
} as const;

export const PRIORITY_THRESHOLDS = { P1: 2.0, P2: 1.0 }; // < P2 => P3

export interface ImpactScoreResult {
  scored: SynthFinding[];
  stats: { p1: number; p2: number; p3: number; overrides: number };
}

export const ImpactScorer = {
  run(findings: SynthFinding[]): ImpactScoreResult {
    let p1 = 0;
    let p2 = 0;
    let p3 = 0;
    let overrides = 0;

    const scored = findings.map((f) => {
      const computed = score(f);
      const priority = priorityFor(computed);
      if (priority !== f.severity) overrides++;
      if (priority === "P1") p1++;
      else if (priority === "P2") p2++;
      else p3++;
      return { ...f, score: computed, priority };
    });

    scored.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

    return { scored, stats: { p1, p2, p3, overrides } };
  },
};

function score(f: SynthFinding): number {
  const m = SCORE_WEIGHTS.magnitude[f.estimated_impact?.magnitude];
  const c = SCORE_WEIGHTS.confidence[f.confidence];
  const e = SCORE_WEIGHTS.effort[f.effort];
  if (!m || !c || !e) return 0;
  return Math.round((m * c) / e * 100) / 100;
}

function priorityFor(scoreValue: number): Severity {
  if (scoreValue >= PRIORITY_THRESHOLDS.P1) return "P1";
  if (scoreValue >= PRIORITY_THRESHOLDS.P2) return "P2";
  return "P3";
}
