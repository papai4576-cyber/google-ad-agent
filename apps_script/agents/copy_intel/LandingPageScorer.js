/**
 * LandingPageScorer.js — fetches the actual landing pages your ads point to
 * and scores them on quick-CRO signals.
 *
 * This is the first agent that does real-world I/O outside Google APIs:
 * it uses UrlFetchApp to GET each unique final URL and measures:
 *   - HTTP response code
 *   - Response time (proxy for page speed)
 *   - Response size (proxy for page weight)
 *   - Presence of basic conversion-critical elements (H1, form, CTA verbs)
 *   - Mobile viewport meta tag
 *
 * The findings flag pages that are slow, broken, or missing minimum elements.
 * These are the cheapest wins for CVR — the click already happened; bad LP
 * undoes everything upstream.
 *
 * Reads: Raw_Ads (for final_urls_json).
 * Brain categories queried: landing_page, copy.
 *
 * Caps: we score at most LP_MAX_PAGES pages per run (default 15) to stay
 * inside the 6-minute Apps Script execution window. URL fetches are sequential
 * with a small delay to be polite to the user's own servers.
 */

const LP_MAX_PAGES         = 15;
const LP_FETCH_TIMEOUT_MS  = 15000;   // per-page UrlFetchApp default ~60s; we cap via deadline
const LP_SLOW_RESPONSE_MS  = 2500;    // > 2.5s → flag as slow
const LP_HEAVY_BYTES       = 1500000; // > 1.5 MB → flag as heavy
const LP_USER_AGENT        = 'google-ads-agent-fleet/1.0 (LP scorer; UrlFetchApp)';

function runLandingPageScorer(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const ads = AgentCommon.readAds();
  if (ads.length === 0) {
    log_('agent', 'landing_page_scorer: no ads — skipping');
    return { agent: 'landing_page_scorer', findings: [], summary: 'No ad data.' };
  }

  // Collect unique URLs from top-impression ads (the URLs that matter most).
  const urlSet = new Set();
  const urlContexts = {};  // url → { ad_id, ad_group_id, campaign_id, impressions }
  ads
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .forEach(ad => {
      let urls = [];
      try { urls = JSON.parse(ad.final_urls_json || '[]'); } catch (_e) { urls = []; }
      for (const url of urls) {
        if (!url || typeof url !== 'string') continue;
        if (!url.startsWith('http')) continue;
        if (urlSet.has(url)) continue;
        urlSet.add(url);
        urlContexts[url] = {
          ad_id:        ad.ad_id,
          ad_group_id:  ad.ad_group_id,
          campaign_id:  ad.campaign_id,
          impressions:  ad.impressions,
        };
      }
    });

  const urls = Array.from(urlSet).slice(0, LP_MAX_PAGES);
  log_('agent', `landing_page_scorer: scoring ${urls.length} unique URLs`);

  const scores = [];
  for (const url of urls) {
    const ctx = urlContexts[url] || {};
    const score = _scorePage(url);
    scores.push(Object.assign({ url, ctx }, score));
  }

  return AgentCommon.runAgent({
    agentName:       'landing_page_scorer',
    mode:            mode,
    brainCategories: ['landing_page', 'copy', 'general'],
    brainLimit:      5,
    persona:
      'You are a Google Ads landing-page / CRO specialist. You read live ' +
      'page-scoring data (HTTP, speed, content checks) and identify the ' +
      'landing pages dragging down post-click conversion the most.',
    instructions:
      'Analyze the landing-page scores and surface up to 5 LANDING-PAGE ' +
      'findings. Focus:\n' +
      '  1. Broken pages: status_code != 200 → P1, urgent. ' +
      '     Even a temporary 5xx wastes every click that lands there.\n' +
      '  2. Slow pages: response_ms > ' + LP_SLOW_RESPONSE_MS + ' → P1/P2. ' +
      '     Each extra second costs ~7% of conversions per industry benchmarks.\n' +
      '  3. Heavy pages: response_bytes > ' + LP_HEAVY_BYTES + ' → P2/P3.\n' +
      '  4. Missing H1 / missing form / missing viewport meta → message-match / ' +
      '     mobile issues. Suggest a specific copy / structure fix.\n' +
      '  5. Pages with no CTA verb in detected text → recommend explicit CTAs.\n\n' +
      'Group findings by URL — one finding per problematic LP, list multiple ' +
      'issues inside one finding\'s evidence + action.\n' +
      'Use category="landing_page". target.type = "ad" (the ad pointing at it) ' +
      'or "campaign" if the URL is used across many ads.',
    data: { scores, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _landingPageScorerFormatData(d);
    },
  });
}

