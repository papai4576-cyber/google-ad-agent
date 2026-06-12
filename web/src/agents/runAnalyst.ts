/**
 * runAnalyst.ts — the AnalystSpec harness every v2 Analyst is built on.
 *
 * Ported from `runAgent` / `runRuleBasedAgent` / `buildSystemPrompt` /
 * `buildRuleSystemPrompt` / `formatDataContext` / `_renderCandidates_` /
 * `_candScore_` in apps_script/agents/_common.js.
 *
 * Differences from the Apps Script version:
 *   - async (callLLM is fetch-based)
 *   - does NOT write to the database — it returns an `AnalystOutput`
 *     (CLAUDE.md universal agent output schema). Persisting `findings` rows
 *     and synthesising `action_plan` is the daily-audit pipeline's job
 *     (Phase F), not the Analyst's.
 *   - data context (LAST_COLLECT_DATE_RANGE / _DATE / _MODE) is read from the
 *     `config` table instead of Script Properties.
 */

import { callLLM } from "./llm";
import { queryBrain, formatBrainContext } from "./brain";
import { getConfigValue, getTargets, type Targets } from "./rules/rulesEngine";
import {
  VALID,
  validateFinding,
  validateFindings as validateFindingsRaw,
  type AnalystOutput,
  type BrainCategory,
  type Category,
  type Confidence,
  type Effort,
  type Finding,
  type FindingTarget,
  type Magnitude,
  type Mode,
} from "./schema";

/* ===========================================================================
 * Candidate type — used by rule-based Analysts' detect() functions.
 * ========================================================================= */

export interface Candidate {
  id: string;
  category: Category;
  severity: "P1" | "P2" | "P3";
  magnitude: Magnitude;
  confidence: Confidence;
  effort: Effort;
  metric?: string;
  direction?: "up" | "down";
  target: FindingTarget;
  evidence: string[];
  /** Short human hint used as a fallback for title/what/action if the LLM omits prose. */
  hint?: string;
}

interface RuleContext {
  targets: Targets;
  cur: string;
  cfg: Record<string, number>;
}

/* ===========================================================================
 * AnalystSpec
 * ========================================================================= */

export interface AnalystSpec<TData = unknown> {
  agentName: string;
  mode?: Mode;
  persona: string;
  instructions: string;
  brainCategories: BrainCategory[];
  brainLimit?: number;
  maxTokens?: number;
  data: TData;
  formatDataForPrompt: (data: TData) => string;
}

export interface RuleBasedAnalystSpec<TData = unknown> extends AnalystSpec<TData> {
  detect: (data: TData, ctx: RuleContext) => Candidate[];
  /** Pre-loaded RULE_* thresholds (e.g. via RulesEngine.load), lowercased keys. */
  ruleConfig?: Record<string, number>;
  maxCandidates?: number;
}

/* ===========================================================================
 * Pure-LLM analyst: spec.formatDataForPrompt(data) -> raw data section.
 * ========================================================================= */

export async function runPureLLMAnalyst<TData>(spec: AnalystSpec<TData>, runDate: string): Promise<AnalystOutput> {
  const start = Date.now();
  const mode = spec.mode || "daily";

  const brain = await queryBrain(spec.brainCategories, spec.brainLimit ?? 5);
  const targets = await getTargets();

  const systemPrompt = buildSystemPrompt(spec.persona, spec.instructions);
  const userPrompt =
    (await formatDataContext()) +
    "\n" +
    "TARGETS:\n" +
    JSON.stringify(targets) +
    "\n\n" +
    formatBrainContext(brain) +
    "\n\n" +
    "--- DATA ---\n" +
    spec.formatDataForPrompt(spec.data);

  const llm = await callLLM(systemPrompt, userPrompt, {
    label: spec.agentName,
    max_tokens: spec.maxTokens ?? 3500,
    temperature: 0.2,
  });

  const { findings, dropped, summary } = validateAndNormalize(llm.json);
  const ms = Date.now() - start;

  console.log(
    `[agent] ${spec.agentName} [${llm.provider}] -> ${findings.length} findings (dropped=${dropped.length}, tokens=${llm.tokens.total}, ${ms}ms)`
  );
  for (const d of dropped.slice(0, 3)) {
    console.log(`[agent]   dropped: ${d}`);
  }

  return {
    agent: spec.agentName,
    run_date: runDate,
    mode,
    findings,
    summary,
    token_count: llm.tokens.total,
    run_time_ms: ms,
  };
}

