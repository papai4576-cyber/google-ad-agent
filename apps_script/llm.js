/**
 * llm.js — Groq Llama 3.3 70B wrapper used by every agent.
 *
 * One entry point: callLLM(systemPrompt, userPrompt, options).
 * Returns { ok, json, text, model, tokens, ms } on success, throws on
 * unrecoverable failure (after retries).
 *
 * Why a single helper:
 *   - All 15 agents call this — switching providers later touches one file.
 *   - Centralises retry/backoff so individual agents stay readable.
 *   - Centralises JSON-mode handling so agents can rely on parsed objects.
 *
 * Groq specifics:
 *   - OpenAI-compatible /v1/chat/completions endpoint
 *   - Llama 3.3 70B Versatile supports response_format: {type:"json_object"}
 *   - Free-tier limits: 30 RPM, 14,400 RPD, 6,000 TPM (see LLM constants)
 *
 * Apps Script specifics:
 *   - UrlFetchApp is synchronous (no async/await needed)
 *   - 60s default timeout (Groq usually returns in 1–5s)
 *   - 6 min total script execution; budget calls accordingly
 */

/* ===========================================================================
 * Public API
 * ========================================================================= */

/**
 * Call Groq.
 *
 * @param {string} systemPrompt — the role/instructions block (agent persona)
 * @param {string} userPrompt   — the actual question + data payload
 * @param {object} [options]
 *   .json         (default true)  Force JSON mode. Reply guaranteed to parse.
 *   .model        (default LLM.model)
 *   .temperature  (default LLM.temperature)
 *   .max_tokens   (default LLM.max_tokens)
 *   .max_retries  (default 4)     Attempts on 429/5xx before giving up
 *   .label        (default '')    Tag for logs — usually the agent name
 *
 * @returns {{ok: true, json: object|null, text: string, model: string,
 *            tokens: {prompt:number, completion:number, total:number},
 *            ms: number, attempts: number}}
 */
function callLLM(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const cfg = {
    json:        opts.json !== false,            // default true
    model:       opts.model       || LLM.model,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : LLM.temperature,
    max_tokens:  opts.max_tokens  || LLM.max_tokens,
    max_retries: typeof opts.max_retries === 'number' ? opts.max_retries : 4,
    label:       opts.label       || '',
  };

  if (typeof systemPrompt !== 'string' || systemPrompt.trim() === '') {
    throw new Error('callLLM: systemPrompt must be a non-empty string.');
  }
  if (typeof userPrompt !== 'string' || userPrompt.trim() === '') {
    throw new Error('callLLM: userPrompt must be a non-empty string.');
  }

  const apiKey = PROPS.require('GROQ_API_KEY');
  const start  = Date.now();

  const payload = {
    model:       cfg.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt  },
    ],
    temperature: cfg.temperature,
    max_tokens:  cfg.max_tokens,
  };
  if (cfg.json) {
    payload.response_format = { type: 'json_object' };
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= cfg.max_retries + 1; attempt++) {
    const resp = UrlFetchApp.fetch(LLM.endpoint, {
      method:             'post',
      contentType:        'application/json',
      headers:            { Authorization: 'Bearer ' + apiKey },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    const body = resp.getContentText();

    if (code === 200) {
      const ms = Date.now() - start;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        throw new Error('callLLM: Groq returned 200 but body is not JSON: ' + body.slice(0, 300));
      }
      const text = extractText_(parsed);
      const json = cfg.json ? safeParseJson_(text) : null;
      const tokens = parsed.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      log_('llm', `${cfg.label || cfg.model} OK attempt=${attempt} ms=${ms} ` +
                  `tokens=${tokens.total_tokens || 0}`);
      return {
        ok:     true,
        json:   json,
        text:   text,
        model:  parsed.model || cfg.model,
        tokens: {
          prompt:     tokens.prompt_tokens     || 0,
          completion: tokens.completion_tokens || 0,
          total:      tokens.total_tokens      || 0,
        },
        ms:       ms,
        attempts: attempt,
      };
    }

    // ── error path ────────────────────────────────────────────────────────
    lastErr = `HTTP ${code}: ${body.slice(0, 300)}`;

    // 429 (rate limit) and 5xx → retry with backoff.
    if (code === 429 || (code >= 500 && code < 600)) {
      if (attempt > cfg.max_retries) break;
      const waitMs = backoffMs_(attempt, resp);
      log_('llm', `${cfg.label || cfg.model} ${code} attempt=${attempt} → ` +
                  `sleeping ${waitMs}ms before retry`);
      Utilities.sleep(waitMs);
      continue;
    }

    // 4xx other than 429 → fatal, no point retrying.
    throw new Error(`callLLM: Groq returned ${code} (non-retryable). ${lastErr}`);
  }

  throw new Error(`callLLM: gave up after ${cfg.max_retries + 1} attempts. Last error: ${lastErr}`);
}

/* ===========================================================================
 * Internal helpers
 * ========================================================================= */

function extractText_(groqResponse) {
  if (!groqResponse.choices || !groqResponse.choices.length) {
    throw new Error('callLLM: Groq response missing `choices`. Body: ' +
                    JSON.stringify(groqResponse).slice(0, 300));
  }
  const c = groqResponse.choices[0];
  if (c.message && typeof c.message.content === 'string') return c.message.content;
  if (typeof c.text === 'string') return c.text;
  throw new Error('callLLM: cannot find text in Groq response choice: ' +
                  JSON.stringify(c).slice(0, 300));
}

