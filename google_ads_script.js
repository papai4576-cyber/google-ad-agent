/**
 * google_ads_script.js — v2 ingest architecture
 * ---------------------------------------------------------------------------
 * Runs INSIDE the Google Ads UI (Tools & Settings → Bulk Actions → Scripts).
 * NOT to be confused with Google Apps Script — this is a separate runtime
 * with its own auth, scheduler, and built-in `AdsApp` API.
 *
 * This script:
 *   1. Fetches all account data into in-memory arrays.
 *   2. POSTs the full payload as JSON to the Next.js /api/ingest route
 *      (Bearer-token auth), which writes the raw snapshot tables in Postgres.
 *
 * Why this architecture: Google Ads Scripts in a Workspace tenant often can't
 * authorize direct Sheet/Drive access (Workspace blocks unverified OAuth).
 * Plain HTTPS calls to a public API route have no such restriction.
 *
 * ---------------------------------------------------------------------------
 * Two modes:
 *   collect  → fetch + POST to /api/ingest
 *   execute  → polls /api/pending-changes, applies mutations via AdsApp,
 *              reports back to /api/execute-result
 *
 * ---------------------------------------------------------------------------
 * Setup (one-time):
 *   1. Set APPS_SCRIPT_WEBHOOK_URL to <your Vercel deployment>/api/ingest
 *   2. Set INGEST_SECRET to match the INGEST_SECRET env var on Vercel
 *   3. Save → Authorize → Preview → Run
 *
 *   Permissions granted on first run: external URL fetch only (no Sheets,
 *   no Drive).
 * ---------------------------------------------------------------------------
 */

const CONFIG = {
  APPS_SCRIPT_WEBHOOK_URL: 'https://web-seven-rho-96.vercel.app/api/ingest',
  INGEST_SECRET:           '873f1fe208b9a445b34ecad0aaf0650931b7da98cc9d91e6',

  MODE:         'collect',  // 'collect' | 'execute'
  COLLECT_MODE: 'daily',    // 'daily' (LAST_30_DAYS) | 'weekly' (LAST_90_DAYS)

  DATE_RANGES: {
    daily:  'LAST_30_DAYS',
    weekly: 'LAST_90_DAYS',
  },

  // Caps to keep payload size reasonable and execution well under 30 minutes.
  LIMITS: {
    keywords:     5000,
    ads:          500,
    search_terms: 2000,
    extensions:   1000,
  },
};

/* ===========================================================================
 * ENTRY POINT — Google Ads Scripts call main() automatically.
 * ========================================================================= */
function main() {
  log_('═════════════════════════════════════════════');
  log_(`Google Ads Agent Fleet — ${CONFIG.MODE} mode`);
  log_(`Customer: ${AdsApp.currentAccount().getCustomerId()}`);
  log_('═════════════════════════════════════════════');

  if (!CONFIG.APPS_SCRIPT_WEBHOOK_URL || CONFIG.APPS_SCRIPT_WEBHOOK_URL.indexOf('PASTE') === 0) {
    throw new Error(
      'APPS_SCRIPT_WEBHOOK_URL is not set. Point it at <your Vercel deployment>/api/ingest.'
    );
  }
  if (!CONFIG.INGEST_SECRET || CONFIG.INGEST_SECRET.indexOf('PASTE') === 0) {
    throw new Error(
      'INGEST_SECRET is not set. It must match the INGEST_SECRET env var configured on Vercel.'
    );
  }

  switch (CONFIG.MODE) {
    case 'collect': return runCollect_();
    case 'execute': return runExecute_();
    default:
      throw new Error(`Unknown MODE: ${CONFIG.MODE}. Use 'collect' or 'execute'.`);
  }
}

/* ===========================================================================
 * COLLECT MODE — fetch everything into memory, POST to ingest webhook.
 * ========================================================================= */
