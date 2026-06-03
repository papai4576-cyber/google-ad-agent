/**
 * config.js — central configuration: script properties, sheet schemas, constants.
 *
 * Every other Apps Script file imports from here. No I/O happens at load time;
 * call PROPS.require('KEY') at the point of use so partial-setup runs don't break.
 *
 * Files in this Apps Script project are intentionally flat — Apps Script does
 * not have real folders, but filenames with slashes ("managers/AuditManager")
 * render as folders in the editor sidebar.
 */

/* ============================================================================
 * Script Properties wrapper — fail loudly when a required key is missing.
 * ========================================================================== */
const PROPS = {
  get(key, fallback) {
    const v = PropertiesService.getScriptProperties().getProperty(key);
    if (v === null || v === '') return fallback === undefined ? null : fallback;
    return v;
  },
  require(key) {
    const v = this.get(key);
    if (v === null) {
      throw new Error(
        `Required Script Property ${key} is not set. ` +
        `Go to Project Settings → Script Properties → add ${key}.`
      );
    }
    return v;
  },
  set(key, value) {
    PropertiesService.getScriptProperties().setProperty(key, String(value));
  },
  getBool(key, fallback = false) {
    const v = this.get(key);
    if (v === null) return fallback;
    return ['true', '1', 'yes', 'y', 'on'].includes(String(v).toLowerCase().trim());
  },
  getFloat(key, fallback) {
    const v = this.get(key);
    if (v === null) return fallback;
    return parseFloat(v);
  },
};

/* ============================================================================
 * Required Script Properties — listed here so setup can validate them.
 * ========================================================================== */
const REQUIRED_PROPS = [
  'GROQ_API_KEY',
  'SPREADSHEET_ID',
  'BRAIN_DRIVE_FOLDER_ID',
  // The next four become required when the Slack gate is wired (phase 11).
  // They are documented here so SETUP.md can refer to one source of truth.
  // 'SLACK_BOT_TOKEN',
  // 'SLACK_WEBHOOK_URL',
  // 'SLACK_CHANNEL_ID',
  // 'ADS_SCRIPT_EXECUTE_URL',
];

/* ============================================================================
 * LLM provider config — central so swapping providers later touches one place.
 * Groq is OpenAI-compatible, so most code reads identically to OpenAI clients.
 * ========================================================================== */
const LLM = {
  provider:    'groq',
  endpoint:    'https://api.groq.com/openai/v1/chat/completions',
  model:       'llama-3.3-70b-versatile',
  // Free-tier rate limits as of 2026 — used by retry/backoff logic later.
  rpm:         30,        // requests per minute
  rpd:         14400,     // requests per day
  tpm:         6000,      // tokens per minute
  // Default generation settings used unless an agent overrides.
  temperature: 0.3,
  max_tokens:  4000,
};

/* ============================================================================
 * Account targets and safety rails — these are SOURCED FROM the Config sheet
 * tab at runtime (not from Script Properties) so you can edit them without
 * re-deploying. Defaults here are the seeds the Config tab is initialised to.
 * ========================================================================== */
const DEFAULTS = {
  DRY_RUN:               'false',
  MONTHLY_BUDGET_TARGET: '5000',
  TARGET_CPA:            '50',
  TARGET_ROAS:           '4.0',
  // Safety rules from CLAUDE.md — non-negotiable, never relax these in code.
  MAX_BID_CHANGE_PCT:    '0.30',
  MAX_BUDGET_SHIFT_PCT:  '0.20',
  MIN_ACTIVE_ADS:        '2',
};

/* ============================================================================
 * Impact scoring weights (from CLAUDE.md "Impact scoring formula").
 * Used by SynthesisManager.ImpactScorer in phase 10.
 * ========================================================================== */
const SCORE_WEIGHTS = {
  magnitude:  { high: 3,   medium: 2,   low: 1   },
  confidence: { high: 1.0, medium: 0.7, low: 0.4 },
  effort:     { easy: 1.0, medium: 1.5, hard: 2.5 },
};
const PRIORITY_THRESHOLDS = { P1: 2.0, P2: 1.0 };  // < P2 ⇒ P3

/* ============================================================================
 * Valid enums — schema-level allowlists used by parseFindings() in every agent.
 * ========================================================================== */
const VALID = {
  severities:   ['P1', 'P2', 'P3'],
  magnitudes:   ['low', 'medium', 'high'],
  confidences:  ['low', 'medium', 'high'],
  efforts:      ['easy', 'medium', 'hard'],
  categories:   ['performance', 'keywords', 'copy', 'structure',
                 'bidding', 'audience', 'extensions', 'competitive'],
  target_types: ['campaign', 'adgroup', 'keyword', 'ad'],
  modes:        ['daily', 'weekly'],
  brain_categories: ['copy', 'bidding', 'structure', 'scaling', 'brand',
                     'keywords', 'audience', 'competitive', 'landing_page',
                     'pmax', 'reddit_intel', 'general'],
};

/* ============================================================================
 * Sheet schemas — every tab the system reads or writes is declared here.
 * The bootstrap (setup.js) uses this single source of truth to create tabs.
 * ========================================================================== */
