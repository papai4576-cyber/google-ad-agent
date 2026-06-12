# Google Ads Agent Fleet v2 — Master Brief

Read this file at the start of every session. It contains everything you need to know about this project.

> **v2 Status: COMPLETE (Phases A–J done, ready for Phase J parallel validation & cutover)**
>
> This project was originally built on Google Apps Script + Google Sheets (Phases 1–12, complete, kept in `apps_script/` for reference). **v2 rearchitecture is done**: Postgres + Next.js + GitHub Actions stack fully implemented and tested. v1 and v2 can run in parallel; cutover to v2 after Week 1 validation (Phase J). See `SETUP_AND_RUN_GUIDE.md` for step-by-step instructions on running the system end-to-end.

---

## What we are building

A fully autonomous, strategically intelligent multi-agent system that:
1. Collects Google Ads account data daily via a Google Ads Script (kept from v1, repointed to a new backend)
2. Runs 6 consolidated "Analyst" agents (down from 14 in v1) over that data, each expert in a domain group
3. Grounds every analysis in **The Brain** — a living knowledge base of strategy resources and curated PPC insight
4. Synthesizes findings into a prioritized P1/P2/P3 action plan with `action_category` (auto/manual/insight) and `action_type`
5. Surfaces the action plan on a Next.js web dashboard for human approval (no more Sheets, no more Slack reaction-polling)
6. Executes only approved `auto` changes via the Google Ads Script's execute mode, under the same safety rails as v1
7. Reports every change back via a change log, visible on the dashboard, with optional Slack notification

**Total infrastructure cost: ~$0/month** (Groq free tier, Google Ads Scripts free, Vercel free tier, Supabase/Neon free Postgres, GitHub Actions free for own repo)

---

## Quick Start

**New to this project?** Start here:
1. Read `SETUP_AND_RUN_GUIDE.md` — complete step-by-step to get the system running locally and in production
2. Run `npm run dev` to start the dashboard
3. For Phase J validation, use `npm run compare` daily and log in `PHASE_J_LOG.md`

**Detailed progress:** See `state/progress.json` (Phase A–J completion status and notes)

**Diagrams & architecture overview:** See `graphify-out/GRAPH_REPORT.md` or run `graphify query "<question>"` for scoped searches

---

## v2 Architecture

```
Google Ads Script (collect mode)         [kept from v1 — runs on Ads UI scheduler]
   │  GAQL: campaigns, campaigns_daily, ad_groups, keywords, ads,
   │        search_terms, extensions, negative_keywords
   │  POST /api/ingest  (Bearer secret)
   ▼
Next.js API routes (Vercel, free)  ──────────────────────────────┐
   │  /api/ingest          — writes raw snapshot tables           │
   │  /api/action-plan     — read for dashboard                   │
   │  /api/approve         — approve/reject from dashboard        │
   │  /api/pending-changes — GET, polled by Ads Script execute mode│
   │  /api/execute-result  — POST, results from Ads Script        │
   ▼                                                               │
Postgres (Supabase or Neon, free tier)                             │
   - raw snapshot tables (campaigns, keywords, ads, search_terms…) │
   - findings, action_plan, approvals, change_log,                 │
     pending_changes, brain_entries, config, token_usage           │
   ▲                                                               │
   │  read + write                                                 │
   │                                                                │
GitHub Actions (cron, free)  ──────────────────────────────────────┘
   - "daily-audit" (once/day): rules engines → 6 consolidated
       LLM Analysts (Groq) → dedup → cross-agent patterns →
       impact scoring → action_category/action_type → action_plan
       → optional Slack digest notification
   - "hourly-implementation" (hourly): derive pending_changes from
       newly approved 'auto' action_plan rows

Next.js Dashboard (Vercel, free) — password-gated
   - / (Overview)     — KPIs, budget pacing, 7d/30d/MTD charts
   - /action-plan     — sortable/filterable table, auto/manual/insight tabs, approve/reject
   - /history         — past runs, change log, before/after
   - /brain           — manage strategy knowledge entries
   - /config          — edit RULE_* / targets / safety rails

Google Ads Script (execute mode)         [kept from v1 — repointed]
   - polls GET /api/pending-changes (Bearer secret)
   - applies adjust_budget / add_negative via AdsApp
   - POST /api/execute-result
```