function runCollect_() {
  const dateRange = CONFIG.DATE_RANGES[CONFIG.COLLECT_MODE] || CONFIG.DATE_RANGES.daily;
  const runDate = todayString_();

  log_(`Date range: ${dateRange}, run_date: ${runDate}`);
  log_('');

  const data = {};
  const results = [];

  results.push(collect_(data, 'Raw_Campaigns',        () => fetchCampaigns_(runDate, dateRange)));
  results.push(collect_(data, 'Raw_Campaigns_Daily',  () => fetchCampaignsDaily_(runDate)));
  results.push(collect_(data, 'Raw_AdGroups',         () => fetchAdGroups_(runDate, dateRange)));
  results.push(collect_(data, 'Raw_Keywords',         () => fetchKeywords_(runDate, dateRange)));
  results.push(collect_(data, 'Raw_Ads',              () => fetchAds_(runDate, dateRange)));
  results.push(collect_(data, 'Raw_SearchTerms',      () => fetchSearchTerms_(runDate, dateRange)));
  results.push(collect_(data, 'Raw_Extensions',       () => fetchExtensions_(runDate, dateRange)));
  results.push(collect_(data, 'Raw_NegativeKeywords', () => fetchNegativeKeywords_(runDate)));

  log_('');
  log_('═════════════════════════════════════════════');
  log_('Collection summary:');
  let allOk = true;
  for (const r of results) {
    const mark = r.ok ? 'OK  ' : 'FAIL';
    log_(`  [${mark}] ${pad_(r.label, 16)} ${r.detail}`);
    allOk = allOk && r.ok;
  }
  log_('═════════════════════════════════════════════');

  if (!allOk) {
    throw new Error('Collection had failures — see log above. Fix and re-run.');
  }

  // POST everything to Apps Script.
  log_('');
  log_('Posting to Apps Script ingest endpoint…');
  const postResult = postToAppsScript_({
    source:     'google_ads_script',
    secret:     CONFIG.INGEST_SECRET,
    customer:   AdsApp.currentAccount().getCustomerId(),
    mode:       CONFIG.COLLECT_MODE,
    run_date:   runDate,
    date_range: dateRange,
    data:       data,
  });
  log_(`Ingest response: ${postResult}`);
  log_('');
  log_('Done.');
}

/* ===========================================================================
 * INDIVIDUAL FETCHERS — return arrays of row-objects.
 * Each fetcher returns an array of { col1, col2, ... } objects that the
 * Apps Script ingest endpoint maps to the corresponding Raw_* tab.
 * ========================================================================= */

function fetchCampaigns_(runDate, dateRange) {
  const query = `
    SELECT
      campaign.id, campaign.name, campaign.status,
      campaign.advertising_channel_type, campaign.bidding_strategy_type,
      campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
      campaign_budget.amount_micros,
      metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.conversions_value,
      metrics.ctr, metrics.average_cpc,
      metrics.search_impression_share,
      metrics.search_budget_lost_impression_share,
      metrics.search_rank_lost_impression_share
    FROM campaign
    WHERE segments.date DURING ${dateRange}
      AND campaign.status = 'ENABLED'
    ORDER BY metrics.cost_micros DESC
  `;
  const rows = [];
  const iter = AdsApp.report(query).rows();
  while (iter.hasNext()) {
    const r = iter.next();
    rows.push({
      run_date:               runDate,
      campaign_id:            rs_(r, 'campaign.id'),
      campaign_name:          rs_(r, 'campaign.name'),
      status:                 rs_(r, 'campaign.status'),
      channel_type:           rs_(r, 'campaign.advertising_channel_type'),
      bidding_strategy:       rs_(r, 'campaign.bidding_strategy_type'),
      target_cpa_micros:      rn_(r, 'campaign.target_cpa.target_cpa_micros'),
      target_roas:            rn_(r, 'campaign.target_roas.target_roas'),
      budget_micros:          rn_(r, 'campaign_budget.amount_micros'),
      impressions:            rn_(r, 'metrics.impressions'),
      clicks:                 rn_(r, 'metrics.clicks'),
      cost_micros:            rn_(r, 'metrics.cost_micros'),
      conversions:            rn_(r, 'metrics.conversions'),
      conversion_value:       rn_(r, 'metrics.conversions_value'),
      ctr:                    rn_(r, 'metrics.ctr'),
      avg_cpc_micros:         rn_(r, 'metrics.average_cpc'),
      search_is:              rn_(r, 'metrics.search_impression_share'),
      search_budget_lost_is:  rn_(r, 'metrics.search_budget_lost_impression_share'),
      search_rank_lost_is:    rn_(r, 'metrics.search_rank_lost_impression_share'),
    });
  }
  return rows;
}

