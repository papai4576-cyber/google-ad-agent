/**
 * ConversionHealthChecker.js — surfaces tracking and attribution problems.
 *
 * Domain: is the conversion data we use to optimise actually reliable?
 * Flags:
 *   - Campaigns with >$50 cost AND 0 conversions across full window → likely
 *     tracking gap, wrong conversion goal selected, or wrong intent.
 *   - Campaigns with conversions > 0 but conversion_value = 0 → value tracking
 *     not configured; smart bidding on ROAS is impossible.
 *   - Campaigns where avg_cpc looks insanely high vs benchmark — often a sign
 *     of broken negatives or wrong match types creating phantom conversions.
 *   - Click-to-conversion ratio outliers (e.g. some campaigns at 30%+ CVR
 *     while others at <0.5%) — suggests mis-tagged conversion actions.
 *
 * Reads: Raw_Campaigns + Raw_Ads (for ad-level conversion sanity).
 * Brain categories queried: general, performance.
 */

function runConversionHealthChecker(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const campaigns = AgentCommon.readCampaigns();
  const ads       = AgentCommon.readAds();
  if (campaigns.length === 0) {
    log_('agent', 'conversion_health_checker: no campaigns — skipping');
    return { agent: 'conversion_health_checker', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'conversion_health_checker',
    mode:            mode,
    brainCategories: ['general', 'scaling'],
    brainLimit:      4,
    persona:
      'You are a Google Ads Conversion Tracking & Attribution specialist. ' +
      'You spend most of your day verifying that the conversion data feeding ' +
      'smart bidding is actually clean. You catch broken pixels, missing ' +
      'values, and mis-tagged goals before they cost the advertiser real money.',
    instructions:
      'Analyze conversion data integrity and surface up to 6 findings. Focus:\n' +
      '  1. Spend without conversions: cost > $50 AND conversions = 0  → ' +
      '     tracking gap or wrong-intent campaign. P1 if cost > $200.\n' +
      '  2. Conversions without value: conversions > 0 AND conversion_value = 0 → ' +
      '     value tracking not configured; smart bidding on ROAS is impossible. ' +
      '     P1 if bidding_strategy is target_roas or maximize_conversion_value.\n' +
      '  3. Suspiciously high CVR: clicks > 50 AND conversions/clicks > 0.30 → ' +
      '     mis-tagged conversion (counting page views?). Flag for investigation.\n' +
      '  4. Suspiciously low CVR on big spenders: cost > $200 AND ' +
      '     conversions/clicks < 0.005 → tracking firing late or wrong goal.\n' +
      '  5. Outlier value-per-conversion (one campaign 10× the rest) — possible ' +
      '     stale value passed to gtag/GA.\n\n' +
      'Use category="performance" for these (tracking sits in the performance bucket ' +
      'in our taxonomy).\n' +
      'Action items must be concrete: "verify Google Tag Manager fires goal X on ' +
      "URL pattern Y\", \"ensure dynamic value is passed from the order confirmation\".",
    data: { campaigns, ads, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _conversionHealthFormatData(d);
    },
  });
}

function _conversionHealthFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  // Hard caps to stay under Groq's free-tier per-request TPM ceiling (12K tokens).
  // 40 campaigns × ~110 tokens/row ≈ 4400 input tokens for campaign data,
  // leaving ample headroom for system prompt + brain context + ad section.
  const MAX_CAMPAIGNS = 40;
  const MAX_ADS = 12;

  // Pre-filter: only campaigns where there's anything worth checking — either
  // spend ≥ 50 (low-conv signal) OR conversions > 0 (value/CVR sanity).
  const interesting = d.campaigns.filter(c =>
    AgentCommon.micros(c.cost_micros) >= 50 || c.conversions > 0
  );
  const sorted = interesting.sort((a, b) => b.cost_micros - a.cost_micros);
  const top    = sorted.slice(0, MAX_CAMPAIGNS);

  lines.push(`Campaigns with spend ≥ ${cur}50 OR conversions > 0 ` +
             `(showing top ${top.length} by spend, of ${interesting.length} interesting):`);
  lines.push('id | name | bidding | spend | clicks | conv | conv_value | CVR | val/conv | avg_cpc');
  for (const c of top) {
    const spend = AgentCommon.micros(c.cost_micros);
    const cvr   = c.clicks > 0 ? (c.conversions / c.clicks * 100).toFixed(2) + '%' : 'n/a';
    const vpc   = c.conversions > 0 ? cur + (c.conversion_value / c.conversions).toFixed(2) : 'n/a';
    const cpc   = AgentCommon.micros(c.avg_cpc_micros).toFixed(2);
    lines.push(
      `${c.campaign_id} | ${c.campaign_name} | ${c.bidding_strategy} | ` +
      `${cur}${spend.toFixed(2)} | ${c.clicks} | ${c.conversions} | ${cur}${(c.conversion_value || 0).toFixed(2)} | ` +
      `${cvr} | ${vpc} | ${cur}${cpc}`
    );
  }

  // Trimmed ad-level cross-check: only top spenders in top-3 campaigns.
  if (d.ads && d.ads.length) {
    const topIds = new Set(top.slice(0, 3).map(c => c.campaign_id));
    const topAds = d.ads.filter(a => topIds.has(a.campaign_id))
                        .sort((a, b) => b.cost_micros - a.cost_micros)
                        .slice(0, MAX_ADS);
    if (topAds.length) {
      lines.push('');
      lines.push(`Top ${topAds.length} ads in top-3-spending campaigns:`);
      lines.push('ad_id | campaign_id | clicks | conv | spend');
      for (const a of topAds) {
        lines.push(
          `${a.ad_id} | ${a.campaign_id} | ${a.clicks} | ${a.conversions} | ` +
          `${cur}${AgentCommon.micros(a.cost_micros).toFixed(2)}`
        );
      }
    }
  }
  return lines.join('\n');
}

function testConversionHealthChecker() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'ConversionHealthChecker dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runConversionHealthChecker({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
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
