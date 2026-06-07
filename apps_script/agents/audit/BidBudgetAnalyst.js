/**
 * BidBudgetAnalyst.js — bid-strategy and budget issues.  [RULE-BASED]
 *
 * Detection is deterministic (see _bidBudgetDetect_), so the LLM never sees the
 * raw 144-campaign table or does any threshold arithmetic — it only writes the
 * human copy for the issues the rules already flagged. This cut the prompt from
 * ~5K tokens of tables to a compact candidate list, and makes severity stable.
 *
 * Tunable thresholds (Config sheet, RULE_* keys — defaults in parens):
 *   RULE_BUDGET_LOST_IS   (0.30) search budget-lost impression share to flag
 *   RULE_RANK_LOST_IS     (0.40) search rank-lost impression share to flag
 *   RULE_MIN_CONV_ROAS    (50)   min conversions before tROAS is trustworthy
 *   RULE_MIN_CONV_CPA     (30)   min conversions before tCPA is trustworthy
 *   RULE_IDLE_SPEND_RATIO (0.5)  spend/budget below this with no IS loss = idle
 *
 * Reads: Raw_Campaigns. Brain categories queried: bidding, scaling, structure.
 */

function runBidBudgetAnalyst(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const campaigns = AgentCommon.readCampaigns();
  if (campaigns.length === 0) {
    log_('agent', 'bid_budget_analyst: no campaigns — skipping');
    return { agent: 'bid_budget_analyst', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runRuleBasedAgent({
    agentName:       'bid_budget_analyst',
    mode:            mode,
    brainCategories: ['bidding', 'scaling', 'structure'],
    brainLimit:      5,
    persona:
      'You are a Google Ads Bidding & Budget specialist. You translate flagged ' +
      'bid-strategy and budget issues into clear, safe recommendations.',
    instructions:
      'Respect the safety rails from strategy: never recommend a single bid ' +
      'change >30% or a budget shift >20% per run. Prefer transitional bid ' +
      'strategies (Maximize Conversions / eCPC) when volume is too low for ' +
      'smart bidding.',
    data:            { campaigns: campaigns },
    ruleConfig:      RulesEngine.load({
      BUDGET_LOST_IS:   0.30,
      RANK_LOST_IS:     0.40,
      MIN_CONV_ROAS:    50,
      MIN_CONV_CPA:     30,
      IDLE_SPEND_RATIO: 0.5,
    }),
    detect:          _bidBudgetDetect_,
    maxCandidates:   8,
    maxTokens:       2200,
  });
}

/**
 * Deterministic detection. Returns candidate findings with all structured
 * fields set; the runner adds LLM-written prose. ctx = { targets, cur, cfg }.
 */
function _bidBudgetDetect_(data, ctx) {
  const cfg  = ctx.cfg;
  const cur  = ctx.cur;
  const out  = [];

  for (const c of data.campaigns) {
    const spend  = AgentCommon.micros(c.cost_micros);
    const budget = AgentCommon.micros(c.budget_micros);
    const conv   = Number(c.conversions) || 0;
    const strat  = String(c.bidding_strategy || '').toUpperCase();
    const tgt    = { type: 'campaign', id: String(c.campaign_id), name: c.campaign_name };

    const budgetLost = Number(c.search_budget_lost_is) || 0;
    const rankLost   = Number(c.search_rank_lost_is) || 0;

    // 1. Budget-capped growth.
    if (budgetLost > cfg.budget_lost_is) {
      out.push({
        id: 'budget-locked-' + c.campaign_id, category: 'performance',
        severity: 'P1', magnitude: 'high', confidence: 'high', effort: 'easy',
        metric: 'conversions', direction: 'up', target: tgt,
        hint: 'Budget-capped: losing impression share to a too-small daily budget. ' +
              'Recommend a budget increase capped at +20% this run.',
        evidence: [
          'search_budget_lost_is=' + (budgetLost * 100).toFixed(0) + '%',
          'budget ' + cur + budget.toFixed(0) + '/day, spend ' + cur + spend.toFixed(0),
          conv + ' conversions',
        ],
      });
    }

    // 2. Rank-capped (bids or QS too low).
    if (rankLost > cfg.rank_lost_is) {
      out.push({
        id: 'rank-locked-' + c.campaign_id, category: 'bidding',
        severity: 'P2', magnitude: 'medium', confidence: 'medium', effort: 'medium',
        metric: 'CPA', direction: 'down', target: tgt,
        hint: 'Rank-capped: bids and/or Quality Score too low to show competitively. ' +
              'Recommend a QS path, or a bid lift capped at +30% this run.',
        evidence: [
          'search_rank_lost_is=' + (rankLost * 100).toFixed(0) + '%',
          'strategy ' + strat, conv + ' conversions',
        ],
      });
    }

    // 3. Smart bidding on too little volume.
    const isRoas = strat.indexOf('ROAS') >= 0 || strat.indexOf('CONVERSION_VALUE') >= 0;
    const isCpa  = strat.indexOf('TARGET_CPA') >= 0;
    if (isRoas && conv < cfg.min_conv_roas) {
      out.push({
        id: 'thin-roas-' + c.campaign_id, category: 'bidding',
        severity: 'P2', magnitude: 'medium', confidence: 'high', effort: 'medium',
        metric: 'ROAS', direction: 'up', target: tgt,
        hint: 'tROAS with too few conversions to learn from. Recommend a transitional ' +
              'strategy (Maximize Conversions or eCPC) until volume builds.',
        evidence: [strat, conv + ' conv (<' + cfg.min_conv_roas + ' needed for tROAS)'],
      });
    } else if (isCpa && conv < cfg.min_conv_cpa) {
      out.push({
        id: 'thin-cpa-' + c.campaign_id, category: 'bidding',
        severity: 'P2', magnitude: 'medium', confidence: 'high', effort: 'medium',
        metric: 'CPA', direction: 'down', target: tgt,
        hint: 'tCPA with too few conversions to learn from. Recommend a transitional ' +
              'strategy (Maximize Conversions or eCPC) until volume builds.',
        evidence: [strat, conv + ' conv (<' + cfg.min_conv_cpa + ' needed for tCPA)'],
      });
    }

    // 4. Mature campaign still on Maximize Conversions → graduate to tCPA.
    if (strat.indexOf('MAXIMIZE_CONVERSIONS') >= 0 && conv >= cfg.min_conv_cpa) {
      const cpa = conv > 0 ? spend / conv : 0;
      out.push({
        id: 'graduate-tcpa-' + c.campaign_id, category: 'bidding',
        severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'easy',
        metric: 'CPA', direction: 'down', target: tgt,
        hint: 'Enough conversion history to graduate from Maximize Conversions to ' +
              'Target CPA set near the recent average CPA.',
        evidence: [conv + ' conversions', 'recent CPA ~' + cur + cpa.toFixed(0)],
      });
    }

    // 5. Manual CPC with real conversion history.
    if (strat.indexOf('MANUAL') >= 0 && conv > cfg.min_conv_cpa) {
      out.push({
        id: 'manual-to-smart-' + c.campaign_id, category: 'bidding',
        severity: 'P2', magnitude: 'medium', confidence: 'medium', effort: 'easy',
        metric: 'CPA', direction: 'down', target: tgt,
        hint: 'Manual CPC despite a useful conversion history. Recommend eCPC or tCPA ' +
              'to let smart bidding optimise.',
        evidence: [strat, conv + ' conversions'],
      });
    }

    // 6. Idle / over-allocated budget.
    if (budget > 0 && spend < cfg.idle_spend_ratio * budget && budgetLost < 0.05 && conv > 0) {
      out.push({
        id: 'idle-budget-' + c.campaign_id, category: 'performance',
        severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'medium',
        metric: 'spend', direction: 'down', target: tgt,
        hint: 'Spending well below its daily budget with no impression-share loss — ' +
              'budget could be reallocated to capacity-constrained campaigns.',
        evidence: [
          'spend ' + cur + spend.toFixed(0) + ' of ' + cur + budget.toFixed(0) + ' budget',
          'budget_lost_is=' + (budgetLost * 100).toFixed(0) + '%',
        ],
      });
    }
  }

  return out;
}

function testBidBudgetAnalyst() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'BidBudgetAnalyst dry run (rule-based)');
  log_('test', '═══════════════════════════════════════════');
  const r = runBidBudgetAnalyst({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, provider: ${r.provider}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 120)}`);
  }
}
