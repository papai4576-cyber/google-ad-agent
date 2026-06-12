/**
 * QualityScoreInspector.js — low-QS keywords that cost real money.  [RULE-BASED]
 *
 * Detection is deterministic: flag keywords with QS in 1..5 and meaningful
 * spend, diagnosing the root cause from the three QS components. The LLM only
 * writes the copy. No raw 50-row keyword table is sent.
 *
 * Tunable thresholds (Config, RULE_* — defaults in parens):
 *   RULE_QS_MIN_COST (5)   min spend (currency) for a low-QS keyword to flag
 *   RULE_QS_MAX      (5)   QS at/below this is "low"
 *   RULE_QS_P1_COST  (50)  spend above this makes it P1
 *
 * Reads: Raw_Keywords. Brain categories: keywords, copy, landing_page.
 */

function runQualityScoreInspector(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const keywords = AgentCommon.readKeywords();
  if (keywords.length === 0) {
    log_('agent', 'quality_score_inspector: no keywords — skipping');
    return { agent: 'quality_score_inspector', findings: [], summary: 'No keyword data.' };
  }

  return AgentCommon.runRuleBasedAgent({
    agentName:       'quality_score_inspector',
    mode:            mode,
    brainCategories: ['keywords', 'copy', 'landing_page'],
    brainLimit:      3,
    persona:
      'You are a Google Ads Quality Score specialist. You turn flagged low-QS ' +
      'keywords into specific, root-cause-matched actions.',
    instructions:
      'Quantify where useful: raising QS by ~2 points typically cuts CPC ~15-20%.',
    data:            { keywords: keywords },
    ruleConfig:      RulesEngine.load({ QS_MIN_COST: 5, QS_MAX: 5, QS_P1_COST: 50 }),
    detect:          _qsDetect_,
    maxCandidates:   8,
    maxTokens:       2200,
  });
}

function _qsDetect_(data, ctx) {
  const cur = ctx.cur;
  const cfg = ctx.cfg;
  const out = [];

  // Extra rule: new keywords spending above P1 threshold with no QS assigned yet (qs=0/null).
  for (const k of data.keywords) {
    const cost = AgentCommon.micros(k.cost_micros);
    const qs   = Number(k.quality_score) || 0;
    if (qs === 0 && cost >= cfg.qs_p1_cost) {
      out.push({
        id: 'no-qs-spend-' + k.keyword_id, category: 'keywords',
        severity: 'P2', magnitude: 'medium', confidence: 'medium', effort: 'easy',
        metric: 'CPA', direction: 'down',
        target: { type: 'keyword', id: String(k.keyword_id), name: k.text },
        hint: 'Keyword has no QS assigned yet (new/low volume) but is spending ' +
              cur + cost.toFixed(0) + '. Monitor closely — if QS stays unassigned ' +
              'after significant spend, check match type and ad relevance.',
        evidence: [
          'QS=none (new/low volume)', 'spend ' + cur + cost.toFixed(0),
          'match type ' + (k.match_type || '?'), 'ad group ' + k.ad_group_name,
          k.clicks + ' clicks',
        ],
      });
    }
  }

  for (const k of data.keywords) {
    const cost = AgentCommon.micros(k.cost_micros);
    const qs   = Number(k.quality_score) || 0;
    if (!(cost >= cfg.qs_min_cost && qs >= 1 && qs <= cfg.qs_max)) continue;

    const adRel = String(k.creative_quality || '').toUpperCase();
    const lp    = String(k.post_click_quality || '').toUpperCase();
    const ctr   = String(k.search_predicted_ctr || '').toUpperCase();

    let category, hint;
    if (lp === 'BELOW_AVERAGE') {
      category = 'landing_page';
      hint = 'Low QS driven by below-average landing-page experience — audit message ' +
             'match and page speed for this keyword/ad group.';
    } else if (adRel === 'BELOW_AVERAGE') {
      category = 'copy';
      hint = 'Low QS driven by below-average ad relevance — add ad variants featuring ' +
             'the keyword in headlines 1–2.';
    } else if (ctr === 'BELOW_AVERAGE') {
      category = 'copy';
      hint = 'Low QS driven by below-average expected CTR — test stronger headlines/CTAs.';
    } else {
      category = 'keywords';
      hint = 'Persistently low QS without a single below-average component — consider ' +
             'tighter ad-group theming, or pausing if it stays low.';
    }

    const big = cost > cfg.qs_p1_cost;
    out.push({
      id: 'low-qs-' + k.keyword_id, category: category,
      severity: big ? 'P1' : 'P2', magnitude: big ? 'high' : 'medium',
      confidence: 'high', effort: 'medium', metric: 'CPA', direction: 'down',
      target: { type: 'keyword', id: String(k.keyword_id), name: k.text },
      hint: hint,
      evidence: [
        'QS=' + qs, 'spend ' + cur + cost.toFixed(0),
        'components adRel=' + (k.creative_quality || '?') + ', LP=' + (k.post_click_quality || '?') +
          ', expCTR=' + (k.search_predicted_ctr || '?'),
        k.clicks + ' clicks, ' + k.conversions + ' conv',
        'ad group ' + k.ad_group_name,
      ],
    });
  }
  return out;
}

function testQualityScoreInspector() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'QualityScoreInspector dry run (rule-based)');
  log_('test', '═══════════════════════════════════════════');
  const r = runQualityScoreInspector({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, provider: ${r.provider}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 120)}`);
  }
}