function fetchCampaignsDaily_(runDate) {
  // Per-campaign-per-DAY metrics for the trailing 30 days, regardless of
  // COLLECT_MODE. The dashboard derives 7d / 30d / this-month windows and
  // period-over-period trends by summing the relevant day rows — so one
  // segmented query replaces three window-specific queries.
  const query = `
    SELECT
      campaign.id, campaign.name, segments.date,
      metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status = 'ENABLED'
    ORDER BY segments.date DESC
  `;
  const rows = [];
  const iter = AdsApp.report(query).rows();
  while (iter.hasNext()) {
    const r = iter.next();
    rows.push({
      run_date:         runDate,
      date:             rs_(r, 'segments.date'),
      campaign_id:      rs_(r, 'campaign.id'),
      campaign_name:    rs_(r, 'campaign.name'),
      impressions:      rn_(r, 'metrics.impressions'),
      clicks:           rn_(r, 'metrics.clicks'),
      cost_micros:      rn_(r, 'metrics.cost_micros'),
      conversions:      rn_(r, 'metrics.conversions'),
      conversion_value: rn_(r, 'metrics.conversions_value'),
    });
  }
  return rows;
}

function fetchAdGroups_(runDate, dateRange) {
  // GAQL note: ad_group has no `campaign_id` column — instead, query
  // `campaign.id` directly. GAQL auto-joins the parent campaign for you.
  const query = `
    SELECT
      ad_group.id, ad_group.name, ad_group.status,
      campaign.id,
      ad_group.cpc_bid_micros, ad_group.target_cpa_micros,
      metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.conversions_value
    FROM ad_group
    WHERE segments.date DURING ${dateRange}
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
    ORDER BY metrics.cost_micros DESC
  `;
  const rows = [];
  const iter = AdsApp.report(query).rows();
  while (iter.hasNext()) {
    const r = iter.next();
    rows.push({
      run_date:           runDate,
      ad_group_id:        rs_(r, 'ad_group.id'),
      ad_group_name:      rs_(r, 'ad_group.name'),
      status:             rs_(r, 'ad_group.status'),
      campaign_id:        rs_(r, 'campaign.id'),
      cpc_bid_micros:     rn_(r, 'ad_group.cpc_bid_micros'),
      target_cpa_micros:  rn_(r, 'ad_group.target_cpa_micros'),
      impressions:        rn_(r, 'metrics.impressions'),
      clicks:             rn_(r, 'metrics.clicks'),
      cost_micros:        rn_(r, 'metrics.cost_micros'),
      conversions:        rn_(r, 'metrics.conversions'),
      conversion_value:   rn_(r, 'metrics.conversions_value'),
      avg_quality_score:  '',   // not available at ad-group level; computed by agents
    });
  }
  return rows;
}

function fetchKeywords_(runDate, dateRange) {
  const query = `
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
      ad_group_criterion.status, ad_group_criterion.cpc_bid_micros,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.post_click_quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr,
      ad_group.id, ad_group.name,
      campaign.id, campaign.name,
      metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.conversions_value,
      metrics.ctr, metrics.average_cpc
    FROM keyword_view
    WHERE segments.date DURING ${dateRange}
      AND ad_group_criterion.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
      AND metrics.impressions > 0
    ORDER BY metrics.cost_micros DESC
    LIMIT ${CONFIG.LIMITS.keywords}
  `;
  const rows = [];
  const iter = AdsApp.report(query).rows();
  while (iter.hasNext()) {
    const r = iter.next();
    rows.push({
      run_date:              runDate,
      keyword_id:            rs_(r, 'ad_group_criterion.criterion_id'),
      text:                  rs_(r, 'ad_group_criterion.keyword.text'),
      match_type:            rs_(r, 'ad_group_criterion.keyword.match_type'),
      status:                rs_(r, 'ad_group_criterion.status'),
      campaign_id:           rs_(r, 'campaign.id'),
      campaign_name:         rs_(r, 'campaign.name'),
      ad_group_id:           rs_(r, 'ad_group.id'),
      ad_group_name:         rs_(r, 'ad_group.name'),
      cpc_bid_micros:        rn_(r, 'ad_group_criterion.cpc_bid_micros'),
      quality_score:         rn_(r, 'ad_group_criterion.quality_info.quality_score'),
      creative_quality:      rs_(r, 'ad_group_criterion.quality_info.creative_quality_score'),
      post_click_quality:    rs_(r, 'ad_group_criterion.quality_info.post_click_quality_score'),
      search_predicted_ctr:  rs_(r, 'ad_group_criterion.quality_info.search_predicted_ctr'),
      impressions:           rn_(r, 'metrics.impressions'),
      clicks:                rn_(r, 'metrics.clicks'),
      cost_micros:           rn_(r, 'metrics.cost_micros'),
      conversions:           rn_(r, 'metrics.conversions'),
      conversion_value:      rn_(r, 'metrics.conversions_value'),
      ctr:                   rn_(r, 'metrics.ctr'),
      avg_cpc_micros:        rn_(r, 'metrics.average_cpc'),
    });
  }
  return rows;
}

