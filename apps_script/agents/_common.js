/**
 * agents/_common.js — shared scaffold every agent uses.
 *
 * Each of the 14 audit + copy_intel agents follows the same pattern:
 *   1. Read one or more Raw_* tabs into JS objects
 *   2. Query Brain for relevant strategy categories
 *   3. Build a domain-expert prompt for Groq (data + brain + schema)
 *   4. Call callLLM with JSON mode
 *   5. Validate findings against the universal schema
 *   6. Write findings to the Findings tab
 *
 * AgentCommon centralises steps 1, 5, 6 plus prompt boilerplate so each
 * agent file stays focused on its domain expertise (the system prompt).
 *
 * Apps Script flat-namespace note: every helper is namespaced under
 * AgentCommon to avoid collisions with helpers in brain/ or llm.js.
 */

const AgentCommon = {

  /* ===================================================================
   * Data readers — Raw_* tabs → arrays of typed JS objects.
   * Each reader respects the schema defined in config.js SHEETS.
   * Numeric columns are parsed; empty strings become null/0 sensibly.
   * =================================================================== */

  _ss() {
    return SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  },

  /**
   * Read a Raw_* tab and return an array of objects keyed by the column
   * headers declared in SHEETS[tabName].headers. Coerces known numeric
   * columns. Returns [] if sheet is empty.
   */
  readSheet(tabName, opts) {
    const limit = (opts && typeof opts.limit === 'number') ? opts.limit : Infinity;
    const ss = this._ss();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) throw new Error(`Sheet "${tabName}" not found. Have you run the data collector?`);
    const last = sheet.getLastRow();
    if (last < 2) return [];

    const schema = SHEETS[tabName];
    if (!schema) throw new Error(`No schema for sheet "${tabName}" in config.SHEETS.`);
    const headers = schema.headers;
    const numericCols = new Set(this._numericColsFor(tabName));

    const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
    const rows = [];
    const cap = Math.min(data.length, limit);
    for (let r = 0; r < cap; r++) {
      const row = data[r];
      const obj = {};
      for (let c = 0; c < headers.length; c++) {
        const key = headers[c];
        let v = row[c];
        if (numericCols.has(key)) {
          if (v === '' || v === null || v === undefined) v = 0;
          else if (typeof v !== 'number') v = Number(v) || 0;
        } else {
          if (v === null || v === undefined) v = '';
          else v = String(v);
        }
        obj[key] = v;
      }
      rows.push(obj);
    }
    return rows;
  },

  _numericColsFor(tabName) {
    // Columns that should always be coerced to numbers.
    const map = {
      Raw_Campaigns: [
        'target_cpa_micros', 'target_roas', 'budget_micros',
        'impressions', 'clicks', 'cost_micros', 'conversions',
        'conversion_value', 'ctr', 'avg_cpc_micros',
        'search_is', 'search_budget_lost_is', 'search_rank_lost_is',
      ],
      Raw_AdGroups: [
        'cpc_bid_micros', 'target_cpa_micros',
        'impressions', 'clicks', 'cost_micros',
        'conversions', 'conversion_value', 'avg_quality_score',
      ],
      Raw_Keywords: [
        'cpc_bid_micros', 'quality_score',
        'impressions', 'clicks', 'cost_micros',
        'conversions', 'conversion_value', 'ctr', 'avg_cpc_micros',
      ],
      Raw_Ads: [
        'impressions', 'clicks', 'cost_micros',
        'conversions', 'ctr', 'avg_cpc_micros',
      ],
      Raw_SearchTerms: [
        'impressions', 'clicks', 'cost_micros',
        'conversions', 'ctr', 'avg_cpc_micros',
      ],
      Raw_Extensions: ['impressions', 'clicks', 'ctr'],
      Raw_NegativeKeywords: [],
      Raw_Campaigns_Daily: [
        'impressions', 'clicks', 'cost_micros', 'conversions', 'conversion_value',
      ],
    };
    return map[tabName] || [];
  },

  // ---- typed convenience wrappers --------------------------------------
  //
  // All readers filter to ENABLED-only entities by default — paused campaigns
  // and their children are not actionable, so analyzing them wastes both
  // human and LLM tokens. Pass { includePaused: true } to opt out (rarely
  // useful — e.g. an agent that explicitly hunts for re-enable candidates).
  //
  // Parent-status filtering: an ad group / keyword / ad inside a PAUSED
  // campaign is effectively inert even if its own status is ENABLED, so we
  // also drop those.

  readCampaigns(opts) {
    const all = this.readSheet('Raw_Campaigns');
    if (opts && opts.includePaused) return all;
    return all.filter(c => c.status === 'ENABLED');
  },

  readAdGroups(opts) {
    const all = this.readSheet('Raw_AdGroups');
    if (opts && opts.includePaused) return all;
    const enabledCampaignIds = this._enabledCampaignIds_();
    return all.filter(ag =>
      ag.status === 'ENABLED' && enabledCampaignIds.has(String(ag.campaign_id))
    );
  },

  readKeywords(opts) {
    const all = this.readSheet('Raw_Keywords');
    if (opts && opts.includePaused) return all;
    const enabledCampaignIds = this._enabledCampaignIds_();
    return all.filter(k =>
      k.status === 'ENABLED' && enabledCampaignIds.has(String(k.campaign_id))
    );
  },

  readAds(opts) {
    const all = this.readSheet('Raw_Ads');
    if (opts && opts.includePaused) return all;
    const enabledCampaignIds = this._enabledCampaignIds_();
    return all.filter(a =>
      a.status === 'ENABLED' && enabledCampaignIds.has(String(a.campaign_id))
    );
  },

  readSearchTerms(opts) {
    // Search terms only exist for impressions actually served, so they are
    // implicitly from active campaigns. But filter by enabled campaigns
    // anyway in case stale data from a paused campaign is still in the tab.
    const all = this.readSheet('Raw_SearchTerms');
    if (opts && opts.includePaused) return all;
    const enabledCampaignIds = this._enabledCampaignIds_();
    return all.filter(t => enabledCampaignIds.has(String(t.campaign_id)));
  },

  readExtensions(opts) {
    // Extension rows are written only for ENABLED campaign_asset links, but
    // those links may point at PAUSED campaigns. Filter to enabled campaigns.
    const all = this.readSheet('Raw_Extensions');
    if (opts && opts.includePaused) return all;
    const enabledCampaignIds = this._enabledCampaignIds_();
    return all.filter(e => enabledCampaignIds.has(String(e.campaign_id)));
  },

  readNegativeKeywords() {
    // Negatives are not status-filtered here — even paused-campaign negatives
    // matter for shared lists and for understanding the historical blocklist.
    try {
      return this.readSheet('Raw_NegativeKeywords');
    } catch (_e) {
      // Old setups before Raw_NegativeKeywords existed return [] gracefully.
      return [];
    }
  },

  /**
   * Per-execution cache of enabled campaign IDs (Set of strings). Computed
   * lazily on first call within an Apps Script execution; cleared between
   * runs because Apps Script reloads the script each invocation.
   */
  _enabledCampaignIds_() {
    if (this.__enabledIdsCache) return this.__enabledIdsCache;
    const set = new Set();
    for (const c of this.readSheet('Raw_Campaigns')) {
      if (c.status === 'ENABLED') set.add(String(c.campaign_id));
    }
    this.__enabledIdsCache = set;
    return set;
  },

  /**
   * Convert micros → currency units (Google Ads stores all money in micros).
   * Numeric only — use formatMoney() to prepend the currency symbol.
   */
  micros(n) { return Math.round((Number(n) || 0) / 10000) / 100; },

  /**
   * Format a micros amount as a currency string with the configured symbol.
   * e.g. formatMoney(84316670000) → "₹84316.67"
   */
  formatMoney(microsAmount) {
    return this.getCurrency() + this.micros(microsAmount).toFixed(2);
  },

  /**
   * Format an already-converted number (e.g. conversion_value) with the symbol.
   * e.g. formatAmount(70677.21) → "₹70677.21"
   */
  formatAmount(amount) {
    return this.getCurrency() + (Number(amount) || 0).toFixed(2);
  },

  getCurrency() {
    return String(getConfig('CURRENCY_SYMBOL', '₹') || '₹');
  },

  /* ===================================================================
   * Materiality & statistical significance.
   *
   * Relevance principle: only analyse entities that actually did something
   * in the window, and never draw a RATE-based conclusion (CPA, CVR, ROAS)
   * below a minimum denominator — n=1 "findings" destroy trust.
   *
   * Note: zero-impression keywords/terms are already excluded at COLLECTION
   * (the Ads script filters metrics.impressions > 0), so these are the
   * second line of defence + the significance gates for rate metrics.
   * Thresholds are Config-tunable.
   * =================================================================== */
  isActive(e) {
    return (Number(e.impressions) || 0) > 0 ||
           (Number(e.cost_micros) || 0) > 0 ||
           (Number(e.conversions) || 0) > 0;
  },
  minConvForCpa()   { return parseFloat(getConfig('MIN_CONV_FOR_CPA', '5')) || 5; },
  minClicksForCvr() { return parseFloat(getConfig('MIN_CLICKS_FOR_CVR', '30')) || 30; },
  minImpressions()  { return parseFloat(getConfig('MIN_IMPRESSIONS', '0')) || 0; },

  /** True if a campaign/entity has enough conversions to trust a CPA/ROAS read. */
  cpaIsSignificant(e) { return (Number(e.conversions) || 0) >= this.minConvForCpa(); },
  /** True if it has enough clicks to trust a CVR read. */
  cvrIsSignificant(e) { return (Number(e.clicks) || 0) >= this.minClicksForCvr(); },

  /* ===================================================================
   * Targets — read from the Config tab so non-developers can adjust live.
   * =================================================================== */

  getTargets() {
    return {
      currency_symbol:      this.getCurrency(),
      target_cpa:           parseFloat(getConfig('TARGET_CPA', '200'))             || 200,
      target_roas:          parseFloat(getConfig('TARGET_ROAS', '4.0'))            || 4.0,
      monthly_budget:       parseFloat(getConfig('MONTHLY_BUDGET_TARGET', '100000')) || 100000,
    };
  },

  /* ===================================================================
   * Data context — tells the LLM exactly which window of data it's seeing.
   * Without this, "Campaign X has 0 conversions" is ambiguous (in 30 days?
   * 90 days?). The ingest endpoint stamps these properties on every fetch.
   * =================================================================== */
  formatDataContext() {
    const range = PROPS.get('LAST_COLLECT_DATE_RANGE') || 'unknown';
    const date  = PROPS.get('LAST_COLLECT_DATE') || 'unknown';
    const mode  = PROPS.get('LAST_COLLECT_MODE') || 'unknown';
    const human = _humanizeRange_(range);
    return (
      'DATA CONTEXT:\n' +
      '  - All numbers below are TOTALS over the lookback window.\n' +
      '  - Window:        ' + human + ' (' + range + ', mode=' + mode + ')\n' +
      '  - Collected on:  ' + date + '\n' +
      '  - Note: conversion VALUES for the last ~7 days may be incomplete — ' +
              'Google Ads attributes value retroactively. Discount recent-window ' +
              'ROAS findings accordingly.\n' +
      '  - Note: Raw_* tabs contain ENABLED entities only; paused/removed campaigns are excluded.\n'
    );
  },

  /* ===================================================================
   * Prompt boilerplate — universal findings JSON schema.
   * Every agent appends its domain-specific instructions to this base.
   * =================================================================== */

  buildSystemPrompt(persona, instructionsForDomain) {
    return (
      persona + '\n\n' +
      instructionsForDomain + '\n\n' +
      'Output STRICT JSON with this EXACT shape:\n' +
      '{\n' +
      '  "findings": [\n' +
      '    {\n' +
      '      "id":         "kebab-case unique id within this run, e.g. \\"underspending-search-1\\"",\n' +
      '      "category":   "' + VALID.categories.join(' | ') + '",\n' +
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
      '      },\n' +
      '      "confidence": "high | medium | low",\n' +
      '      "effort":     "easy | medium | hard",\n' +
      '      "evidence":   ["data point 1", "data point 2"],\n' +
      '      "brain_sources": ["brain_001", "brain_042"]    // ids from the BRAIN section, or [] if none used\n' +
      '    }\n' +
      '  ],\n' +
      '  "summary": "one-sentence overview of the run"\n' +
      '}\n\n' +
      'Severity guide:\n' +
      '  P1 = costing meaningful $ today or blocking conversions — act today\n' +
      '  P2 = real opportunity but not bleeding right now — this week\n' +
      '  P3 = optimisation / nice-to-have — consider when bandwidth allows\n\n' +
      'Confidence guide:\n' +
      '  high   = data is decisive (statistically significant or unambiguous)\n' +
      '  medium = pattern is suggestive but limited data\n' +
      '  low    = early signal, needs more data — usually still worth a P3\n\n' +
      'Effort guide:\n' +
      '  easy   = a few clicks in Google Ads UI\n' +
      '  medium = research + a few campaigns of changes\n' +
      '  hard   = restructuring or new infrastructure\n\n' +
      'Rules:\n' +
      '  - Return ONLY the JSON object. No prose, no markdown fences.\n' +
      '  - Quantify amounts using the CURRENCY symbol given in the TARGETS ' +
              'block of the user prompt (NEVER assume $). Use % freely.\n' +
      '  - target.type MUST be EXACTLY one of: "campaign", "adgroup", "keyword", "ad". ' +
              'NO other values are allowed. NEVER use "budget", "bid", "strategy", ' +
              '"account", "monthly_budget", "ad_group", or anything else.\n' +
              '    - Budget / pacing findings → target.type = "campaign" (budget belongs to the campaign)\n' +
              '    - Bid strategy findings    → target.type = "campaign"\n' +
              '    - Account-wide findings    → still pick a representative campaign as the target\n' +
      '  - target.id MUST be a real id from the DATA section. target.name MUST be the matching name.\n' +
      '  - If you cite a brain entry, put its id (e.g. "brain_006") in brain_sources.\n' +
      '  - Produce AT MOST 8 findings per run. Surface only the most actionable.\n' +
      '  - If nothing is wrong, return findings:[] and an honest summary.\n'
    );
  },

  /**
   * Build the BRAIN section of the user prompt. Returns a string suitable for
   * direct concatenation into the user prompt. Empty string if no brain entries.
   */
  formatBrainContext(brainEntries) {
    if (!brainEntries || brainEntries.length === 0) {
      return '--- BRAIN (no relevant strategy context for this run) ---\n';
    }
    const lines = ['--- BRAIN (strategy context — cite ids in brain_sources) ---'];
    for (const e of brainEntries) {
      lines.push(`[${e.id}] (${e.category}) ${e.title}`);
      lines.push(`  summary: ${e.summary}`);
      if (e.key_points && e.key_points.length) {
        lines.push(`  key_points:`);
        for (const kp of e.key_points) lines.push(`    - ${kp}`);
      }
    }
    return lines.join('\n');
  },

  /* ===================================================================
   * Findings validation + writing
   * =================================================================== */

  /**
   * Validate a raw findings object from the LLM. Returns:
   *   { ok: true, findings: [...validated], dropped: [{reason, raw}, ...] }
   *
   * Invalid findings are dropped (not thrown). The agent caller decides how
   * vocally to log the drops. We never block a whole run on one bad finding.
   */
  validateFindings(raw, agentName) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, findings: [], dropped: [], summary: '', error: 'LLM returned non-object' };
    }
    const list = Array.isArray(raw.findings) ? raw.findings : [];
    const summary = String(raw.summary || '').slice(0, 600);
    const validated = [];
    const dropped = [];

    for (const f of list) {
      const errs = this._validateFinding(f);
      if (errs.length) {
        dropped.push({ reason: errs.join('; '), raw: f });
        continue;
      }
      validated.push(this._normalizeFinding(f));
    }
    return { ok: true, findings: validated, dropped, summary };
  },

  _validateFinding(f) {
    const errs = [];
    if (!f || typeof f !== 'object')            errs.push('not an object');
    if (!f.id || typeof f.id !== 'string')      errs.push('missing id');
    if (!VALID.categories.includes(f.category)) errs.push(`bad category="${f.category}"`);
    if (!VALID.severities.includes(f.severity)) errs.push(`bad severity="${f.severity}"`);
    if (!f.title || typeof f.title !== 'string') errs.push('missing title');
    if (!f.what  || typeof f.what  !== 'string') errs.push('missing what');
    if (!f.why   || typeof f.why   !== 'string') errs.push('missing why');
    if (!f.action || typeof f.action !== 'string') errs.push('missing action');
    if (!f.target || !VALID.target_types.includes(f.target.type)) errs.push('bad target.type');
    const ei = f.estimated_impact || {};
    if (!VALID.magnitudes.includes(ei.magnitude))   errs.push(`bad impact.magnitude="${ei.magnitude}"`);
    if (!['up', 'down'].includes(ei.direction))     errs.push(`bad impact.direction="${ei.direction}"`);
    if (!VALID.confidences.includes(f.confidence))  errs.push(`bad confidence="${f.confidence}"`);
    if (!VALID.efforts.includes(f.effort))          errs.push(`bad effort="${f.effort}"`);
    return errs;
  },

  _normalizeFinding(f) {
    return {
      id:        String(f.id).slice(0, 100),
      category:  f.category,
      severity:  f.severity,
      title:     String(f.title).slice(0, 200),
      what:      String(f.what).slice(0, 1000),
      why:       String(f.why).slice(0, 1000),
      action:    String(f.action).slice(0, 1000),
      target: {
        type: f.target.type,
        id:   String(f.target.id || '').slice(0, 100),
        name: String(f.target.name || '').slice(0, 200),
      },
      estimated_impact: {
        metric:    String(f.estimated_impact.metric || '').slice(0, 32),
        direction: f.estimated_impact.direction,
        magnitude: f.estimated_impact.magnitude,
      },
      confidence:    f.confidence,
      effort:        f.effort,
      evidence:      Array.isArray(f.evidence)      ? f.evidence.slice(0, 8).map(e => String(e).slice(0, 300)) : [],
      brain_sources: Array.isArray(f.brain_sources) ? f.brain_sources.slice(0, 8).map(e => String(e).slice(0, 32)) : [],
    };
  },

  /**
   * Append validated findings to the Findings tab. Returns row count written.
   *
   * Each row: run_date, mode, agent, finding_id, category, severity, title,
   * what, why, action, target_type, target_id, target_name, impact_metric,
   * impact_direction, impact_magnitude, confidence, effort, evidence_json,
   * brain_sources_json, score, status.
   *
   * `score` is computed here using SCORE_WEIGHTS so synthesis can sort
   * without re-reading every finding. `status` starts as 'new'.
   */
  appendFindings(agentName, mode, validated) {
    const sheet = this._ss().getSheetByName('Findings');
    if (!sheet) throw new Error('Findings sheet missing. Run setupEverything().');
    const headers = SHEETS.Findings.headers;
    const runDate = runDateForWrite_();

    // Idempotency: clear any rows this same agent already wrote for today, so
    // re-running an agent (or the whole director) on the same day REPLACES its
    // findings instead of stacking a second copy. Done before the empty-check
    // so a re-run that now finds nothing also clears yesterday-shaped staleness.
    this._clearAgentFindingsForDate_(sheet, headers, runDate, agentName);

    if (!validated.findings.length) return 0;

    const rows = validated.findings.map(f => {
      const score = this._scoreFinding(f);
      const map = {
        run_date:           runDate,
        mode:               mode,
        agent:              agentName,
        finding_id:         f.id,
        category:           f.category,
        severity:           f.severity,
        title:              f.title,
        what:               f.what,
        why:                f.why,
        action:             f.action,
        target_type:        f.target.type,
        target_id:          f.target.id,
        target_name:        f.target.name,
        impact_metric:      f.estimated_impact.metric,
        impact_direction:   f.estimated_impact.direction,
        impact_magnitude:   f.estimated_impact.magnitude,
        confidence:         f.confidence,
        effort:             f.effort,
        evidence_json:      JSON.stringify(f.evidence),
        brain_sources_json: JSON.stringify(f.brain_sources),
        score:              score,
        status:             'new',
      };
      return headers.map(h => (map[h] !== undefined ? map[h] : ''));
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
    return rows.length;
  },

  _scoreFinding(f) {
    const m = SCORE_WEIGHTS.magnitude[f.estimated_impact.magnitude];
    const c = SCORE_WEIGHTS.confidence[f.confidence];
    const e = SCORE_WEIGHTS.effort[f.effort];
    if (!m || !c || !e) return 0;
    return Math.round((m * c / e) * 100) / 100;   // 2 decimals
  },

  /**
   * Delete every Findings row matching BOTH run_date AND agent. Returns the
   * number of rows cleared. Row 1 (header) is never touched. Deletes bottom-up
   * so row indices don't shift mid-loop. Per-agent finding counts are tiny
   * (<= 8), so the deleteRow loop is cheap.
   */
  _clearAgentFindingsForDate_(sheet, headers, runDate, agentName) {
    const last = sheet.getLastRow();
    if (last < 2) return 0;
    const data = sheet.getRange(2, 1, last - 1, headers.length).getValues();
    const dateIdx  = headers.indexOf('run_date');
    const agentIdx = headers.indexOf('agent');

    const toDelete = [];
    for (let i = data.length - 1; i >= 0; i--) {
      let rd = data[i][dateIdx];
      rd = (rd instanceof Date)
        ? Utilities.formatDate(rd, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(rd).trim();
      const ag = String(data[i][agentIdx]).trim();
      if (rd === runDate && ag === agentName) toDelete.push(i + 2);
    }
    for (const rowNum of toDelete) sheet.deleteRow(rowNum);
    if (toDelete.length) {
      log_('agent', `${agentName}: cleared ${toDelete.length} prior findings for ${runDate} (re-run replace)`);
    }
    return toDelete.length;
  },

  /* ===================================================================
   * Standard agent runner — wraps the LLM call + validation + write.
   * Each agent file just provides persona, instructions, brainCategories,
   * and data → user-prompt builder.
   * =================================================================== */

  runAgent(spec) {
    /*
     * spec = {
     *   agentName:        'performance_analyst',
     *   mode:             'daily' | 'weekly',
     *   persona:          string,   // role description for the LLM
     *   instructions:     string,   // domain-specific instructions
     *   brainCategories:  string[], // categories to query in Brain
     *   brainLimit:       number,
     *   data:             object,   // arbitrary data the user prompt formatter consumes
     *   formatDataForPrompt(data): string,    // returns the DATA section
     *   maxTokens?:       number,
     * }
     */
    const start = Date.now();
    const mode  = spec.mode || 'daily';

    const brain = BrainStore.query(spec.brainCategories, spec.brainLimit || 5);
    const systemPrompt = this.buildSystemPrompt(spec.persona, spec.instructions);
    const userPrompt =
      this.formatDataContext() + '\n' +
      'TARGETS:\n' + JSON.stringify(this.getTargets()) + '\n\n' +
      this.formatBrainContext(brain) + '\n\n' +
      '--- DATA ---\n' +
      spec.formatDataForPrompt(spec.data);

    const provider = pickProvider(spec.agentName);
    const llm = callLLM(systemPrompt, userPrompt, {
      label:       spec.agentName,
      provider:    provider,
      max_tokens:  spec.maxTokens || 3500,
      temperature: 0.2,
    });

    const validated = this.validateFindings(llm.json, spec.agentName);
    const written = this.appendFindings(spec.agentName, mode, validated);
    const ms = Date.now() - start;

    log_('agent', `${spec.agentName} [${llm.provider}] → ${validated.findings.length} findings ` +
                  `(written=${written}, dropped=${validated.dropped.length}, ` +
                  `tokens=${llm.tokens.total}, ${ms}ms)`);
    if (validated.dropped.length) {
      for (const d of validated.dropped.slice(0, 3)) {
        log_('agent', `  dropped: ${d.reason}`);
      }
    }
    return {
      agent:        spec.agentName,
      mode:         mode,
      findings:     validated.findings,
      summary:      validated.summary,
      dropped:      validated.dropped.length,
      written:      written,
      tokens:       llm.tokens.total,
      provider:     llm.provider,
      run_time_ms:  ms,
    };
  },

  /* ===================================================================
   * RULE-BASED agent runner (token-lean path).
   *
   * Difference from runAgent: detection is DETERMINISTIC JS, not the LLM.
   *   1. spec.detect(data, ctx) returns an array of "candidate" objects with
   *      all the STRUCTURED fields already set (category/severity/magnitude/
   *      confidence/effort/target/evidence). ctx = { targets, cur, cfg }.
   *   2. If there are 0 candidates we write nothing and DO NOT CALL THE LLM.
   *   3. Otherwise we send only the compact candidate list (no raw tables) and
   *      the LLM writes ONLY the prose (title/what/why/action). We merge that
   *      prose back onto our deterministic candidates, so the LLM can never
   *      corrupt severity, target ids, or evidence.
   *
   * Net effect: far smaller prompts, deterministic severity (no drift), fewer
   * LLM calls, and thresholds you tune from the Config sheet.
   *
   * candidate = {
   *   id, category, severity, magnitude, confidence, effort,
   *   metric?, direction?, target:{type,id,name}, evidence:[..], hint:'...'
   * }
   * =================================================================== */
  runRuleBasedAgent(spec) {
    const start = Date.now();
    const mode  = spec.mode || 'daily';
    const ctx = {
      targets: this.getTargets(),
      cur:     this.getCurrency(),
      cfg:     spec.ruleConfig || {},
    };

    let candidates = spec.detect(spec.data, ctx) || [];
    candidates.sort((a, b) => this._candScore_(b) - this._candScore_(a));
    const cap = spec.maxCandidates || 8;
    if (candidates.length > cap) candidates = candidates.slice(0, cap);

    // No rule hits → no LLM call. Still clear this agent's stale rows for today.
    if (candidates.length === 0) {
      this.appendFindings(spec.agentName, mode, { findings: [] });
      log_('agent', `${spec.agentName} [rules] → 0 candidates (no LLM call), ${Date.now() - start}ms`);
      return {
        agent: spec.agentName, mode: mode, findings: [], summary: 'No rule hits.',
        dropped: 0, written: 0, tokens: 0, provider: 'none', run_time_ms: Date.now() - start,
      };
    }

    const brain = BrainStore.query(spec.brainCategories, spec.brainLimit || 4);
    const systemPrompt = this.buildRuleSystemPrompt(spec.persona, spec.instructions);
    const userPrompt =
      this.formatDataContext() + '\n' +
      'TARGETS:\n' + JSON.stringify(ctx.targets) + '\n\n' +
      this.formatBrainContext(brain) + '\n\n' +
      '--- PRE-DETECTED ISSUES (write each one up; do NOT add or drop any) ---\n' +
      this._renderCandidates_(candidates);

    const provider = pickProvider(spec.agentName);
    const llm = callLLM(systemPrompt, userPrompt, {
      label:       spec.agentName,
      provider:    provider,
      max_tokens:  spec.maxTokens || 2000,
      temperature: 0.2,
    });

    // Index the LLM's prose by echoed id.
    const prose = {};
    const arr = (llm.json && Array.isArray(llm.json.findings)) ? llm.json.findings : [];
    for (const p of arr) if (p && p.id) prose[String(p.id)] = p;

    // Merge prose onto deterministic candidates. Candidate fields are authoritative.
    const findings = [];
    for (const c of candidates) {
      const p = prose[c.id] || {};
      const fallbackWhy = (c.evidence || []).join('; ');
      const f = {
        id:       c.id,
        category: c.category,
        severity: c.severity,
        title:    String(p.title  || c.hint || c.id).slice(0, 200),
        what:     String(p.what   || c.hint || fallbackWhy).slice(0, 1000),
        why:      String(p.why    || fallbackWhy).slice(0, 1000),
        action:   String(p.action || c.hint || '').slice(0, 1000),
        target:   c.target,
        estimated_impact: {
          metric:    String(c.metric || 'spend').slice(0, 32),
          direction: (c.direction === 'up' || c.direction === 'down') ? c.direction : 'down',
          magnitude: c.magnitude,
        },
        confidence:    c.confidence,
        effort:        c.effort,
        evidence:      Array.isArray(c.evidence) ? c.evidence.slice(0, 8).map(e => String(e).slice(0, 300)) : [],
        brain_sources: Array.isArray(p.brain_sources) ? p.brain_sources.slice(0, 8).map(e => String(e).slice(0, 32)) : [],
      };
      const errs = this._validateFinding(f);
      if (errs.length) {
        log_('agent', `${spec.agentName} candidate ${c.id} invalid: ${errs.join('; ')}`);
        continue;
      }
      findings.push(f);
    }

    const written = this.appendFindings(spec.agentName, mode, { findings });
    const ms = Date.now() - start;
    log_('agent', `${spec.agentName} [rules+${llm.provider}] → ${findings.length} findings ` +
                  `from ${candidates.length} candidates (tokens=${llm.tokens.total}, ${ms}ms)`);
    return {
      agent: spec.agentName, mode: mode, findings: findings,
      summary: (llm.json && llm.json.summary) || `${findings.length} rule-detected issues.`,
      dropped: 0, written: written, tokens: llm.tokens.total,
      provider: llm.provider, run_time_ms: ms,
    };
  },

  /** Compact system prompt for the prose-only LLM step. */
  buildRuleSystemPrompt(persona, instructions) {
    return (
      persona + '\n\n' +
      (instructions ? instructions + '\n\n' : '') +
      'You are given a list of PRE-DETECTED issues, each with an id, the data ' +
      'evidence, and a target. Your ONLY job is to write clear human-facing copy ' +
      'for each issue. Detection is already done — do not second-guess it.\n\n' +
      'Output STRICT JSON:\n' +
      '{\n' +
      '  "findings": [\n' +
      '    { "id": "<echo the given id EXACTLY>", "title": "<=100 chars", ' +
      '"what": "what is wrong / the opportunity", "why": "why it matters, quantified", ' +
      '"action": "exact change for a human implementer", "brain_sources": ["brain_001"] }\n' +
      '  ],\n' +
      '  "summary": "one sentence"\n' +
      '}\n\n' +
      'Rules:\n' +
      '  - Echo every id EXACTLY. Write up EVERY issue provided; never invent or drop any.\n' +
      '  - Use ONLY the evidence numbers given — never fabricate data.\n' +
      '  - Quantify money with the currency symbol in TARGETS (never assume $).\n' +
      '  - Cite a brain id in brain_sources only if you actually used it.\n' +
      '  - Return ONLY the JSON object — no prose, no markdown fences.\n'
    );
  },

  _renderCandidates_(candidates) {
    const lines = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      lines.push(
        `#${i + 1} id=${c.id} [${c.severity}/${c.category}]\n` +
        `  issue:  ${c.hint || ''}\n` +
        `  target: ${c.target.type} "${c.target.name}" (${c.target.id})\n` +
        `  data:   ${(c.evidence || []).join(' | ')}`
      );
    }
    return lines.join('\n\n');
  },

  _candScore_(c) {
    const m = SCORE_WEIGHTS.magnitude[c.magnitude];
    const cf = SCORE_WEIGHTS.confidence[c.confidence];
    const e = SCORE_WEIGHTS.effort[c.effort];
    if (!m || !cf || !e) return 0;
    return (m * cf) / e;
  },
};

/* ===========================================================================
 * Module-level helpers — pure functions used by AgentCommon. Top-level so
 * Apps Script's flat namespace sees them; underscore-prefixed so they're
 * obviously private.
 * ========================================================================= */
function _humanizeRange_(range) {
  if (!range) return 'unknown';
  const r = String(range).toUpperCase();
  const map = {
    LAST_7_DAYS:   'last 7 days',
    LAST_14_DAYS:  'last 14 days',
    LAST_30_DAYS:  'last 30 days',
    LAST_60_DAYS:  'last 60 days',
    LAST_90_DAYS:  'last 90 days',
    THIS_MONTH:    'this calendar month so far',
    LAST_MONTH:    'previous calendar month',
    YESTERDAY:     'yesterday only',
    TODAY:         'today only',
  };
  return map[r] || range;
}
