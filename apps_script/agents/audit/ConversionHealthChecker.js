/**
 * ConversionHealthChecker.js — tracking & attribution problems.  [RULE-BASED]
 *
 * Detection is deterministic: spend-without-conversions, conversions-without-
 * value, and implausible conversion rates are all pure threshold checks. The
 * LLM only writes the human copy — no raw campaign table is sent.
 *
 * Tunable thresholds (Config, RULE_* — defaults in parens):
 *   RULE_CH_SPEND_NO_CONV    (50)    spend with 0 conv to flag a tracking gap
 *   RULE_CH_SPEND_NO_CONV_P1 (200)   spend with 0 conv that escalates to P1
 *   RULE_CH_HIGH_CVR         (0.30)  CVR above this is implausibly high
 *   RULE_CH_HIGH_CVR_CLICKS  (50)    min clicks before the high-CVR check
 *   RULE_CH_LOW_CVR          (0.005) CVR below this on a big spender is suspect
 *   RULE_CH_LOW_CVR_SPEND    (200)   spend above this for the low-CVR check
 *
 * Reads: Raw_Campaigns. Brain categories: general, scaling.
 */

function runConversionHealthChecker(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const campaigns = AgentCommon.readCampaigns();
  if (campaigns.length === 0) {
    log_('agent', 'conversion_health_checker: no campaigns — skipping');
    return { agent: 'conversion_health_checker', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runRuleBasedAgent({
    agentName:       'conversion_health_checker',
    mode:            mode,
    brainCategories: ['general', 'scaling'],
    brainLimit:      3,
    persona:
      'You are a Google Ads Conversion Tracking & Attribution specialist. You ' +
      'turn flagged data-integrity issues into concrete verification steps.',
    instructions:
      'Action items must be concrete and technical: name the likely fix — e.g. ' +
      '"verify the Google Tag fires the purchase goal on the order-confirmation URL", ' +
      '"pass dynamic value from the order total into the conversion tag".',
    data:            { campaigns: campaigns },
    ruleConfig:      RulesEngine.load({
      CH_SPEND_NO_CONV:    50,
      CH_SPEND_NO_CONV_P1: 200,
      CH_HIGH_CVR:         0.30,
      CH_HIGH_CVR_CLICKS:  50,
      CH_LOW_CVR:          0.005,
      CH_LOW_CVR_SPEND:    200,
    }),
    detect:          _conversionHealthDetect_,
    maxCandidates:   6,
    maxTokens:       2000,
  });
}

function _conversionHealthDetect_(data, ctx) {
  const cur = ctx.cur;
  const cfg = ctx.cfg;
  const out = [];

  for (const c of data.campaigns) {
    const spend  = AgentCommon.micros(c.cost_micros);
    const conv   = Number(c.conversions) || 0;
    const value  = Number(c.conversion_value) || 0;
    const clicks = Number(c.clicks) || 0;
    const strat  = String(c.bidding_strategy || '').toUpperCase();
    const tgt    = { type: 'campaign', id: String(c.campaign_id), name: c.campaign_name };

    // 1. Spend without conversions → tracking gap / wrong intent.
    if (spend > cfg.ch_spend_no_conv && conv === 0) {
      const big = spend > cfg.ch_spend_no_conv_p1;
      out.push({
        id: 'no-conv-' + c.campaign_id, category: 'performance',
        severity: big ? 'P1' : 'P2', magnitude: big ? 'high' : 'medium',
        confidence: 'medium', effort: 'medium', metric: 'conversions', direction: 'up', target: tgt,
        hint: 'Real spend with zero conversions — likely a tracking gap, wrong conversion ' +
              'goal, or wrong-intent traffic. Verify the conversion tag fires before touching bids.',
        evidence: ['spend ' + cur + spend.toFixed(0), '0 conversions', clicks + ' clicks', 'strategy ' + strat],
      });
    }

    // 2. Conversions without value.
    if (conv > 0 && value === 0) {
      const roas = strat.indexOf('ROAS') >= 0 || strat.indexOf('CONVERSION_VALUE') >= 0;
      out.push({
        id: 'no-value-' + c.campaign_id, category: 'performance',
        severity: roas ? 'P1' : 'P2', magnitude: roas ? 'high' : 'medium',
        confidence: 'high', effort: 'medium', metric: 'ROAS', direction: 'up', target: tgt,
        hint: roas
          ? 'Conversions tracked but with NO value, while this campaign bids on value ' +
            '(tROAS / Max Conversion Value) — smart bidding is flying blind. Configure ' +
            'dynamic conversion values urgently.'
          : 'Conversions tracked but with no value — ROAS reporting and value-based bidding ' +
            'are impossible until conversion values are passed to the tag.',
        evidence: [conv + ' conversions', 'conversion_value=0', 'strategy ' + strat],
      });
    }

    // 3. Implausibly high CVR → soft-event mis-tag.
    if (clicks > cfg.ch_high_cvr_clicks && (conv / clicks) > cfg.ch_high_cvr) {
      out.push({
        id: 'high-cvr-' + c.campaign_id, category: 'performance',
        severity: 'P2', magnitude: 'medium', confidence: 'medium', effort: 'easy',
        metric: 'conversions', direction: 'down', target: tgt,
        hint: 'Implausibly high conversion rate — the conversion action may be counting a ' +
              'soft event (page view / add-to-cart). Verify it only counts real conversions.',
        evidence: ['CVR ' + (conv / clicks * 100).toFixed(1) + '%', conv + ' conv / ' + clicks + ' clicks'],
      });
    }

    // 4. Big spender, near-zero CVR.
    if (spend > cfg.ch_low_cvr_spend && clicks > 0 && (conv / clicks) < cfg.ch_low_cvr) {
      out.push({
        id: 'low-cvr-' + c.campaign_id, category: 'performance',
        severity: 'P2', magnitude: 'medium', confidence: 'medium', effort: 'medium',
        metric: 'conversions', direction: 'up', target: tgt,
        hint: 'High spend but near-zero conversion rate — tracking may fire late or on the ' +
              'wrong goal, or the traffic intent is off. Verify tracking before optimising bids.',
        evidence: ['spend ' + cur + spend.toFixed(0), 'CVR ' + (conv / clicks * 100).toFixed(2) + '%',
                   conv + ' conv / ' + clicks + ' clicks'],
      });
    }
  }
  return out;
}

function testConversionHealthChecker() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'ConversionHealthChecker dry run (rule-based)');
  log_('test', '═══════════════════════════════════════════');
  const r = runConversionHealthChecker({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, provider: ${r.provider}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 120)}`);
  }
}

/**
 * Convenience runner for ALL Phase 6 agents. Use this when you want to verify
 * the batch end-to-end in one click.
 */
function testAuditBatch1() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'Audit Batch 1 — 4 agents in sequence');
  log_('test', '═══════════════════════════════════════════');
  const t0 = Date.now();

  const fns = [
    ['PerformanceAnalyst',       runPerformanceAnalyst],
    ['BidBudgetAnalyst',         runBidBudgetAnalyst],
    ['QualityScoreInspector',    runQualityScoreInspector],
    ['ConversionHealthChecker',  runConversionHealthChecker],
  ];

  let totalFindings = 0, totalTokens = 0;
  for (const [name, fn] of fns) {
    try {
      const r = fn({ mode: 'daily' });
      log_('test', `  [OK]   ${name.padEnd(28)} findings=${r.findings.length} tokens=${r.tokens}`);
      totalFindings += r.findings.length;
      totalTokens   += r.tokens || 0;
    } catch (e) {
      log_('test', `  [FAIL] ${name.padEnd(28)} ${e.message || e}`);
    }
  }
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  log_('test', '');
  log_('test', `Batch complete: ${totalFindings} findings, ${totalTokens} tokens, ${seconds}s.`);
  log_('test', 'Check the Findings sheet for the new rows.');
}