function fetchAds_(runDate, dateRange) {
  // RSAs have nested headlines/descriptions; use selector iteration.
  const adsIter = AdsApp.ads()
    .withCondition("Status = 'ENABLED'")
    .withCondition("AdGroupStatus = 'ENABLED'")
    .withCondition("CampaignStatus = 'ENABLED'")
    .withCondition("Type = 'RESPONSIVE_SEARCH_AD'")
    .orderBy('metrics.impressions DESC')
    .forDateRange(dateRange)
    .withLimit(CONFIG.LIMITS.ads)
    .get();

  const rows = [];
  while (adsIter.hasNext()) {
    const ad = adsIter.next();
    let headlines = [];
    let descriptions = [];
    try {
      const rsa = ad.asType().responsiveSearchAd();
      headlines    = rsa.getHeadlines().map(function (h) { return h.text(); });
      descriptions = rsa.getDescriptions().map(function (d) { return d.text(); });
    } catch (e) { /* non-RSA subtype — skip */ }
    const stats   = ad.getStatsFor(dateRange);
    const adGroup = ad.getAdGroup();
    const campaign = adGroup.getCampaign();
    rows.push({
      run_date:         runDate,
      ad_id:            String(ad.getId()),
      status:           ad.isEnabled() ? 'ENABLED' : 'PAUSED',
      approval_status:  ad.getPolicyApprovalStatus ? String(ad.getPolicyApprovalStatus() || '') : '',
      ad_group_id:      String(adGroup.getId()),
      ad_group_name:    adGroup.getName(),
      campaign_id:      String(campaign.getId()),
      headlines_json:   JSON.stringify(headlines),
      descriptions_json: JSON.stringify(descriptions),
      final_urls_json:  JSON.stringify(ad.urls().getFinalUrl() ? [ad.urls().getFinalUrl()] : []),
      impressions:      stats.getImpressions(),
      clicks:           stats.getClicks(),
      cost_micros:      Math.round(stats.getCost() * 1e6),
      conversions:      stats.getConversions(),
      ctr:              stats.getCtr(),
      avg_cpc_micros:   Math.round(stats.getAverageCpc() * 1e6),
    });
  }
  return rows;
}

function fetchSearchTerms_(runDate, dateRange) {
  const query = `
    SELECT
      search_term_view.search_term, search_term_view.status,
      campaign.id, campaign.name, ad_group.id, ad_group.name,
      metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.ctr, metrics.average_cpc
    FROM search_term_view
    WHERE segments.date DURING ${dateRange}
      AND metrics.impressions > 0
      AND campaign.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
    ORDER BY metrics.cost_micros DESC
    LIMIT ${CONFIG.LIMITS.search_terms}
  `;
  const rows = [];
  const iter = AdsApp.report(query).rows();
  while (iter.hasNext()) {
    const r = iter.next();
    rows.push({
      run_date:        runDate,
      term:            rs_(r, 'search_term_view.search_term'),
      status:          rs_(r, 'search_term_view.status'),
      campaign_id:     rs_(r, 'campaign.id'),
      campaign_name:   rs_(r, 'campaign.name'),
      ad_group_id:     rs_(r, 'ad_group.id'),
      ad_group_name:   rs_(r, 'ad_group.name'),
      impressions:     rn_(r, 'metrics.impressions'),
      clicks:          rn_(r, 'metrics.clicks'),
      cost_micros:     rn_(r, 'metrics.cost_micros'),
      conversions:     rn_(r, 'metrics.conversions'),
      ctr:             rn_(r, 'metrics.ctr'),
      avg_cpc_micros:  rn_(r, 'metrics.average_cpc'),
    });
  }
  return rows;
}

