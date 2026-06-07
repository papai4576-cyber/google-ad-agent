/**
 * ExtensionAuditor.js — missing / weak ad extensions (assets).  [RULE-BASED]
 *
 * Deterministic coverage check per campaign (sitelinks, callouts, structured
 * snippets) plus underperformer detection. The LLM only writes the copy — and
 * crucially, proposes the actual sitelink/callout text in the action field.
 *
 * Tunable thresholds (Config, RULE_* — defaults in parens):
 *   RULE_EXT_MIN_SPEND  (10) ignore campaigns spending below this
 *   RULE_EXT_HIGH_SPEND (50) spend above this escalates missing-asset severity
 *
 * Reads: Raw_Extensions + Raw_Campaigns. Brain categories: copy, general.
 */

function runExtensionAuditor(opts) {
  const mode = (opts && opts.mode) || 'daily';

  const extensions = AgentCommon.readExtensions();
  const campaigns  = AgentCommon.readCampaigns();
  if (campaigns.length === 0) {
    log_('agent', 'extension_auditor: no campaigns — skipping');
    return { agent: 'extension_auditor', findings: [], summary: 'No campaign data.' };
  }

  return AgentCommon.runRuleBasedAgent({
    agentName:       'extension_auditor',
    mode:            mode,
    brainCategories: ['copy', 'general'],
    brainLimit:      3,
    persona:
      'You are a Google Ads asset/extension specialist. For each flagged gap you ' +
      'propose ready-to-paste extension copy.',
    instructions:
      'In the action field, propose CONCRETE starting copy: 4-6 sitelink texts, ' +
      '6-8 callouts, or 1-2 structured-snippet headers+values — tailored to the ' +
      'campaign name/offering. Keep within Google length limits (sitelink text ≤ 25 chars).',
    data:            { extensions: extensions, campaigns: campaigns },
    ruleConfig:      RulesEngine.load({ EXT_MIN_SPEND: 10, EXT_HIGH_SPEND: 50 }),
    detect:          _extensionDetect_,
    maxCandidates:   5,
    maxTokens:       2200,
  });
}

function _extensionDetect_(data, ctx) {
  const cur = ctx.cur;
  const cfg = ctx.cfg;
  const out = [];

  const byCampaign = {};
  for (const e of data.extensions) {
    const c = byCampaign[e.campaign_id] = byCampaign[e.campaign_id] || {};
    (c[e.type] = c[e.type] || []).push(e);
  }
  const campName = {};
  for (const c of data.campaigns) campName[c.campaign_id] = c.campaign_name;

  // No assets anywhere → one account-level flag on the top spender.
  if (data.extensions.length === 0) {
    const top = data.campaigns.slice().sort((a, b) => b.cost_micros - a.cost_micros)[0];
    if (top) {
      out.push({
        id: 'no-extensions-account', category: 'extensions',
        severity: 'P1', magnitude: 'high', confidence: 'high', effort: 'easy',
        metric: 'CTR', direction: 'up',
        target: { type: 'campaign', id: String(top.campaign_id), name: top.campaign_name },
        hint: 'No extensions found anywhere in the account — add sitelinks, callouts and ' +
              'structured snippets to the top campaigns; the cheapest CTR lift available.',
        evidence: ['0 extensions across all campaigns'],
      });
    }
    return out;
  }

  const camps = data.campaigns.slice().sort((a, b) => b.cost_micros - a.cost_micros);
  for (const c of camps) {
    const spend = AgentCommon.micros(c.cost_micros);
    if (spend < cfg.ext_min_spend) continue;
    const cov = byCampaign[c.campaign_id] || {};
    const n = (t) => (cov[t] || []).length;
    const big = spend > cfg.ext_high_spend;
    const tgt = { type: 'campaign', id: String(c.campaign_id), name: c.campaign_name };

    if (n('SITELINK') === 0) {
      out.push({
        id: 'no-sitelinks-' + c.campaign_id, category: 'extensions',
        severity: big ? 'P1' : 'P2', magnitude: big ? 'high' : 'medium',
        confidence: 'high', effort: 'easy', metric: 'CTR', direction: 'up', target: tgt,
        hint: 'No sitelinks — the single biggest extension CTR lift. Propose 4-6 concrete ' +
              'sitelink texts relevant to this campaign.',
        evidence: ['0 sitelinks', c.channel_type, 'spend ' + cur + spend.toFixed(0)],
      });
    } else if (n('SITELINK') < 4) {
      out.push({
        id: 'few-sitelinks-' + c.campaign_id, category: 'extensions',
        severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'easy',
        metric: 'CTR', direction: 'up', target: tgt,
        hint: 'Below the recommended 4+ sitelinks — propose additional sitelink texts.',
        evidence: [n('SITELINK') + ' sitelinks', 'spend ' + cur + spend.toFixed(0)],
      });
    }

    if (n('CALLOUT') === 0) {
      out.push({
        id: 'no-callouts-' + c.campaign_id, category: 'extensions',
        severity: big ? 'P2' : 'P3', magnitude: big ? 'medium' : 'low',
        confidence: 'high', effort: 'easy', metric: 'CTR', direction: 'up', target: tgt,
        hint: 'No callouts — propose 6-8 concise callout phrases (benefits, trust signals).',
        evidence: ['0 callouts', 'spend ' + cur + spend.toFixed(0)],
      });
    }

    if (n('STRUCTURED_SNIPPET') === 0 && big) {
      out.push({
        id: 'no-snippets-' + c.campaign_id, category: 'extensions',
        severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'easy',
        metric: 'CTR', direction: 'up', target: tgt,
        hint: 'No structured snippets — propose 1-2 snippet headers + values for the offering.',
        evidence: ['0 structured snippets', 'spend ' + cur + spend.toFixed(0)],
      });
    }
  }

  // A few underperforming extensions (lots of impressions, almost no clicks).
  const under = data.extensions
    .filter(e => e.impressions > 100 && e.ctr < 0.01)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 3);
  for (const e of under) {
    out.push({
      id: 'weak-ext-' + e.extension_id, category: 'extensions',
      severity: 'P3', magnitude: 'low', confidence: 'medium', effort: 'easy',
      metric: 'CTR', direction: 'up',
      target: { type: 'campaign', id: String(e.campaign_id), name: campName[e.campaign_id] || String(e.campaign_id) },
      hint: 'Extension shown a lot but barely clicked — replace its copy with a stronger variant.',
      evidence: [e.type + ' "' + e.text + '"', e.impressions + ' impr', (e.ctr * 100).toFixed(2) + '% CTR'],
    });
  }

  return out;
}

function testExtensionAuditor() {
  log_('test', '═══════════════════════════════════════════');
  log_('test', 'ExtensionAuditor dry run (rule-based)');
  log_('test', '═══════════════════════════════════════════');
  const r = runExtensionAuditor({ mode: 'daily' });
  log_('test', `Summary: ${r.summary}`);
  log_('test', `Findings: ${r.findings.length}, provider: ${r.provider}, tokens: ${r.tokens}, ${r.run_time_ms}ms`);
  for (const f of r.findings.slice(0, 3)) {
    log_('test', `  [${f.severity}] ${f.title}`);
    log_('test', `    target: ${f.target.type} ${f.target.name} (${f.target.id})`);
    log_('test', `    action: ${f.action.slice(0, 150)}`);
  }
}
