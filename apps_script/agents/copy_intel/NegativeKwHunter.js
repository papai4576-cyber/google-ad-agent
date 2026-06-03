/**
 * NegativeKwHunter.js — finds search terms wasting budget that should be
 * blocked as negative keywords.
 *
 * Domain: search terms with meaningful spend AND zero conversions. The
 * cheapest action in Google Ads — every $/₹ blocked here is real savings.
 *
 * Logic:
 *   1. Pre-filter terms with cost ≥ MIN_WASTE (configurable, default 50 in
 *      account currency) AND conversions = 0.
 *   2. Sort by cost desc, take top 100.
 *   3. LLM clusters them into themes ("informational queries", "wrong-product",
 *      "free/cheap intent", etc.) and produces grouped negative recommendations.
 *
 * Reads: Raw_SearchTerms.
 * Brain categories queried: keywords.
 */

function runNegativeKwHunter(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const searchTerms = AgentCommon.readSearchTerms();
  if (searchTerms.length === 0) {
    log_('agent', 'negative_kw_hunter: no search terms — skipping');
    return { agent: 'negative_kw_hunter', findings: [], summary: 'No search term data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'negative_kw_hunter',
    mode:            mode,
    brainCategories: ['keywords', 'audience', 'competitive'],
    brainLimit:      5,
    persona:
      'You are a Google Ads negative-keyword specialist. You read wasted-spend ' +
      'search terms and cluster them into theme-based negative-keyword ' +
      'recommendations. You distinguish broad-block themes (negate at campaign ' +
      'level) from one-off bad queries (negate at ad group level).',
    instructions:
      'Analyze the wasted-spend search terms and surface up to 6 NEGATIVE-KW ' +
      'findings. For each finding:\n' +
      '  1. Identify a clear theme (e.g. "informational queries containing \'how to\'", ' +
      '     "free / cheap variants", "DIY / tutorial intent", "wrong product line").\n' +
      '  2. Pick the right SCOPE: campaign-level negative if the theme is universally ' +
      '     irrelevant across the account, ad-group-level if specific to one group.\n' +
      '  3. In the `action` field, list the exact negative keywords to add WITH ' +
      '     match type: e.g. -[free trial], -"how to", +tutorial (phrase), -how (broad).\n' +
      '     Prefer broader matches that catch families of terms over single-term blocks.\n' +
      '  4. Quantify wasted spend you would save in the next 30 days.\n\n' +
      'Be CONSERVATIVE — never recommend a negative that could also block converting ' +
      'queries. When in doubt, scope to ad group not campaign.\n' +
      'Use category="keywords", target.type="campaign" or "adgroup".\n' +
      'Severity: P1 if combined cluster wasted-spend > target_cpa × 5.',
    data: { searchTerms, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _negativeKwHunterFormatData(d);
    },
    maxTokens: 3500,
  });
}

function _negativeKwHunterFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  // Minimum wasted spend threshold to surface (account currency units).
  const minWaste = parseFloat(getConfig('NEGATIVE_KW_MIN_WASTE', '50')) || 50;
  const wasted = d.searchTerms.filter(t =>
    t.conversions === 0 && AgentCommon.micros(t.cost_micros) >= minWaste
  );
  const top = wasted
    .sort((a, b) => b.cost_micros - a.cost_micros)
    .slice(0, 100);

  const totalWastedTop = top.reduce((s, t) => s + AgentCommon.micros(t.cost_micros), 0);
  const totalWastedAll = wasted.reduce((s, t) => s + AgentCommon.micros(t.cost_micros), 0);

  lines.push(`Zero-conversion search terms with spend ≥ ${cur}${minWaste}: ${wasted.length} total, ${cur}${totalWastedAll.toFixed(2)} wasted.`);
  lines.push(`Showing top ${top.length} (${cur}${totalWastedTop.toFixed(2)}) by wasted spend:`);
  lines.push('term | impressions | clicks | spend | ad_group_id | ad_group | campaign');
  for (const t of top) {
    lines.push(
      `"${t.term}" | ${t.impressions} | ${t.clicks} | ` +
      `${cur}${AgentCommon.micros(t.cost_micros).toFixed(2)} | ` +
      `${t.ad_group_id} | ${t.ad_group_name} | ${t.campaign_name}`
    );
  }
  if (top.length === 0) {
    lines.push('');
    lines.push('No wasted-spend terms meet threshold. Negatives are well-managed.');
  }
  return lines.join('\n');
}

function testNegativeKwHunter() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'NegativeKwHunter dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runNegativeKwHunter({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 200)}`);
  }
}