function fetchExtensions_(runDate, dateRange) {
  const query = `
    SELECT
      campaign.id, campaign.status,
      asset.id, asset.type, asset.name,
      asset.sitelink_asset.link_text,
      asset.callout_asset.callout_text,
      asset.structured_snippet_asset.header,
      campaign_asset.status,
      metrics.impressions, metrics.clicks, metrics.ctr
    FROM campaign_asset
    WHERE segments.date DURING ${dateRange}
      AND campaign_asset.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
      AND asset.type IN ('SITELINK','CALLOUT','STRUCTURED_SNIPPET','PROMOTION','CALL','PRICE')
    LIMIT ${CONFIG.LIMITS.extensions}
  `;
  const rows = [];
  const iter = AdsApp.report(query).rows();
  while (iter.hasNext()) {
    const r = iter.next();
    const type = rs_(r, 'asset.type');
    let text = '';
    if      (type === 'SITELINK')           text = rs_(r, 'asset.sitelink_asset.link_text');
    else if (type === 'CALLOUT')            text = rs_(r, 'asset.callout_asset.callout_text');
    else if (type === 'STRUCTURED_SNIPPET') text = rs_(r, 'asset.structured_snippet_asset.header');
    else                                    text = rs_(r, 'asset.name');
    rows.push({
      run_date:      runDate,
      extension_id:  rs_(r, 'asset.id'),
      type:          type,
      campaign_id:   rs_(r, 'campaign.id'),
      ad_group_id:   '',
      text:          text,
      status:        rs_(r, 'campaign_asset.status'),
      impressions:   rn_(r, 'metrics.impressions'),
      clicks:        rn_(r, 'metrics.clicks'),
      ctr:           rn_(r, 'metrics.ctr'),
    });
  }
  return rows;
}

/* ===========================================================================
 * Negative keywords — three sources rolled into one tab:
 *   1. ad_group_criterion where .negative = TRUE
 *   2. campaign_criterion where .negative = TRUE AND .type = KEYWORD
 *   3. shared_criterion (shared negative lists) attached to active campaigns
 *
 * No metrics — negatives have no performance data. We just need their text
 * so NegativeKwHunter can stop recommending things you already block.
 * ========================================================================= */
