# Graph Report - web  (2026-06-12)

## Corpus Check
- 55 files · ~27,906 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 358 nodes · 744 edges · 21 communities (17 shown, 4 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
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

## God Nodes (most connected - your core abstractions)
1. `micros()` - 18 edges
2. `compilerOptions` - 16 edges
3. `main()` - 15 edges
4. `loadAccountData()` - 13 edges
5. `getTargets()` - 13 edges
6. `scripts` - 11 edges
7. `runImplementation()` - 11 edges
8. `getConfigValue()` - 11 edges
9. `runRuleBasedAnalyst()` - 11 edges
10. `SynthFinding` - 11 edges

## Surprising Connections (you probably didn't know these)
- `buildAudienceCopyAnalystSpec()` --calls--> `getConfigValue()`  [EXTRACTED]
  src/agents/analysts/audienceCopyAnalyst.ts → src/agents/rules/rulesEngine.ts
- `MarketIntelligenceData` --references--> `CampaignRow`  [EXTRACTED]
  src/agents/analysts/marketIntelligenceAnalyst.ts → src/agents/data.ts
- `formatDataForPrompt()` --calls--> `micros()`  [EXTRACTED]
  src/agents/analysts/marketIntelligenceAnalyst.ts → src/agents/data.ts
- `PerformanceBudgetData` --references--> `CampaignRow`  [EXTRACTED]
  src/agents/analysts/performanceBudgetAnalyst.ts → src/agents/data.ts
- `detectPerformanceBudget()` --calls--> `micros()`  [EXTRACTED]
  src/agents/analysts/performanceBudgetAnalyst.ts → src/agents/data.ts

## Import Cycles
- None detected.

## Communities (21 total, 4 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (28): AccountData, VALID_ACTIONS, Body, ConfigRow, ConfigTableProps, metadata, Body, actionPlan (+20 more)

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (33): BrainContextEntry, formatBrainContext(), queryBrain(), AnalystSpec, buildRuleSystemPrompt(), buildSystemPrompt(), Candidate, formatDataContext() (+25 more)

### Community 2 - "Community 2"
Cohesion: 0.12
Nodes (30): NegativeKeywordRow, readNegativeKeywords(), SearchTermRow, ApprovedItem, buildNegativeMatcher(), Context, deriveChanges(), DerivedChange (+22 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (25): Finding, Severity, SynthFinding, ActionMeta, deriveActionMeta(), TYPE_MAP, detectCrossAgentPatterns(), cluster() (+17 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (32): dependencies, drizzle-orm, next, postgres, react, react-dom, devDependencies, dotenv (+24 more)

### Community 5 - "Community 5"
Cohesion: 0.15
Nodes (23): loadAccountData(), readSearchTerms(), runPureLLMAnalyst(), main(), runAnalystSafely(), stampConfig(), todayUTC(), writeFindings() (+15 more)

### Community 6 - "Community 6"
Cohesion: 0.15
Nodes (22): AdGroupRow, AdRow, CampaignRow, ExtensionRow, KeywordRow, micros(), AudienceCopyData, detectAdCopy() (+14 more)

### Community 7 - "Community 7"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 8 - "Community 8"
Cohesion: 0.24
Nodes (16): backoffMs(), callGroq(), callLLM(), dailyTokenCeiling(), extractText(), GroqResponse, LLM, LLMOptions (+8 more)

### Community 9 - "Community 9"
Cohesion: 0.25
Nodes (14): cpa(), fmtCurrency(), getOverviewData(), Home(), KpiRow(), OverviewData, roas(), campaignsDaily (+6 more)

### Community 10 - "Community 10"
Cohesion: 0.24
Nodes (8): ActionPlanPage(), CATEGORIES, Category, fmtCurrency(), getCounts(), getRows(), PRIORITY_STYLES, STATUS_STYLES

### Community 11 - "Community 11"
Cohesion: 0.22
Nodes (4): BrainEntryProps, BrainFormProps, CATEGORIES, metadata

### Community 12 - "Community 12"
Cohesion: 0.25
Nodes (4): geistMono, geistSans, metadata, LINKS

### Community 13 - "Community 13"
Cohesion: 0.27
Nodes (12): mapAd(), mapAdGroup(), mapCampaign(), mapCampaignDaily(), mapExtension(), mapKeyword(), mapNegativeKeyword(), mapSearchTerm() (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.50
Nodes (3): Deploy on Vercel, Getting Started, Learn More

## Knowledge Gaps
- **107 isolated node(s):** `eslintConfig`, `nextConfig`, `name`, `version`, `private` (+102 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `micros()` connect `Community 6` to `Community 0`, `Community 9`, `Community 2`, `Community 5`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `getTargets()` connect `Community 5` to `Community 1`, `Community 10`, `Community 2`, `Community 9`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Why does `SynthFinding` connect `Community 3` to `Community 1`, `Community 5`, `Community 6`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **What connects `eslintConfig`, `nextConfig`, `name` to the rest of the system?**
  _107 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06009783368273934 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.10510510510510511 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.11586452762923351 - nodes in this community are weakly interconnected._