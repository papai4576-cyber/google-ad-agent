/**
 * llm.ts — multi-provider LLM client used by every Analyst, with automatic
 * failover across providers/keys so one exhausted free-tier daily quota
 * doesn't stall the whole pipeline.
 *
 * Ported from apps_script/llm.js (Groq-only) and extended: callLLM() now
 * tries a ranked list of providers built from whichever API keys are set in
 * the environment, in order:
 *
 *   1. Groq key 1     (GROQ_API_KEY)            — required, primary
 *   2. Groq key 2..4   (GROQ_API_KEY_2/_3/_4)    — optional, extra free accounts
 *   3. Google Gemini   (GEMINI_API_KEY)          — optional, OpenAI-compatible endpoint
 *   4. Cerebras        (CEREBRAS_API_KEY)        — optional, OpenAI-compatible endpoint
 *   5. OpenRouter       (OPENROUTER_API_KEY)     — optional, ":free" model, OpenAI-compatible
 *
 * Any provider whose env var is unset is simply absent from the list — no
 * error, no config needed beyond adding the key. When the current provider
 * is at its proactive daily ceiling (or its call fails for any reason —
 * TPD limit, transient error exhausted after retries, bad key), callLLM
 * moves to the next provider in the list rather than throwing immediately.
 * Only throws if EVERY configured provider is exhausted/failing.
 *
 * Token usage is tracked per provider id (e.g. "groq_1", "gemini") in the
 * `token_usage` table, so each provider/key gets its own independent daily
 * ceiling — exhausting groq_1 does not affect groq_2's budget.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { config, tokenUsage } from "@/db/schema";

export const LLM = {
  temperature: 0.3,
  max_tokens: 4000,
  request_timeout_ms: 60000,
} as const;

export interface LLMOptions {
  /** Force JSON mode (default true). */
  json?: boolean;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** Attempts on 429/5xx before giving up (default 4), per provider. */
  max_retries?: number;
  /** Tag for logs — usually the agent name. */
  label?: string;
  /**
   * Set true when the prompt may run large (big data tables / batched review
   * lists — roughly >6K tokens combined). Cerebras's free tier caps context at
   * 8,192 tokens; OpenRouter's free Llama 3.3 70B routes through providers with
   * much larger context windows. For large prompts, Cerebras is tried LAST
   * instead of second, since it's the most likely to reject with a
   * context-length error (researched June 2026 — see llm.ts header comment).
   */
  largePrompt?: boolean;
}

export interface LLMResult {
  ok: true;
  /** Provider id that actually served this call, e.g. "groq_1", "gemini", "cerebras". */
  provider: string;
  json: Record<string, unknown> | null;
  text: string;
  model: string;
  tokens: { prompt: number; completion: number; total: number };
  ms: number;
  attempts: number;
}

/* ===========================================================================
 * Provider registry — built from whichever env vars are set.
 * ========================================================================= */

interface ProviderConfig {
  id: string;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Proactive daily-ceiling default for this provider; overridable via config.<ID>_DAILY_TOKEN_CEILING. */
  defaultCeiling: number;
  /** Regex matched against 429 response bodies to detect a daily-quota-type error (bail to next provider, don't retry). */
  tpdErrorPattern: RegExp;
  /**
   * Extra max_tokens headroom added on top of the caller's requested budget.
   * Chain-of-thought/reasoning models (e.g. gpt-oss-120b) spend tokens on a
   * hidden `reasoning` field before emitting `content` — without headroom,
   * the response can hit the token limit mid-reasoning with empty content.
   * 0 for plain instruct models.
   */
  reasoningHeadroom: number;
}

