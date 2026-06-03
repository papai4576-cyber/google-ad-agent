/**
 * BidBudgetAnalyst.js — surfaces bid-strategy and budget issues.
 *
 * Domain: HOW the campaign is bidding/spending, not WHAT it's producing.
 * Flags:
 *   - Smart bidding (tROAS/tCPA) on campaigns with too little conversion
 *     volume (rule of thumb: tROAS needs 50+ conv/30d, tCPA needs 30+).
 *   - High `search_budget_lost_impression_share` (>30%) — daily budget capping growth.
 *   - High `search_rank_lost_impression_share` (>40%) — bids too low / quality issue.
 *   - Maximize Conversions on a campaign that has clearly stabilized (move to tCPA).
 *   - Manual CPC on a campaign that has conversion history (move to tCPA/eCPC).
 *
 * Reads: Raw_Campaigns.
 * Brain categories queried: bidding, scaling.
 */

function runBidBudgetAnalyst(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const campaigns = AgentCommon.readCampaigns();
  if (campaigns.length === 0) {
    log_('agent', 'bid_budget_analyst: no campaigns — skipping');
    return { agent: 'bid_budget_analyst', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'bid_budget_analyst',
    mode:            mode,
    brainCategories: ['bidding', 'scaling', 'structure'],
    brainLimit:      6,
    persona:
      'You are a Google Ads Bidding & Budget specialist. You evaluate whether ' +
      'each campaign uses the right bid strategy for its data volume and ' +
      'whether budget is being left on the table. You know exact volume ' +
      'thresholds for smart bidding (tROAS ~50 conv/30d, tCPA ~30 conv/30d) ' +
      'and how to read impression-share signals.',
    instructions:
      'Analyze the campaigns and surface up to 8 BIDDING / BUDGET issues. Focus:\n' +
      '  1. Wrong-strategy-for-volume: tROAS/tCPA on campaigns with <30 conversions.\n' +
      '     Recommend a transitional strategy (Maximize Conversions or eCPC).\n' +
      '  2. Budget-locked growth: search_budget_lost_is > 0.30 → propose budget ' +
      '     increase capped by the SAFETY rail in CLAUDE.md (max 20%/run).\n' +
      '  3. Rank-locked: search_rank_lost_is > 0.40 → bids too low or QS too low.\n' +
      '     If QS data is available recommend a QS path; otherwise propose bid lift\n' +
      '     capped at +30% (safety rail).\n' +
      '  4. Mature campaigns still on Maximize Conversions → suggest moving to tCPA ' +
      '     at the trailing CPA average.\n' +
      '  5. Manual CPC on campaigns with >30 conversions → suggest eCPC or tCPA.\n' +
      '  6. Idle budgets — campaigns far below daily budget with no IS loss → ' +
      '     redirect budget to capacity-constrained campaigns.\n\n' +
      'Use category="bidding" for #1 #4 #5; "performance" or "structure" for #2 #6 ' +
      'where appropriate.\n' +
      'Quantify in $: "campaign losing ~$X/day in capped impressions".\n' +
      'Never recommend a single bid change >30% or a single budget shift >20%.',
    data: { campaigns, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _bidBudgetAnalystFormatData(d);
    },
  });
}

function _bidBudgetAnalystFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();
  lines.push('Campaigns (sorted by cost):');
  lines.push('id | name | bidding_strategy | tCPA | tROAS | budget/day | spend | conv | conv_value | search_IS | budget_lost_IS | rank_lost_IS');
  const top = d.campaigns
    .slice()
    .sort((a, b) => b.cost_micros - a.cost_micros)
    .slice(0, 40);
  for (const c of top) {
    const tcpa  = c.target_cpa_micros > 0 ? cur + AgentCommon.micros(c.target_cpa_micros).toFixed(2) : 'n/a';
    const troas = c.target_roas > 0 ? c.target_roas.toFixed(2) : 'n/a';
    lines.push(
      `${c.campaign_id} | ${c.campaign_name} | ${c.bidding_strategy} | ${tcpa} | ${troas} | ` +
      `${cur}${AgentCommon.micros(c.budget_micros).toFixed(2)} | ${cur}${AgentCommon.micros(c.cost_micros).toFixed(2)} | ` +
      `${c.conversions} | ${cur}${(c.conversion_value || 0).toFixed(2)} | ` +
      `${(c.search_is * 100).toFixed(0)}% | ${(c.search_budget_lost_is * 100).toFixed(0)}% | ${(c.search_rank_lost_is * 100).toFixed(0)}%`
    );
  }
  return lines.join('\n');
}

function testBidBudgetAnalyst() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'BidBudgetAnalyst dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runBidBudgetAnalyst({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 120)}`);
  }
}