function fetchNegativeKeywords_(runDate) {
  const rows = [];

  // 1. Ad-group-level negatives.
  try {
    const q1 = `
      SELECT
        ad_group.id, ad_group.name,
        campaign.id, campaign.name,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type
      FROM ad_group_criterion
      WHERE ad_group_criterion.negative = TRUE
        AND ad_group_criterion.type = 'KEYWORD'
        AND ad_group.status = 'ENABLED'
        AND campaign.status = 'ENABLED'
      LIMIT 10000
    `;
    const it = AdsApp.report(q1).rows();
    while (it.hasNext()) {
      const r = it.next();
      rows.push({
        run_date:         runDate,
        scope:            'ad_group',
        campaign_id:      rs_(r, 'campaign.id'),
        campaign_name:    rs_(r, 'campaign.name'),
        ad_group_id:      rs_(r, 'ad_group.id'),
        ad_group_name:    rs_(r, 'ad_group.name'),
        shared_set_id:    '',
        shared_set_name:  '',
        text:             rs_(r, 'ad_group_criterion.keyword.text'),
        match_type:       rs_(r, 'ad_group_criterion.keyword.match_type'),
      });
    }
  } catch (e) {
    log_(`fetchNegativeKeywords: ad-group query failed: ${e.message || e}`);
  }

  // 2. Campaign-level negatives.
  try {
    const q2 = `
      SELECT
        campaign.id, campaign.name,
        campaign_criterion.keyword.text,
        campaign_criterion.keyword.match_type
      FROM campaign_criterion
      WHERE campaign_criterion.negative = TRUE
        AND campaign_criterion.type = 'KEYWORD'
        AND campaign.status = 'ENABLED'
      LIMIT 10000
    `;
    const it = AdsApp.report(q2).rows();
    while (it.hasNext()) {
      const r = it.next();
      rows.push({
        run_date:         runDate,
        scope:            'campaign',
        campaign_id:      rs_(r, 'campaign.id'),
        campaign_name:    rs_(r, 'campaign.name'),
        ad_group_id:      '',
        ad_group_name:    '',
        shared_set_id:    '',
        shared_set_name:  '',
        text:             rs_(r, 'campaign_criterion.keyword.text'),
        match_type:       rs_(r, 'campaign_criterion.keyword.match_type'),
      });
    }
  } catch (e) {
    log_(`fetchNegativeKeywords: campaign query failed: ${e.message || e}`);
  }

  // 3. Shared negative lists. Use the selector API — much easier than GAQL
  //    for shared_set + shared_criterion joins.
  try {
    const setIter = AdsApp.negativeKeywordLists().get();
    while (setIter.hasNext()) {
      const set = setIter.next();
      const setId = String(set.getId());
      const setName = set.getName();
      const kwIter = set.negativeKeywords().get();
      while (kwIter.hasNext()) {
        const kw = kwIter.next();
        rows.push({
          run_date:         runDate,
          scope:            'shared',
          campaign_id:      '',
          campaign_name:    '',
          ad_group_id:      '',
          ad_group_name:    '',
          shared_set_id:    setId,
          shared_set_name:  setName,
          text:             kw.getText(),
          match_type:       String(kw.getMatchType() || ''),
        });
      }
    }
  } catch (e) {
    log_(`fetchNegativeKeywords: shared lists failed: ${e.message || e}`);
  }

  return rows;
}

/* ===========================================================================
 * EXECUTE MODE — Phase 12 placeholder.
 * ========================================================================= */
/* ===========================================================================
 * EXECUTE MODE (Phase H) — pull the approved-change queue from
 * /api/pending-changes, apply each via AdsApp, and report results back to
 * /api/execute-result for the change_log.
 *
 * Safety: the API only queues a change (status='queued') when its config
 * DRY_RUN=false (and only after the dashboard Approvals gate). So anything we
 * pull here is human-approved and rail-validated. We still wrap every change
 * in its own try/catch so one failure never blocks the rest.
 * ========================================================================= */
function runExecute_() {
  log_('Execute mode — polling /api/pending-changes…');

  const url = _apiUrl_('pending-changes') + '?secret=' + encodeURIComponent(CONFIG.INGEST_SECRET);
  const resp = UrlFetchApp.fetch(url, { method: 'get', followRedirects: true, muteHttpExceptions: true });
  let parsed;
  try { parsed = JSON.parse(resp.getContentText()); }
  catch (e) { throw new Error('Bad queue response: ' + resp.getContentText().slice(0, 300)); }
  if (!parsed.ok) throw new Error('Queue error: ' + (parsed.error || 'unknown'));

  const changes = parsed.changes || [];
  log_(`Pulled ${changes.length} queued change(s).`);
  if (changes.length === 0) { log_('Nothing to execute.'); return; }

  const results = [];
  for (const ch of changes) {
    try {
      applyChange_(ch);
      results.push({ change_id: ch.change_id, success: true });
      log_(`  [OK]   ${ch.change_type} ${ch.target_type} ${ch.target_id} (${ch.before_value} → ${ch.after_value})`);
    } catch (e) {
      results.push({ change_id: ch.change_id, success: false, error: String(e.message || e).slice(0, 300) });
      log_(`  [FAIL] ${ch.change_type} ${ch.target_id}: ${e.message || e}`);
    }
  }

  // Report results back so the API updates pending_changes + change_log.
  const post = UrlFetchApp.fetch(_apiUrl_('execute-result'), {
    method: 'post', contentType: 'application/json', followRedirects: true, muteHttpExceptions: true,
    payload: JSON.stringify({
      secret: CONFIG.INGEST_SECRET, run_date: todayString_(), results: results,
    }),
  });
  log_(`Reported ${results.length} result(s): ${post.getContentText().slice(0, 200)}`);
}