const SHEETS = {
  Dashboard: {
    description: 'Human-readable KPI summary + last-run status + Reddit digest',
    headers: ['Section', 'Metric', 'Value', 'As Of', 'Notes'],
  },
  Brain: {
    description: 'Indexed strategy knowledge from Drive uploads + Reddit intel',
    headers: [
      'id', 'category', 'source', 'source_type', 'date_added',
      'title', 'summary', 'key_points_json', 'raw_text',
    ],
  },
  Raw_Campaigns: {
    description: 'Campaign metrics — written by Google Ads Script in collect mode',
    headers: [
      'run_date', 'campaign_id', 'campaign_name', 'status', 'channel_type',
      'bidding_strategy', 'target_cpa_micros', 'target_roas',
      'budget_micros', 'impressions', 'clicks', 'cost_micros',
      'conversions', 'conversion_value', 'ctr', 'avg_cpc_micros',
      'search_is', 'search_budget_lost_is', 'search_rank_lost_is',
    ],
  },
  Raw_AdGroups: {
    description: 'Ad group metrics — written by Google Ads Script',
    headers: [
      'run_date', 'ad_group_id', 'ad_group_name', 'status', 'campaign_id',
      'cpc_bid_micros', 'target_cpa_micros', 'impressions', 'clicks',
      'cost_micros', 'conversions', 'conversion_value', 'avg_quality_score',
    ],
  },
  Raw_Keywords: {
    description: 'Keyword metrics + QS — written by Google Ads Script',
    headers: [
      'run_date', 'keyword_id', 'text', 'match_type', 'status',
      'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name',
      'cpc_bid_micros', 'quality_score', 'creative_quality',
      'post_click_quality', 'search_predicted_ctr',
      'impressions', 'clicks', 'cost_micros', 'conversions',
      'conversion_value', 'ctr', 'avg_cpc_micros',
    ],
  },
  Raw_Ads: {
    description: 'RSA assets + metrics — written by Google Ads Script',
    headers: [
      'run_date', 'ad_id', 'status', 'approval_status',
      'ad_group_id', 'ad_group_name', 'campaign_id',
      'headlines_json', 'descriptions_json', 'final_urls_json',
      'impressions', 'clicks', 'cost_micros', 'conversions',
      'ctr', 'avg_cpc_micros',
    ],
  },
  Raw_SearchTerms: {
    description: 'Search term report — written by Google Ads Script',
    headers: [
      'run_date', 'term', 'status', 'campaign_id', 'campaign_name',
      'ad_group_id', 'ad_group_name', 'impressions', 'clicks',
      'cost_micros', 'conversions', 'ctr', 'avg_cpc_micros',
    ],
  },
  Raw_Extensions: {
    description: 'Sitelinks, callouts, structured snippets, promos',
    headers: [
      'run_date', 'extension_id', 'type', 'campaign_id', 'ad_group_id',
      'text', 'status', 'impressions', 'clicks', 'ctr',
    ],
  },
  Raw_SearchConsole: {
    description: 'Organic queries — written by SearchConsoleFetcher (phase 2)',
    headers: [
      'run_date', 'query', 'page', 'impressions', 'clicks', 'ctr', 'position',
    ],
  },
  Raw_Trends: {
    description: 'Category interest over time — written by TrendsFetcher',
    headers: ['run_date', 'keyword', 'date', 'interest_score', 'geo'],
  },
  Findings: {
    description: 'All findings from all 15 agents (one row per finding)',
    headers: [
      'run_date', 'mode', 'agent', 'finding_id', 'category', 'severity',
      'title', 'what', 'why', 'action',
      'target_type', 'target_id', 'target_name',
      'impact_metric', 'impact_direction', 'impact_magnitude',
      'confidence', 'effort', 'evidence_json', 'brain_sources_json',
      'score', 'status',
    ],
  },
  Action_Plan: {
    description: 'Synthesised + scored P1/P2/P3 plan, one row per action item',
    headers: [
      'run_date', 'plan_id', 'finding_id', 'priority', 'title', 'what', 'why',
      'action', 'target_type', 'target_id', 'target_name', 'score',
      'slack_message_ts', 'status',
    ],
  },
  Approvals: {
    description: 'One row per approval reaction received from Slack',
    headers: [
      'timestamp', 'plan_id', 'finding_id', 'reaction',
      'user_id', 'status', 'notes',
    ],
  },
  Change_Log: {
    description: 'Audit trail of every mutate (or dry-run) the system performs',
    headers: [
      'timestamp', 'plan_id', 'finding_id', 'agent',
      'target_type', 'target_id', 'target_name',
      'field_changed', 'before_value', 'after_value',
      'dry_run', 'success', 'error_message',
    ],
  },
  Config: {
    description: 'Runtime config — edit values here without redeploying',
    headers: ['key', 'value', 'description'],
  },
};

/* ============================================================================
 * Config-tab helper — reads runtime config from the Config sheet (not Script
 * Properties), so non-developers can change targets/safety/dry-run live.
 * ========================================================================== */
function getConfig(key, fallback) {
  const ss = SpreadsheetApp.openById(PROPS.require('SPREADSHEET_ID'));
  const sheet = ss.getSheetByName('Config');
  if (!sheet) throw new Error('Config sheet not found. Run setupEverything().');
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      const v = rows[i][1];
      if (v === '' || v === null || v === undefined) return fallback;
      return v;
    }
  }
  return fallback;
}

function isDryRun() {
  const v = String(getConfig('DRY_RUN', 'true')).toLowerCase().trim();
  return ['true', '1', 'yes', 'y', 'on'].includes(v);
}

/* ============================================================================
 * Tiny logging helper — used everywhere. Mirrors to Apps Script logs and to
 * the Dashboard sheet (last-run section). Phase 13 wires the Dashboard part.
 * ========================================================================== */
function log_(component, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${component}] ${msg}`);
}

/* ============================================================================
 * Shared utility helpers (Apps Script side). Defined here because Apps Script
 * has ONE flat global namespace across all .gs files — keeping shared helpers
 * in config.js avoids accidental redefinition collisions in agent/brain files.
 * ========================================================================== */
function todayString_() {
  const d = new Date();
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function nowIso_() {
  return new Date().toISOString();
}