**Why GitHub Actions for the agent pipeline:** v1's 6-minute Apps Script ceiling forced heavy rules-engine optimization. GitHub Actions jobs run up to 6 hours, free for the user's own repo — removes the time pressure and lets analysis be more thorough.

**Why Postgres:** real relational queries for the dashboard, `jsonb` for evidence/headlines/key_points, room for `pgvector` later for Brain semantic search.

**Why no Slack reaction-polling:** the dashboard is the approval surface (buttons → `/api/approve`). Slack is now an optional one-way notification channel.

---

## The Brain — persistent strategic knowledge base (carried over from v1)

The Brain is what makes this system strategically intelligent rather than purely reactive. Every Analyst queries it before calling Groq.

### v2 storage

`brain_entries` table in Postgres (see schema below). Managed via the `/brain` dashboard page (add/edit entries directly — file upload via Drive indexing is deferred, lowest-value part of v1 to port).

### Brain entry schema

```json
{
  "id": "brain_001",
  "category": "copy|bidding|structure|scaling|brand|keywords|audience|competitive|landing_page|pmax|reddit_intel|general",
  "source": "filename or URL",
  "source_type": "upload|reddit|manual",
  "date_added": "YYYY-MM-DD",
  "title": "Short descriptive title",
  "summary": "2–3 sentence summary of the key insight",
  "key_points": ["point 1", "point 2", "point 3"],
  "raw_text": "Full extracted text"
}
```

### Brain categories and what goes in each

| Category | What to upload |
|----------|---------------|
| `copy` | Ad copy frameworks, headline formulas, CTAs, A/B test results, messaging guides |
| `bidding` | Bid strategy case studies, smart bidding guides, tROAS/tCPA setup notes |
| `structure` | Campaign structure guides, STAG/Alpha-Beta notes, naming conventions |
| `scaling` | Scaling playbooks, budget ramp guides, geo expansion frameworks |
| `brand` | Brand voice guide, messaging pillars, positioning docs, competitor differentiation |
| `keywords` | KW research methodology, match type guides, negative lists, taxonomy docs |
| `audience` | RLSA strategy, Customer Match setup, lookalike guides, audience stacking |
| `competitive` | Competitor analysis, auction insights interpretation, conquesting tactics |
| `landing_page` | CRO guides, landing page scoring rubrics, page speed notes |
| `pmax` | Performance Max optimization guides, asset group strategy, signal setup |
| `reddit_intel` | Reserved for future Reddit integration |
| `general` | Anything that doesn't fit a specific category |

---

## Strategy taxonomy — what this system knows (carried over from v1, unchanged)

### Bidding strategies (agents can recommend AND implement)
- Target CPA — lower bids when CPA > target, raise when CPA < target
- Target ROAS — optimize for conversion value relative to spend
- Maximize Conversions — volume over efficiency, good for new campaigns
- Maximize Conversion Value — revenue-focused, needs accurate values
- Enhanced CPC — hybrid manual + smart, safe transitional strategy
- Manual CPC — full control, needed for very low-volume campaigns
- Target Impression Share — brand defense / competitor conquesting
- Portfolio bid strategies — shared tCPA/tROAS across campaign groups

### Campaign structure strategies (recommend only — human implements)
- STAG (Single Theme Ad Groups) — current best practice, tight message match
- Alpha/Beta structure — proven winners in Alpha (exact), test in Beta (broad)
- Brand vs Non-brand separation — protect brand ROAS, manage non-brand CPA independently
- Search / PMax / Display / Video budget allocation frameworks
- Funnel-stage structure — awareness, consideration, conversion campaigns

### Keyword strategies (agents can recommend AND implement negatives/pauses)
- Broad match + Smart Bidding — let the algorithm find intent signals
- Exact match control — lock in proven converters, protect budget
- Search term harvesting — promote converting search terms to exact keywords
- Negative keyword mining — block irrelevant traffic draining budget
- Competitor conquesting — bid on competitor brand terms
- Match type migration — manage phrase/BMM consolidation correctly

### Copy strategies (agents can recommend; human/copy step implements)
- RSA pinning strategy — pin only when message must be fixed, let Google optimise otherwise
- Message-to-market match — align headline to the specific search intent
- Benefit vs feature framing — lead with outcomes, not product attributes
- Social proof insertion — reviews, trust signals, numbers
- CTA optimisation — action verbs, urgency, specificity
- Ad strength targeting — push all ads to "Excellent" via headline diversity
- USP rotation — test differentiation angles systematically