/** Build a sibling API URL from APPS_SCRIPT_WEBHOOK_URL (…/api/ingest -> …/api/<name>). */
function _apiUrl_(name) {
  return CONFIG.APPS_SCRIPT_WEBHOOK_URL.replace(/\/api\/[^/?]+\/?$/, '/api/' + name);
}

function applyChange_(ch) {
  if (ch.change_type === 'add_negative') {
    const term = ch.params && ch.params.term;
    if (!term) throw new Error('missing term');
    const text = '"' + String(term).trim() + '"';   // phrase match
    if (ch.target_type === 'adgroup') {
      const ag = adGroupById_(ch.target_id);
      if (!ag) throw new Error('ad group ' + ch.target_id + ' not found');
      ag.createNegativeKeyword(text);
    } else {
      const c = campaignById_(ch.target_id);
      if (!c) throw new Error('campaign ' + ch.target_id + ' not found');
      c.createNegativeKeyword(text);
    }
    return;
  }
  if (ch.change_type === 'adjust_budget') {
    const c = campaignById_(ch.target_id);
    if (!c) throw new Error('campaign ' + ch.target_id + ' not found');
    const amount = parseFloat(ch.after_value);
    if (!(amount > 0)) throw new Error('bad budget amount ' + ch.after_value);
    c.getBudget().setAmount(amount);   // account-currency units
    return;
  }
  throw new Error('unsupported change_type ' + ch.change_type);
}

function campaignById_(id) {
  const it = AdsApp.campaigns().withIds([String(id)]).get();
  return it.hasNext() ? it.next() : null;
}
function adGroupById_(id) {
  const it = AdsApp.adGroups().withIds([String(id)]).get();
  return it.hasNext() ? it.next() : null;
}

/* ===========================================================================
 * INGEST API CALL
 * ========================================================================= */
function postToAppsScript_(payload) {
  const resp = UrlFetchApp.fetch(CONFIG.APPS_SCRIPT_WEBHOOK_URL, {
    method:             'post',
    contentType:        'application/json',
    headers:            { Authorization: 'Bearer ' + CONFIG.INGEST_SECRET },
    payload:            JSON.stringify(payload),
    followRedirects:    true,
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error(`Ingest API returned HTTP ${code}: ${body.slice(0, 400)}`);
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed.ok === false) {
      throw new Error(`Ingest failed: ${parsed.error || body.slice(0, 400)}`);
    }
    const summary = parsed.written
      ? Object.keys(parsed.written).map(k => `${k}=${parsed.written[k]}`).join(', ')
      : '(no row-count returned)';
    return `HTTP 200 — ${summary}`;
  } catch (e) {
    // Non-JSON response — likely an HTML error page.
    return `HTTP ${code} but non-JSON body: ${body.slice(0, 200)}`;
  }
}

/* ===========================================================================
 * GAQL ROW HELPERS
 * ========================================================================= */
function rs_(row, key) {
  const v = row[key];
  if (v === undefined || v === null) return '';
  return String(v);
}
function rn_(row, key) {
  const v = row[key];
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/* ===========================================================================
 * SMALL UTILITIES
 * ========================================================================= */
function todayString_() {
  const d  = new Date();
  const y  = d.getFullYear();
  const m  = pad2_(d.getMonth() + 1);
  const dd = pad2_(d.getDate());
  return `${y}-${m}-${dd}`;
}
function pad2_(n) { return n < 10 ? '0' + n : String(n); }
function pad_(s, len) { while (s.length < len) s = s + ' '; return s; }
function log_(msg) { Logger.log(msg); }

function safe_(fn, label) {
  try { return { ok: true, label, detail: String(fn()) || 'ok' }; }
  catch (e) { return { ok: false, label, detail: `${e.name || 'Error'}: ${String(e.message || e).slice(0, 300)}` }; }
}

/**
 * Wrap a fetcher call: store its array in `data[tabName]` and produce a
 * status row whose `detail` is the row count (NOT the array, which prints
 * as [object Object] noise).
 */
function collect_(data, tabName, fn) {
  try {
    const rows = fn();
    data[tabName] = rows;
    return { ok: true, label: tabName, detail: `${rows.length} rows` };
  } catch (e) {
    return {
      ok: false,
      label: tabName,
      detail: `${e.name || 'Error'}: ${String(e.message || e).slice(0, 300)}`,
    };
  }
}