/* ===========================================================================
 * Rule-based analyst (token-lean path).
 *
 *   1. spec.detect(data, ctx) returns deterministic candidates.
 *   2. If 0 candidates, no LLM call — return an empty AnalystOutput.
 *   3. Otherwise send only the compact candidate list; the LLM writes ONLY
 *      prose (title/what/why/action), merged back onto the deterministic
 *      candidate fields (which remain authoritative for severity/target/evidence).
 * ========================================================================= */

export async function runRuleBasedAnalyst<TData>(spec: RuleBasedAnalystSpec<TData>, runDate: string): Promise<AnalystOutput> {
  const start = Date.now();
  const mode = spec.mode || "daily";
  const targets = await getTargets();
  const ctx: RuleContext = { targets, cur: targets.currency_symbol, cfg: spec.ruleConfig ?? {} };

  let candidates = spec.detect(spec.data, ctx) || [];
  candidates.sort((a, b) => candidateScore(b) - candidateScore(a));
  const cap = spec.maxCandidates ?? 8;
  if (candidates.length > cap) candidates = candidates.slice(0, cap);

  if (candidates.length === 0) {
    console.log(`[agent] ${spec.agentName} [rules] -> 0 candidates (no LLM call), ${Date.now() - start}ms`);
    return {
      agent: spec.agentName,
      run_date: runDate,
      mode,
      findings: [],
      summary: "No rule hits.",
      token_count: 0,
      run_time_ms: Date.now() - start,
    };
  }

  const brain = await queryBrain(spec.brainCategories, spec.brainLimit ?? 4);
  const systemPrompt = buildRuleSystemPrompt(spec.persona, spec.instructions);
  const userPrompt =
    (await formatDataContext()) +
    "\n" +
    "TARGETS:\n" +
    JSON.stringify(ctx.targets) +
    "\n\n" +
    formatBrainContext(brain) +
    "\n\n" +
    "--- PRE-DETECTED ISSUES (write each one up; do NOT add or drop any) ---\n" +
    renderCandidates(candidates);

  const llm = await callLLM(systemPrompt, userPrompt, {
    label: spec.agentName,
    max_tokens: spec.maxTokens ?? 2000,
    temperature: 0.2,
  });

  // Index the LLM's prose by echoed id.
  const proseList = Array.isArray(llm.json?.findings) ? (llm.json!.findings as Array<Record<string, unknown>>) : [];
  const prose = new Map<string, Record<string, unknown>>();
  for (const p of proseList) {
    if (p && typeof p.id === "string") prose.set(p.id, p);
  }

  // Merge prose onto deterministic candidates. Candidate fields are authoritative.
  const findings: Finding[] = [];
  for (const c of candidates) {
    const p = prose.get(c.id) ?? {};
    const fallbackWhy = (c.evidence || []).join("; ");
    const f: Finding = {
      id: c.id,
      category: c.category,
      severity: c.severity,
      title: String(p.title ?? c.hint ?? c.id).slice(0, 200),
      what: String(p.what ?? c.hint ?? fallbackWhy).slice(0, 1000),
      why: String(p.why ?? fallbackWhy).slice(0, 1000),
      action: String(p.action ?? c.hint ?? "").slice(0, 1000),
      target: c.target,
      estimated_impact: {
        metric: String(c.metric ?? "spend").slice(0, 32),
        direction: c.direction === "up" || c.direction === "down" ? c.direction : "down",
        magnitude: c.magnitude,
      },
      confidence: c.confidence,
      effort: c.effort,
      evidence: Array.isArray(c.evidence) ? c.evidence.slice(0, 8).map((e) => String(e).slice(0, 300)) : [],
      brain_sources: Array.isArray(p.brain_sources) ? (p.brain_sources as unknown[]).slice(0, 8).map((e) => String(e).slice(0, 32)) : [],
    };
    const errs = validateFinding(f);
    if (errs.length) {
      console.log(`[agent] ${spec.agentName} candidate ${c.id} invalid: ${errs.join("; ")}`);
      continue;
    }
    findings.push(f);
  }

  const ms = Date.now() - start;
  console.log(
    `[agent] ${spec.agentName} [rules+${llm.provider}] -> ${findings.length} findings from ${candidates.length} candidates (tokens=${llm.tokens.total}, ${ms}ms)`
  );

  return {
    agent: spec.agentName,
    run_date: runDate,
    mode,
    findings,
    summary: typeof llm.json?.summary === "string" ? (llm.json.summary as string) : `${findings.length} rule-detected issues.`,
    token_count: llm.tokens.total,
    run_time_ms: ms,
  };
}

