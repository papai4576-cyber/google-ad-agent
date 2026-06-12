/**
 * schema.ts — universal findings schema (shared by all 6 v2 Analysts).
 *
 * Ported from apps_script/config.js (VALID, SCORE_WEIGHTS, PRIORITY_THRESHOLDS
 * live in their own modules) and apps_script/agents/_common.js
 * (validateFindings / _validateFinding / _normalizeFinding).
 */

export const VALID = {
  severities: ["P1", "P2", "P3"] as const,
  magnitudes: ["low", "medium", "high"] as const,
  confidences: ["low", "medium", "high"] as const,
  efforts: ["easy", "medium", "hard"] as const,
  categories: [
    "performance",
    "keywords",
    "copy",
    "structure",
    "bidding",
    "audience",
    "extensions",
    "competitive",
    "landing_page",
    "general",
    "scaling",
  ] as const,
  target_types: ["campaign", "adgroup", "keyword", "ad"] as const,
  modes: ["daily", "weekly"] as const,
  brain_categories: [
    "copy",
    "bidding",
    "structure",
    "scaling",
    "brand",
    "keywords",
    "audience",
    "competitive",
    "landing_page",
    "pmax",
    "reddit_intel",
    "general",
  ] as const,
};

export type Severity = (typeof VALID.severities)[number];
export type Magnitude = (typeof VALID.magnitudes)[number];
export type Confidence = (typeof VALID.confidences)[number];
export type Effort = (typeof VALID.efforts)[number];
export type Category = (typeof VALID.categories)[number];
export type TargetType = (typeof VALID.target_types)[number];
export type Mode = (typeof VALID.modes)[number];
export type BrainCategory = (typeof VALID.brain_categories)[number];

export interface FindingTarget {
  type: TargetType;
  id: string;
  name: string;
}

export interface EstimatedImpact {
  metric: string;
  direction: "up" | "down";
  magnitude: Magnitude;
}

/** A single finding, in the universal schema shape returned by an LLM. */
export interface Finding {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  what: string;
  why: string;
  action: string;
  target: FindingTarget;
  estimated_impact: EstimatedImpact;
  confidence: Confidence;
  effort: Effort;
  evidence: string[];
  brain_sources: string[];
}

/** A finding that has entered the synthesis pipeline (agent/run metadata attached). */
export interface SynthFinding extends Finding {
  agent: string;
  runDate: string;
  mode: Mode;
  /** Set by ImpactScorer; absent before scoring. */
  score?: number;
  /** Set by ImpactScorer; absent before scoring. */
  priority?: Severity;
}

export interface AnalystOutput {
  agent: string;
  run_date: string;
  mode: Mode;
  findings: Finding[];
  summary: string;
  token_count: number;
  run_time_ms: number;
}

export interface DroppedFinding {
  reason: string;
  raw: unknown;
}

export interface ValidateFindingsResult {
  ok: boolean;
  findings: Finding[];
  dropped: DroppedFinding[];
  summary: string;
  error?: string;
}

/**
 * Validate + normalize a raw `{ findings: [...], summary }` object as
 * returned by an LLM in JSON mode. Invalid findings are dropped, not thrown.
 */
export function validateFindings(raw: unknown): ValidateFindingsResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, findings: [], dropped: [], summary: "", error: "LLM returned non-object" };
  }
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.findings) ? obj.findings : [];
  const summary = String(obj.summary ?? "").slice(0, 600);

  const validated: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const f of list) {
    const errs = validateFinding(f);
    if (errs.length) {
      dropped.push({ reason: errs.join("; "), raw: f });
      continue;
    }
    validated.push(normalizeFinding(f as RawFinding));
  }
  return { ok: true, findings: validated, dropped, summary };
}

interface RawFinding {
  id?: unknown;
  category?: unknown;
  severity?: unknown;
  title?: unknown;
  what?: unknown;
  why?: unknown;
  action?: unknown;
  target?: { type?: unknown; id?: unknown; name?: unknown };
  estimated_impact?: { metric?: unknown; direction?: unknown; magnitude?: unknown };
  confidence?: unknown;
  effort?: unknown;
  evidence?: unknown;
  brain_sources?: unknown;
}

export function validateFinding(f: unknown): string[] {
  const errs: string[] = [];
  if (!f || typeof f !== "object") {
    errs.push("not an object");
    return errs;
  }
  const r = f as RawFinding;
  if (!r.id || typeof r.id !== "string") errs.push("missing id");
  if (!VALID.categories.includes(r.category as Category)) errs.push(`bad category="${String(r.category)}"`);
  if (!VALID.severities.includes(r.severity as Severity)) errs.push(`bad severity="${String(r.severity)}"`);
  if (!r.title || typeof r.title !== "string") errs.push("missing title");
  if (!r.what || typeof r.what !== "string") errs.push("missing what");
  if (!r.why || typeof r.why !== "string") errs.push("missing why");
  if (!r.action || typeof r.action !== "string") errs.push("missing action");
  if (!r.target || !VALID.target_types.includes(r.target.type as TargetType)) errs.push("bad target.type");
  const ei = r.estimated_impact || {};
  if (!VALID.magnitudes.includes(ei.magnitude as Magnitude)) errs.push(`bad impact.magnitude="${String(ei.magnitude)}"`);
  if (ei.direction !== "up" && ei.direction !== "down") errs.push(`bad impact.direction="${String(ei.direction)}"`);
  if (!VALID.confidences.includes(r.confidence as Confidence)) errs.push(`bad confidence="${String(r.confidence)}"`);
  if (!VALID.efforts.includes(r.effort as Effort)) errs.push(`bad effort="${String(r.effort)}"`);
  return errs;
}

export function normalizeFinding(f: RawFinding): Finding {
  const target = f.target!;
  const ei = f.estimated_impact!;
  return {
    id: String(f.id).slice(0, 100),
    category: f.category as Category,
    severity: f.severity as Severity,
    title: String(f.title).slice(0, 200),
    what: String(f.what).slice(0, 1000),
    why: String(f.why).slice(0, 1000),
    action: String(f.action).slice(0, 1000),
    target: {
      type: target.type as TargetType,
      id: String(target.id ?? "").slice(0, 100),
      name: String(target.name ?? "").slice(0, 200),
    },
    estimated_impact: {
      metric: String(ei.metric ?? "").slice(0, 32),
      direction: ei.direction as "up" | "down",
      magnitude: ei.magnitude as Magnitude,
    },
    confidence: f.confidence as Confidence,
    effort: f.effort as Effort,
    evidence: Array.isArray(f.evidence) ? f.evidence.slice(0, 8).map((e) => String(e).slice(0, 300)) : [],
    brain_sources: Array.isArray(f.brain_sources) ? f.brain_sources.slice(0, 8).map((e) => String(e).slice(0, 32)) : [],
  };
}