/* ===========================================================================
 * Per-page scoring — does the actual HTTP fetch + content checks.
 * ========================================================================= */
function _scorePage(url) {
  const start = Date.now();
  let resp = null;
  try {
    resp = UrlFetchApp.fetch(url, {
      method:             'get',
      followRedirects:    true,
      muteHttpExceptions: true,
      headers:            { 'User-Agent': LP_USER_AGENT },
      validateHttpsCertificates: true,
    });
  } catch (e) {
    return {
      status_code:    0,
      response_ms:    Date.now() - start,
      response_bytes: 0,
      has_h1:         false,
      has_form:       false,
      has_viewport:   false,
      has_cta_verb:   false,
      error:          String(e.message || e).slice(0, 200),
    };
  }
  const elapsed = Date.now() - start;
  const body    = resp.getContentText() || '';
  const bytes   = body.length;
  const lower   = body.toLowerCase();
  const ctaVerbs = ['shop', 'buy', 'get', 'start', 'sign up', 'book', 'order',
                    'subscribe', 'try', 'request', 'download', 'add to cart'];

  return {
    status_code:    resp.getResponseCode(),
    response_ms:    elapsed,
    response_bytes: bytes,
    has_h1:         /<h1[\s>]/i.test(body),
    has_form:       /<form[\s>]/i.test(body),
    has_viewport:   /<meta[^>]+name=["']?viewport/i.test(body),
    has_cta_verb:   ctaVerbs.some(v => lower.indexOf(v) !== -1),
    error:          null,
  };
}

function _landingPageScorerFormatData(d) {
  const lines = [];
  lines.push(`Landing page scores (${d.scores.length} URLs sampled, top by impressions):`);
  lines.push('url | status | response_ms | bytes | has_h1 | has_form | has_viewport | has_cta | impressions | ad_id');
  for (const s of d.scores) {
    lines.push(
      `${s.url} | ${s.status_code} | ${s.response_ms}ms | ${s.response_bytes} | ` +
      `${s.has_h1} | ${s.has_form} | ${s.has_viewport} | ${s.has_cta_verb} | ` +
      `${s.ctx.impressions} | ${s.ctx.ad_id}`
    );
    if (s.error) {
      lines.push(`  ERROR: ${s.error}`);
    }
  }
  return lines.join('\n');
}

function testLandingPageScorer() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'LandingPageScorer dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runLandingPageScorer({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 200)}`);
  }
}

/**
 * Convenience batch runner for ALL Phase 8 agents.
 */
function testAuditBatch3() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'Audit Batch 3 — 6 final agents in sequence');
  log_('test', '═══════════════════════════════════════════');
  const t0 = Date.now();

  const fns = [
    ['AccountStructureReviewer',  runAccountStructureReviewer],
    ['AudienceAnalyst',           runAudienceAnalyst],
    ['ExtensionAuditor',          runExtensionAuditor],
    ['CompetitiveIntel',          runCompetitiveIntel],
    ['CategoryTrendSpotter',      runCategoryTrendSpotter],
    ['LandingPageScorer',         runLandingPageScorer],
  ];

  let totalFindings = 0, totalTokens = 0;
  for (const [name, fn] of fns) {
    try {
      const r = fn({ mode: 'daily' });
      log_('test', `  [OK]   ${name.padEnd(32)} findings=${r.findings.length} tokens=${r.tokens || 0}`);
      totalFindings += r.findings.length;
      totalTokens   += r.tokens || 0;
    } catch (e) {
      log_('test', `  [FAIL] ${name.padEnd(32)} ${e.message || e}`);
    }
  }
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  log_('test', '');
  log_('test', `Batch complete: ${totalFindings} findings, ${totalTokens} tokens, ${seconds}s.`);
  log_('test', 'Check the Findings sheet for the new rows.');
}
