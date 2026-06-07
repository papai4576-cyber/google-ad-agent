/**
 * AudienceAnalyst.js — surfaces audience layering opportunities.
 *
 * Domain: audience targeting (RLSA, Customer Match, in-market, affinity,
 * lookalikes). Identifies campaigns where layering audiences in
 * observation mode would unlock material lift, plus campaigns that are
 * over-targeted (audience exclusion bleeding past converting visitors).
 *
 * Reads: Raw_Campaigns + Raw_AdGroups.
 *
 * Note on data: we do not yet have Raw_Audiences (audience_view from the
 * Google Ads API). For now this agent inspects campaign mix and recommends
 * WHERE audience layering would pay off based on performance characteristics.
 * Once Raw_Audiences is added (planned via google_ads_script.js), findings
 * will become more concrete (specific RLSA lists, current bid modifiers).
 *
 * Brain categories queried: audience, scaling.
 */

function runAudienceAnalyst(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const campaigns = AgentCommon.readCampaigns();
  const adGroups  = AgentCommon.readAdGroups();
  if (campaigns.length === 0) {
    log_('agent', 'audience_analyst: no campaigns — skipping');
    return { agent: 'audience_analyst', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'audience_analyst',
    mode:            mode,
    brainCategories: ['audience', 'scaling', 'general'],
    brainLimit:      5,
    persona:
      'You are a Google Ads audience strategy specialist. You read campaign ' +
      'performance + structure and identify the specific audiences (RLSA, ' +
      'Customer Match, in-market, affinity, lookalikes) that would lift ' +
      'each campaign’s performance. You know when to add audiences in ' +
      'observation mode vs targeting mode.',
    instructions:
      'Analyze the campaign mix and surface up to 5 AUDIENCE findings. Focus:\n' +
      '  1. High-spend SEARCH campaigns on smart bidding (tCPA / tROAS / Max Conv) ' +
      '     with no audience layering observable → recommend adding 2-3 RLSA ' +
      '     observation audiences (Past Visitors 30d, Past Converters 540d, ' +
      '     Customer Match if available). Smart bidding will use the signal.\n' +
      '  2. SHOPPING / PMAX campaigns — recommend adding Customer Match + ' +
      '     similar audiences as signals.\n' +
      '  3. Display / Video campaigns with broad targeting — recommend tightening ' +
      '     with in-market segments matching the product category.\n' +
      '  4. Brand campaigns — recommend exclusion of past converters from ' +
      '     prospecting non-brand to avoid double-paying.\n\n' +
      'Findings are typically P2 / P3 — audience layering is an opportunity, ' +
      'not an emergency. Use category="audience". ' +
      'target.type = "campaign". Be honest about data limits — say "would need ' +
      'audience_view data to quantify exact uplift".',
    data: { campaigns, adGroups, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _audienceAnalystFormatData(d);
    },
  });
}

function _audienceAnalystFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  lines.push('Campaigns by channel + bidding (top 30 by spend):');
  lines.push('id | name | channel | bidding | spend | conv | conv_value | conv_rate | search_IS');
  const top = d.campaigns
    .slice()
    .sort((a, b) => b.cost_micros - a.cost_micros)
    .slice(0, 30);
  for (const c of top) {
    const spend = AgentCommon.micros(c.cost_micros);
    const cvr = c.clicks > 0 ? (c.conversions / c.clicks * 100).toFixed(2) + '%' : 'n/a';
    lines.push(
      `${c.campaign_id} | ${c.campaign_name} | ${c.channel_type} | ${c.bidding_strategy} | ` +
      `${cur}${spend.toFixed(2)} | ${c.conversions} | ${cur}${(c.conversion_value || 0).toFixed(2)} | ` +
      `${cvr} | ${(c.search_is * 100).toFixed(0)}%`
    );
  }

  // Channel-mix summary so the model sees the spread.
  const channelMix = {};
  for (const c of d.campaigns) {
    if (!channelMix[c.channel_type]) channelMix[c.channel_type] = { count: 0, spend: 0 };
    channelMix[c.channel_type].count++;
    channelMix[c.channel_type].spend += AgentCommon.micros(c.cost_micros);
  }
  lines.push('');
  lines.push('Channel mix:');
  for (const [ch, info] of Object.entries(channelMix)) {
    lines.push(`  ${ch}: ${info.count} campaigns, ${cur}${info.spend.toFixed(2)} total spend`);
  }

  lines.push('');
  lines.push('Note: Raw_Audiences (audience_view) is not yet collected; recommendations ' +
             'should be framed as observation-mode tests with expected directional uplift.');
  return lines.join('\n');
}

function testAudienceAnalyst() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'AudienceAnalyst dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runAudienceAnalyst({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 150)}`);
  }
}