function safeParseJson_(text) {
  // JSON-mode is supposed to guarantee parseability, but models can still
  // emit prose wrappers. Try strict parse first; on failure, attempt to
  // extract the largest {...} substring.
  try { return JSON.parse(text); } catch (_e) { /* fall through */ }

  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch (_e) { /* fall through */ }
  }
  throw new Error('callLLM: model returned non-JSON despite json mode: ' +
                  text.slice(0, 300));
}

function backoffMs_(attempt, resp) {
  // Honour Retry-After header if Groq sets it (seconds, integer).
  const retryAfter = resp.getHeaders()['Retry-After'] ||
                     resp.getHeaders()['retry-after'];
  if (retryAfter && !isNaN(Number(retryAfter))) {
    return Math.min(Number(retryAfter) * 1000, 30000);
  }
  // Exponential backoff with jitter: 500ms, 1s, 2s, 4s + 0–500ms jitter.
  const base = Math.min(500 * Math.pow(2, attempt - 1), 8000);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

/* ===========================================================================
 * MANUAL TEST — run this from the Apps Script editor to verify Groq end-to-end.
 *
 * Open the Apps Script editor, select "testLLM" in the function dropdown,
 * click Run, then check the execution log. You should see a parsed JSON
 * response with the structure { agent, findings: [...], summary }.
 * ========================================================================= */

function testLLM() {
  log_('test', '════════════════════════════════════════════');
  log_('test', 'Testing callLLM with a realistic agent-style prompt');
  log_('test', '════════════════════════════════════════════');

  const systemPrompt =
    'You are a Google Ads Performance Analyst. Given campaign data, identify ' +
    'underperforming campaigns and produce findings in EXACT JSON shape:\n' +
    '{\n' +
    '  "agent": "performance_analyst",\n' +
    '  "findings": [\n' +
    '    {\n' +
    '      "id": "string (unique)",\n' +
    '      "title": "short action title",\n' +
    '      "what": "what is wrong or what opportunity exists",\n' +
    '      "why":  "why it matters, quantified",\n' +
    '      "severity": "P1|P2|P3"\n' +
    '    }\n' +
    '  ],\n' +
    '  "summary": "one-sentence overview"\n' +
    '}\n' +
    'Return ONLY the JSON object. No prose, no markdown fences.';

  const userPrompt =
    'Target CPA is $50. Target ROAS is 4.0. Here are 3 campaigns from the last 30 days:\n\n' +
    'Campaign A: cost $2400, conversions 12, conversion_value $9800, CTR 4.1%, search IS 38%\n' +
    'Campaign B: cost $1800, conversions 9,  conversion_value $4200, CTR 2.3%, search IS 71%\n' +
    'Campaign C: cost $900,  conversions 22, conversion_value $11400, CTR 5.6%, search IS 22%\n\n' +
    'Identify the top 2 findings. Be concise.';

  let result;
  try {
    result = callLLM(systemPrompt, userPrompt, { label: 'test_perf_analyst' });
  } catch (e) {
    log_('test', `FAIL — ${e.message}`);
    throw e;
  }

  log_('test', '');
  log_('test', `Model:    ${result.model}`);
  log_('test', `Attempts: ${result.attempts}`);
  log_('test', `Time:     ${result.ms}ms`);
  log_('test', `Tokens:   prompt=${result.tokens.prompt}, completion=${result.tokens.completion}, total=${result.tokens.total}`);
  log_('test', '');
  log_('test', 'Raw text:');
  log_('test', result.text);
  log_('test', '');

  // Validate JSON shape
  if (!result.json) {
    log_('test', 'FAIL — JSON did not parse');
    throw new Error('JSON did not parse');
  }
  const j = result.json;
  const checks = [
    { name: 'agent field',           ok: j.agent === 'performance_analyst'                   },
    { name: 'findings is array',     ok: Array.isArray(j.findings) && j.findings.length > 0  },
    { name: 'summary is string',     ok: typeof j.summary === 'string' && j.summary.length   },
    { name: 'first finding has id',  ok: !!(j.findings && j.findings[0] && j.findings[0].id) },
    { name: 'first finding has severity', ok: !!(j.findings && j.findings[0] && ['P1','P2','P3'].includes(j.findings[0].severity)) },
  ];
  let allPassed = true;
  for (const c of checks) {
    log_('test', `  [${c.ok ? 'OK  ' : 'FAIL'}] ${c.name}`);
    if (!c.ok) allPassed = false;
  }
  log_('test', '');
  log_('test', allPassed
    ? '✅ callLLM is working. Phase 3 ready.'
    : '⚠️  Call succeeded but JSON shape was unexpected. See raw text above.');
  return result;
}

/**
 * Smaller version of testLLM — just verifies the wire connection without
 * exercising JSON mode or schema. Use this if testLLM is failing and you
 * want to isolate whether it's auth or output shape.
 */
function testLLMPing() {
  const result = callLLM(
    'You reply with exactly one word.',
    'Reply with: pong',
    { json: false, label: 'ping', max_tokens: 16 }
  );
  log_('test', `Ping result: "${result.text}" (model=${result.model}, ms=${result.ms})`);
  return result;
}
