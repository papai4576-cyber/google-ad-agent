/**
 * ContentHunter.js — weekly scan of high-quality PPC industry blogs via RSS.
 *
 * Why RSS instead of Reddit: Reddit blocks unauthenticated requests from
 * cloud IPs (Apps Script runs on Google Cloud), and Reddit's data-access
 * approval is a multi-week process for personal scripts. RSS feeds are
 * public, no-auth, and reachable from cloud IPs. The content is also
 * higher signal-to-noise — pro authors instead of random posters.
 *
 * For each configured feed, fetch the last week of items, filter for
 * Google Ads / PPC relevance, dedup against existing Brain entries by URL,
 * then use Groq to extract structured metadata. Surviving entries land in
 * the Brain sheet with source_type='rss'.
 *
 * After indexing, build a digest of the top 5 newly-added insights and
 * post to Slack via SLACK_WEBHOOK_URL — or just log it if Slack isn't
 * wired yet (the webhook URL becomes available in Phase 11).
 *
 * Schedule: weekly, Sunday morning. Install via setupContentWeeklyTrigger().
 *
 * Config (Config sheet):
 *   CONTENT_FEEDS_JSON   JSON array of {name, url} feed entries (optional —
 *                        defaults to DEFAULT_FEEDS below if absent/blank)
 *   CONTENT_LOOKBACK_DAYS  how many days of items to consider (default 7)
 */

/* ===========================================================================
 * Constants
 * ========================================================================= */

const CONTENT_USER_AGENT = 'google-ads-agent-fleet/1.0 (apps-script content hunter)';
const CONTENT_FETCH_TIMEOUT_MS = 20000;
const CONTENT_PROCESS_CAP = 25;       // max NEW items to LLM-extract per run
const CONTENT_MIN_BODY_CHARS = 200;

const DEFAULT_FEEDS = [
  { name: 'PPC Hero',                   url: 'https://www.ppchero.com/feed/' },
  { name: 'Search Engine Land (PPC)',   url: 'https://searchengineland.com/library/channel/ppc/feed' },
  { name: 'Search Engine Journal (PPC)', url: 'https://www.searchenginejournal.com/category/pay-per-click/feed/' },
  { name: 'WordStream Blog',            url: 'https://www.wordstream.com/blog/feed' },
];

// Same strategy keyword universe RedditHunter used. Used to filter Search
// Engine Land's general feed (and any non-PPC content that slips in).
const CONTENT_STRATEGY_TERMS = [
  'google ads', 'adwords', 'ppc', 'sem', 'paid search', 'paid media',
  'roas', 'cpa', 'troas', 'tcpa', 'cpc', 'bid', 'bidding', 'budget',
  'campaign', 'ad group', 'keyword', 'negative', 'search term',
  'rsa', 'responsive search ad', 'pmax', 'performance max',
  'quality score', 'impression share', 'audience', 'rlsa', 'remarketing',
  'customer match', 'lookalike', 'dayparting', 'attribution',
  'conversion', 'landing page', 'cro',
  'scaling', 'scale', 'structure', 'optimization', 'optimisation',
];

// Content:encoded RSS namespace (used by WordPress-style feeds).
const RSS_NS_CONTENT = XmlService.getNamespace('content', 'http://purl.org/rss/1.0/modules/content/');

/* ===========================================================================
 * Public entry points
 * ========================================================================= */

