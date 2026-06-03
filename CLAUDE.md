# Google Ads Agent Fleet — Master Brief

Read this file at the start of every session. It contains everything you need to know about this project.

---

## What we are building

A fully autonomous, strategically intelligent multi-agent system that:
1. Audits a Google Ads account daily (lightweight) and weekly (deep-dive)
2. Runs 15 specialized agents in parallel, each expert in one domain
3. Grounds every analysis in **The Brain** — a living knowledge base of strategy resources, case studies, and auto-curated PPC blog intelligence you curate over time
4. Synthesizes findings into a prioritized P1/P2/P3 action plan
5. Sends each action item to Slack for human approval (✅/❌ reactions)
6. Executes only approved changes via 6 write agents with strict safety rails
7. Reports every change back to Slack with before/after values
8. Maintains a live Google Sheets dashboard with all data, findings, history, and brain entries

**Total infrastructure cost: ~$0/month** (Groq free tier, Google Ads Scripts free, Apps Script free, Sheets free, Slack free)

---

## Current build status

Check `state/progress.json` for last completed phase.

If `state/progress.json` does not exist → we are at Phase 0. Start Phase 1.

---

## Architecture overview

```
Google Ads Script  (JavaScript, runs inside Google Ads UI on a schedule)
│
│  Collects all account data → writes to Google Sheets Raw_* tabs
│  Triggers Google Apps Script Web App via HTTP POST
│
└──▶ Google Apps Script Web App  (JavaScript, free, attached to Google Sheet)
          │
          ├── Brain Curator     → indexes Drive folder, ContentHunter pulls PPC blog RSS weekly
          ├── Data Manager      → reads & normalises Raw_* tabs
          ├── Audit Manager     → 7 audit agents (each gets Brain context + live data)
          ├── Copy & Intel Mgr  → 7 copy/intel agents (each gets Brain context)
          ├── Synthesis Manager → dedup + impact score + format plan
          │
          ├── ══ SLACK GATE ══  (hard stop — no code path bypasses this)
          │       Posts each action item to Slack with context
          │       Reads ✅/❌ reactions (polls every 30 min)
          │
          └── Implementation Manager
                    Reads Approvals sheet before every mutate
                    Calls back into Google Ads Script execute endpoint
                    Logs every change to Change_Log sheet
                    Reports to Slack with before/after values
```

---

## The Brain — persistent strategic knowledge base

The Brain is what makes this system strategically intelligent rather than purely reactive.
Every agent queries it before calling Groq. Groq sees live account data AND curated strategy context together.

### How it works

1. You drop files (PDFs, Google Docs, articles, notes, screenshots) into a Google Drive folder called **"Ads Agent Brain"** at any time.
2. A nightly Apps Script job (`BrainCurator.js`) scans that folder, extracts text, chunks it, and indexes it into the `Brain` sheet tab.
3. Each agent, before building its Groq prompt, calls `queryBrain(category)` to fetch the top relevant chunks for its domain.
4. The Reddit Hunter Agent runs weekly, harvests strategy insights from Reddit, and adds them to the Brain automatically under `reddit_intel`.

### Brain entry schema (one row per chunk in the Brain sheet tab)