### Audience & scaling strategies (recommend + implement adjustments)
- RLSA layering — bid up on past visitors, converters, cart abandoners
- Customer Match — upload CRM list, bid up on known buyers
- Lookalike / Similar Audiences — expand reach to high-probability prospects
- In-market audience overlays — bid adjustments for people actively shopping
- Geographic bid adjustments — raise bids in high-converting regions
- Device bid adjustments — adjust for mobile vs desktop conversion rates
- Dayparting — concentrate spend in peak conversion hours
- Budget scaling ramp — 15–20% increases, not more, to avoid disrupting smart bidding

### Competitive strategies (recommend only)
- Brand defense — own your brand terms, prevent competitor conquest
- Auction insights tracking — monitor impression share, position above rate, overlap rate
- Competitor keyword targeting — bid on competitor names as non-brand
- Scheduling vs competitors — run ads when competitor share is lower

---

## Agent architecture — 14 agents (v1) → 6 Analysts (v2)

Each Analyst = one rules pass (if applicable) + **one** Groq call. Same universal findings schema, dedup, cross-agent patterns, and `ImpactScorer` formula carry over unchanged from v1 — port directly from `apps_script/agents/synthesis/DeduplicationAgent.js`, `ImpactScorer.js`, `apps_script/managers/SynthesisManager.js`.

| Analyst | Merges (v1 agents) | Pattern | Brain categories |
|---|---|---|---|
| **Performance & Budget Analyst** | PerformanceAnalyst, BidBudgetAnalyst, ConversionHealthChecker | rule-based, 1 LLM call | bidding, scaling, general |
| **Quality & Structure Analyst** | QualityScoreInspector, AccountStructureReviewer, ExtensionAuditor | rule-based, 1 LLM call | structure, copy, landing_page |
| **Audience & Copy Analyst** | AudienceAnalyst, AdCopyCritic | rule-based, 1 LLM call | audience, copy, brand |
| **Search Intelligence Analyst** | KeywordMiner, NegativeKwHunter, SearchTermPatternAnalyzer | pure LLM, 1 call, structured multi-section output | keywords, structure, audience |
| **Market Intelligence Analyst** | CompetitiveIntel, CategoryTrendSpotter | pure LLM, 1 call | competitive, brand, general, pmax |
| **Landing Page Scorer** | LandingPageScorer (unchanged) | LLM + URL fetch | landing_page, copy |

Result: **6 LLM calls/day** instead of 14, each with a richer prompt and bigger token budget per call (no 6-min ceiling), producing more specific `action` text.

Each Analyst module follows:
```typescript
interface AnalystSpec {
  name: string;
  rules?: (data: AccountData, cfg: RuleConfig) => Candidate[];  // ported detect_() functions
  brainCategories: string[];
  persona: string;
  instructions: string;
  formatDataForPrompt: (data: AccountData) => string;
}
runRuleBasedAnalyst(spec, data, cfg) -> Finding[]   // ported from runRuleBasedAgent (apps_script/agents/_common.js)
runPureLLMAnalyst(spec, data) -> Finding[]          // ported from runAgent (apps_script/agents/_common.js)
```

Port directly from `apps_script/` (load-bearing, validated logic):
- `RulesEngine.load(defaults)` pattern (`apps_script/rules/RulesEngine.js`) → reads `RULE_*` rows from the `config` table
- All `detect_()` rule functions from the v1 audit/copy agents, regrouped into the 6 Analysts above
- `DeduplicationAgent` (entity-bucket + Jaccard title clustering, ≥0.5 threshold)
- `ImpactScorer` (weights below)
- The 3 cross-agent patterns from `SynthesisManager.js`
- `_deriveActionMeta_()` from `apps_script/agents/synthesis/PlanFormatter.js` (action_category/action_type)
- Universal findings schema validation

---

## Rules-based detection — Config-tunable thresholds (carried over from v1)

All `RULE_*` keys are read from the `config` table via `RulesEngine.load(defaults)`. Defaults are used if the key is missing. To tune a threshold, add/edit a row in `config`: key `RULE_<KEY>`, value `<value>`.

