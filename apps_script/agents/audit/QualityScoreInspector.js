/**
 * QualityScoreInspector.js — surfaces low-QS keywords that cost real money.
 *
 * Domain: keyword-level Quality Score and its three components:
 *   ad_relevance, post_click_quality (LP experience), search_predicted_ctr.
 *
 * Flags:
 *   - Keywords with QS ≤ 5 AND cost > $10 (configurable spend threshold)
 *     — low QS taxes every click; the cost compounds.
 *   - Keywords where ad_relevance is below_average → ad copy mismatch.
 *   - Keywords where post_click_quality is below_average → landing page issue.
 *   - Keywords where search_predicted_ctr is below_average → headline/CTA work.
 *
 * Reads: Raw_Keywords.
 * Brain categories queried: keywords, copy, landing_page.
 */

function runQualityScoreInspector(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const keywords = AgentCommon.readKeywords();
  if (keywords.length === 0) {
    log_('agent', 'quality_score_inspector: no keywords — skipping');
    return { agent: 'quality_score_inspector', findings: [], summary: 'No keyword data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'quality_score_inspector',
    mode:            mode,
    brainCategories: ['keywords', 'copy', 'landing_page'],
    brainLimit:      6,
    persona:
      'You are a Google Ads Quality Score specialist. You diagnose low-QS ' +
      'keywords by reading the three QS components (ad relevance, expected CTR, ' +
      'landing page experience) and translate them into specific actions for ' +
      'each root cause.',
    instructions:
      'Analyze the keywords and surface up to 8 QUALITY-SCORE findings. Focus:\n' +
      '  1. Keywords with QS ≤ 5 AND cost > $10 → flag as P1 if cost > $50.\n' +
      '  2. Diagnose root cause from QS components:\n' +
      '     - ad_relevance = BELOW_AVERAGE → ad copy does not match keyword intent;\n' +
      '       action = create ad variants with the keyword in H1/H2.\n' +
      '     - post_click_quality = BELOW_AVERAGE → landing page mismatch or speed;\n' +
      '       action = audit LP for message match + page speed.\n' +
      '     - search_predicted_ctr = BELOW_AVERAGE → headlines/CTAs underperform;\n' +
      '       action = test new headline variants with stronger CTAs.\n' +
      '  3. Cluster: if many KWs in the same ad group all show same root cause, ' +
      '     surface ONE finding targeting the ad group instead of N keyword findings.\n' +
      '  4. Skip keywords with QS = 0 (no QS calculated yet — too little data).\n\n' +
      'Use category="keywords" or "copy" depending on root cause. ' +
      'Quantify: "this keyword costs $X with QS=N; raising QS by 2 typically cuts CPC ~20%".',
    data: { keywords },
    formatDataForPrompt(d) {
      return _qualityScoreInspectorFormatData(d);
    },
  });
}

function _qualityScoreInspectorFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  // Pre-filter: only keywords with cost > 5 currency units AND quality_score 1..5.
  // Keep the LLM focused on the actionable subset.
  const interesting = d.keywords.filter(k =>
    k.cost_micros >= 5000000 && k.quality_score >= 1 && k.quality_score <= 5
  );
  lines.push(`Low-QS keywords (QS 1–5, cost ≥ ${cur}5): ${interesting.length} total`);
  lines.push('Showing top 50 by cost:');
  lines.push('id | text | match | QS | ad_rel | post_click | exp_ctr | spend | clicks | conv | ad_group | campaign');
  const top = interesting.sort((a, b) => b.cost_micros - a.cost_micros).slice(0, 50);
  for (const k of top) {
    lines.push(
      `${k.keyword_id} | "${k.text}" | ${k.match_type} | ${k.quality_score} | ` +
      `${k.creative_quality || '?'} | ${k.post_click_quality || '?'} | ${k.search_predicted_ctr || '?'} | ` +
      `${cur}${AgentCommon.micros(k.cost_micros).toFixed(2)} | ${k.clicks} | ${k.conversions} | ` +
      `${k.ad_group_name} | ${k.campaign_name}`
    );
  }

  if (interesting.length === 0) {
    lines.push('');
    lines.push('No keywords meet the low-QS + cost threshold. Account is healthy on QS.');
  }
  return lines.join('\n');
}

function testQualityScoreInspector() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'QualityScoreInspector dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runQualityScoreInspector({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 120)}`);
  }
}