```json
{
  "id": "brain_001",
  "category": "copy|bidding|structure|scaling|brand|keywords|audience|competitive|landing_page|pmax|reddit_intel|general",
  "source": "filename or reddit post URL",
  "source_type": "upload|reddit|manual",
  "date_added": "YYYY-MM-DD",
  "title": "Short descriptive title",
  "summary": "2–3 sentence summary of the key insight",
  "key_points": ["point 1", "point 2", "point 3"],
  "raw_text": "Full extracted text (truncated to 2000 chars)"
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
| `reddit_intel` | Auto-populated by Reddit Hunter Agent weekly |
| `general` | Anything that doesn't fit a specific category |

---

## Strategy taxonomy — what this system knows

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

### Copy strategies (agents can recommend; copy_uploader implements)
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

## Manager hierarchy

```
Campaign Director
├── Brain Curator → [Drive indexer, Reddit Hunter]
├── Data Manager → [Ads fetcher, Search Console, Trends, SERP watcher]
├── Audit Manager → [Performance, Bid/Budget, QS, Conversion, Audience, Structure, Extensions]
├── Copy & Intel Manager → [Copy critic, KW miner, Negative KW, Search terms, Competitive, Trends, Landing page]
├── Synthesis Manager → [Dedup, Impact scorer, Plan formatter]
├── [SLACK GATE — hard stop — no code bypasses this]
└── Implementation Manager → [KW implementer, Bid adjuster, Copy uploader, Audience adjuster, Budget reallocator, Extension manager]
```

---

## Full agent list (15 agents)

### Brain layer (runs before all audits)
| Agent | Domain | Frequency |
|-------|--------|-----------|
| Brain Curator | Indexes Drive uploads, refreshes Reddit intel | Nightly + weekly |
| **Content Hunter** | Monitors PPC industry blog RSS (PPC Hero, Search Engine Land, Search Engine Journal, WordStream) | Weekly |

### Data layer (no LLM — pure data collection)
| Agent | Domain | Output |
|-------|--------|--------|
| Ads Fetcher | Campaigns, ad groups, keywords, ads, search terms | Raw_* sheet tabs |
| Search Console Fetcher | Organic queries, CTR, position | Raw_SearchConsole tab |
| Trends Fetcher | Category search volume trends via Google Trends | Raw_Trends tab |
| SERP Watcher | Competitor ad copy from live SERPs (weekly) | Raw_Serp tab |

### Audit agents (each = Groq call grounded in Brain + live data)
| Agent | Domain | Key questions answered |
|-------|--------|----------------------|
| Performance Analyst | Campaign/ad group metrics | What's underperforming vs targets? Where is CPA/ROAS off? |
| Bid & Budget Analyst | Bidding strategy, budget distribution | Is budget allocated to best performers? Are bids leaving money on the table? |
| Quality Score Inspector | QS, ad relevance, landing page exp, expected CTR | Which keywords have low QS dragging up costs? |
| Conversion Health Checker | Conversion tracking, attribution, value | Is tracking firing correctly? Are values accurate? |
| Audience Analyst | Audience overlaps, RLSA, Customer Match | Audience opportunities or over-targeting? |
| Account Structure Reviewer | Campaign/ad group architecture | Structural inefficiencies, consolidation opportunities? |
| Extension Auditor | Sitelinks, callouts, structured snippets, promos | Missing or underperforming extensions? |

### Copy & Intel agents (each = Groq call grounded in Brain + live data)
| Agent | Domain | Key questions answered |
|-------|--------|----------------------|
| Ad Copy Critic | RSA headlines, descriptions, ad strength | Which ads underperform? What copy angles to test? |
| Keyword Miner | Search term → keyword opportunity gaps | Which converting search terms aren't yet keywords? |
| Negative KW Hunter | Irrelevant search terms draining budget | What negatives should be added immediately? |
| Search Term Pattern Analyzer | Query intent clusters, theme gaps | What intent patterns are we missing or wasting on? |
| Competitive Intel | SERP competitor ad copy, positioning | What are competitors saying? Where's our differentiation gap? |
| Category Trend Spotter | Rising/falling search trends in the category | What should we be ahead of in the next 30–60 days? |
| Landing Page Scorer | URL crawl, load speed, message match, CRO | Where is post-click experience killing conversions? |

### Reddit Hunter Agent — detail
- **Sources:** r/PPC, r/googleads, r/marketing, r/entrepreneur (top posts, week/month filters)
- **Reddit API:** Public JSON endpoint (`reddit.com/r/PPC/top.json?t=week`) — no auth needed
- **Filter criteria:** upvotes > 50, contains strategy keywords (ROAS, CPA, scaling, structure, what's working, case study)
- **Groq extracts:** core insight, applicable strategy category, account size/type context, confidence level
- **Output:** Brain entries under `reddit_intel` category
- **Slack summary:** Weekly digest of top 5 Reddit strategy insights, posted Sunday alongside weekly audit

---

## Technology stack

| Need | Tool | Cost |
|------|------|------|
| Data collection | Google Ads Script (JavaScript, built into Google Ads UI) | Free |
| Scheduling | Google Ads Script built-in scheduler (daily/weekly) | Free |
| Orchestration | Google Apps Script (Web App, attached to Google Sheet) | Free |
| LLM analysis (all 15 agents) | Groq API — Llama 3.3 70B Versatile (14,400 free req/day, ~1000 tokens/sec) | Free |
| Brain document indexing | Google Drive API via Apps Script | Free |
| Reddit intel | Reddit public JSON API via UrlFetchApp | Free |
| Dashboard + state storage | Google Sheets (15 tabs) | Free |
| Approval gate | Slack Bot — posts items, reads ✅/❌ reactions | Free |
| Change reporting | Slack incoming webhook | Free |

---

## Project folder structure

```
google-ads-agent/
├── CLAUDE.md
├── SETUP.md                        # Step-by-step human setup guide
├── state/
│   └── progress.json               # Build phase tracker
│
├── google_ads_script.js            # ← paste into Google Ads → Tools → Scripts
│                                   #   mode=collect: data fetch
│                                   #   mode=execute: approved mutates
│
└── apps_script/                    # ← Google Apps Script project (clasp or copy-paste)
    ├── Code.js                     # Web App entry (doPost/doGet) + Campaign Director
    ├── config.js                   # Script Properties wrapper + all constants
    │
    ├── managers/
    │   ├── BrainCurator.js         # Drive indexer + Reddit Hunter orchestrator
    │   ├── DataManager.js
    │   ├── AuditManager.js
    │   ├── CopyIntelManager.js
    │   ├── SynthesisManager.js
    │   └── ImplementationManager.js
    │
    ├── brain/
    │   ├── BrainStore.js           # queryBrain(category, limit), addEntry(), refreshIndex()
    │   └── RedditHunter.js         # fetches Reddit, extracts insights via Groq
    │
    ├── agents/
    │   ├── fetchers/
    │   │   ├── AdsFetcher.js
    │   │   ├── SearchConsoleFetcher.js
    │   │   ├── TrendsFetcher.js
    │   │   └── SerpWatcher.js
    │   │
    │   ├── audit/
    │   │   ├── PerformanceAnalyst.js
    │   │   ├── BidBudgetAnalyst.js
    │   │   ├── QualityScoreInspector.js
    │   │   ├── ConversionHealthChecker.js
    │   │   ├── AudienceAnalyst.js
    │   │   ├── AccountStructureReviewer.js
    │   │   └── ExtensionAuditor.js
    │   │
    │   ├── copy_intel/
    │   │   ├── AdCopyCritic.js
    │   │   ├── KeywordMiner.js
    │   │   ├── NegativeKwHunter.js
    │   │   ├── SearchTermPatternAnalyzer.js
    │   │   ├── CompetitiveIntel.js
    │   │   ├── CategoryTrendSpotter.js
    │   │   └── LandingPageScorer.js
    │   │
    │   ├── synthesis/
    │   │   ├── DeduplicationAgent.js
    │   │   ├── ImpactScorer.js
    │   │   └── PlanFormatter.js
    │   │
    │   └── implementation/
    │       ├── KeywordImplementer.js
    │       ├── BidAdjuster.js
    │       ├── CopyUploader.js
    │       ├── AudienceAdjuster.js
    │       ├── BudgetReallocator.js
    │       └── ExtensionManager.js
    │
    ├── llm.js                      # callLLM(prompt, schema) Groq wrapper — used by all agents
    │
    └── slack/
        ├── PlanSender.js
        ├── ReactionListener.js
        └── ChangeReporter.js