/* ===========================================================================
 * Prompt boilerplate
 * ========================================================================= */

export function buildSystemPrompt(persona: string, instructionsForDomain: string): string {
  return (
    persona +
    "\n\n" +
    instructionsForDomain +
    "\n\n" +
    "Output STRICT JSON with this EXACT shape:\n" +
    "{\n" +
    '  "findings": [\n' +
    "    {\n" +
    '      "id":         "kebab-case unique id within this run, e.g. \\"underspending-search-1\\"",\n' +
    '      "category":   "' + VALID.categories.join(" | ") + '",\n' +
    '      "severity":   "P1 | P2 | P3   // P1=act today, P2=this week, P3=consider",\n' +
    '      "title":      "short action title, max 100 chars",\n' +
    '      "what":       "what is wrong or what opportunity exists",\n' +
    '      "why":        "why it matters — quantified with $ / % wherever possible",\n' +
    '      "action":     "exact change to make, written for a human implementer",\n' +
    '      "target":     { "type": "campaign | adgroup | keyword | ad", "id": "<id from data>", "name": "<name>" },\n' +
    '      "estimated_impact": {\n' +
    '        "metric":    "CPA | ROAS | CTR | spend | conversions",\n' +
    '        "direction": "up | down",\n' +
    '        "magnitude": "low | medium | high"\n' +
    "      },\n" +
    '      "confidence": "high | medium | low",\n' +
    '      "effort":     "easy | medium | hard",\n' +
    '      "evidence":   ["data point 1", "data point 2"],\n' +
    '      "brain_sources": ["brain_001", "brain_042"]    // ids from the BRAIN section, or [] if none used\n' +
    "    }\n" +
    "  ],\n" +
    '  "summary": "one-sentence overview of the run"\n' +
    "}\n\n" +
    "Severity guide:\n" +
    "  P1 = costing meaningful $ today or blocking conversions — act today\n" +
    "  P2 = real opportunity but not bleeding right now — this week\n" +
    "  P3 = optimisation / nice-to-have — consider when bandwidth allows\n\n" +
    "Confidence guide:\n" +
    "  high   = data is decisive (statistically significant or unambiguous)\n" +
    "  medium = pattern is suggestive but limited data\n" +
    "  low    = early signal, needs more data — usually still worth a P3\n\n" +
    "Effort guide:\n" +
    "  easy   = a few clicks in Google Ads UI\n" +
    "  medium = research + a few campaigns of changes\n" +
    "  hard   = restructuring or new infrastructure\n\n" +
    "Rules:\n" +
    "  - Return ONLY the JSON object. No prose, no markdown fences.\n" +
    "  - Quantify amounts using the CURRENCY symbol given in the TARGETS block of the user prompt (NEVER assume $). Use % freely.\n" +
    '  - target.type MUST be EXACTLY one of: "campaign", "adgroup", "keyword", "ad". NO other values are allowed. NEVER use "budget", "bid", "strategy", "account", "monthly_budget", "ad_group", or anything else.\n' +
    '    - Budget / pacing findings → target.type = "campaign" (budget belongs to the campaign)\n' +
    '    - Bid strategy findings    → target.type = "campaign"\n' +
    "    - Account-wide findings    → still pick a representative campaign as the target\n" +
    "  - target.id MUST be a real id from the DATA section. target.name MUST be the matching name.\n" +
    '  - If you cite a brain entry, put its id (e.g. "brain_006") in brain_sources.\n' +
    "  - Produce AT MOST 8 findings per run. Surface only the most actionable.\n" +
    "  - If nothing is wrong, return findings:[] and an honest summary.\n"
  );
}