/**
 * Provider order rationale (researched June 2026 — see sources in PR/commit):
 *   1. Groq (each key: 100K tokens/day) — fastest, already proven reliable
 *      JSON-mode output in this exact pipeline. Multiple free accounts each
 *      get an independent quota, so this is the cheapest way to add headroom.
 *   2. Cerebras (1M tokens/day, 10x a single Groq key) — same Llama 3.3 70B
 *      model family, very fast, huge daily headroom. BUT its free tier caps
 *      context at 8,192 tokens, so it's a poor fit for prompts with large
 *      data tables (search-term batches, multi-campaign account dumps,
 *      the recommendation validator's batched review). Default order; see
 *      `largePrompt` for prompts that should try it last instead.
 *   3. OpenRouter (50-1000 requests/day depending on credit, 20 RPM) — the
 *      most rate-limited of the three by request count, but its free models
 *      (we use llama-3.3-70b-instruct:free for consistency) typically route
 *      through providers with much larger context windows than Cerebras's
 *      free tier, and offer real model diversity if ever wanted. Used last
 *      under default ordering; promoted ahead of Cerebras for large prompts.
 *   4. Gemini — optional, not currently configured; very large context
 *      window, no known small-context-cap issue, so it stays in its
 *      registered position regardless of `largePrompt`.
 */

function buildProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  const groqKeys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
  ]
    .map((k) => (k || "").trim())
    .filter(Boolean);

  groqKeys.forEach((apiKey, i) => {
    providers.push({
      id: `groq_${i + 1}`,
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      apiKey,
      model: "llama-3.3-70b-versatile",
      defaultCeiling: 90000,
      tpdErrorPattern: /tokens per day|TPD|tokens_per_day/i,
      reasoningHeadroom: 0,
    });
  });

  const geminiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (geminiKey) {
    providers.push({
      id: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: geminiKey,
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      defaultCeiling: 800000, // free tier is RPM/RPD-gated, not a published TPD figure — generous soft cap
      tpdErrorPattern: /quota|rate.?limit|resource.?exhausted/i,
      reasoningHeadroom: 0,
    });
  }

  const cerebrasKey = (process.env.CEREBRAS_API_KEY || "").trim();
  if (cerebrasKey) {
    providers.push({
      id: "cerebras",
      endpoint: "https://api.cerebras.ai/v1/chat/completions",
      apiKey: cerebrasKey,
      // Verified live against this key (June 2026): the account's only models are gpt-oss-120b and zai-glm-4.7.
      // Both can intermittently emit a hidden chain-of-thought `reasoning` field before `content` (observed on
      // zai-glm-4.7 too, not just gpt-oss — non-deterministic, varies by call) which can exhaust max_tokens before
      // any content is produced. Unconditional headroom on this provider, regardless of model, is cheap insurance
      // against Cerebras's 1M-token/day budget.
      model: process.env.CEREBRAS_MODEL || "zai-glm-4.7",
      defaultCeiling: 900000,
      tpdErrorPattern: /tokens per day|TPD|rate.?limit|quota/i,
      reasoningHeadroom: 1200,
    });
  }

  const openRouterKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (openRouterKey) {
    providers.push({
      id: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: openRouterKey,
      // OpenRouter's free catalog rotates — verified live (June 2026): llama-3.3-70b-instruct:free and
      // qwen3-next-80b-a3b-instruct:free were both congested (429 upstream), nemotron-3-super-120b-a12b:free is a
      // reasoning model (needs headroom, same risk as Cerebras's gpt-oss-120b). gemma-4-26b-a4b-it:free returned
      // clean `content` at low max_tokens with no reasoning overhead — used as the default.
      model: process.env.OPENROUTER_MODEL || "google/gemma-4-26b-a4b-it:free",
      defaultCeiling: 900000, // real constraint is 50-1000 requests/day, not tokens — this pipeline makes ~8 calls/day total
      tpdErrorPattern: /rate.?limit|quota|too many requests/i,
      reasoningHeadroom: 0,
    });
  }

  return providers;
}

/** Moves Cerebras to the end of the list — see `largePrompt` doc on LLMOptions for why. */
function orderForPromptSize(providers: ProviderConfig[], largePrompt: boolean): ProviderConfig[] {
  if (!largePrompt) return providers;
  const idx = providers.findIndex((p) => p.id === "cerebras");
  if (idx === -1) return providers;
  const reordered = providers.slice();
  const [cerebras] = reordered.splice(idx, 1);
  reordered.push(cerebras);
  return reordered;
}

/* ===========================================================================
 * Public API
 * ========================================================================= */

