/**
 * llm.ts — Groq Llama 3.3 70B client used by every Analyst.
 *
 * Ported from apps_script/llm.js. Differences from the Apps Script version:
 *   - fetch + async/await instead of UrlFetchApp + Utilities.sleep
 *   - GROQ_API_KEY comes from process.env instead of Script Properties
 *   - token usage / daily ceiling are tracked in the `token_usage` and
 *     `config` Postgres tables instead of Script Properties
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { config, tokenUsage } from "@/db/schema";

export const LLM = {
  provider: "groq",
  endpoint: "https://api.groq.com/openai/v1/chat/completions",
  model: "llama-3.3-70b-versatile",
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
  /** Attempts on 429/5xx before giving up (default 4). */
  max_retries?: number;
  /** Tag for logs — usually the agent name. */
  label?: string;
}

export interface LLMResult {
  ok: true;
  provider: "groq";
  json: Record<string, unknown> | null;
  text: string;
  model: string;
  tokens: { prompt: number; completion: number; total: number };
  ms: number;
  attempts: number;
}

/**
 * Call Groq. Throws on unrecoverable failure (after retries, or daily ceiling).
 */
export async function callLLM(systemPrompt: string, userPrompt: string, options?: LLMOptions): Promise<LLMResult> {
  const opts = options || {};

  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") {
    throw new Error("callLLM: systemPrompt must be a non-empty string.");
  }
  if (typeof userPrompt !== "string" || userPrompt.trim() === "") {
    throw new Error("callLLM: userPrompt must be a non-empty string.");
  }

  if (await overDailyCeiling("groq")) {
    const used = await tokensUsedToday("groq");
    const ceil = await dailyTokenCeiling("groq");
    throw new Error(
      `callLLM: Groq at daily token ceiling (${used}/${ceil} tokens used today). Resets at 00:00 UTC.`
    );
  }

  const res = await callGroq(systemPrompt, userPrompt, opts);
  await recordTokenUsage("groq", res.tokens.total);
  return res;
}

async function callGroq(systemPrompt: string, userPrompt: string, options: LLMOptions): Promise<LLMResult> {
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("callLLM(groq): GROQ_API_KEY is not set.");
  }

  const cfg = {
    json: options.json !== false,
    model: options.model || LLM.model,
    temperature: typeof options.temperature === "number" ? options.temperature : LLM.temperature,
    max_tokens: options.max_tokens || LLM.max_tokens,
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
    const resp = await fetch(LLM.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM.request_timeout_ms),
    });
    const code = resp.status;
    const body = await resp.text();

    if (code === 200) {
      const ms = Date.now() - start;
      let parsed: GroqResponse;
      try {
        parsed = JSON.parse(body) as GroqResponse;
      } catch {
        throw new Error(`callLLM(groq): returned 200 but body is not JSON: ${body.slice(0, 300)}`);
      }
      const text = extractText(parsed);
      const json = cfg.json ? safeParseJson(text) : null;
      const usage = parsed.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      console.log(
        `[llm] ${cfg.label || cfg.model} [groq] OK attempt=${attempt} ms=${ms} tokens=${usage.total_tokens || 0}`
      );
      return {
        ok: true,
        provider: "groq",
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

    // TPD (tokens per day) errors won't reset within the retry window — bail immediately.
    if (code === 429 && /tokens per day|TPD|tokens_per_day/i.test(body)) {
      throw new Error(
        `callLLM(groq): Groq daily token limit reached for model ${cfg.model} (resets 00:00 UTC). Raw: ${body.slice(0, 200)}`
      );
    }

    if (code === 429 || (code >= 500 && code < 600)) {
      if (attempt > cfg.max_retries) break;
      const waitMs = backoffMs(attempt, resp);
      console.log(`[llm] ${cfg.label || cfg.model} [groq] ${code} attempt=${attempt} -> sleeping ${waitMs}ms before retry`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`callLLM(groq): returned ${code} (non-retryable). ${lastErr}`);
  }

  throw new Error(`callLLM(groq): gave up after ${cfg.max_retries + 1} attempts. Last error: ${lastErr}`);
}

/* ===========================================================================
 * Internal helpers
 * ========================================================================= */

interface GroqResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; text?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function extractText(groqResponse: GroqResponse): string {
  const c = groqResponse.choices?.[0];
  if (!c) {
    throw new Error(`callLLM: Groq response missing 'choices'. Body: ${JSON.stringify(groqResponse).slice(0, 300)}`);
  }
  if (c.message && typeof c.message.content === "string") return c.message.content;
  if (typeof c.text === "string") return c.text;
  throw new Error(`callLLM: cannot find text in Groq response choice: ${JSON.stringify(c).slice(0, 300)}`);
}

function safeParseJson(text: string): Record<string, unknown> {
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
  throw new Error(`callLLM: model returned non-JSON despite json mode: ${text.slice(0, 300)}`);
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
 * because Groq's free-tier daily token quota resets at 00:00 UTC.
 * ========================================================================= */

function utcDateString(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export async function tokensUsedToday(provider: string): Promise<number> {
  if (!db) return 0;
  const date = utcDateString();
  const rows = await db
    .select({ totalTokens: tokenUsage.totalTokens })
    .from(tokenUsage)
    .where(and(eq(tokenUsage.date, date), eq(tokenUsage.provider, provider)));
  return rows[0]?.totalTokens ?? 0;
}

export async function requestsToday(provider: string): Promise<number> {
  if (!db) return 0;
  const date = utcDateString();
  const rows = await db
    .select({ requests: tokenUsage.requests })
    .from(tokenUsage)
    .where(and(eq(tokenUsage.date, date), eq(tokenUsage.provider, provider)));
  return rows[0]?.requests ?? 0;
}

async function recordTokenUsage(provider: string, totalTokens: number): Promise<void> {
  if (!db) return;
  const date = utcDateString();
  const used = await tokensUsedToday(provider);
  const reqs = await requestsToday(provider);
  await db
    .insert(tokenUsage)
    .values({
      date,
      provider,
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

/** Daily token ceiling for Groq, read from config.GROQ_DAILY_TOKEN_CEILING (default 90000). 0 = no ceiling. */
export async function dailyTokenCeiling(provider: string): Promise<number> {
  if (provider !== "groq") return 0;
  if (!db) return 90000;
  const rows = await db.select({ value: config.value }).from(config).where(eq(config.key, "GROQ_DAILY_TOKEN_CEILING"));
  const raw = rows[0]?.value;
  if (raw === undefined || raw === "") return 90000;
  const n = parseFloat(raw);
  return isNaN(n) ? 90000 : n;
}

export async function overDailyCeiling(provider: string): Promise<boolean> {
  const ceil = await dailyTokenCeiling(provider);
  if (!ceil || ceil <= 0) return false;
  const used = await tokensUsedToday(provider);
  return used >= ceil;
}