```

---

## Google Sheets tab layout (15 tabs)

| Tab name | Written by | Contains |
|----------|-----------|---------|
| `Dashboard` | Apps Script | KPI summary, trend charts, last-run status, Reddit top insights |
| `Brain` | BrainCurator | All indexed knowledge chunks (uploads + Reddit intel) |
| `Raw_Campaigns` | Google Ads Script | Campaign metrics, budgets, bid strategies |
| `Raw_AdGroups` | Google Ads Script | Ad group metrics, bids |
| `Raw_Keywords` | Google Ads Script | Keyword text, match type, QS, metrics |
| `Raw_Ads` | Google Ads Script | RSA headlines, descriptions, metrics |
| `Raw_SearchTerms` | Google Ads Script | Search term report, match status |
| `Raw_Extensions` | Google Ads Script | Sitelinks, callouts, structured snippets |
| `Raw_SearchConsole` | SearchConsoleFetcher | Organic queries, CTR, position |
| `Raw_Trends` | TrendsFetcher | Category interest over time |
| `Findings` | All 15 agents | Date-stamped finding rows with full schema |
| `Action_Plan` | SynthesisManager | Scored P1/P2/P3 items with Slack message IDs |
| `Approvals` | ReactionListener | Per-item approval status + timestamp |
| `Change_Log` | Implementation agents | Every mutate: before/after, agent, timestamp |
| `Config` | Human (manual) | Targets, safety limits, Drive folder ID, Slack channel |

---

## How each agent works (implementation pattern)

Every agent is a JavaScript function that:
1. Receives a structured `data` object (from relevant Sheets tabs)
2. Calls `queryBrain(category)` → fetches top-N relevant Brain chunks
3. Builds a domain-expert prompt for Groq (Llama 3.3 70B Versatile) with BOTH live data AND brain context
4. Parses Groq's JSON response into the universal findings schema
5. Returns an array of finding objects

```javascript
// Pattern every agent follows
function runPerformanceAnalyst(data) {
  const brainContext = BrainStore.query(['performance', 'bidding', 'scaling'], 5);
  const prompt = buildPrompt(data, brainContext);  // data + strategy knowledge
  const raw = callLLM(prompt, FINDINGS_SCHEMA);
  return parseFindings(raw);
}
```

---

## Universal agent output schema (unchanged)

Every agent returns findings in this structure (stored as rows in the `Findings` sheet):

```json
{
  "agent": "agent_name",
  "run_date": "YYYY-MM-DD",
  "mode": "daily|weekly",
  "findings": [
    {
      "id": "unique_id",
      "category": "performance|keywords|copy|structure|bidding|audience|extensions|competitive",
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

Note: `brain_sources` tracks which Brain entries informed each finding — full traceability.

---

## Impact scoring formula (synthesis layer — unchanged)

```javascript
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

## Safety rules for implementation agents — NON-NEGOTIABLE

1. **Never delete** — only pause (ads, keywords, ad groups, extensions)
2. **Bid limit**: max ±30% change per run
3. **Budget limit**: max 20% of campaign daily budget moved per run
4. **Ad minimum**: ad group must retain ≥ 2 active ads before pausing any ad
5. **Dry-run**: if Config sheet `DRY_RUN = true` → log to Change_Log but never mutate
6. **Change log**: every mutate appends a row to Change_Log sheet (before/after/agent/timestamp)
7. **Approval check**: read Approvals sheet before every mutate — skip if not approved

---

## Slack approval flow

1. `PlanSender.js` posts one Slack message per P1/P2 action item (P3 batched in a weekly digest)
2. Each message includes: title, what, why, exact action, target, estimated impact, Brain sources used
3. You react ✅ to approve or ❌ to reject
4. `ReactionListener.js` runs every 30 min via time trigger — reads reactions, writes to Approvals sheet
5. `ImplementationManager.js` checks Approvals sheet before every mutate
6. `ChangeReporter.js` posts confirmation to Slack after each executed change (before → after)

---

## Google Ads Script — two modes

| Mode | Triggered by | Does |
|------|-------------|------|
| `collect` | Scheduler (daily 2 AM, weekly Sunday 1 AM) | Fetches all data → writes Sheets → triggers Apps Script Web App |
| `execute` | Apps Script Web App HTTP call | Reads approved actions from Sheets → calls Google Ads API mutates |

---

## Script Properties (replaces .env)

Set in Apps Script → Project Settings → Script Properties:

```
GROQ_API_KEY                = (from console.groq.com — free)
SLACK_BOT_TOKEN             =
SLACK_WEBHOOK_URL           =
SLACK_CHANNEL_ID            =
SPREADSHEET_ID              = (your Google Sheet ID)
BRAIN_DRIVE_FOLDER_ID       = (Google Drive folder "Ads Agent Brain")
ADS_SCRIPT_EXECUTE_URL      = (URL of Google Ads Script execute endpoint)
DRY_RUN                     = false
MONTHLY_BUDGET_TARGET       = 5000
TARGET_CPA                  = 50
TARGET_ROAS                 = 4.0
```

Set in Google Ads Script (top-of-file constants):

```javascript
const APPS_SCRIPT_WEBHOOK_URL = '...';  // Apps Script Web App URL
const SPREADSHEET_ID          = '...';  // same Sheet
const MODE                    = 'collect'; // 'collect' | 'execute'
```

---

## Build phases (revised)

| # | Phase | Key output |
|---|-------|-----------|
| 1 | Foundation — Sheet schema + config skeleton | Google Sheet created with all 15 tabs, Script Properties set |
| 2 | Google Ads Script — data collector (`collect` mode) | All Raw_* tabs populated on manual run |
| 3 | Apps Script Web App + Groq helper | `callLLM()` works, `doPost()` responds |
| 4 | Brain layer — BrainStore + BrainCurator + Drive indexer | Brain tab populates from Drive folder uploads |
| 5 | Reddit Hunter Agent | Weekly Reddit fetch → Brain entries + Slack digest |
| 6 | Audit batch 1 — Performance, Bid, QS, Conversion | 4 agents write to Findings tab (with Brain context) |
| 7 | Audit batch 2 — Copy, Keywords, Negatives, Patterns | 4 agents + copy suggestions (with Brain context) |
| 8 | Audit batch 3 — Audience, Structure, Extensions, Competitive, Trends, Landing page | 6 agents (with Brain context) |
| 9 | Audit Manager + Copy & Intel Manager | All 14 audit agents run in sequence within their manager |
| 10 | Synthesis layer — dedup + score + format | Scored Action_Plan tab populated |
| 11 | Slack approval gate | Plan posted to Slack, reactions read, Approvals tab updated |
| 12 | Implementation fleet — 6 write agents + Google Ads Script execute mode | Dry-run passes, 1 live test change |
| 13 | Dashboard tab — KPIs + trend charts + Brain activity | Live dashboard visible in Sheets |
| 14 | Scheduling + end-to-end test | Fully autonomous daily + weekly runs |

---

## How to work on this project

- Always check `state/progress.json` first to know where we are
- Build **one phase at a time** — complete it, test it, then move on
- Every file must be immediately runnable — no TODOs or placeholders
- Each agent is independent: receives data object + brain context, returns findings array, no shared state
- Fail loudly with descriptive error messages written to both Apps Script logs and the Dashboard tab
- All output logged with timestamps for debugging
- **The Slack gate is sacred** — no code path in ImplementationManager runs without checking the Approvals sheet
- **Brain context is mandatory** — every audit/copy agent must call `BrainStore.query()` before building its Groq prompt

---

## Key references during build

- **Agent output schema**: "Universal agent output schema" section above
- **Scoring formula**: "Impact scoring formula" section above
- **Safety rules**: "Safety rules" section above — enforce these first in every implementation agent
- **Sheets layout**: "Google Sheets tab layout" section above
- **Agent pattern**: "How each agent works" section above
- **Brain schema**: "Brain entry schema" section above
- **Strategy taxonomy**: "Strategy taxonomy" section above — agents reference this when framing recommendations
