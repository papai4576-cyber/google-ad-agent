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

  if (typeof systemPrompt !== 'string' || systemPrompt.trim() === '') {
    throw new Error('callLLM: systemPrompt must be a non-empty string.');
  }
  if (typeof userPrompt !== 'string' || userPrompt.trim() === '') {
    throw new Error('callLLM: userPrompt must be a non-empty string.');
  }

  // Resolve the provider order: assigned provider first, then (unless disabled)
  // the OTHER provider as automatic failover for capacity/availability errors.
  const primary = LLM_PROVIDERS[opts.provider] ? opts.provider : LLM_DEFAULT_PROVIDER;
  const order = [primary];
  if (opts.fallback !== false) {
    const other = primary === 'groq' ? 'gemini' : 'groq';
    if (LLM_PROVIDERS[other]) order.push(other);
  }

  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const prov = order[i];
    try {
      const res = _callProvider_(prov, systemPrompt, userPrompt, opts);
      if (i > 0) log_('llm', `${opts.label || ''} recovered on fallback provider "${prov}".`);
      return res;
    } catch (e) {
      lastErr = e;
      const haveMore = i < order.length - 1;
      if (haveMore && _isFailoverWorthy_(e)) {
        log_('llm', `${opts.label || ''} provider "${prov}" unavailable ` +
                    `(${String(e.message || e).slice(0, 140)}) → failing over to "${order[i + 1]}".`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/* ===========================================================================
 * Provider dispatch + per-provider callers. Each caller returns the SAME
 * normalized shape: { ok, provider, json, text, model, tokens, ms, attempts }.
 * ========================================================================= */

function _callProvider_(provider, systemPrompt, userPrompt, opts) {
  if (provider === 'gemini') return _callGemini_(systemPrompt, userPrompt, opts);
  return _callGroq_(systemPrompt, userPrompt, opts);
}

function _callGroq_(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const reg  = LLM_PROVIDERS.groq;
  const cfg = {
    json:        opts.json !== false,
    model:       opts.model       || reg.model,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : LLM.temperature,
    max_tokens:  opts.max_tokens  || LLM.max_tokens,
    max_retries: typeof opts.max_retries === 'number' ? opts.max_retries : 4,
    label:       opts.label       || '',
  };

  const apiKey = String(PROPS.require(reg.apiKeyProp)).trim();
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
    const resp = UrlFetchApp.fetch(reg.endpoint, {
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
        throw new Error('callLLM(groq): returned 200 but body is not JSON: ' + body.slice(0, 300));
      }
      const text = extractText_(parsed);
      const json = cfg.json ? safeParseJson_(text) : null;
      const tokens = parsed.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      log_('llm', `${cfg.label || cfg.model} [groq] OK attempt=${attempt} ms=${ms} ` +
                  `tokens=${tokens.total_tokens || 0}`);
      return {
        ok:       true,
        provider: 'groq',
        json:     json,
        text:     text,
        model:    parsed.model || cfg.model,
        tokens: {
          prompt:     tokens.prompt_tokens     || 0,
          completion: tokens.completion_tokens || 0,
          total:      tokens.total_tokens      || 0,
        },
        ms:       ms,
        attempts: attempt,
      };
    }

    lastErr = `HTTP ${code}: ${body.slice(0, 300)}`;

    // TPD (tokens per day) errors come back as 429 but won't reset within
    // a retry window — bail immediately so callLLM can fail over to Gemini.
    if (code === 429 && /tokens per day|TPD|tokens_per_day/i.test(body)) {
      throw new Error(
        `callLLM(groq): Groq daily token limit reached for model ${cfg.model} ` +
        `(resets 00:00 UTC). Raw: ${body.slice(0, 200)}`
      );
    }

    if (code === 429 || (code >= 500 && code < 600)) {
      if (attempt > cfg.max_retries) break;
      const waitMs = backoffMs_(attempt, resp);
      log_('llm', `${cfg.label || cfg.model} [groq] ${code} attempt=${attempt} → ` +
                  `sleeping ${waitMs}ms before retry`);
      Utilities.sleep(waitMs);
      continue;
    }

    throw new Error(`callLLM(groq): returned ${code} (non-retryable). ${lastErr}`);
  }

  throw new Error(`callLLM(groq): gave up after ${cfg.max_retries + 1} attempts. Last error: ${lastErr}`);
}

function _callGemini_(systemPrompt, userPrompt, options) {
  const opts = options || {};
  const reg  = LLM_PROVIDERS.gemini;
  const cfg = {
    json:        opts.json !== false,
    model:       opts.model       || reg.model,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : LLM.temperature,
    max_tokens:  opts.max_tokens  || LLM.max_tokens,
    max_retries: typeof opts.max_retries === 'number' ? opts.max_retries : 4,
    label:       opts.label       || '',
  };

  const apiKey = String(PROPS.require(reg.apiKeyProp)).trim();
  const url    = reg.endpoint.replace('{model}', cfg.model) + '?key=' + encodeURIComponent(apiKey);
  const start  = Date.now();

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents:          [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature:     cfg.temperature,
      maxOutputTokens: cfg.max_tokens,
      // Gemini 2.5 models are "thinking" models — by default they spend output
      // tokens on hidden reasoning before answering, which can exhaust the
      // budget (finishReason=MAX_TOKENS, empty text) and costs latency/tokens.
      // We want fast structured JSON, so disable thinking entirely.
      thinkingConfig:  { thinkingBudget: 0 },
    },
  };
  if (cfg.json) {
    // Native JSON mode — guarantees parseable output.
    payload.generationConfig.responseMimeType = 'application/json';
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= cfg.max_retries + 1; attempt++) {
    const resp = UrlFetchApp.fetch(url, {
      method:             'post',
      contentType:        'application/json',
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
        throw new Error('callLLM(gemini): returned 200 but body is not JSON: ' + body.slice(0, 300));
      }
      const text = _geminiText_(parsed);
      const json = cfg.json ? safeParseJson_(text) : null;
      const um   = parsed.usageMetadata || {};
      log_('llm', `${cfg.label || cfg.model} [gemini] OK attempt=${attempt} ms=${ms} ` +
                  `tokens=${um.totalTokenCount || 0}`);
      return {
        ok:       true,
        provider: 'gemini',
        json:     json,
        text:     text,
        model:    cfg.model,
        tokens: {
          prompt:     um.promptTokenCount     || 0,
          completion: um.candidatesTokenCount || 0,
          total:      um.totalTokenCount      || 0,
        },
        ms:       ms,
        attempts: attempt,
      };
    }

    lastErr = `HTTP ${code}: ${body.slice(0, 300)}`;

    // Hard quota (free-tier limit 0, or daily cap) — NOT a transient per-minute
    // rate limit. Retrying wastes seconds; bail immediately so callLLM fails
    // over to Groq right away. Detected by the distinctive quota language.
    if (code === 429 && /limit:\s*0|free_tier|per day|perday|requests_per_day/i.test(body)) {
      throw new Error(
        `callLLM(gemini): Gemini quota unavailable for ${cfg.model} ` +
        `(free-tier limit 0 or daily cap — not a transient rate limit). ` +
        `Raw: ${body.slice(0, 200)}`
      );
    }

    // 429 = transient per-minute rate limit, 5xx = overloaded/unavailable → retry.
    if (code === 429 || (code >= 500 && code < 600)) {
      if (attempt > cfg.max_retries) break;
      const waitMs = backoffMs_(attempt, resp);
      log_('llm', `${cfg.label || cfg.model} [gemini] ${code} attempt=${attempt} → ` +
                  `sleeping ${waitMs}ms before retry`);
      Utilities.sleep(waitMs);
      continue;
    }

    throw new Error(`callLLM(gemini): returned ${code} (non-retryable). ${lastErr}`);
  }

  throw new Error(`callLLM(gemini): gave up after ${cfg.max_retries + 1} attempts. Last error: ${lastErr}`);
}

/** Extract the text from a Gemini generateContent response. */
function _geminiText_(resp) {
  const c = resp.candidates && resp.candidates[0];
  if (!c) {
    const fb = resp.promptFeedback ? ' promptFeedback=' + JSON.stringify(resp.promptFeedback) : '';
    throw new Error('callLLM(gemini): response had no candidates.' + fb +
                    ' Raw: ' + JSON.stringify(resp).slice(0, 200));
  }
  const parts = c.content && c.content.parts;
  if (parts && parts.length) {
    const text = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    if (text) return text;
  }
  throw new Error('callLLM(gemini): candidate had no text (finishReason=' +
                  (c.finishReason || '?') + '). Often means maxOutputTokens too low or content blocked.');
}

/**
 * Decide whether an error from one provider should trigger failover to the
 * other. Capacity / availability / not-configured → yes. A genuine bad-request
 * (400) or content problem → no (the other provider would fail the same way and
 * we'd waste tokens).
 */
function _isFailoverWorthy_(err) {
  const m = String(err && (err.message || err)).toLowerCase();
  if (/daily token limit|tokens per day|tpd/.test(m))                       return true;
  if (/resource_exhausted|rate limit|quota|429/.test(m))                    return true;
  if (/\b5\d\d\b|overloaded|unavailable|timeout|timed out|dns|address/.test(m)) return true;
  if (/required script property|is not set|api key/.test(m))                return true;
  // Provider misconfiguration (bad/missing/restricted key, API not enabled).
  // The OTHER provider is very likely fine, so degrade to it instead of failing.
  if (/\b401\b|\b403\b|permission|forbidden|api_key_invalid|unauthorized/.test(m)) return true;
  return false;
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
  log_('test', `Ping result: "${result.text}" (provider=${result.provider}, model=${result.model}, ms=${result.ms})`);
  return result;
}

/**
 * Deep Gemini diagnostic — run this in the editor to find out EXACTLY why
 * Gemini is rejecting us. Prints the key's shape (to catch paste errors) and
 * the FULL, untruncated response from two endpoints:
 *   1. GET  /v1beta/models           — does the key authenticate at all?
 *   2. POST /v1beta/.../generateContent — can it actually generate?
 * Never logs the key itself, only its length and first/last 4 chars.
 */
function debugGemini() {
  log_('test', '════════════════════════════════════════════');
  log_('test', 'Gemini deep diagnostic');
  log_('test', '════════════════════════════════════════════');

  const raw = PROPS.get('GEMINI_API_KEY');
  if (!raw) {
    log_('test', 'GEMINI_API_KEY is NOT set in Script Properties. Add it and re-run.');
    return;
  }
  const key = String(raw).trim();
  const hadWhitespace = (key !== String(raw));
  log_('test', `Key length: ${raw.length} raw, ${key.length} trimmed` +
               (hadWhitespace ? '  ⚠️ had surrounding whitespace/newline (now trimmed)' : ''));
  log_('test', `Key looks like: ${key.slice(0, 4)}…${key.slice(-4)}  ` +
               `(valid AI Studio keys start with "AIza" or "AQ.")`);
  if (!/^(AIza[0-9A-Za-z_\-]{30,}|AQ\.[0-9A-Za-z_\-.]{20,})$/.test(key)) {
    log_('test', '⚠️ Key does not match a known Gemini key shape. It may be the wrong ' +
                 'value (e.g. an OAuth client id, or quotes got included).');
  }

  const base = 'https://generativelanguage.googleapis.com/v1beta';

  // 1. List models — the cleanest auth check.
  try {
    const resp = UrlFetchApp.fetch(base + '/models?key=' + encodeURIComponent(key),
      { method: 'get', muteHttpExceptions: true });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    log_('test', '');
    log_('test', `[1] GET /models → HTTP ${code}`);
    if (code === 200) {
      let names = [];
      try {
        const j = JSON.parse(body);
        names = (j.models || []).map(m => m.name).filter(n => /flash|pro/.test(n)).slice(0, 8);
      } catch (_e) {}
      log_('test', `    ✅ Key authenticates. Sample models: ${names.join(', ') || '(parsed, see raw)'}`);
    } else {
      log_('test', `    ❌ Full body: ${body.slice(0, 800)}`);
    }
  } catch (e) {
    log_('test', `[1] GET /models threw: ${String(e.message || e).slice(0, 300)}`);
  }

  // 2. generateContent — the call agents actually make.
  try {
    const url = base + '/models/' + LLM_PROVIDERS.gemini.model + ':generateContent?key=' + encodeURIComponent(key);
    const payload = {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: pong' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8 },
    };
    const resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    log_('test', '');
    log_('test', `[2] POST generateContent (${LLM_PROVIDERS.gemini.model}) → HTTP ${code}`);
    log_('test', `    Full body: ${body.slice(0, 800)}`);
  } catch (e) {
    log_('test', `[2] generateContent threw: ${String(e.message || e).slice(0, 300)}`);
  }

  log_('test', '');
  log_('test', 'Read [1]: 403 here = key/project/API-enablement problem (not our code). ' +
               '200 here but [2] fails = model-access or quota problem.');
}

/**
 * Ping BOTH providers directly and print how every agent is routed. Run this
 * after adding GEMINI_API_KEY to confirm the partner is live and the
 * assignment map resolves as expected. Costs a few tokens on each provider.
 */
function testProviderRouting() {
  log_('test', '════════════════════════════════════════════');
  log_('test', 'Provider routing + connectivity');
  log_('test', '════════════════════════════════════════════');

  // 1. Direct ping of each provider (no failover, so we isolate each one).
  for (const prov of ['groq', 'gemini']) {
    try {
      const r = callLLM('You reply with exactly one word.', 'Reply with: pong',
        { json: false, label: 'ping_' + prov, provider: prov, fallback: false, max_tokens: 16 });
      log_('test', `  [OK]   ${prov.padEnd(7)} → "${String(r.text).trim()}" ` +
                   `(model=${r.model}, ${r.ms}ms, tokens=${r.tokens.total})`);
    } catch (e) {
      log_('test', `  [FAIL] ${prov.padEnd(7)} → ${String(e.message || e).slice(0, 160)}`);
    }
  }

  // 2. Show resolved routing for every agent (honours Config overrides).
  log_('test', '');
  log_('test', 'Agent → provider assignment:');
  const agents = Object.keys(AGENT_LLM);
  for (const a of agents) {
    log_('test', `  ${a.padEnd(30)} ${pickProvider(a)}`);
  }
  const groqN   = agents.filter(a => pickProvider(a) === 'groq').length;
  const geminiN = agents.filter(a => pickProvider(a) === 'gemini').length;
  log_('test', '');
  log_('test', `Split: ${groqN} on Groq, ${geminiN} on Gemini. ` +
               `(Set Config LLM_FORCE_PROVIDER=groq|gemini to override all.)`);
}
