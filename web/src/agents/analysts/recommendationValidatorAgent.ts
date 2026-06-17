/**
 * recommendationValidatorAgent.ts — the 7th lightweight agent in the pipeline.
 *
 * Unlike the 6 Analysts, this does NOT produce new findings — it reviews the
 * day's already-deduped, business-rule-gated findings in ONE batched Groq
 * call and annotates each with: is_generic, missing_data,
 * alternative_explanations, and an optional confidence_override. This is
 * the judgment-based check a deterministic regex/threshold layer cannot do
 * reliably (businessRules.ts handles the pure-arithmetic gates separately).
 *
 * Findings flagged generic with no rescue get demoted one severity tier —
 * never silently dropped. Every override is recorded in `validation_flags`
 * so it is auditable on the dashboard. Reuses the same `callLLM` client as
 * the 6 Analysts (web/src/agents/llm.ts) — no new provider/infra.
 *
 * Failures are non-fatal: if the Groq call throws (including the daily
 * token-ceiling error), findings pass through unannotated rather than
 * blocking the rest of the daily-audit pipeline.
 */

import { callLLM } from "../llm";
import type { Confidence, Severity, SynthFinding } from "../schema";

const MAX_REVIEW = 60; // batch ceiling — keeps prompt/token size predictable

export interface ValidatorResult {
  findings: SynthFinding[];
  tokenCount: number;
}

export async function runRecommendationValidator(findings: SynthFinding[], runDate: string): Promise<ValidatorResult> {
  if (findings.length === 0) return { findings, tokenCount: 0 };

  const toReview = findings.slice(0, MAX_REVIEW);
  const rest = findings.slice(MAX_REVIEW);

  try {
    const llm = await callLLM(buildSystemPrompt(), buildUserPrompt(toReview, runDate), {
      label: "recommendation_validator",
      max_tokens: 4000,
      temperature: 0.1,
      largePrompt: true, // up to 60 batched findings reviewed at once
    });

    const annotations = parseAnnotations(llm.json);
    const reviewed = toReview.map((f) => applyAnnotation(f, annotations.get(f.id)));
    const flagged = reviewed.filter((f) => (f.validation_flags || []).length > 0).length;

    console.log(`[agent] recommendation_validator [${llm.provider}] -> reviewed ${reviewed.length}, flagged ${flagged} (tokens=${llm.tokens.total})`);

    return { findings: [...reviewed, ...rest], tokenCount: llm.tokens.total };
  } catch (e) {
    console.error(`[agent] recommendation_validator FAILED (non-fatal, findings pass through unannotated): ${String((e as Error)?.message || e)}`);
    return { findings, tokenCount: 0 };
  }
}

function buildSystemPrompt(): string {
  return (
    "You are a skeptical senior PPC reviewer auditing a list of already-generated recommendations before they reach " +
    "a human for approval. You do not generate new findings — you judge the ones given.\n\n" +
    "For EACH finding, decide:\n" +
    "  - is_generic: true if the `action` text could apply to almost any campaign/keyword/ad without modification " +
    '(e.g. "increase budget", "improve ad relevance", "optimize targeting" with no named entity or number). ' +
    "false if it names a specific entity AND cites at least one real number from evidence.\n" +
    "  - missing_data: array of specific data points that would make this finding more defensible if they existed " +
    '(e.g. "Auction Insights", "keyword-level Quality Score history", "device breakdown"). Empty array if none needed.\n' +
    "  - alternative_explanations: array of 0-2 plausible alternative causes for the same observation that the " +
    'finding did not consider (e.g. "could be seasonality, not creative fatigue"). Empty array if the evidence is ' +
    "decisive enough that no alternative is plausible.\n" +
    '  - confidence_override: "low" | "medium" | "high" | null. Only set this if you believe the evidence supports a ' +
    "different confidence than what's implied — otherwise null.\n\n" +
    "Output STRICT JSON:\n" +
    "{\n" +
    '  "reviews": [\n' +
    '    { "id": "<echo exactly>", "is_generic": false, "missing_data": [], "alternative_explanations": [], "confidence_override": null }\n' +
    "  ]\n" +
    "}\n\n" +
    "Rules:\n" +
    "  - Echo every id EXACTLY as given. Review every finding provided — never skip or invent one.\n" +
    "  - Be skeptical but fair: a finding naming a specific keyword/campaign/ad WITH a real number is NOT generic, " +
    "even if the underlying advice (e.g. 'add negative keywords') is a common type of action.\n" +
    "  - Return ONLY the JSON object — no prose, no markdown fences."
  );
}

function buildUserPrompt(findings: SynthFinding[], runDate: string): string {
  const lines = [`Reviewing ${findings.length} findings from the ${runDate} daily audit.\n`];
  for (const f of findings) {
    lines.push(
      `id=${f.id} severity=${f.severity} confidence=${f.confidence}\n` +
        `  title: ${f.title}\n` +
        `  action: ${f.action}\n` +
        `  evidence: ${(f.evidence || []).join(" | ")}\n` +
        `  target: ${f.target?.type} "${f.target?.name}"`
    );
  }
  return lines.join("\n\n");
}

interface RawReview {
  id?: unknown;
  is_generic?: unknown;
  missing_data?: unknown;
  alternative_explanations?: unknown;
  confidence_override?: unknown;
}

function parseAnnotations(json: Record<string, unknown> | null): Map<string, RawReview> {
  const out = new Map<string, RawReview>();
  const reviews = Array.isArray(json?.reviews) ? (json!.reviews as RawReview[]) : [];
  for (const r of reviews) {
    if (r && typeof r.id === "string") out.set(r.id, r);
  }
  return out;
}

const VALID_CONFIDENCE: Confidence[] = ["low", "medium", "high"];

function demoteSeverity(sev: Severity): Severity {
  if (sev === "P1") return "P2";
  if (sev === "P2") return "P3";
  return "P3";
}

function applyAnnotation(f: SynthFinding, review: RawReview | undefined): SynthFinding {
  if (!review) return f;

  const missingData = Array.isArray(review.missing_data) ? review.missing_data.map((s) => String(s).slice(0, 200)).slice(0, 6) : [];
  const altExplanations = Array.isArray(review.alternative_explanations)
    ? review.alternative_explanations.map((s) => String(s).slice(0, 200)).slice(0, 4)
    : [];
  const isGeneric = review.is_generic === true;
  const confidenceOverride = VALID_CONFIDENCE.includes(review.confidence_override as Confidence)
    ? (review.confidence_override as Confidence)
    : null;

  const flags = [...(f.validation_flags || [])];
  let severity = f.severity;
  let confidence = f.confidence;

  if (isGeneric) {
    flags.push("flagged_generic_by_validator");
    severity = demoteSeverity(severity);
  }
  if (confidenceOverride && confidenceOverride !== f.confidence) {
    flags.push(`confidence_override: ${f.confidence} -> ${confidenceOverride}`);
    confidence = confidenceOverride;
  }

  return {
    ...f,
    severity,
    confidence,
    missing_data: Array.from(new Set([...(f.missing_data || []), ...missingData])),
    alternative_explanations: Array.from(new Set([...(f.alternative_explanations || []), ...altExplanations])),
    validation_flags: flags,
  };
}
