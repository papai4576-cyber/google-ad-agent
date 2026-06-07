# Graph Report - C:\Users\papai\google-ads-agent  (2026-06-07)

## Corpus Check
- Corpus is ~44,219 words - fits in a single context window. You may not need a graph.

## Summary
- 432 nodes · 596 edges · 49 communities (19 shown, 30 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 34 edges (avg confidence: 0.83)
- Token cost: 135,000 input · 11,000 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Audit & Copy-Intel Agent Runners|Audit & Copy-Intel Agent Runners]]
- [[_COMMUNITY_Manager Orchestration & Brain Core|Manager Orchestration & Brain Core]]
- [[_COMMUNITY_Content Ingestion & Brain Storage|Content Ingestion & Brain Storage]]
- [[_COMMUNITY_Dashboard & Reporting|Dashboard & Reporting]]
- [[_COMMUNITY_Campaign Director State|Campaign Director State]]
- [[_COMMUNITY_Config & Content Feeds|Config & Content Feeds]]
- [[_COMMUNITY_Google Ads Data Fetchers|Google Ads Data Fetchers]]
- [[_COMMUNITY_Manager Modules|Manager Modules]]
- [[_COMMUNITY_Configuration Constants|Configuration Constants]]
- [[_COMMUNITY_Shared Agent Utilities|Shared Agent Utilities]]
- [[_COMMUNITY_LLM Provider Routing|LLM Provider Routing]]
- [[_COMMUNITY_Strategy Knowledge Base|Strategy Knowledge Base]]
- [[_COMMUNITY_Project Setup|Project Setup]]
- [[_COMMUNITY_Brain File Extraction|Brain File Extraction]]
- [[_COMMUNITY_Webhook Ingestion|Webhook Ingestion]]
- [[_COMMUNITY_Negative Keyword Hunter|Negative Keyword Hunter]]
- [[_COMMUNITY_Apps Script Manifest|Apps Script Manifest]]
- [[_COMMUNITY_Landing Page Scorer|Landing Page Scorer]]
- [[_COMMUNITY_Conversion Health Checker|Conversion Health Checker]]
- [[_COMMUNITY_Search Term Pattern Analyzer|Search Term Pattern Analyzer]]
- [[_COMMUNITY_Account Structure Reviewer|Account Structure Reviewer]]
- [[_COMMUNITY_Audience Analyst|Audience Analyst]]
- [[_COMMUNITY_Bid & Budget Analyst|Bid & Budget Analyst]]
- [[_COMMUNITY_Extension Auditor|Extension Auditor]]
- [[_COMMUNITY_Performance Analyst|Performance Analyst]]
- [[_COMMUNITY_Quality Score Inspector|Quality Score Inspector]]
- [[_COMMUNITY_Ad Copy Critic|Ad Copy Critic]]
- [[_COMMUNITY_Category Trend Spotter|Category Trend Spotter]]
- [[_COMMUNITY_Competitive Intel|Competitive Intel]]
- [[_COMMUNITY_Keyword Miner|Keyword Miner]]
- [[_COMMUNITY_Agent Common Utilities|Agent Common Utilities]]
- [[_COMMUNITY_Brain Store|Brain Store]]
- [[_COMMUNITY_Clasp Config|Clasp Config]]
- [[_COMMUNITY_Local Claude Settings|Local Claude Settings]]
- [[_COMMUNITY_Claude Settings|Claude Settings]]
- [[_COMMUNITY_Manager Pair|Manager Pair]]
- [[_COMMUNITY_Rules Engine|Rules Engine]]
- [[_COMMUNITY_Deduplication Agent|Deduplication Agent]]
- [[_COMMUNITY_Impact Scorer|Impact Scorer]]
- [[_COMMUNITY_Plan Formatter|Plan Formatter]]
- [[_COMMUNITY_Clasp Config Singleton|Clasp Config Singleton]]
- [[_COMMUNITY_Agent Common Namespace|Agent Common Namespace]]
- [[_COMMUNITY_Agent Common Micros|Agent Common Micros]]
- [[_COMMUNITY_Dedup Namespace|Dedup Namespace]]
- [[_COMMUNITY_Manifest Singleton|Manifest Singleton]]
- [[_COMMUNITY_Content Weekly Trigger|Content Weekly Trigger]]
- [[_COMMUNITY_Today String Helper|Today String Helper]]
- [[_COMMUNITY_Webhook GET Handler|Webhook GET Handler]]

