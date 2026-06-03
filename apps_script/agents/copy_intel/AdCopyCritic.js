/**
 * AdCopyCritic.js — diagnoses underperforming RSAs and proposes copy fixes.
 *
 * Domain: Responsive Search Ad headlines + descriptions.
 * Flags:
 *   - Ads with CTR significantly below the ad-group/campaign median
 *   - Ads where all headlines feel generic (no specifics, no numbers, no CTA verbs)
 *   - Ads that mismatch the ad-group/campaign theme (poor message match)
 *   - Ads dominated by brand-only headlines on a non-brand campaign
 *   - Missing CTAs, missing benefits, missing social proof / numbers
 *
 * Reads: Raw_Ads (RSAs) + Raw_AdGroups (for context).
 * Brain categories queried: copy, brand.
 *
 * The `action` field in each finding contains the proposed new copy — write
 * it as a bulleted list of new headline / description suggestions for the
 * human implementer (or for CopyUploader in Phase 12).
 */

function runAdCopyCritic(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const ads      = AgentCommon.readAds();
  const adGroups = AgentCommon.readAdGroups();
  if (ads.length === 0) {
    log_('agent', 'ad_copy_critic: no ads — skipping');
    return { agent: 'ad_copy_critic', findings: [], summary: 'No ad data.' };
  }

  return AgentCommon.runAgent({
    agentName:       'ad_copy_critic',
    mode:            mode,
    brainCategories: ['copy', 'brand', 'general'],
    brainLimit:      6,
    persona:
      'You are a senior Google Ads RSA copywriter. You read responsive search ' +
      'ads and identify the specific headline/description weaknesses dragging ' +
      'down CTR or relevance. You write tight, benefit-led, search-intent-matched ' +
      'copy with explicit CTAs.',
    instructions:
      'Analyze the RSAs and surface up to 8 COPY findings. Focus:\n' +
      '  1. Ads with CTR < 50% of the typical for their channel/match type.\n' +
      '  2. Ads where headlines are generic (no numbers, no concrete value prop, ' +
      '     no CTA verb like Shop/Get/Save/Book).\n' +
      '  3. Ads on a non-brand campaign whose headlines are mostly brand mentions.\n' +
      '  4. Ads whose descriptions duplicate headlines without adding new info.\n' +
      '  5. Ads missing the 30-char headline opportunities (no pricing, no urgency).\n\n' +
      'For each finding, in the `action` field, propose 3-5 NEW headlines (max ' +
      '30 chars each) and 2 NEW descriptions (max 90 chars each) tailored to the ' +
      'ad group context. Be specific — no placeholders. Use category="copy".\n' +
      'target.type = "ad" (use the ad_id), or "adgroup" if the issue applies to ' +
      'all ads in the group equally.',
    data: { ads, adGroups, targets: AgentCommon.getTargets() },
    formatDataForPrompt(d) {
      return _adCopyCriticFormatData(d);
    },
  });
}

function _adCopyCriticFormatData(d) {
  const lines = [];
  const cur = AgentCommon.getCurrency();

  // Top 30 by impressions — that's the universe of ads worth critiquing.
  const top = d.ads
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 30);

  // Build ad_group lookup so we can show ad group context.
  const adGroupById = {};
  for (const ag of d.adGroups) adGroupById[ag.ad_group_id] = ag;

  lines.push(`Ads (top 30 by impressions) — context first, then per-ad detail:`);
  lines.push('');

  // Group ads by ad group so the model sees them in context.
  const byAdGroup = {};
  for (const ad of top) {
    if (!byAdGroup[ad.ad_group_id]) byAdGroup[ad.ad_group_id] = [];
    byAdGroup[ad.ad_group_id].push(ad);
  }

  for (const agId of Object.keys(byAdGroup)) {
    const ag = adGroupById[agId];
    const adsInGroup = byAdGroup[agId];
    lines.push(`Ad group: ${ag ? ag.ad_group_name : '(unknown)'} (${agId}) — ${adsInGroup.length} ad(s)`);
    for (const ad of adsInGroup) {
      let headlines = [];
      let descs = [];
      try { headlines = JSON.parse(ad.headlines_json || '[]'); } catch (_e) { headlines = []; }
      try { descs     = JSON.parse(ad.descriptions_json || '[]'); } catch (_e) { descs = []; }
      const ctr = (ad.ctr * 100).toFixed(2) + '%';
      lines.push(
        `  ad ${ad.ad_id} | imp=${ad.impressions} clicks=${ad.clicks} ctr=${ctr} ` +
        `conv=${ad.conversions} spend=${cur}${AgentCommon.micros(ad.cost_micros).toFixed(2)}`
      );
      lines.push('    headlines:    ' + JSON.stringify(headlines));
      lines.push('    descriptions: ' + JSON.stringify(descs));
    }
    lines.push('');
  }
  return lines.join('\n');
}

function testAdCopyCritic() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'AdCopyCritic dry run');
  log_('test', '═══════════════════════════════════════════');
  const r = runAdCopyCritic({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, dropped: ${r.dropped}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 200)}`);
  }
}