/**
 * Call an LLM, trying each configured provider in order until one succeeds.
 * Throws only if every provider is exhausted or fails.
 */
export async function callLLM(systemPrompt: string, userPrompt: string, options?: LLMOptions): Promise<LLMResult> {
  const opts = options || {};

  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    throw new Error("callLLM: systemPrompt must be a non-empty string.");
  }
  if (typeof userPrompt !== "string" || userPrompt.trim() === "") {
    throw new Error("callLLM: userPrompt must be a non-empty string.");
  }

  const providers = orderForPromptSize(buildProviders(), opts.largePrompt === true);
  if (providers.length === 0) {
    throw new Error("callLLM: no LLM provider configured. Set GROQ_API_KEY (and optionally GROQ_API_KEY_2/_3/_4, GEMINI_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY).");
  }

  const failures: string[] = [];

  for (const p of providers) {
    if (await overDailyCeiling(p.id, p.defaultCeiling)) {
      const used = await tokensUsedToday(p.id);
      failures.push(`${p.id}: at daily ceiling (${used}/${await dailyTokenCeiling(p.id, p.defaultCeiling)})`);
      continue;
    }

    try {
      const res = await callProvider(p, systemPrompt, userPrompt, opts);
      await recordTokenUsage(p.id, res.tokens.total);
      return res;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      failures.push(`${p.id}: ${msg.slice(0, 200)}`);
      console.log(`[llm] ${p.id} failed, trying next provider if available: ${msg.slice(0, 200)}`);
    }
  }

  throw new Error(`callLLM: all ${providers.length} provider(s) exhausted/failed. ${failures.join(" | ")}`);
}

async function callProvider(p: ProviderConfig, systemPrompt: string, userPrompt: string, options: LLMOptions): Promise<LLMResult> {
  const cfg = {
    json: options.json !== false,
    model: options.model || p.model,
    temperature: typeof options.temperature === "number" ? options.temperature : LLM.temperature,
    max_tokens: (options.max_tokens || LLM.max_tokens) + p.reasoningHeadroom,
    max_retries: typeof options.max_retries === "number" ? options.max_retries : 4,
    label: options.label || "",
  };

  const start = Date.now();

  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
  };
  if (cfg.json) {
    payload.response_format = { type: "json_object" };
  }

  let lastErr: string | null = null;

  for (let attempt = 1; attempt <= cfg.max_retries + 1; attempt++) {
    const resp = await fetch(p.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM.request_timeout_ms),
    });
    const code = resp.status;
    const body = await resp.text();

    if (code === 200) {
      const ms = Date.now() - start;
      let parsed: ProviderResponse;
      try {
        parsed = JSON.parse(body) as ProviderResponse;
      } catch {
        throw new Error(`callLLM(${p.id}): returned 200 but body is not JSON: ${body.slice(0, 300)}`);
      }
      const text = extractText(parsed, p.id);
      const json = cfg.json ? safeParseJson(text, p.id) : null;
      const usage = parsed.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      console.log(`[llm] ${cfg.label || cfg.model} [${p.id}] OK attempt=${attempt} ms=${ms} tokens=${usage.total_tokens || 0}`);
      return {
        ok: true,
        provider: p.id,
        json,
        text,
        model: parsed.model || cfg.model,
        tokens: {
          prompt: usage.prompt_tokens || 0,
          completion: usage.completion_tokens || 0,
          total: usage.total_tokens || 0,
        },
        ms,
        attempts: attempt,
      };
    }

    lastErr = `HTTP ${code}: ${body.slice(0, 300)}`;

    // Daily-quota-type errors won't reset within the retry window — bail to the
    // next provider immediately instead of burning retries.
    if (code === 429 && p.tpdErrorPattern.test(body)) {
      throw new Error(`callLLM(${p.id}): daily quota reached for model ${cfg.model}. Raw: ${body.slice(0, 200)}`);
    }

    if (code === 429 || (code >= 500 && code < 600)) {
      if (attempt > cfg.max_retries) break;
      const waitMs = backoffMs(attempt, resp);
      console.log(`[llm] ${cfg.label || cfg.model} [${p.id}] ${code} attempt=${attempt} -> sleeping ${waitMs}ms before retry`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`callLLM(${p.id}): returned ${code} (non-retryable). ${lastErr}`);
  }

  throw new Error(`callLLM(${p.id}): gave up after ${cfg.max_retries + 1} attempts. Last error: ${lastErr}`);
}

