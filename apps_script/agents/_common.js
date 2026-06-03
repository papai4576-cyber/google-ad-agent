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
    };
    return map[tabName] || [];
  },

  // ---- typed convenience wrappers --------------------------------------

  readCampaigns()   { return this.readSheet('Raw_Campaigns');   },
  readAdGroups()    { return this.readSheet('Raw_AdGroups');    },
  readKeywords()    { return this.readSheet('Raw_Keywords');    },
  readAds()         { return this.readSheet('Raw_Ads');         },
  readSearchTerms() { return this.readSheet('Raw_SearchTerms'); },
  readExtensions()  { return this.readSheet('Raw_Extensions');  },

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
    if (!validated.findings.length) return 0;
    const sheet = this._ss().getSheetByName('Findings');
    if (!sheet) throw new Error('Findings sheet missing. Run setupEverything().');
    const headers = SHEETS.Findings.headers;
    const runDate = todayString_();

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
      'TARGETS:\n' + JSON.stringify(this.getTargets()) + '\n\n' +
      this.formatBrainContext(brain) + '\n\n' +
      '--- DATA ---\n' +
      spec.formatDataForPrompt(spec.data);

    const llm = callLLM(systemPrompt, userPrompt, {
      label:      spec.agentName,
      max_tokens: spec.maxTokens || 3500,
      temperature: 0.2,
    });

    const validated = this.validateFindings(llm.json, spec.agentName);
    const written = this.appendFindings(spec.agentName, mode, validated);
    const ms = Date.now() - start;

    log_('agent', `${spec.agentName} → ${validated.findings.length} findings ` +
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
      run_time_ms:  ms,
    };
  },
};