function refreshContentIntel() {
  log_('content', '═══════════════════════════════════════════');
  log_('content', 'ContentHunter starting');
  log_('content', '═══════════════════════════════════════════');

  const feeds   = getFeeds_();
  const lookbackDays = parseInt(getConfig('CONTENT_LOOKBACK_DAYS', '7'), 10) || 7;
  const cutoff  = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
  log_('content', `Feeds (${feeds.length}): ${feeds.map(f => f.name).join(', ')}`);
  log_('content', `Lookback: ${lookbackDays} days (cutoff ${new Date(cutoff).toISOString()})`);

  const existing = BrainStore.existingSources();
  log_('content', `Brain currently has: ${existing.size} entries`);

  // 1. Fetch + pre-filter all feeds.
  let candidates = [];
  for (const feed of feeds) {
    try {
      const items = fetchFeed_(feed);
      const recent = items.filter(it => it.pubDateMs && it.pubDateMs >= cutoff);
      const relevant = recent.filter(isRelevantItem_);
      log_('content', `  ${feed.name}: ${items.length} items, ` +
                      `${recent.length} in window, ${relevant.length} PPC-relevant`);
      candidates = candidates.concat(relevant.map(it => Object.assign(it, { feedName: feed.name })));
    } catch (e) {
      log_('content', `  ${feed.name}: FAIL ${e.message || e}`);
    }
  }

  // 2. Dedup against Brain (by article URL).
  const fresh = candidates.filter(it => !existing.has(it.url));
  log_('content', `Candidates after dedup: ${fresh.length} (of ${candidates.length})`);

  if (fresh.length === 0) {
    log_('content', 'No new PPC articles this window. Done.');
    return { processed: 0, added: 0, skipped_low_confidence: 0, failed: 0, digest_posted: false };
  }

  // Newest first, then cap.
  const toProcess = fresh
    .sort((a, b) => b.pubDateMs - a.pubDateMs)
    .slice(0, CONTENT_PROCESS_CAP);
  log_('content', `Processing newest ${toProcess.length} (cap=${CONTENT_PROCESS_CAP})`);

  // 3. LLM extract + write to Brain.
  let added = 0, lowConf = 0, failed = 0;
  const addedEntries = [];
  for (const item of toProcess) {
    log_('content', `── ${item.feedName} · ${item.title.slice(0, 90)}`);
    try {
      const meta = extractContentMetadata_(item);
      if (meta.confidence === 'low') {
        log_('content', `   SKIP: confidence=low ("${meta.title}")`);
        lowConf++;
        continue;
      }
      const id = BrainStore.add({
        category:    meta.category,
        source:      item.url,
        source_type: 'rss',
        title:       meta.title || item.title.slice(0, 200),
        summary:     meta.summary,
        key_points:  meta.key_points,
        raw_text:    (item.body || '').slice(0, 2000),
      });
      log_('content', `   OK   → ${id} (${meta.category}, ${meta.confidence})`);
      addedEntries.push({ id, meta, item });
      added++;
    } catch (e) {
      log_('content', `   FAIL: ${e.name || 'Error'}: ${String(e.message || e).slice(0, 200)}`);
      failed++;
    }
  }

  // 4. Build + post digest (top 5 newest of the added).
  let digestPosted = false;
  if (addedEntries.length > 0) {
    const digest = buildContentDigest_(addedEntries.slice(0, 5));
    log_('content', '');
    log_('content', '─── Digest preview ───');
    for (const line of digest.plainText.split('\n')) log_('content', line);
    log_('content', '──────────────────────');

    const webhook = PROPS.get('SLACK_WEBHOOK_URL');
    if (webhook) {
      try {
        postContentDigestToSlack_(webhook, digest);
        log_('content', 'Digest posted to Slack.');
        digestPosted = true;
      } catch (e) {
        log_('content', `Slack post failed: ${e.message || e}`);
      }
    } else {
      log_('content', 'SLACK_WEBHOOK_URL not set — digest only logged. (Wired in Phase 11.)');
    }
  }

  log_('content', '');
  log_('content', `Done. added=${added}, skipped_low_confidence=${lowConf}, ` +
                  `failed=${failed}, digest_posted=${digestPosted}`);
  return { processed: toProcess.length, added, skipped_low_confidence: lowConf, failed, digest_posted: digestPosted };
}

/**
 * Install a weekly trigger that runs refreshContentIntel every Sunday at
 * Config.DAILY_RUN_HOUR (default 3 AM). Idempotent.
 */
function setupContentWeeklyTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'refreshContentIntel') {
      ScriptApp.deleteTrigger(t);
    }
  }
  const hour = Math.max(0, Math.min(23, parseInt(getConfig('DAILY_RUN_HOUR', '3'), 10) || 3));
  ScriptApp.newTrigger('refreshContentIntel')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(hour)
    .create();
  log_('content', `Weekly trigger installed: refreshContentIntel Sundays at ${hour}:00.`);
}

/* ===========================================================================
 * Feed configuration
 * ========================================================================= */

function getFeeds_() {
  const raw = String(getConfig('CONTENT_FEEDS_JSON', '') || '').trim();
  if (!raw) return DEFAULT_FEEDS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      log_('content', 'CONTENT_FEEDS_JSON parsed but is not a non-empty array; using defaults.');
      return DEFAULT_FEEDS;
    }
    const cleaned = parsed
      .filter(f => f && typeof f.url === 'string' && f.url.startsWith('http'))
      .map(f => ({ name: String(f.name || f.url), url: String(f.url) }));
    return cleaned.length ? cleaned : DEFAULT_FEEDS;
  } catch (e) {
    log_('content', `CONTENT_FEEDS_JSON invalid JSON; using defaults. (${e.message})`);
    return DEFAULT_FEEDS;
  }
}

/* ===========================================================================
 * Fetch + parse RSS
 * ========================================================================= */

