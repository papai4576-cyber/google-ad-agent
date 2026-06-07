/**
 * AccountStructureReviewer.js — architectural debt in the account.  [RULE-BASED]
 *
 * Deterministic topology checks: bloated campaigns/ad groups, ad groups under
 * the 2-active-ad safety rail, and duplicate keyword text causing self-
 * competition. The LLM only writes the human copy.
 *
 * Tunable thresholds (Config, RULE_* — defaults in parens):
 *   RULE_MAX_ADGROUPS_PER_CAMPAIGN (30) above this a campaign is "bloated"
 *   RULE_MAX_KEYWORDS_PER_ADGROUP  (20) above this an ad group is "bloated"
 *   RULE_MIN_ACTIVE_ADS            (2)  ad groups below this violate the rail
 *
 * Reads: Raw_Campaigns + Raw_AdGroups + Raw_Keywords + Raw_Ads.
 * Brain categories: structure, scaling, general.
 */

function runAccountStructureReviewer(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const campaigns = AgentCommon.readCampaigns();
  const adGroups  = AgentCommon.readAdGroups();
  const keywords  = AgentCommon.readKeywords();
  const ads       = AgentCommon.readAds();
  if (campaigns.length === 0) {
    log_('agent', 'account_structure_reviewer: no campaigns — skipping');
    return { agent: 'account_structure_reviewer', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runRuleBasedAgent({
    agentName:       'account_structure_reviewer',
    mode:            mode,
    brainCategories: ['structure', 'scaling'],
    brainLimit:      3,
    persona:
      'You are a Google Ads account architect favouring Single-Theme Ad Groups ' +
      'and clean brand/non-brand separation. You turn flagged structural debt ' +
      'into clear restructuring steps.',
    instructions:
      'These are structural (usually P2/P3). Be concrete about the restructure: ' +
      'name the split, the consolidation, or the ad to add.',
    data:            { campaigns: campaigns, adGroups: adGroups, keywords: keywords, ads: ads },
    ruleConfig:      RulesEngine.load({
      MAX_ADGROUPS_PER_CAMPAIGN: 30,
      MAX_KEYWORDS_PER_ADGROUP:  20,
      MIN_ACTIVE_ADS:            2,
    }),
    detect:          _structureDetect_,
    maxCandidates:   6,
    maxTokens:       2200,
  });
}

function _structureDetect_(data, ctx) {
  const cfg = ctx.cfg;
  const out = [];

  const agByCampaign = {};
  for (const ag of data.adGroups) (agByCampaign[ag.campaign_id] = agByCampaign[ag.campaign_id] || []).push(ag);
  const kwByAg = {};
  for (const kw of data.keywords) (kwByAg[kw.ad_group_id] = kwByAg[kw.ad_group_id] || []).push(kw);
  const adsByAg = {};
  for (const ad of data.ads) {
    if (ad.status === 'ENABLED') (adsByAg[ad.ad_group_id] = adsByAg[ad.ad_group_id] || []).push(ad);
  }

  // Bloated campaigns.
  for (const c of data.campaigns) {
    const ags = agByCampaign[c.campaign_id] || [];
    if (ags.length > cfg.max_adgroups_per_campaign) {
      out.push({
        id: 'bloated-campaign-' + c.campaign_id, category: 'structure',
        severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'hard',
        metric: 'CPA', direction: 'down',
        target: { type: 'campaign', id: String(c.campaign_id), name: c.campaign_name },
        hint: 'Campaign has a very large number of ad groups — consider splitting by ' +
              'theme or funnel stage for cleaner budget control and reporting.',
        evidence: [ags.length + ' ad groups'],
      });
    }
  }

  // Ad-group level — iterate highest-spend first so the cap keeps the costly ones.
  const ags = data.adGroups.slice().sort((a, b) => (b.cost_micros || 0) - (a.cost_micros || 0));
  for (const ag of ags) {
    const kwc = (kwByAg[ag.ad_group_id] || []).length;
    const adc = (adsByAg[ag.ad_group_id] || []).length;
    const tgt = { type: 'adgroup', id: String(ag.ad_group_id), name: ag.ad_group_name };

    if (adc < cfg.min_active_ads) {
      out.push({
        id: 'understaffed-ag-' + ag.ad_group_id, category: 'structure',
        severity: 'P2', magnitude: 'medium', confidence: 'high', effort: 'easy',
        metric: 'CTR', direction: 'up', target: tgt,
        hint: 'Ad group is below the 2-active-ad safety rail — add at least one more ' +
              'responsive search ad so Google can rotate and test.',
        evidence: [adc + ' active ads', kwc + ' keywords'],
      });
    }
    if (kwc > cfg.max_keywords_per_adgroup) {
      out.push({
        id: 'bloated-ag-' + ag.ad_group_id, category: 'structure',
        severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'medium',
        metric: 'CTR', direction: 'up', target: tgt,
        hint: 'Ad group packs many keywords spanning likely-different themes — split ' +
              'into Single-Theme Ad Groups for tighter message match.',
        evidence: [kwc + ' keywords', adc + ' ads'],
      });
    }
  }

  // Duplicate keyword text across ad groups (self-competition) — top few.
  const textIndex = {};
  for (const kw of data.keywords) {
    const key = String(kw.text || '').toLowerCase() + '|' + String(kw.match_type || '');
    (textIndex[key] = textIndex[key] || []).push(kw);
  }
  const dupes = Object.keys(textIndex)
    .map(k => [k, textIndex[k]])
    .filter(e => e[1].length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);
  for (const pair of dupes) {
    const parts = pair[0].split('|');
    const text = parts[0], mt = parts[1];
    const first = pair[1][0];
    out.push({
      id: 'dup-kw-' + text.replace(/[^a-z0-9]+/g, '-').slice(0, 30), category: 'structure',
      severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'medium',
      metric: 'CPA', direction: 'down',
      target: { type: 'adgroup', id: String(first.ad_group_id), name: first.ad_group_name },
      hint: 'Identical keyword text+match appears in multiple ad groups, causing ' +
            'self-competition — consolidate to one owner ad group and negate elsewhere.',
      evidence: ['"' + text + '" [' + mt + ']', pair[1].length + ' ad groups contain it'],
    });
  }

  return out;
}

function testAccountStructureReviewer() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'AccountStructureReviewer dry run (rule-based)');
  log_('test', '═══════════════════════════════════════════');
  const r = runAccountStructureReviewer({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, provider: ${r.provider}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 150)}`);
  }
}