/* ===========================================================================
 * Internal helpers
 * ========================================================================= */

interface ProviderResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; text?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function extractText(response: ProviderResponse, providerId: string): string {
  const c = response.choices?.[0];
  if (!c) {
    throw new Error(`callLLM(${providerId}): response missing 'choices'. Body: ${JSON.stringify(response).slice(0, 300)}`);
  }
  if (c.message && typeof c.message.content === "string") return c.message.content;
  if (typeof c.text === "string") return c.text;
  throw new Error(`callLLM(${providerId}): cannot find text in response choice: ${JSON.stringify(c).slice(0, 300)}`);
}

function safeParseJson(text: string, providerId: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
  }
  throw new Error(`callLLM(${providerId}): model returned non-JSON despite json mode: ${text.slice(0, 300)}`);
}

function backoffMs(attempt: number, resp: Response): number {
  const retryAfter = resp.headers.get("Retry-After") || resp.headers.get("retry-after");
  if (retryAfter && !isNaN(Number(retryAfter))) {
    return Math.min(Number(retryAfter) * 1000, 30000);
  }
  const base = Math.min(500 * Math.pow(2, attempt - 1), 8000);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ===========================================================================
 * Token usage ledger — backed by the `token_usage` table, keyed by UTC date
 * and provider id. Each provider/key gets an independent daily quota because
 * free-tier limits are tied to the API key, not the model.
 * ========================================================================= */

function utcDateString(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export async function tokensUsedToday(providerId: string): Promise<number> {
  if (!db) return 0;
  const date = utcDateString();
  const rows = await db
    .select({ totalTokens: tokenUsage.totalTokens })
    .from(tokenUsage)
    .where(and(eq(tokenUsage.date, date), eq(tokenUsage.provider, providerId)));
  return rows[0]?.totalTokens ?? 0;
}

export async function requestsToday(providerId: string): Promise<number> {
  if (!db) return 0;
  const date = utcDateString();
  const rows = await db
    .select({ requests: tokenUsage.requests })
    .from(tokenUsage)
    .where(and(eq(tokenUsage.date, date), eq(tokenUsage.provider, providerId)));
  return rows[0]?.requests ?? 0;
}

async function recordTokenUsage(providerId: string, totalTokens: number): Promise<void> {
  if (!db) return;
  const date = utcDateString();
  const used = await tokensUsedToday(providerId);
  const reqs = await requestsToday(providerId);
  await db
    .insert(tokenUsage)
    .values({
      date,
      provider: providerId,
      totalTokens: used + (Number(totalTokens) || 0),
      requests: reqs + 1,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [tokenUsage.date, tokenUsage.provider],
      set: {
        totalTokens: used + (Number(totalTokens) || 0),
        requests: reqs + 1,
        updatedAt: new Date(),
      },
    });
}

/** Daily token ceiling for a provider id, read from config.<ID_UPPER>_DAILY_TOKEN_CEILING. 0 = no ceiling. */
export async function dailyTokenCeiling(providerId: string, dflt: number): Promise<number> {
  if (!db) return dflt;
  const configKey = `${providerId.toUpperCase()}_DAILY_TOKEN_CEILING`;
  const rows = await db.select({ value: config.value }).from(config).where(eq(config.key, configKey));
  const raw = rows[0]?.value;
  if (raw === undefined || raw === "") return dflt;
  const n = parseFloat(raw);
  return isNaN(n) ? dflt : n;
}

export async function overDailyCeiling(providerId: string, dflt: number): Promise<boolean> {
  const ceil = await dailyTokenCeiling(providerId, dflt);
  if (!ceil || ceil <= 0) return false;
  const used = await tokensUsedToday(providerId);
  return used >= ceil;
}