## God Nodes (most connected - your core abstractions)
1. `refreshDashboard()` - 20 edges
2. `AgentCommon.runAgent` - 16 edges
3. `phases_built` - 15 edges
4. `refreshDashboard` - 11 edges
5. `getConfig()` - 10 edges
6. `AgentCommon.runRuleBasedAgent` - 10 edges
7. `AgentCommon.readCampaigns` - 10 edges
8. `refreshContentIntel()` - 8 edges
9. `callLLM()` - 8 edges
10. `rs_()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `ImpactScorer` --implements--> `Impact Scoring Formula`  [EXTRACTED]
  apps_script/agents/synthesis/ImpactScorer.js → CLAUDE.md
- `ImpactScorer` --cites--> `CLAUDE.md (Master Brief)`  [EXTRACTED]
  apps_script/agents/synthesis/ImpactScorer.js → CLAUDE.md
- `BrainCurator` --implements--> `The Brain (Strategy KB)`  [EXTRACTED]
  apps_script/brain/BrainCurator.js → CLAUDE.md
- `BrainStore` --implements--> `The Brain (Strategy KB)`  [EXTRACTED]
  apps_script/brain/BrainStore.js → CLAUDE.md
- `ContentHunter` --implements--> `The Brain (Strategy KB)`  [EXTRACTED]
  apps_script/brain/ContentHunter.js → CLAUDE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Rule-based agent pattern (deterministic detect + LLM prose)** — common_runRuleBasedAgent, asr_detect, bb_detect, ch_detect, ext_detect, qs_detect [EXTRACTED 1.00]
- **LLM-driven agent pattern (full prompt + JSON validate)** — common_runAgent, perf_run, aud_run, acc_run, km_run, nkh_run, ci_run, cts_run, stpa_run, lps_run [EXTRACTED 1.00]
- **Findings write/dedup/dashboard pipeline** — common_appendFindings, concept_findings_tab, dedup_run, dashboard_appendHealthSections [INFERRED 0.85]
- **Synthesis Pipeline (Findings to Action_Plan)** — synthesismanager_run, impactscorer_run, planformatter_run [EXTRACTED 1.00]
- **Campaign Director Top-Level Orchestration** — campaigndirector_run, auditmanager_run, copyintelmanager_run, synthesismanager_run [EXTRACTED 1.00]
- **Google Ads to Sheet Webhook Pipeline** — googleadsscript_runcollect, googleadsscript_post, ingest_dopost, ingest_writealltabs [EXTRACTED 1.00]

## Communities (49 total, 30 thin omitted)

### Community 0 - "Audit & Copy-Intel Agent Runners"
Cohesion: 0.08
Nodes (51): _adCopyCriticFormatData, runAdCopyCritic, _structureDetect_, runAccountStructureReviewer, _audienceAnalystFormatData, runAudienceAnalyst, _bidBudgetDetect_, runBidBudgetAnalyst (+43 more)

### Community 1 - "Manager Orchestration & Brain Core"
Cohesion: 0.06
Nodes (36): AUDIT_AGENTS, runAuditManager, setupBrainNightlyTrigger, BrainStore.count, BrainStore.query, BrainStore._readAll_, _directorPreflight_, runCampaignDirector (+28 more)

### Community 2 - "Content Ingestion & Brain Storage"
Cohesion: 0.08
Nodes (29): collectFiles_, extractFileText_, extractMetadata_, extractViaConversion_, refreshBrain, BrainStore.add, BrainStore.existingSources, Webhook Architecture (Workspace OAuth workaround) (+21 more)

### Community 3 - "Dashboard & Reporting"
Cohesion: 0.14
Nodes (25): _addDays_(), _aggregate_(), _aggregateByCampaign_(), _appendHealthSections_(), _countBy_(), _daysInMonth_(), _delta_(), _fmtYmd_() (+17 more)

### Community 4 - "Campaign Director State"
Cohesion: 0.07
Nodes (27): CampaignDirector, architecture, current_phase, current_phase_name, current_phase_status, known_flaws_pending_fix, last_completed_phase, next_user_action (+19 more)

### Community 5 - "Config & Content Feeds"
Cohesion: 0.15
Nodes (21): getConfig(), isDryRun(), setupBrainNightlyTrigger(), buildContentDigest_(), CONTENT_STRATEGY_TERMS, DEFAULT_FEEDS, extractContentMetadata_(), fetchFeed_() (+13 more)

### Community 6 - "Google Ads Data Fetchers"
Cohesion: 0.19
Nodes (19): collect_(), CONFIG, fetchAdGroups_(), fetchCampaigns_(), fetchCampaignsDaily_(), fetchExtensions_(), fetchKeywords_(), fetchNegativeKeywords_() (+11 more)

### Community 7 - "Manager Modules"
Cohesion: 0.17
Nodes (13): AUDIT_AGENTS, runAuditManager(), testAuditManager(), _directorPreflight_(), runCampaignDirector(), testCampaignDirector(), COPY_INTEL_AGENTS, runCopyIntelManager() (+5 more)

### Community 8 - "Configuration Constants"
Cohesion: 0.13
Nodes (14): AGENT_LLM, DEFAULTS, LLM, LLM_PROVIDERS, nowIso_(), PRIORITY_THRESHOLDS, PROPS, REQUIRED_PROPS (+6 more)

### Community 9 - "Shared Agent Utilities"
Cohesion: 0.13
Nodes (16): AgentCommon.appendFindings, AgentCommon.getTargets, Findings sheet tab, _aggregate_, _aggregateByCampaign_, _appendHealthSections_, installDashboardTrigger, _latestRows_ (+8 more)

### Community 10 - "LLM Provider Routing"
Cohesion: 0.26
Nodes (13): pickProvider(), backoffMs_(), _callGemini_(), _callGroq_(), callLLM(), _callProvider_(), extractText_(), _geminiText_() (+5 more)

### Community 11 - "Strategy Knowledge Base"
Cohesion: 0.19
Nodes (12): BrainCurator, BrainStore, The Brain (Strategy KB), RSS Pivot from Reddit, Safety Rules (Non-Negotiable), Impact Scoring Formula, Slack Approval Gate, Universal Findings Schema (+4 more)

### Community 12 - "Project Setup"
Cohesion: 0.22
Nodes (4): createAllTabs_(), safe_(), setSheetDescription_(), setupEverything()

### Community 13 - "Brain File Extraction"
Cohesion: 0.35
Nodes (10): collectFiles_(), extractFileText_(), extractFromSheet_(), extractMetadata_(), extractViaConversion_(), inferCategoryFromFilename_(), refreshBrain(), sanitizeCategory_() (+2 more)

### Community 14 - "Webhook Ingestion"
Cohesion: 0.42
Nodes (8): authorize_(), doGet(), doPost(), jsonResponse_(), parsePayload_(), _testIngestLocally(), writeAllTabs_(), writeTab_()

### Community 15 - "Negative Keyword Hunter"
Cohesion: 0.48
Nodes (6): _buildNegativeMatcher_(), _negativeKwHunterFormatData(), _negativeMatches_(), _reEscape_(), runNegativeKwHunter(), testNegativeKwHunter()

### Community 16 - "Apps Script Manifest"
Cohesion: 0.33
Nodes (5): dependencies, enabledAdvancedServices, exceptionLogging, runtimeVersion, timeZone

### Community 17 - "Landing Page Scorer"
Cohesion: 0.47
Nodes (3): runLandingPageScorer(), _scorePage(), testLandingPageScorer()

## Knowledge Gaps
- **117 isolated node(s):** `scriptId`, `rootDir`, `allow`, `allow`, `AgentCommon` (+112 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **30 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getConfig()` connect `Config & Content Feeds` to `Configuration Constants`, `LLM Provider Routing`, `Dashboard & Reporting`, `Negative Keyword Hunter`?**
  _High betweenness centrality (0.043) - this node is a cross-community bridge._
- **Why does `_resolveWindowLabel_()` connect `Dashboard & Reporting` to `Config & Content Feeds`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Why does `refreshDashboard()` connect `Dashboard & Reporting` to `Manager Modules`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `getConfig()` (e.g. with `_resolveWindowLabel_()` and `setupBrainNightlyTrigger()`) actually correct?**
  _`getConfig()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `scriptId`, `rootDir`, `allow` to the rest of the system?**
  _117 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Audit & Copy-Intel Agent Runners` be split into smaller, more focused modules?**
  _Cohesion score 0.07764705882352942 - nodes in this community are weakly interconnected._
- **Should `Manager Orchestration & Brain Core` be split into smaller, more focused modules?**
  _Cohesion score 0.059743954480796585 - nodes in this community are weakly interconnected._