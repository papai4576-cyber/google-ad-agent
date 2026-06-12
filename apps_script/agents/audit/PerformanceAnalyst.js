/**
 * PerformanceAnalyst.js — campaign-level performance issues. [RULE-BASED]
 *
 * Deterministic detection, LLM writes prose only. Zero candidates = no LLM call.
 *
 * Tunable thresholds (Config sheet, RULE_* keys — defaults in parens):
 *   RULE_CPA_OVERAGE_RATIO    (1.5)  CPA must exceed this multiple of TARGET_CPA to flag
 *   RULE_ROAS_SHORTFALL_RATIO (0.7)  ROAS must be below this fraction of TARGET_ROAS to flag
 *   RULE_PERF_SPEND_FLOOR     (5000) Min spend (account currency) for a 0-conv campaign to flag
 *   RULE_CTR_FLOOR_RATIO      (0.40) CTR below this fraction of channel median triggers flag
 *   RULE_PACING_TOLERANCE     (0.30) Monthly spend deviation ±30% triggers pacing flag
 *   RULE_CAPPED_UNDERPERF_IS  (0.20) Budget IS loss threshold for capped+underperforming rule
 *
 * Reads: Raw_Campaigns + Raw_AdGroups.
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

  return AgentCommon.runRuleBasedAgent({
    agentName:       'performance_analyst',
    mode:            mode,
    brainCategories: ['scaling', 'bidding', 'general'],
    brainLimit:      5,
    persona:
      'You are a senior Google Ads Performance Analyst with 10+ years of enterprise PPC experience. ' +
      'You are a senior PPC analyst. Every finding must include a specific number from the data as evidence. ' +
      'Do not write generic recommendations. If you cannot find evidence for a specific issue, return an empty findings array.',
    instructions:
      'Explain each flagged issue clearly. Include the specific numbers from evidence. ' +
      'Every recommendation must be concrete — no generic advice. Use category="performance" for ' +
      'CPA/ROAS/pacing issues, "bidding" if the root cause is bid strategy, "copy" for CTR issues.',
    data:            { campaigns, adGroups, targets: AgentCommon.getTargets() },
    ruleConfig:      RulesEngine.load({
      CPA_OVERAGE_RATIO:    1.5,
      ROAS_SHORTFALL_RATIO: 0.7,
      PERF_SPEND_FLOOR:     5000,
      CTR_FLOOR_RATIO:      0.40,
      PACING_TOLERANCE:     0.30,
      CAPPED_UNDERPERF_IS:  0.20,
    }),
    detect:        _perfDetect_,
    maxCandidates: 8,
    maxTokens:     2500,
  });
}

function _perfDetect_(data, ctx) {
  const cfg        = ctx.cfg;
  const cur        = ctx.cur;
  const targets    = ctx.targets;
  const out        = [];

  const targetCpa      = parseFloat(targets.TARGET_CPA)             || 0;
  const targetRoas     = parseFloat(targets.TARGET_ROAS)            || 0;
  const monthlyBudget  = parseFloat(targets.MONTHLY_BUDGET_TARGET)  || 0;
  const minConvForCpa  = parseFloat(getConfig('MIN_CONV_FOR_CPA', '5')) || 5;

  // Compute channel-type CTR medians for low-CTR rule.
  const channelCtrs = {};
  for (const c of data.campaigns) {
    const ch = String(c.channel_type || 'UNKNOWN');
    if (!channelCtrs[ch]) channelCtrs[ch] = [];
    channelCtrs[ch].push(Number(c.ctr) || 0);
  }
  const channelMedian = {};
  for (const ch of Object.keys(channelCtrs)) {
    const arr = channelCtrs[ch].slice().sort(function(a, b) { return a - b; });
    channelMedian[ch] = arr[Math.floor(arr.length / 2)];
  }

  // Account-level pacing: 30d total spend vs monthly budget target.
  if (monthlyBudget > 0) {
    const total30d = data.campaigns.reduce(function(s, c) {
      return s + AgentCommon.micros(c.cost_micros);
    }, 0);
    const ratio = total30d / monthlyBudget;
    if (ratio < (1 - cfg.pacing_tolerance) || ratio > (1 + cfg.pacing_tolerance)) {
      const dir = ratio < 1 ? 'under-pacing' : 'over-pacing';
      out.push({
        id: 'pacing-account', category: 'performance',
        severity: (ratio < 0.5 || ratio > 1.5) ? 'P1' : 'P2',
        magnitude: Math.abs(ratio - 1) > 0.4 ? 'high' : 'medium',
        confidence: 'high', effort: 'medium',
        metric: 'spend', direction: ratio < 1 ? 'up' : 'down',
        target: { type: 'campaign', id: 'account', name: 'Account (all campaigns)' },
        hint: 'Account is ' + dir + ': 30-day spend ' + cur + total30d.toFixed(0) +
              ' vs monthly target ' + cur + monthlyBudget.toFixed(0) + '.',
        evidence: [
          '30d spend ' + cur + total30d.toFixed(0),
          'monthly target ' + cur + monthlyBudget.toFixed(0),
          'ratio ' + (ratio * 100).toFixed(0) + '% of target',
        ],
      });
    }
  }

  for (var i = 0; i < data.campaigns.length; i++) {
    var c = data.campaigns[i];
    var spend    = AgentCommon.micros(c.cost_micros);
    var conv     = Number(c.conversions)       || 0;
    var convVal  = Number(c.conversion_value)  || 0;
    var ctr      = Number(c.ctr)               || 0;
    var impr     = Number(c.impressions)       || 0;
    var ch       = String(c.channel_type       || 'UNKNOWN');
    var tgt      = { type: 'campaign', id: String(c.campaign_id), name: c.campaign_name };
    var budgLost = Number(c.search_budget_lost_is) || 0;

    // 1. High spend, zero conversions.
    if (conv === 0 && spend >= cfg.perf_spend_floor) {
      out.push({
        id: 'zero-conv-' + c.campaign_id, category: 'performance',
        severity: spend >= cfg.perf_spend_floor * 3 ? 'P1' : 'P2',
        magnitude: spend >= cfg.perf_spend_floor * 3 ? 'high' : 'medium',
        confidence: 'high', effort: 'medium',
        metric: 'conversions', direction: 'up', target: tgt,
        hint: cur + spend.toFixed(0) + ' spent over the period with 0 conversions — ' +
              'check conversion tracking, landing page, or campaign targeting.',
        evidence: [
          'spend ' + cur + spend.toFixed(0), '0 conversions',
          'channel ' + c.channel_type, 'bidding ' + c.bidding_strategy,
        ],
      });
      continue; // CPA/ROAS undefined for zero-conv campaigns.
    }

    // 2. CPA overage.
    if (targetCpa > 0 && conv >= minConvForCpa) {
      var cpa = spend / conv;
      if (cpa > cfg.cpa_overage_ratio * targetCpa) {
        out.push({
          id: 'cpa-over-' + c.campaign_id, category: 'performance',
          severity: cpa > 2.5 * targetCpa ? 'P1' : 'P2',
          magnitude: cpa > 2.5 * targetCpa ? 'high' : 'medium',
          confidence: 'high', effort: 'medium',
          metric: 'CPA', direction: 'down', target: tgt,
          hint: 'CPA is ' + (cpa / targetCpa).toFixed(1) + '× above target (' +
                cur + cpa.toFixed(0) + ' vs target ' + cur + targetCpa.toFixed(0) + ').',
          evidence: [
            'spend ' + cur + spend.toFixed(0), 'conversions ' + conv,
            'actual CPA ' + cur + cpa.toFixed(0), 'target CPA ' + cur + targetCpa.toFixed(0),
          ],
        });
      }
    }

    // 3. ROAS shortfall.
    if (targetRoas > 0 && conv >= minConvForCpa && spend > 0) {
      var roas = convVal / spend;
      if (roas < cfg.roas_shortfall_ratio * targetRoas) {
        out.push({
          id: 'roas-low-' + c.campaign_id, category: 'performance',
          severity: roas < 0.4 * targetRoas ? 'P1' : 'P2',
          magnitude: roas < 0.4 * targetRoas ? 'high' : 'medium',
          confidence: 'high', effort: 'medium',
          metric: 'ROAS', direction: 'up', target: tgt,
          hint: 'ROAS is ' + roas.toFixed(2) + ' vs target ' + targetRoas.toFixed(2) +
                ' (' + (roas / targetRoas * 100).toFixed(0) + '% of target).',
          evidence: [
            'conv_value ' + cur + convVal.toFixed(0), 'spend ' + cur + spend.toFixed(0),
            'ROAS ' + roas.toFixed(2), 'target ROAS ' + targetRoas.toFixed(2),
          ],
        });
      }
    }

    // 4. Low CTR vs channel median (min 500 impressions for statistical relevance).
    var median = channelMedian[ch] || 0;
    if (median > 0 && ctr < cfg.ctr_floor_ratio * median && impr > 500) {
      out.push({
        id: 'low-ctr-' + c.campaign_id, category: 'copy',
        severity: 'P2', magnitude: 'medium', confidence: 'medium', effort: 'medium',
        metric: 'CTR', direction: 'up', target: tgt,
        hint: 'CTR ' + (ctr * 100).toFixed(2) + '% is below ' +
              (cfg.ctr_floor_ratio * 100).toFixed(0) + '% of ' + ch +
              ' channel median ' + (median * 100).toFixed(2) + '% — likely a copy or targeting issue.',
        evidence: [
          'ctr ' + (ctr * 100).toFixed(2) + '%',
          'channel median ' + (median * 100).toFixed(2) + '%',
          'impressions ' + impr, 'channel ' + ch,
        ],
      });
    }

    // 5. Budget-capped + underperforming ROAS ("more budget won't fix this").
    if (targetRoas > 0 && budgLost > cfg.capped_underperf_is && spend > 0 && conv >= minConvForCpa) {
      var roasHere = convVal / spend;
      if (roasHere < 0.8 * targetRoas) {
        out.push({
          id: 'capped-underperf-' + c.campaign_id, category: 'bidding',
          severity: 'P1', magnitude: 'high', confidence: 'medium', effort: 'hard',
          metric: 'ROAS', direction: 'up', target: tgt,
          hint: 'Budget-capped (' + (budgLost * 100).toFixed(0) + '% IS lost to budget) but ROAS ' +
                'is already below target — adding budget without fixing strategy will waste money.',
          evidence: [
            'search_budget_lost_is ' + (budgLost * 100).toFixed(0) + '%',
            'ROAS ' + roasHere.toFixed(2) + ' vs target ' + targetRoas.toFixed(2),
          ],
        });
      }
    }
  }

  return out;
}

function testPerformanceAnalyst() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'PerformanceAnalyst dry run (rule-based)');
  log_('test', '═══════════════════════════════════════════');
  var r = runPerformanceAnalyst({ mode: 'daily' });
  log_('test', 'Summary: ' + r.summary);
  log_('test', 'Findings: ' + r.findings.length + ', provider: ' + r.provider + ', tokens: ' + r.tokens + ', ' + r.run_time_ms + 'ms');
  for (var i = 0; i < Math.min(3, r.findings.length); i++) {
    var f = r.findings[i];
    log_('test', '  [' + f.severity + '] ' + f.title);
    log_('test', '    target: ' + f.target.type + ' ' + f.target.name + ' (' + f.target.id + ')');
    log_('test', '    action: ' + String(f.action || '').slice(0, 120));
  }
}
