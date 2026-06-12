/**
 * AdCopyCritic.js — diagnoses underperforming RSAs and proposes copy fixes. [RULE-BASED]
 *
 * Deterministic detection, LLM writes prose + headline suggestions only.
 * Zero candidates = no LLM call.
 *
 * Rules detect structurally weak ads; the LLM step proposes 3-5 new headlines
 * and 2 new descriptions for each flagged ad.
 *
 * Tunable thresholds (Config sheet, RULE_* keys — defaults in parens):
 *   RULE_AD_CTR_FLOOR_RATIO (0.40) Ad CTR below this fraction of ad-group median triggers flag
 *   RULE_AD_MIN_IMPR        (200)  Min impressions for CTR comparison to be meaningful
 *
 * Reads: Raw_Ads (RSAs) + Raw_AdGroups.
 * Brain categories queried: copy, brand.
 */

var AD_CTA_VERBS = /\b(buy|shop|get|start|book|order|try|save|claim|see|learn|explore|discover|find|sign up|register|download|request|apply|call)\b/i;

function runAdCopyCritic(opts) {
  var mode = (opts && opts.mode) || 'daily';

  var ads      = AgentCommon.readAds();
  var adGroups = AgentCommon.readAdGroups();
  if (ads.length === 0) {
    log_('agent', 'ad_copy_critic: no ads — skipping');
    return { agent: 'ad_copy_critic', findings: [], summary: 'No ad data.' };
  }

  return AgentCommon.runRuleBasedAgent({
    agentName:       'ad_copy_critic',
    mode:            mode,
    brainCategories: ['copy', 'brand', 'general'],
    brainLimit:      6,
    persona:
      'You are a senior Google Ads RSA copywriter. ' +
      'You are a senior PPC analyst. Every finding must include a specific number from the data as evidence. ' +
      'Do not write generic recommendations. For each flagged ad, write 3-5 new headlines (max 30 chars each) ' +
      'and 2 new descriptions (max 90 chars each) that fix the specific weakness detected.',
    instructions:
      'For each candidate, the `action` field must contain bullet-point copy suggestions. ' +
      'Headlines: benefit-led, search-intent matched, include CTA verbs and numbers where natural. ' +
      'Descriptions: expand on the headline benefit, add specifics. Use category="copy". ' +
      'target.type="ad" for ad-specific issues, "adgroup" for group-wide issues.',
    data:            { ads: ads, adGroups: adGroups, targets: AgentCommon.getTargets() },
    ruleConfig:      RulesEngine.load({
      AD_CTR_FLOOR_RATIO: 0.40,
      AD_MIN_IMPR:        200,
    }),
    detect:        _adCopyDetect_,
    maxCandidates: 8,
    maxTokens:     3000,
  });
}