/** Compact system prompt for the prose-only LLM step (rule-based analysts). */
export function buildRuleSystemPrompt(persona: string, instructions: string): string {
  return (
    persona +
    "\n\n" +
    (instructions ? instructions + "\n\n" : "") +
    "You are given a list of PRE-DETECTED issues, each with an id, the data evidence, and a target. Your ONLY job is to write clear human-facing copy for each issue. Detection is already done — do not second-guess it.\n\n" +
    "Output STRICT JSON:\n" +
    "{\n" +
    '  "findings": [\n' +
    '    { "id": "<echo the given id EXACTLY>", "title": "<=100 chars", "what": "what is wrong / the opportunity", "why": "why it matters, quantified", "action": "exact change for a human implementer", "brain_sources": ["brain_001"] }\n' +
    "  ],\n" +
    '  "summary": "one sentence"\n' +
    "}\n\n" +
    "Rules:\n" +
    "  - Echo every id EXACTLY. Write up EVERY issue provided; never invent or drop any.\n" +
    "  - Use ONLY the evidence numbers given — never fabricate data.\n" +
    "  - Quantify money with the currency symbol in TARGETS (never assume $).\n" +
    "  - Cite a brain id in brain_sources only if you actually used it.\n" +
    "  - Return ONLY the JSON object — no prose, no markdown fences.\n"
  );
}

function renderCandidates(candidates: Candidate[]): string {
  const lines: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    lines.push(
      `#${i + 1} id=${c.id} [${c.severity}/${c.category}]\n` +
        `  issue:  ${c.hint || ""}\n` +
        `  target: ${c.target.type} "${c.target.name}" (${c.target.id})\n` +
        `  data:   ${(c.evidence || []).join(" | ")}`
    );
  }
  return lines.join("\n\n");
}

const SCORE_WEIGHTS_LOCAL = {
  magnitude: { high: 3, medium: 2, low: 1 },
  confidence: { high: 1.0, medium: 0.7, low: 0.4 },
  effort: { easy: 1.0, medium: 1.5, hard: 2.5 },
} as const;

function candidateScore(c: Candidate): number {
  const m = SCORE_WEIGHTS_LOCAL.magnitude[c.magnitude];
  const cf = SCORE_WEIGHTS_LOCAL.confidence[c.confidence];
  const e = SCORE_WEIGHTS_LOCAL.effort[c.effort];
  if (!m || !cf || !e) return 0;
  return (m * cf) / e;
}

/* ===========================================================================
 * Data context — tells the LLM exactly which window of data it's seeing.
 * Stamped into `config` (LAST_COLLECT_DATE_RANGE / _DATE / _MODE) by the
 * ingest pipeline; "unknown" if not yet set.
 * ========================================================================= */

export async function formatDataContext(): Promise<string> {
  const range = await getConfigValue("LAST_COLLECT_DATE_RANGE", "unknown");
  const date = await getConfigValue("LAST_COLLECT_DATE", "unknown");
  const mode = await getConfigValue("LAST_COLLECT_MODE", "unknown");
  const human = humanizeRange(range);
  return (
    "DATA CONTEXT:\n" +
    "  - All numbers below are TOTALS over the lookback window.\n" +
    `  - Window:        ${human} (${range}, mode=${mode})\n` +
    `  - Collected on:  ${date}\n` +
    "  - Note: conversion VALUES for the last ~7 days may be incomplete — Google Ads attributes value retroactively. Discount recent-window ROAS findings accordingly.\n" +
    "  - Note: raw snapshot tables contain ENABLED entities only; paused/removed campaigns are excluded.\n"
  );
}

function humanizeRange(range: string): string {
  if (!range) return "unknown";
  const map: Record<string, string> = {
    LAST_7_DAYS: "last 7 days",
    LAST_14_DAYS: "last 14 days",
    LAST_30_DAYS: "last 30 days",
    LAST_60_DAYS: "last 60 days",
    LAST_90_DAYS: "last 90 days",
    THIS_MONTH: "this calendar month so far",
    LAST_MONTH: "previous calendar month",
    YESTERDAY: "yesterday only",
    TODAY: "today only",
  };
  return map[range.toUpperCase()] || range;
}

/* ===========================================================================
 * Validation wrapper (returns flat findings/dropped/summary).
 * ========================================================================= */

function validateAndNormalize(raw: unknown): { findings: Finding[]; dropped: string[]; summary: string } {
  const result = validateFindingsRaw(raw);
  return {
    findings: result.findings,
    dropped: result.dropped.map((d) => d.reason),
    summary: result.summary,
  };
}