function fetchFeed_(feed) {
  const resp = UrlFetchApp.fetch(feed.url, {
    method:             'get',
    headers:            { 'User-Agent': CONTENT_USER_AGENT, Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
    muteHttpExceptions: true,
    followRedirects:    true,
  });
  const code = resp.getResponseCode();
  if (code !== 200) {
    throw new Error(`HTTP ${code}: ${resp.getContentText().slice(0, 200)}`);
  }
  return parseRss_(resp.getContentText());
}

function parseRss_(xmlText) {
  const doc = XmlService.parse(xmlText);
  const root = doc.getRootElement();

  // RSS 2.0:   <rss><channel><item>...</item></channel></rss>
  // Atom 1.0:  <feed><entry>...</entry></feed>
  // Support both.

  if (root.getName().toLowerCase() === 'rss') {
    const channel = root.getChild('channel');
    if (!channel) return [];
    return channel.getChildren('item').map(parseRssItem_);
  }
  if (root.getName().toLowerCase() === 'feed') {
    return root.getChildren('entry', root.getNamespace()).map(parseAtomEntry_);
  }
  return [];
}

function parseRssItem_(item) {
  const title       = textOf_(item.getChild('title'));
  const link        = textOf_(item.getChild('link')) || textOf_(item.getChild('guid'));
  const description = textOf_(item.getChild('description'));
  let body = '';
  try {
    body = textOf_(item.getChild('encoded', RSS_NS_CONTENT)) || description;
  } catch (_e) { body = description; }
  const pubDate     = textOf_(item.getChild('pubDate'));

  return {
    title:     stripHtml_(title),
    url:       (link || '').trim(),
    body:      stripHtml_(body),
    pubDate:   pubDate,
    pubDateMs: pubDate ? Date.parse(pubDate) : 0,
  };
}

function parseAtomEntry_(entry) {
  const ns = entry.getNamespace();
  const title = textOf_(entry.getChild('title', ns));
  // Atom <link> is an element with href attribute.
  let link = '';
  const linkEl = entry.getChild('link', ns);
  if (linkEl) link = linkEl.getAttribute('href') ? linkEl.getAttribute('href').getValue() : textOf_(linkEl);
  const summary = textOf_(entry.getChild('summary', ns));
  const content = textOf_(entry.getChild('content', ns));
  const updated = textOf_(entry.getChild('updated', ns)) || textOf_(entry.getChild('published', ns));

  return {
    title:     stripHtml_(title),
    url:       (link || '').trim(),
    body:      stripHtml_(content || summary || ''),
    pubDate:   updated,
    pubDateMs: updated ? Date.parse(updated) : 0,
  };
}

function textOf_(el) {
  if (!el) return '';
  try { return String(el.getText() || '').trim(); }
  catch (_e) { return ''; }
}

function stripHtml_(s) {
  if (!s) return '';
  return String(s)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isRelevantItem_(item) {
  if ((item.body || '').length < CONTENT_MIN_BODY_CHARS && (item.title || '').length < 30) {
    return false;
  }
  const hay = ((item.title || '') + ' ' + (item.body || '')).toLowerCase();
  return CONTENT_STRATEGY_TERMS.some(t => hay.includes(t));
}

/* ===========================================================================
 * LLM metadata extraction
 * ========================================================================= */

function extractContentMetadata_(item) {
  const categories = VALID.brain_categories;

  const systemPrompt =
    'You are extracting actionable Google Ads strategy insights from a PPC ' +
    'industry blog post. The post may be tactical, news-y, or vendor-fluff. ' +
    'Judge honestly. Output STRICT JSON with this EXACT shape:\n' +
    '{\n' +
    '  "category":    "ONE of: ' + categories.join(', ') + '",\n' +
    '  "title":       "short descriptive title, max 100 chars",\n' +
    '  "summary":     "2-3 sentences capturing the takeaway, max 400 chars",\n' +
    '  "key_points":  ["3-5 specific actionable insights, max 200 chars each"],\n' +
    '  "confidence":  "high | medium | low"\n' +
    '}\n\n' +
    'Confidence guide:\n' +
    '  high   = contains specific tactics, numbers, or frameworks worth ' +
              'adding to a strategy knowledge base\n' +
    '  medium = useful directional insight, even if anecdotal\n' +
    '  low    = vendor fluff, news without tactics, vague advice — exclude\n\n' +
    'Use a specific category whenever possible. Use "general" only if it ' +
    'truly does not fit any other category.\n' +
    'Return ONLY the JSON object. No prose, no markdown fences.';

  const userPrompt =
    `Source: ${item.feedName}\n` +
    `Title: ${item.title}\n\n` +
    `--- ARTICLE BODY (truncated) ---\n` +
    (item.body || '').slice(0, 8000);

  const result = callLLM(systemPrompt, userPrompt, {
    label:       'content_hunter',
    temperature: 0.2,
    max_tokens:  700,
  });

  const j = result.json || {};
  return {
    category:   sanitizeContentCategory_(j.category, categories),
    title:      String(j.title || item.title).slice(0, 200),
    summary:    String(j.summary || '').slice(0, 600),
    key_points: Array.isArray(j.key_points)
                  ? j.key_points.map(p => String(p).slice(0, 300)).filter(Boolean).slice(0, 5)
                  : [],
    confidence: ['high', 'medium', 'low'].includes(j.confidence) ? j.confidence : 'low',
  };
}

function sanitizeContentCategory_(raw, allowed) {
  const c = String(raw || '').toLowerCase().trim();
  return allowed.includes(c) ? c : 'general';
}

/* ===========================================================================
 * Digest formatting + Slack post
 * ========================================================================= */

function buildContentDigest_(entries) {
  const week = todayString_();
  const lines = [`*PPC Strategy Digest — week of ${week}*`, ''];
  const blocks = [{
    type: 'header',
    text: { type: 'plain_text', text: `PPC Strategy Digest — week of ${week}` },
  }];

  entries.forEach((e, i) => {
    const num = i + 1;
    const cat = e.meta.category;
    const conf = e.meta.confidence;
    const src = e.item.feedName;
    const url = e.item.url;

    lines.push(`${num}. [${cat} · ${conf} · ${src}] ${e.meta.title}`);
    lines.push(`   ${e.meta.summary}`);
    if (e.meta.key_points.length) {
      for (const kp of e.meta.key_points) lines.push(`   • ${kp}`);
    }
    lines.push(`   ${url}`);
    lines.push('');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${num}. <${url}|${e.meta.title}>*\n` +
          `_${cat} · ${conf} confidence · ${src}_\n` +
          e.meta.summary +
          (e.meta.key_points.length
            ? '\n• ' + e.meta.key_points.join('\n• ')
            : ''),
      },
    });
    blocks.push({ type: 'divider' });
  });

  return {
    plainText:  lines.join('\n'),
    slackBlocks: blocks,
  };
}

function postContentDigestToSlack_(webhookUrl, digest) {
  const payload = {
    text:   digest.plainText,
    blocks: digest.slackBlocks,
  };
  const resp = UrlFetchApp.fetch(webhookUrl, {
    method:             'post',
    contentType:        'application/json',
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`Slack returned HTTP ${code}: ${resp.getContentText().slice(0, 200)}`);
  }
}

/* ===========================================================================
 * MANUAL TESTS
 * ========================================================================= */

/**
 * Tiny diagnostic — hit each configured feed and report counts. No LLM,
 * no Brain writes. Use this first when setting up Phase 5.
 */
function testContentFetch() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'ContentHunter feed diagnostic (no LLM)');
  log_('test', '═══════════════════════════════════════════');

  const feeds = getFeeds_();
  const lookbackDays = parseInt(getConfig('CONTENT_LOOKBACK_DAYS', '7'), 10) || 7;
  const cutoff = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);

  let totalItems = 0, totalRecent = 0, totalRelevant = 0;
  for (const feed of feeds) {
    try {
      const items = fetchFeed_(feed);
      const recent = items.filter(it => it.pubDateMs && it.pubDateMs >= cutoff);
      const relevant = recent.filter(isRelevantItem_);
      totalItems    += items.length;
      totalRecent   += recent.length;
      totalRelevant += relevant.length;
      log_('test', `${feed.name}: items=${items.length} ` +
                   `recent(${lookbackDays}d)=${recent.length} relevant=${relevant.length}`);
      for (const it of relevant.slice(0, 3)) {
        const date = it.pubDateMs ? new Date(it.pubDateMs).toISOString().slice(0, 10) : '?';
        log_('test', `  ${date} — ${it.title.slice(0, 90)}`);
      }
    } catch (e) {
      log_('test', `${feed.name}: FAIL ${e.message || e}`);
    }
  }
  log_('test', '');
  log_('test', `TOTAL: items=${totalItems}, recent=${totalRecent}, would-process=${totalRelevant}`);
  log_('test', totalRelevant > 0
    ? '✅ Pre-filter is producing candidates. Run testContentHunter for the full pipeline.'
    : '⚠️  Zero relevant candidates. Try widening CONTENT_LOOKBACK_DAYS in Config (default 7).');
}

/**
 * Full pipeline test: fetch + filter + LLM + Brain writes + (optional) Slack.
 * Adds rows to the Brain sheet. Safe to re-run — dedup prevents duplicates.
 */
function testContentHunter() {
  const r = refreshContentIntel();
  log_('test', '');
  log_('test', `Result: added=${r.added}, low_conf=${r.skipped_low_confidence}, ` +
              `failed=${r.failed}, digest_posted=${r.digest_posted}`);
}
