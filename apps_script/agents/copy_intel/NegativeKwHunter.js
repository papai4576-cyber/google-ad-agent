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
  const negatives   = AgentCommon.readNegativeKeywords();
  if (searchTerms.length === 0) {
    log_('agent', 'negative_kw_hunter: no search terms — skipping');
    return { agent: 'negative_kw_hunter', findings: [], summary: 'No search term data.' };
  }
  log_('agent', `negative_kw_hunter: ${negatives.length} existing negatives loaded for dedup`);

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
    data: { searchTerms, negatives, targets: AgentCommon.getTargets() },
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

  // Step 1: filter by waste threshold.
  const wasted = d.searchTerms.filter(t =>
    t.conversions === 0 && AgentCommon.micros(t.cost_micros) >= minWaste
  );

  // Step 2: pre-filter against already-existing negative keywords. If we
  // recommend something already blocked we waste tokens AND the human's
  // attention. Match semantics:
  //   EXACT  → term equals negative text (case-insensitive)
  //   PHRASE → term contains the negative text as a contiguous substring
  //   BROAD  → term contains every word of the negative text (any order)
  const negatives = d.negatives || [];
  const isAlreadyBlocked = _buildNegativeMatcher_(negatives);

  const stillCandidates = [];
  let alreadyBlockedCount = 0;
  for (const t of wasted) {
    if (isAlreadyBlocked(t)) {
      alreadyBlockedCount++;
      continue;
    }
    stillCandidates.push(t);
  }

  const top = stillCandidates
    .sort((a, b) => b.cost_micros - a.cost_micros)
    .slice(0, 40);

  const totalWastedTop = top.reduce((s, t) => s + AgentCommon.micros(t.cost_micros), 0);
  const totalWastedAll = stillCandidates.reduce((s, t) => s + AgentCommon.micros(t.cost_micros), 0);

  lines.push(`Zero-conversion search terms with spend ≥ ${cur}${minWaste}:`);
  lines.push(`  ${wasted.length} initially wasted, ${alreadyBlockedCount} already blocked by ` +
             `existing negatives, ${stillCandidates.length} still candidates ` +
             `(${cur}${totalWastedAll.toFixed(2)} wasted).`);
  lines.push(`Showing top ${top.length} candidates (${cur}${totalWastedTop.toFixed(2)} of those) by wasted spend:`);
  lines.push('term | clicks | spend | ad_group_id | ad_group');
  for (const t of top) {
    lines.push(
      `"${t.term}" | ${t.clicks} | ` +
      `${cur}${AgentCommon.micros(t.cost_micros).toFixed(2)} | ` +
      `${t.ad_group_id} | ${t.ad_group_name}`
    );
  }
  if (top.length === 0) {
    lines.push('');
    lines.push('No new candidates after dedup against existing negatives. ' +
               'Negatives are well-managed.');
  }
  return lines.join('\n');
}

/**
 * Build an "is this term already blocked?" predicate from the existing
 * negative-keyword list. Scope-aware: campaign negatives only block within
 * their campaign, ad-group negatives only within their ad group, shared
 * negatives block account-wide (we assume the shared lists are attached to
 * every campaign — a reasonable simplification for filtering).
 */
function _buildNegativeMatcher_(negatives) {
  // Group negatives by scope key for quick lookup.
  const byCampaign  = {};   // campaign_id   → array of {text, match_type}
  const byAdGroup   = {};   // ad_group_id  → array of {text, match_type}
  const accountWide = [];   // shared

  for (const n of negatives) {
    const entry = {
      text:   String(n.text || '').toLowerCase().trim(),
      match:  String(n.match_type || '').toUpperCase().trim(),
    };
    if (!entry.text) continue;
    if (n.scope === 'campaign') {
      const k = String(n.campaign_id);
      (byCampaign[k] = byCampaign[k] || []).push(entry);
    } else if (n.scope === 'ad_group') {
      const k = String(n.ad_group_id);
      (byAdGroup[k] = byAdGroup[k] || []).push(entry);
    } else if (n.scope === 'shared') {
      accountWide.push(entry);
    }
  }

  return function (term) {
    const text = String(term.term || '').toLowerCase().trim();
    if (!text) return false;
    const candidates = []
      .concat(byCampaign[String(term.campaign_id)] || [])
      .concat(byAdGroup[String(term.ad_group_id)]  || [])
      .concat(accountWide);
    for (const n of candidates) {
      if (_negativeMatches_(text, n.text, n.match)) return true;
    }
    return false;
  };
}

function _negativeMatches_(searchTerm, negText, matchType) {
  // Google Ads negative-match rules:
  //   EXACT  → identical (we strip brackets/quotes already in normalisation)
  //   PHRASE → negative text appears as a contiguous word phrase
  //   BROAD  → every word of negative appears anywhere in search term
  if (!negText) return false;
  const mt = (matchType || '').toUpperCase();
  if (mt === 'EXACT')  return searchTerm === negText;
  if (mt === 'PHRASE') {
    // Word-boundary contiguous match.
    const re = new RegExp('\\b' + _reEscape_(negText) + '\\b');
    return re.test(searchTerm);
  }
  // Default to BROAD (also handles BROAD_MATCH and missing match_type).
  const words = negText.split(/\s+/).filter(Boolean);
  return words.every(w => new RegExp('\\b' + _reEscape_(w) + '\\b').test(searchTerm));
}

function _reEscape_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