function _adCopyDetect_(data, ctx) {
  var cfg = ctx.cfg;
  var out = [];

  // Top 30 ads by impressions — the universe worth critiquing.
  var top = data.ads.slice().sort(function(a, b) {
    return b.impressions - a.impressions;
  }).slice(0, 30);

  // Ad-group median CTR for low-CTR rule.
  var agCtrs = {};
  for (var ti = 0; ti < top.length; ti++) {
    var t = top[ti];
    var agId = String(t.ad_group_id);
    if (!agCtrs[agId]) agCtrs[agId] = [];
    agCtrs[agId].push(Number(t.ctr) || 0);
  }
  var agMedianCtr = {};
  for (var agKey in agCtrs) {
    var arr = agCtrs[agKey].slice().sort(function(a, b) { return a - b; });
    agMedianCtr[agKey] = arr[Math.floor(arr.length / 2)];
  }

  // Ad-group name lookup.
  var agById = {};
  for (var gi = 0; gi < data.adGroups.length; gi++) {
    agById[String(data.adGroups[gi].ad_group_id)] = data.adGroups[gi];
  }

  for (var ai = 0; ai < top.length; ai++) {
    var ad = top[ai];
    var impr   = Number(ad.impressions) || 0;
    var adCtr  = Number(ad.ctr) || 0;
    var agId   = String(ad.ad_group_id);
    var ag     = agById[agId];
    var agName = ag ? String(ag.ad_group_name) : '';

    var headlines = [];
    var descs     = [];
    try { headlines = JSON.parse(ad.headlines_json    || '[]'); } catch (_e) { headlines = []; }
    try { descs     = JSON.parse(ad.descriptions_json || '[]'); } catch (_e) { descs = []; }

    var allText = headlines.concat(descs).join(' ');

    var hlSnip = JSON.stringify(headlines).slice(0, 300);
    var dsSnip = JSON.stringify(descs).slice(0, 200);

    // 1. No CTA verb anywhere in ad copy.
    if (!AD_CTA_VERBS.test(allText)) {
      out.push({
        id: 'no-cta-' + ad.ad_id, category: 'copy',
        severity: 'P2', magnitude: 'medium', confidence: 'high', effort: 'easy',
        metric: 'CTR', direction: 'up',
        target: { type: 'ad', id: String(ad.ad_id), name: agName + ' / ad ' + ad.ad_id },
        hint: 'No CTA verb found. Ad group: ' + agName + '. ' +
              'Current headlines: ' + hlSnip + '. Current descriptions: ' + dsSnip + '. ' +
              'Write 3-5 new headlines (≤30 chars) with CTA verbs and 2 new descriptions (≤90 chars).',
        evidence: [
          'no CTA verb in any headline/description',
          'impressions ' + impr,
          'current headlines: ' + hlSnip,
        ],
      });
      continue; // One flag per ad is enough to avoid duplicate suggestions.
    }

    // 2. No numbers in headlines (price, %, count).
    var headlineText = headlines.join(' ');
    if (impr > cfg.ad_min_impr && !/\d+/.test(headlineText)) {
      out.push({
        id: 'no-numbers-' + ad.ad_id, category: 'copy',
        severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'easy',
        metric: 'CTR', direction: 'up',
        target: { type: 'ad', id: String(ad.ad_id), name: agName + ' / ad ' + ad.ad_id },
        hint: 'No numbers in headlines. Ad group: ' + agName + '. ' +
              'Current headlines: ' + hlSnip + '. ' +
              'Rewrite 3-5 headlines to include specific numbers (price, %, count, days) for credibility.',
        evidence: [
          'no digits in any headline',
          'impressions ' + impr,
          'current headlines: ' + hlSnip,
        ],
      });
      continue;
    }

    // 3. Low CTR vs ad-group median.
    var medCtr = agMedianCtr[agId] || 0;
    if (impr >= cfg.ad_min_impr && medCtr > 0 && adCtr < cfg.ad_ctr_floor_ratio * medCtr) {
      out.push({
        id: 'low-ctr-ad-' + ad.ad_id, category: 'copy',
        severity: 'P2', magnitude: 'medium', confidence: 'medium', effort: 'easy',
        metric: 'CTR', direction: 'up',
        target: { type: 'ad', id: String(ad.ad_id), name: agName + ' / ad ' + ad.ad_id },
        hint: 'CTR ' + (adCtr * 100).toFixed(2) + '% is below ' +
              (cfg.ad_ctr_floor_ratio * 100).toFixed(0) + '% of ad-group median ' +
              (medCtr * 100).toFixed(2) + '%. Ad group: ' + agName + '. ' +
              'Current headlines: ' + hlSnip + '. Propose copy that better matches search intent.',
        evidence: [
          'ad CTR ' + (adCtr * 100).toFixed(2) + '%',
          'ad-group median CTR ' + (medCtr * 100).toFixed(2) + '%',
          'impressions ' + impr,
          'current headlines: ' + hlSnip,
        ],
      });
      continue;
    }

    // 4. Ad-group keyword mismatch: no token from agName appears in any headline.
    if (agName && impr > cfg.ad_min_impr) {
      var agTokens = agName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
                          .filter(function(t) { return t.length > 3; });
      var hlLower  = headlineText.toLowerCase();
      var hasMatch = agTokens.some(function(tok) { return hlLower.indexOf(tok) >= 0; });
      if (!hasMatch && agTokens.length > 0) {
        out.push({
          id: 'kw-mismatch-' + ad.ad_id, category: 'copy',
          severity: 'P2', magnitude: 'medium', confidence: 'low', effort: 'easy',
          metric: 'CTR', direction: 'up',
          target: { type: 'ad', id: String(ad.ad_id), name: agName + ' / ad ' + ad.ad_id },
          hint: 'Message-match gap: ad-group "' + agName + '" has no matching keyword in headlines. ' +
                'Current headlines: ' + hlSnip + '. ' +
                'Rewrite to include the ad group theme in at least 1-2 headlines for QS alignment.',
          evidence: [
            'ad-group: ' + agName,
            'no agName token found in headlines',
            'impressions ' + impr,
            'current headlines: ' + hlSnip,
          ],
        });
        continue;
      }
    }

    // 5. Headline-copy fatigue: >2 headlines share the same 3-gram.
    if (headlines.length >= 3) {
      var trigramCounts = {};
      for (var hi = 0; hi < headlines.length; hi++) {
        var words = headlines[hi].toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
        for (var wi = 0; wi <= words.length - 3; wi++) {
          var tri = words[wi] + ' ' + words[wi + 1] + ' ' + words[wi + 2];
          trigramCounts[tri] = (trigramCounts[tri] || 0) + 1;
        }
      }
      var dupTri = Object.keys(trigramCounts).filter(function(k) {
        return trigramCounts[k] > 2;
      });
      if (dupTri.length > 0) {
        out.push({
          id: 'headline-fatigue-' + ad.ad_id, category: 'copy',
          severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'easy',
          metric: 'CTR', direction: 'up',
          target: { type: 'ad', id: String(ad.ad_id), name: agName + ' / ad ' + ad.ad_id },
          hint: 'Headline fatigue: 3-gram "' + dupTri[0] + '" repeats in 3+ headlines. ' +
                'Ad group: ' + agName + '. Current headlines: ' + hlSnip + '. ' +
                'Replace the repetitive headlines with diverse angles (different value props, CTAs, specifics).',
          evidence: [
            'repeated 3-gram: "' + dupTri[0] + '" (' + trigramCounts[dupTri[0]] + ' times)',
            headlines.length + ' total headlines',
            'current headlines: ' + hlSnip,
          ],
        });
      }
    }
  }

  return out;
}

function testAdCopyCritic() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'AdCopyCritic dry run (rule-based)');
  log_('test', '═══════════════════════════════════════════');
  var r = runAdCopyCritic({ mode: 'daily' });
  log_('test', 'Summary: ' + r.summary);
  log_('test', 'Findings: ' + r.findings.length + ', provider: ' + r.provider + ', tokens: ' + r.tokens + ', ' + r.run_time_ms + 'ms');
  for (var i = 0; i < Math.min(3, r.findings.length); i++) {
    var f = r.findings[i];
    log_('test', '  [' + f.severity + '] ' + f.title);
    log_('test', '    target: ' + f.target.type + ' ' + f.target.name + ' (' + f.target.id + ')');
    log_('test', '    action: ' + String(f.action || '').slice(0, 200));
  }
}