| Key | Default | Used by |
|-----|---------|---------|
| `RULE_BUDGET_LOST_IS` | 0.30 | Performance & Budget Analyst — budget-capped threshold |
| `RULE_RANK_LOST_IS` | 0.40 | Performance & Budget Analyst — rank-capped threshold |
| `RULE_MIN_CONV_ROAS` | 50 | Performance & Budget Analyst — min conv for tROAS to be trustworthy |
| `RULE_MIN_CONV_CPA` | 30 | Performance & Budget Analyst — min conv for tCPA to be trustworthy |
| `RULE_IDLE_SPEND_RATIO` | 0.50 | Performance & Budget Analyst — idle budget detection |
| `RULE_QS_MIN_COST` | 5 | Quality & Structure Analyst — min spend to flag low QS |
| `RULE_QS_MAX` | 5 | Quality & Structure Analyst — QS at or below this = "low" |
| `RULE_QS_P1_COST` | 50 | Quality & Structure Analyst — spend above this = P1 |
| `RULE_CPA_OVERAGE_RATIO` | 1.5 | Performance & Budget Analyst — CPA multiple above target |
| `RULE_ROAS_SHORTFALL_RATIO` | 0.70 | Performance & Budget Analyst — ROAS fraction below target |
| `RULE_PERF_SPEND_FLOOR` | 5000 | Performance & Budget Analyst — zero-conv spend threshold |
| `RULE_CTR_FLOOR_RATIO` | 0.40 | Performance & Budget Analyst — CTR vs channel median floor |
| `RULE_PACING_TOLERANCE` | 0.30 | Performance & Budget Analyst — budget pacing ±30% OOB |
| `RULE_CAPPED_UNDERPERF_IS` | 0.20 | Performance & Budget Analyst — budget-capped + ROAS underperform |
| `RULE_BRAND_ROAS_MULTIPLIER` | 3.0 | Audience & Copy Analyst — brand vs non-brand ROAS gap |
| `RULE_RLSA_MIN_CLICKS` | 300 | Audience & Copy Analyst — clicks floor for RLSA flag |
| `RULE_LOOKALIKE_MIN_CONV` | 30 | Audience & Copy Analyst — min conv for lookalike seeding |
| `RULE_AUDIENCE_SHOP_SPEND` | 5000 | Audience & Copy Analyst — Shopping spend for Customer Match flag |
| `RULE_AD_CTR_FLOOR_RATIO` | 0.40 | Audience & Copy Analyst — ad CTR vs ad-group median |
| `RULE_AD_MIN_IMPR` | 200 | Audience & Copy Analyst — min impressions for CTR comparison |
| `RULE_MAX_ADGROUPS_PER_CAMPAIGN` | 30 | Quality & Structure Analyst |
| `RULE_MAX_KEYWORDS_PER_ADGROUP` | 20 | Quality & Structure Analyst |
| `RULE_MIN_ACTIVE_ADS` | 2 | Quality & Structure Analyst — ad safety rail |
| `RULE_MIN_SPEND_CONCENTRATION` | 1000 | Quality & Structure Analyst — single-ad-group concentration risk |
| `BRAND_KEYWORDS` | (empty) | Audience & Copy Analyst — comma-separated brand keywords for campaign classification |

---

## Universal agent output schema (unchanged from v1)

Every Analyst returns findings in this structure (stored as rows in the `findings` table):

```json
{
  "agent": "analyst_name",
  "run_date": "YYYY-MM-DD",
  "mode": "daily|weekly",
  "findings": [
    {
      "id": "unique_id",
      "category": "performance|keywords|copy|structure|bidding|audience|extensions|competitive|landing_page|general|scaling",
      "severity": "P1|P2|P3",
      "title": "Short action title",
      "what": "What is wrong or what opportunity exists",
      "why": "Why it matters — quantified where possible",
      "action": "Exact change to make",
      "target": {"type": "campaign|adgroup|keyword|ad", "id": "...", "name": "..."},
      "estimated_impact": {"metric": "CPA|ROAS|CTR|spend", "direction": "up|down", "magnitude": "low|medium|high"},
      "confidence": "high|medium|low",
      "effort": "easy|medium|hard",
      "evidence": ["data point 1", "data point 2"],
      "brain_sources": ["brain_001", "brain_042"]
    }
  ],
  "summary": "One sentence summary",
  "token_count": 0,
  "run_time_ms": 0
}
```

