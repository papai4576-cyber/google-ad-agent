/**
 * AudienceAnalyst.js — audience layering opportunities. [RULE-BASED]
 *
 * Deterministic detection, LLM writes prose only. Zero candidates = no LLM call.
 * Rules are opportunity-based (we don't yet have Raw_Audiences) — they fire on
 * performance and structural signals that indicate missing audience layers.
 *
 * Tunable thresholds (Config sheet, RULE_* keys — defaults in parens):
 *   RULE_BRAND_ROAS_MULTIPLIER (3.0)  Brand ROAS must be this multiple of non-brand ROAS to flag gap
 *   RULE_RLSA_MIN_CLICKS       (300)  Min clicks on a search campaign to flag RLSA underutilization
 *   RULE_LOOKALIKE_MIN_CONV    (30)   Min conversions to flag lookalike seeding opportunity
 *   RULE_AUDIENCE_SHOP_SPEND   (5000) Min 30d spend on Shopping for Customer Match flag
 *
 * Reads: Raw_Campaigns + Raw_AdGroups.
 * Brain categories queried: audience, scaling.
 */

function runAudienceAnalyst(opts) {
  var mode = (opts && opts.mode) || 'daily';

  var campaigns = AgentCommon.readCampaigns();
  var adGroups  = AgentCommon.readAdGroups();
  if (campaigns.length === 0) {
    log_('agent', 'audience_analyst: no campaigns — skipping');
    return { agent: 'audience_analyst', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runRuleBasedAgent({
    agentName:       'audience_analyst',
    mode:            mode,
    brainCategories: ['audience', 'scaling', 'general'],
    brainLimit:      5,
    persona:
      'You are a Google Ads audience strategy specialist. ' +
      'You are a senior PPC analyst. Every finding must include a specific number from the data as evidence. ' +
      'Do not write generic recommendations. Explain exactly which audience type to add (RLSA, Customer Match, ' +
      'in-market segment) and in which mode (observation vs targeting).',
    instructions:
      'Translate each flagged audience gap into a specific, actionable recommendation. ' +
      'Include the evidence numbers. All findings use category="audience". target.type="campaign". ' +
      'Note that Raw_Audiences data is not yet collected — frame as observation-mode tests.',
    data:            { campaigns: campaigns, adGroups: adGroups, targets: AgentCommon.getTargets() },
    ruleConfig:      RulesEngine.load({
      BRAND_ROAS_MULTIPLIER: 3.0,
      RLSA_MIN_CLICKS:       300,
      LOOKALIKE_MIN_CONV:    30,
      AUDIENCE_SHOP_SPEND:   5000,
    }),
    detect:        _audienceDetect_,
    maxCandidates: 6,
    maxTokens:     2000,
  });
}

function _audienceDetect_(data, ctx) {
  var cfg  = ctx.cfg;
  var cur  = ctx.cur;
  var out  = [];

  // Brand-keyword heuristic: Config key BRAND_KEYWORDS (comma-separated).
  var brandRaw = String(getConfig('BRAND_KEYWORDS', '') || '');
  var brandKws = brandRaw.split(',').map(function(s) { return s.trim().toLowerCase(); })
                          .filter(function(s) { return s.length > 0; });

  function isBrand(name) {
    if (brandKws.length === 0) return false;
    var lc = String(name).toLowerCase();
    for (var b = 0; b < brandKws.length; b++) {
      if (lc.indexOf(brandKws[b]) >= 0) return true;
    }
    return false;
  }

  var brandCampaigns    = [];
  var nonBrandSearch    = [];
  var shoppingCampaigns = [];
  var allSearch         = [];

  for (var i = 0; i < data.campaigns.length; i++) {
    var c = data.campaigns[i];
    var ch = String(c.channel_type || '').toUpperCase();
    if (ch === 'SEARCH' || ch === 'SEARCH_STANDARD') {
      allSearch.push(c);
      if (isBrand(c.campaign_name)) brandCampaigns.push(c);
      else nonBrandSearch.push(c);
    }
    if (ch === 'SHOPPING' || ch === 'PERFORMANCE_MAX') {
      shoppingCampaigns.push(c);
    }
  }

  // 1. Brand/non-brand ROAS gap.
  if (brandCampaigns.length > 0 && nonBrandSearch.length > 0) {
    var brandSpend = 0, brandVal = 0, nbSpend = 0, nbVal = 0;
    for (var bi = 0; bi < brandCampaigns.length; bi++) {
      brandSpend += AgentCommon.micros(brandCampaigns[bi].cost_micros);
      brandVal   += Number(brandCampaigns[bi].conversion_value) || 0;
    }
    for (var ni = 0; ni < nonBrandSearch.length; ni++) {
      nbSpend += AgentCommon.micros(nonBrandSearch[ni].cost_micros);
      nbVal   += Number(nonBrandSearch[ni].conversion_value) || 0;
    }
    var brandRoas = brandSpend > 0 ? brandVal / brandSpend : 0;
    var nbRoas    = nbSpend    > 0 ? nbVal    / nbSpend    : 0;
    if (brandRoas > cfg.brand_roas_multiplier * nbRoas && nbRoas > 0) {
      out.push({
        id: 'brand-nonbrand-gap', category: 'audience',
        severity: 'P2', magnitude: 'high', confidence: 'medium', effort: 'medium',
        metric: 'ROAS', direction: 'up',
        target: { type: 'campaign', id: 'account', name: 'Account — brand vs non-brand' },
        hint: 'Brand ROAS ' + brandRoas.toFixed(1) + '× is ' + (brandRoas / nbRoas).toFixed(1) +
              '× above non-brand ROAS ' + nbRoas.toFixed(1) + '. Audience segmentation (RLSA past ' +
              'converters, Customer Match) on non-brand can close this gap.',
        evidence: [
          'brand ROAS ' + brandRoas.toFixed(2), 'non-brand ROAS ' + nbRoas.toFixed(2),
          'brand spend ' + cur + brandSpend.toFixed(0), 'non-brand spend ' + cur + nbSpend.toFixed(0),
        ],
      });
    }
  }

  // 2. RLSA underutilization: high-volume smart-bidding search campaigns.
  var smartBiddingPatterns = ['TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSIONS',
                              'MAXIMIZE_CONVERSION_VALUE', 'ENHANCED_CPC'];
  for (var si = 0; si < allSearch.length; si++) {
    var sc = allSearch[si];
    var clicks = Number(sc.clicks) || 0;
    var strat  = String(sc.bidding_strategy || '').toUpperCase();
    var isSmartBidding = smartBiddingPatterns.some(function(p) {
      return strat.indexOf(p) >= 0;
    });
    var nameHasRlsa = String(sc.campaign_name).toLowerCase().indexOf('rlsa') >= 0;
    if (clicks > cfg.rlsa_min_clicks && isSmartBidding && !nameHasRlsa) {
      out.push({
        id: 'rlsa-missing-' + sc.campaign_id, category: 'audience',
        severity: 'P2', magnitude: 'medium', confidence: 'medium', effort: 'easy',
        metric: 'ROAS', direction: 'up',
        target: { type: 'campaign', id: String(sc.campaign_id), name: sc.campaign_name },
        hint: 'High-volume search campaign (' + clicks + ' clicks) on smart bidding with no ' +
              'RLSA signals visible. Adding Past Visitors (30d) + Past Converters (540d) in ' +
              'observation mode gives the algorithm richer signals at no extra cost.',
        evidence: [
          'clicks ' + clicks, 'bidding ' + strat,
          'no RLSA in campaign name (heuristic)',
        ],
      });
    }
  }

  // 3. Lookalike / similar-audience seeding readiness.
  for (var li = 0; li < data.campaigns.length; li++) {
    var lc = data.campaigns[li];
    var lconv = Number(lc.conversions) || 0;
    var lclicks = Number(lc.clicks) || 0;
    var lcvr = lclicks > 0 ? lconv / lclicks : 0;
    if (lconv >= cfg.lookalike_min_conv && lcvr > 0.01) {
      out.push({
        id: 'lookalike-seed-' + lc.campaign_id, category: 'audience',
        severity: 'P3', magnitude: 'medium', confidence: 'medium', effort: 'easy',
        metric: 'conversions', direction: 'up',
        target: { type: 'campaign', id: String(lc.campaign_id), name: lc.campaign_name },
        hint: lconv + ' conversions at ' + (lcvr * 100).toFixed(1) + '% CVR — strong convertor ' +
              'list ready for seeding a Similar Audiences / lookalike list.',
        evidence: [
          'conversions ' + lconv, 'CVR ' + (lcvr * 100).toFixed(1) + '%',
          'clicks ' + lclicks,
        ],
      });
      break; // One lookalike recommendation per run is enough.
    }
  }

  // 4. Shopping / PMax without Customer Match signal.
  var shopSpend = shoppingCampaigns.reduce(function(s, c) {
    return s + AgentCommon.micros(c.cost_micros);
  }, 0);
  if (shoppingCampaigns.length > 0 && shopSpend >= cfg.audience_shop_spend) {
    var shopNames = shoppingCampaigns.map(function(c) { return c.campaign_name; }).join(', ');
    out.push({
      id: 'shopping-cm-missing', category: 'audience',
      severity: 'P2', magnitude: 'medium', confidence: 'low', effort: 'medium',
      metric: 'ROAS', direction: 'up',
      target: { type: 'campaign', id: 'shopping_pmax', name: 'Shopping / PMax campaigns' },
      hint: cur + shopSpend.toFixed(0) + ' spent on Shopping/PMax (' + shoppingCampaigns.length +
            ' campaigns). Adding Customer Match (CRM list) as an audience signal gives the bidder ' +
            'known high-intent users to optimise toward.',
      evidence: [
        shoppingCampaigns.length + ' Shopping/PMax campaigns',
        'combined spend ' + cur + shopSpend.toFixed(0),
        'campaigns: ' + shopNames.slice(0, 100),
      ],
    });
  }

  return out;
}

function testAudienceAnalyst() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'AudienceAnalyst dry run (rule-based)');
  log_('test', '═══════════════════════════════════════════');
  var r = runAudienceAnalyst({ mode: 'daily' });
  log_('test', 'Summary: ' + r.summary);
  log_('test', 'Findings: ' + r.findings.length + ', provider: ' + r.provider + ', tokens: ' + r.tokens + ', ' + r.run_time_ms + 'ms');
  for (var i = 0; i < Math.min(3, r.findings.length); i++) {
    var f = r.findings[i];
    log_('test', '  [' + f.severity + '] ' + f.title);
    log_('test', '    target: ' + f.target.type + ' ' + f.target.name + ' (' + f.target.id + ')');
    log_('test', '    action: ' + String(f.action || '').slice(0, 150));
  }
}
