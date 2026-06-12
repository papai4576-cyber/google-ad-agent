# Graph Report - google-ads-agent  (2026-06-12)

## Corpus Check
- 88 files · ~76,493 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 912 nodes · 1488 edges · 78 communities (48 shown, 30 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 53 edges (avg confidence: 0.82)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `61ee8e08`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]

## God Nodes (most connected - your core abstractions)
1. `refreshDashboard()` - 20 edges
2. `v2_status` - 20 edges
3. `getConfig()` - 18 edges
4. `micros()` - 18 edges
5. `Google Ads Agent Fleet v2 — Master Brief` - 18 edges
6. `compilerOptions` - 16 edges
7. `AgentCommon.runAgent` - 16 edges
8. `main()` - 14 edges
9. `loadAccountData()` - 13 edges
10. `getTargets()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `ImpactScorer` --implements--> `Impact Scoring Formula`  [EXTRACTED]
  apps_script/agents/synthesis/ImpactScorer.js → CLAUDE.md
- `BrainStore` --implements--> `The Brain (Strategy KB)`  [EXTRACTED]
  apps_script/brain/BrainStore.js → CLAUDE.md
- `ImpactScorer` --cites--> `CLAUDE.md (Master Brief)`  [EXTRACTED]
  apps_script/agents/synthesis/ImpactScorer.js → CLAUDE.md
- `BrainCurator` --implements--> `The Brain (Strategy KB)`  [EXTRACTED]
  apps_script/brain/BrainCurator.js → CLAUDE.md
- `ContentHunter` --implements--> `The Brain (Strategy KB)`  [EXTRACTED]
  apps_script/brain/ContentHunter.js → CLAUDE.md

## Import Cycles
- None detected.

## Communities (78 total, 30 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (67): _adCopyCriticFormatData, runAdCopyCritic, _structureDetect_, runAccountStructureReviewer, _audienceAnalystFormatData, runAudienceAnalyst, _bidBudgetDetect_, runBidBudgetAnalyst (+59 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (31): name, status, name, status, name, status, name, status (+23 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (30): note, production_url, supabase_pooler_region, supabase_project_ref, vercel_project, track, updated_at, v1_status (+22 more)

### Community 3 - "Community 3"
Cohesion: 0.15
Nodes (25): _addDays_(), _aggregate_(), _aggregateByCampaign_(), _appendHealthSections_(), _countBy_(), _daysInMonth_(), _delta_(), _fmtYmd_() (+17 more)

### Community 4 - "Community 4"
Cohesion: 0.17
Nodes (23): adGroupById_(), _apiUrl_(), applyChange_(), campaignById_(), collect_(), CONFIG, fetchAdGroups_(), fetchCampaigns_() (+15 more)

### Community 5 - "Community 5"
Cohesion: 0.17
Nodes (18): buildContentDigest_(), CONTENT_STRATEGY_TERMS, DEFAULT_FEEDS, extractContentMetadata_(), fetchFeed_(), getFeeds_(), parseAtomEntry_(), parseRss_() (+10 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (20): RUN_CONTEXT, runAuditManager, BrainStore.count, _directorPreflight_, runCampaignDirector, runCopyIntelManager, AUDIT_AGENTS, runAuditManager() (+12 more)

### Community 7 - "Community 7"
Cohesion: 0.16
Nodes (18): AGENT_LLM, dailyTokenCeiling(), DEFAULTS, LLM, LLM_PROVIDERS, overDailyCeiling_(), PROPS, recordTokenUsage_() (+10 more)

### Community 8 - "Community 8"
Cohesion: 0.22
Nodes (7): Safety Rules (Non-Negotiable), Impact Scoring Formula, Slack Approval Gate, Universal Findings Schema, CLAUDE.md (Master Brief), ImpactScorer, PlanFormatter

### Community 9 - "Community 9"
Cohesion: 0.29
Nodes (13): cpa(), fmtCurrency(), getOverviewData(), Home(), KpiRow(), OverviewData, roas(), WindowStats (+5 more)

### Community 10 - "Community 10"
Cohesion: 0.31
Nodes (11): backoffMs_(), _callGemini_(), _callGroq_(), callLLM(), _callProvider_(), extractText_(), _geminiText_(), _isFailoverWorthy_() (+3 more)

### Community 11 - "Community 11"
Cohesion: 0.06
Nodes (31): dependencies, drizzle-orm, next, postgres, react, react-dom, devDependencies, dotenv (+23 more)

### Community 12 - "Community 12"
Cohesion: 0.35
Nodes (10): collectFiles_(), extractFileText_(), extractFromSheet_(), extractMetadata_(), extractViaConversion_(), inferCategoryFromFilename_(), refreshBrain(), sanitizeCategory_() (+2 more)

### Community 13 - "Community 13"
Cohesion: 0.05
Nodes (57): ActionPlanPage(), CATEGORIES, Category, fmtCurrency(), getCounts(), getRows(), PRIORITY_STYLES, STATUS_STYLES (+49 more)

### Community 14 - "Community 14"
Cohesion: 0.18
Nodes (4): createAllTabs_(), safe_(), setSheetDescription_(), setupEverything()

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (87): BrainContextEntry, formatBrainContext(), queryBrain(), AdGroupRow, AdRow, CampaignRow, ExtensionRow, KeywordRow (+79 more)

### Community 16 - "Community 16"
Cohesion: 0.11
Nodes (31): nowIso_(), authorize_(), doGet(), doPost(), handleExecuteResults_(), jsonResponse_(), parseJson_(), parsePayload_() (+23 more)

### Community 17 - "Community 17"
Cohesion: 0.05
Nodes (50): collectFiles_, extractFileText_, extractMetadata_, extractViaConversion_, refreshBrain, setupBrainNightlyTrigger, BrainStore.add, BrainStore.existingSources (+42 more)

### Community 18 - "Community 18"
Cohesion: 0.07
Nodes (27): Action classification — `action_category` / `action_type`, Agent architecture — 14 agents (v1) → 6 Analysts (v2), Audience & scaling strategies (recommend + implement adjustments), Bidding strategies (agents can recommend AND implement), Brain categories and what goes in each, Brain entry schema, Build phases — v1 (Apps Script + Sheets), all complete, kept for reference, Campaign structure strategies (recommend only — human implements) (+19 more)

### Community 19 - "Community 19"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 20 - "Community 20"
Cohesion: 0.25
Nodes (4): geistMono, geistSans, metadata, LINKS

### Community 21 - "Community 21"
Cohesion: 0.22
Nodes (17): backoffMs(), callGroq(), callLLM(), dailyTokenCeiling(), extractText(), GroqResponse, LLM, LLMOptions (+9 more)

### Community 22 - "Community 22"
Cohesion: 0.20
Nodes (8): Finding, Severity, SynthFinding, DedupResult, ImpactScoreResult, PRIORITY_THRESHOLDS, SCORE_WEIGHTS, ImpactScorer

### Community 23 - "Community 23"
Cohesion: 0.18
Nodes (11): Phase 2 — Google Ads Script data collector (webhook architecture), Step 1 — Add `ingest.js` to your Apps Script project, Step 2 — Add an INGEST_SECRET to Script Properties, Step 3 — Deploy the Apps Script as a Web App, Step 4 — Sanity-check the Web App, Step 5 — Create the Google Ads Script, Step 6 — Authorize (Ads Script side), Step 7 — Preview run (+3 more)

### Community 24 - "Community 24"
Cohesion: 0.33
Nodes (5): dependencies, enabledAdvancedServices, exceptionLogging, runtimeVersion, timeZone

### Community 25 - "Community 25"
Cohesion: 0.47
Nodes (3): runLandingPageScorer(), _scorePage(), testLandingPageScorer()

### Community 29 - "Community 29"
Cohesion: 0.50
Nodes (3): _audienceDetect_(), runAudienceAnalyst(), testAudienceAnalyst()

### Community 32 - "Community 32"
Cohesion: 0.50
Nodes (3): _perfDetect_(), runPerformanceAnalyst(), testPerformanceAnalyst()

### Community 35 - "Community 35"
Cohesion: 0.25
Nodes (7): getConfig(), isDryRun(), pickProvider(), testProviderRouting(), setupBrainNightlyTrigger(), runCategoryTrendSpotter(), testCategoryTrendSpotter()

### Community 39 - "Community 39"
Cohesion: 0.22
Nodes (9): Phase 4 — The Brain (Drive folder → indexed knowledge), Step 1 — Enable Drive Advanced Service (needed for PDF/DOCX support), Step 2 — Add the two Brain files to the project, Step 3 — Verify the LLM extraction works (no Drive needed), Step 4 — Verify BrainStore (writes a test row), Step 5 — Drop a real file in your Brain folder and index it, Step 6 — (Optional) Install the nightly trigger, Step 7 — Confirm Phase 4 is done (+1 more)

### Community 40 - "Community 40"
Cohesion: 0.40
Nodes (4): hooks, PreToolUse, permissions, allow

### Community 54 - "Community 54"
Cohesion: 0.22
Nodes (9): Phase 5 — Content Hunter (auto-curated PPC industry intel via RSS), Step 1 — (Optional cleanup) Remove the unused Reddit Hunter file, Step 2 — Re-paste `config` and `setup` to pick up the new Config defaults, Step 3 — Add `brain/ContentHunter.js` to your project, Step 4 — Sanity-check the feeds (no LLM, no Brain writes), Step 5 — Run the full pipeline, Step 6 — (Optional) Install the weekly trigger, Step 7 — Confirm Phase 5 is done (+1 more)

### Community 55 - "Community 55"
Cohesion: 0.39
Nodes (7): detectCrossAgentPatterns(), MergeLogEntry, ActionPlanRow, formatActionPlan(), clearActionPlan(), runSynthesis(), SynthesisResult

### Community 56 - "Community 56"
Cohesion: 0.31
Nodes (6): cluster(), Dedup, issueSignature(), similarEnough(), STOPWORDS, tokens()

### Community 57 - "Community 57"
Cohesion: 0.29
Nodes (5): BrainStore, BrainCurator, The Brain (Strategy KB), RSS Pivot from Reddit, ContentHunter

### Community 58 - "Community 58"
Cohesion: 0.25
Nodes (8): Architecture (very condensed), Key gotchas learned the hard way, Resume Brief — Read This First, Suggested first message from user on resume, Things that live in the cloud (not in this repo), What this project is (60-second summary), Where we are right now, Working principles (carry these into every session)

### Community 59 - "Community 59"
Cohesion: 0.25
Nodes (8): Phase 7 — Audit Batch 2 (4 copy + intel agents), Step 1 — (Optional) Add new Config row, Step 2 — Add the 4 agent files, Step 3 — Test one agent first, Step 4 — Run the full batch, Step 5 — Verify the Findings tab, Step 6 — Confirm Phase 7 is done, What this phase delivers

### Community 60 - "Community 60"
Cohesion: 0.29
Nodes (7): Phase 6 — Audit Batch 1 (4 audit agents), Step 1 — Add the shared agent scaffold, Step 2 — Add the 4 audit agent files, Step 3 — Test one agent in isolation first, Step 4 — Test all 4 in sequence, Step 5 — Confirm Phase 6 is done, What this phase delivers

### Community 61 - "Community 61"
Cohesion: 0.33
Nodes (6): Phase 3 — LLM helper (`callLLM` via Groq), Step 1 — Add `llm.js` to your Apps Script project, Step 2 — Run the end-to-end LLM test, Step 3 — (Optional) Quick wire-only check, Step 4 — Confirm Phase 3 is done, What this phase delivers

### Community 62 - "Community 62"
Cohesion: 0.40
Nodes (4): ActionMeta, deriveActionMeta(), TYPE_MAP, PRIORITY_RANK

### Community 63 - "Community 63"
Cohesion: 0.40
Nodes (5): PRIORITY_THRESHOLDS, SCORE_WEIGHTS, ImpactScorer._priority_, ImpactScorer.run, ImpactScorer._score_

### Community 65 - "Community 65"
Cohesion: 0.67
Nodes (3): pollReactions(), ReactionListener, testReactionListener()

### Community 66 - "Community 66"
Cohesion: 0.50
Nodes (3): orgId, projectId, projectName

### Community 67 - "Community 67"
Cohesion: 0.50
Nodes (3): Deploy on Vercel, Getting Started, Learn More

### Community 68 - "Community 68"
Cohesion: 0.67
Nodes (3): Phase 1 — Foundation (Sheet + Apps Script + Brain folder) ✅, Setup Guide — Google Ads Agent Fleet, What you do NOT need yet

## Knowledge Gaps
- **303 isolated node(s):** `allow`, `PreToolUse`, `allow`, `AgentCommon`, `Dedup` (+298 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **30 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RulesEngine` connect `Community 15` to `Community 17`, `Community 7`?**
  _High betweenness centrality (0.204) - this node is a cross-community bridge._
- **Why does `getConfig()` connect `Community 35` to `Community 32`, `Community 3`, `Community 36`, `Community 5`, `Community 7`, `Community 16`, `Community 27`, `Community 29`?**
  _High betweenness centrality (0.090) - this node is a cross-community bridge._
- **Why does `getConfig` connect `Community 17` to `Community 15`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Are the 14 inferred relationships involving `getConfig()` (e.g. with `_resolveWindowLabel_()` and `_audienceDetect_()`) actually correct?**
  _`getConfig()` has 14 INFERRED edges - model-reasoned connections that need verification._
- **What connects `allow`, `PreToolUse`, `allow` to the rest of the system?**
  _303 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.053821800090456805 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._