`brain_sources` tracks which Brain entries informed each finding — full traceability.

---

## Impact scoring formula (unchanged from v1)

```typescript
const WEIGHTS = {
  magnitude:  { high: 3, medium: 2, low: 1 },
  confidence: { high: 1.0, medium: 0.7, low: 0.4 },
  effort:     { easy: 1.0, medium: 1.5, hard: 2.5 },
};

function score(finding) {
  return (WEIGHTS.magnitude[finding.estimated_impact.magnitude]
        * WEIGHTS.confidence[finding.confidence])
       / WEIGHTS.effort[finding.effort];
}

// P1: score >= 2.0  → act today
// P2: 1.0 – 1.99   → this week
// P3: < 1.0         → consider
```

---

## Action classification — `action_category` / `action_type`

Every `action_plan` row carries:
- `action_category`: `auto` (implementable via Google Ads Script execute mode under safety rails), `manual` (human must act — e.g. structural changes), or `insight` (informational only, e.g. competitive/trend findings)
- `action_type`: specific operation, e.g. `add_negatives`, `increase_budget`, `decrease_budget`, `adjust_bid`, `pause_keyword`, `pause_ad`, `read_insight`, etc.

Logic ported from `_deriveActionMeta_()` in `apps_script/agents/synthesis/PlanFormatter.js`.

---

## Safety rules for implementation — NON-NEGOTIABLE (unchanged from v1)

1. **Never delete** — only pause (ads, keywords, ad groups, extensions)
2. **Bid limit**: max ±30% change per run
3. **Budget limit**: max 20% of campaign daily budget moved per run
4. **Ad minimum**: ad group must retain ≥ 2 active ads before pausing any ad
5. **Dry-run**: if `config.DRY_RUN = true` → log to `change_log` but never mutate
6. **Change log**: every mutate appends a row to `change_log` (before/after/agent/timestamp)
7. **Approval check**: read `action_plan.status` (must be `approved`) before every mutate — skip if not approved

---

## Database schema (Postgres) — `web/src/db/schema.ts` is authoritative

Direct ports of the v1 Sheet schemas, with `*_json` columns becoming `jsonb`. Tables:
`campaigns`, `campaigns_daily`, `ad_groups`, `keywords`, `ads`, `search_terms`, `extensions`, `negative_keywords` (raw snapshots, replaced wholesale on each collect run, except `campaigns_daily` which appends/upserts by date), and `findings`, `action_plan`, `approvals`, `pending_changes`, `change_log`, `brain_entries`, `config`, `token_usage` (agent layer).

**Budget bug fix (the original motivation for v2):** the Overview page computes "today's total daily budget" as `SUM(budget_micros) WHERE status='ENABLED'` from `campaigns`, AND displays `updated_at` (last collection timestamp) next to it so staleness is visible. Pacing is computed from `campaigns_daily`, not the snapshot, so it stays internally consistent.

---

## Project folder structure (v2)

```
google-ads-agent/
├── CLAUDE.md
├── state/
│   └── progress.json               # v2 Phase A–J tracker
│
├── google_ads_script.js            # ← paste into Google Ads → Tools → Scripts (kept from v1)
│                                   #   mode=collect: POSTs to /api/ingest
│                                   #   mode=execute: polls /api/pending-changes
│
├── apps_script/                    # LEGACY v1 (Apps Script + Sheets) — kept for reference until cutover (Phase J)
│
└── web/                             # Next.js app (Vercel)
    ├── drizzle.config.ts
    ├── src/
    │   ├── db/
    │   │   ├── schema.ts            # Drizzle schema — authoritative DB shape
    │   │   └── index.ts             # db client
    │   ├── app/
    │   │   ├── page.tsx              # Overview (KPIs, budget pacing)
    │   │   ├── action-plan/          # Action Plan page (approve/reject)
    │   │   ├── history/              # Past runs, change log
    │   │   ├── brain/                # Brain entry management
    │   │   ├── config/                # RULE_* / targets editor
    │   │   └── api/
    │   │       ├── ingest/route.ts
    │   │       ├── action-plan/route.ts
    │   │       ├── approve/route.ts
    │   │       ├── pending-changes/route.ts
    │   │       └── execute-result/route.ts
    │   └── agents/                    # Agent pipeline (run by GitHub Actions)
    │       ├── analysts/              # 6 Analyst modules
    │       ├── synthesis/             # dedup, cross-agent patterns, scoring, action-meta
    │       ├── rules/                 # ported RulesEngine + detect_() functions
    │       └── llm.ts                 # Groq client
    └── .github/workflows/
        ├── daily-audit.yml
        └── hourly-implementation.yml
```

