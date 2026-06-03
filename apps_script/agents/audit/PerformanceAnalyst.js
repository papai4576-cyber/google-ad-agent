/**
 * PerformanceAnalyst.js — surfaces campaign-level performance issues.
 *
 * Domain: campaign metrics vs targets. Flags:
 *   - Campaigns with CPA significantly above TARGET_CPA
 *   - Campaigns with ROAS significantly below TARGET_ROAS
 *   - Campaigns with high spend and 0 conversions (likely tracking gap or wrong intent)
 *   - Campaigns that have collapsed week-over-week (we only have totals for the
 *     date_range, so direction is inferred from absolute miss vs target)
 *   - Overspend/underspend vs MONTHLY_BUDGET_TARGET pacing
 *
 * Reads: Raw_Campaigns (primary), Raw_AdGroups (supporting context for severity).
 * Brain categories queried: performance, scaling, bidding.
 */

function runPerformanceAnalyst(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const campaigns = AgentCommon.readCampaigns();
  const adGroups  = AgentCommon.readAdGroups();
  if (campaigns.length === 0) {
    log_('agent', 'performance_analyst: no campaigns — skipping');
    return { agent: 'performance_analyst', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'performance_analyst',
    mode:            mode,
    brainCategories: ['scaling', 'bidding', 'general'],
    brainLimit:      5,
    persona:
      'You are a senior Google Ads Performance Analyst with 10+ years of ' +
      'enterprise PPC experience. You read the full campaign performance picture ' +
      'in seconds and call out the highest-impact problems first. You are ' +
      'numerate, skeptical of small samples, and never flag noise as a finding.',
    instructions:
      'Analyze the campaigns vs TARGETS and surface up to 8 highest-impact ' +
      'PERFORMANCE issues. Focus areas:\n' +
      '  1. Campaigns with cost > 2× TARGET_CPA × conversions  (CPA over target).\n' +
      '  2. Campaigns with conversion_value / cost < 0.6 × TARGET_ROAS  (ROAS under target).\n' +
      '  3. High-spend campaigns with 0 conversions  → tracking or wrong-intent flag.\n' +
      '  4. Campaigns dominated by low-converting ad groups (cross-reference AdGroups data).\n' +
      '  5. Significant impression share lost to budget or rank — flag pacing risk.\n' +
      '  6. If MONTHLY_BUDGET_TARGET pacing is wildly off (>30% over/under), flag it.\n\n' +
      'Skip anything that is just within ±20% of target — that is normal noise. ' +
      'Skip campaigns with <30 clicks unless cost is large; tiny samples are not findings.\n' +
      'For each finding, prefer category="performance"; use "bidding" if the root ' +
      'cause is bid strategy, "structure" if it is a structural problem.',
    data: { campaigns, adGroups, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _performanceAnalystFormatData(d);
    },
  });
}

function _performanceAnalystFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  lines.push('Campaigns (top 30 by cost):');
  lines.push('id | name | status | channel | bidding | spend | conv | conv_value | CPA | ROAS | CTR | budget/day | search_IS | budget_lost_IS | rank_lost_IS');
  const top = d.campaigns
    .slice()
    .sort((a, b) => b.cost_micros - a.cost_micros)
    .slice(0, 30);
  for (const c of top) {
    const spend = AgentCommon.micros(c.cost_micros);
    const cpa   = c.conversions > 0 ? (spend / c.conversions).toFixed(2) : 'n/a';
    const roas  = c.cost_micros > 0 ? (c.conversion_value / AgentCommon.micros(c.cost_micros)).toFixed(2) : 'n/a';
    const budget = AgentCommon.micros(c.budget_micros);
    lines.push(
      `${c.campaign_id} | ${c.campaign_name} | ${c.status} | ${c.channel_type} | ${c.bidding_strategy} | ` +
      `${cur}${spend.toFixed(2)} | ${c.conversions} | ${cur}${(c.conversion_value || 0).toFixed(2)} | ` +
      `${cpa === 'n/a' ? 'n/a' : cur + cpa} | ${roas} | ${(c.ctr * 100).toFixed(2)}% | ${cur}${budget.toFixed(2)} | ` +
      `${(c.search_is * 100).toFixed(0)}% | ${(c.search_budget_lost_is * 100).toFixed(0)}% | ${(c.search_rank_lost_is * 100).toFixed(0)}%`
    );
  }

  // Optional ad-group context — only show ad groups in the top 5 campaigns.
  const topCampaignIds = new Set(top.slice(0, 5).map(c => c.campaign_id));
  const relevantAgs = d.adGroups
    .filter(ag => topCampaignIds.has(ag.campaign_id))
    .sort((a, b) => b.cost_micros - a.cost_micros)
    .slice(0, 30);
  if (relevantAgs.length) {
    lines.push('');
    lines.push('Ad groups in top-5-spending campaigns (top 30 by cost):');
    lines.push('id | name | campaign_id | spend | conv | conv_value');
    for (const ag of relevantAgs) {
      lines.push(
        `${ag.ad_group_id} | ${ag.ad_group_name} | ${ag.campaign_id} | ` +
        `${cur}${AgentCommon.micros(ag.cost_micros).toFixed(2)} | ${ag.conversions} | ` +
        `${cur}${(ag.conversion_value || 0).toFixed(2)}`
      );
    }
  }

  return lines.join('\n');
}

function testPerformanceAnalyst() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'PerformanceAnalyst dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runPerformanceAnalyst({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 120)}`);
  }
}