---

## Phased Roadmap (v2)

| Phase | Deliverable | Status |
|---|---|---|
| **A** | Repo scaffold: Next.js app + Drizzle schema + Supabase project + Vercel deploy | in progress |
| **B** | `/api/ingest` route + repoint `google_ads_script.js` POST URL/secret | ✅ done |
| **C** | Port shared infra to TS: rules engine, findings schema, Groq client, dedup, impact scorer, action-meta classifier | ✅ done |
| **D** | Build Performance & Budget Analyst + Quality & Structure Analyst | ✅ done |
| **E** | Build Audience & Copy Analyst + Search Intelligence Analyst + Market Intelligence Analyst + Landing Page Scorer | ✅ done |
| **F** | Synthesis pipeline + `daily-audit` GitHub Actions workflow, end-to-end with real data | ✅ done |
| **G** | Dashboard: Overview (budget bug fixed) + Action Plan page with approve/reject | ✅ done |
| **H** | `/api/pending-changes` + `/api/execute-result` + repoint execute mode + `hourly-implementation` workflow | ✅ done |
| **I** | Slack digest notification + `/history`, `/brain`, `/config` pages | ✅ done |
| **J** | Parallel-run validation vs v1 → cutover → decommission `apps_script/` | 🔄 in progress |

---

## How to work on this project

- Always check `state/progress.json` first to know where we are
- Build **one phase at a time** — complete it, test it, then move on
- Every file must be immediately runnable — no TODOs or placeholders
- Each Analyst is independent: receives data object + brain context, returns findings array, no shared state
- All output logged with timestamps for debugging
- **Approval check is sacred** — no code path mutates Google Ads without `action_plan.status = 'approved'`
- **Brain context is mandatory** — every Analyst must query `brain_entries` before building its Groq prompt
- After each phase that adds/moves significant code, run `graphify update .` to keep the knowledge graph current

---

## Build phases — v1 (Apps Script + Sheets), all complete, kept for reference

| # | Phase | Key output | Status |
|---|-------|-----------|--------|
| 1–11 | Foundation through Synthesis layer | Sheet schema, data collector, Brain, 14 audit/copy agents, dedup + scoring | ✅ done |
| 12 | Slack approval gate | Plan posted to Slack, reactions read, Approvals tab updated | ✅ done |
| 13 | Implementation fleet | Dry-run + live mutate via Google Ads Script execute mode | ✅ done (v1 only) |

The v1 implementation lives entirely under `apps_script/` and remains functional. v2 is complete and ready to run in parallel for Phase J validation.

---

## v2 Completion Summary (Phases A–I Done, Phase J In Progress)

✅ **Fully built and tested:**
- Next.js dashboard (7 pages: /, /action-plan, /history, /brain, /config + 2 internal pages)
- 6 consolidated Analyst agents (3 rule-based, 3 pure-LLM)
- Full synthesis pipeline (dedup, cross-agent patterns, impact scoring, action classification)
- GitHub Actions automation (daily-audit at 06:00 UTC, hourly-implementation every hour)
- API endpoints for data collection (/api/ingest), approvals (/api/approve), execution (/api/pending-changes, /api/execute-result)
- Safety rails (budget caps, bid limits, dry-run mode, approval gates)
- Slack notifications (optional digest when action items ready)
- Brain knowledge base (add/edit/delete strategy entries)
- Config editor (tune RULE_* thresholds in dashboard)

🔄 **Phase J (Validation & Cutover):**
- Both v1 and v2 run in parallel (same Google Ads Script collects to both)
- Daily spot-check script (`npm run compare`) for findings validation
- Week-long parallel-run logs and go/no-go checklist
- Cutover procedure (repoint Ads Script to v2, disable v1 jobs, monitor)
- Decommissioning checklist (update docs, mark v1 as archived)

**To start using v2:** Follow `SETUP_AND_RUN_GUIDE.md` step-by-step

---

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
