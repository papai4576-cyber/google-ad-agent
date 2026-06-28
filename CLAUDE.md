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
6. Executes only approved `auto` changes via the real Google Ads API (`web/src/agents/googleAdsClient.ts`), under the same safety rails as v1 — approving on the dashboard is now sufficient; no manual follow-through in the Ads UI (see "Execute-mode migration" below)
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
   │  /api/pending-changes — @deprecated, see below                │
   │  /api/execute-result  — @deprecated, see below                │
   ▼                                                               │
Postgres (Supabase or Neon, free tier)                             │
   - raw snapshot tables (campaigns, keywords, ads, search_terms…) │
   - findings, action_plan, approvals, change_log,                 │
     pending_changes, brain_entries, config, token_usage           │
   ▲                                                               │
   │  read + write                                                 │
   │                                                                │
GitHub Actions (cron, free)  ──────────────────────────────────────┘
   - "daily-audit" (CRON CURRENTLY PAUSED — workflow_dispatch only, see
       "Operational status" below; was 06:00 UTC daily): rules engines →
       6 consolidated LLM Analysts (multi-provider, see below) → dedup →
       cross-agent patterns → business-rules gate → recommendation
       validator agent → impact scoring → action_category/action_type →
       action_plan → optional Slack digest notification
   - "hourly-implementation" (hourly): for newly approved 'auto'
       action_plan rows, calls the Google Ads API DIRECTLY via
       googleAdsClient.ts (see "Execute-mode migration" below) —
       no queue/poll handshake with a script anymore
   - "weekly-brain-learning" (Mondays 07:00 UTC): autonomous Brain
       Learning Agent — discovers candidate brain_entries from account
       data, approved-findings feedback, and Groq compound-beta web
       search; writes them status='staged' for human review at /brain

Next.js Dashboard (Vercel, free) — password-gated
   - / (Overview)     — KPIs, budget pacing, 7d/30d/MTD charts
   - /action-plan     — sortable/filterable table, auto/manual/insight tabs, approve/reject
   - /history         — past runs, change log, before/after
   - /brain           — manage strategy knowledge entries
   - /config          — edit RULE_* / targets / safety rails

Google Ads API (direct, see "Execute-mode migration" below)
   - web/src/agents/googleAdsClient.ts — sole import point for the
     `google-ads-api` package; called inline by implementation.ts
     after the dashboard approval gate, no script/polling involved

Google Ads Script (collect mode ONLY)    [kept from v1 — repointed]
   - GAQL fetch → POST /api/ingest (Bearer secret)
   - execute mode REMOVED (was: poll /api/pending-changes, apply via
     AdsApp, POST /api/execute-result) — see "Execute-mode migration"
```

**Why GitHub Actions for the agent pipeline:** v1's 6-minute Apps Script ceiling forced heavy rules-engine optimization. GitHub Actions jobs run up to 6 hours, free for the user's own repo — removes the time pressure and lets analysis be more thorough.

**Why Postgres:** real relational queries for the dashboard, `jsonb` for evidence/headlines/key_points, room for `pgvector` later for Brain semantic search.

**Why no Slack reaction-polling:** the dashboard is the approval surface (buttons → `/api/approve`). Slack is now an optional one-way notification channel.

---

## Execute-mode migration — direct Google Ads API (June 2026)

**What changed:** the execute side of this system (turning an approved `action_plan` row into a real account change) moved from `google_ads_script.js`'s queue-and-poll handshake (write `pending_changes` → script polls `/api/pending-changes` → applies via `AdsApp` → reports to `/api/execute-result`) to calling the real Google Ads API directly from `implementation.ts`, synchronously, the moment an item is approved and the hourly job runs. **Collect mode is completely unaffected** — the script still fetches GAQL data and POSTs to `/api/ingest` exactly as before.

**Why:** before this, only `increase_budget` and `add_negatives` were `action_category: "auto"` — every other recommendation (new keywords, bid changes, extensions, ad copy) required the user to manually re-implement it in the Ads UI after approving it on the dashboard, defeating the point of an "approval gate." Simply swapping `AdsApp` calls for API calls would not have fixed this on its own — there was no structured, machine-readable channel for "the exact keyword text" or "the exact sitelink copy," only free-text `action` prose written for a human. That gap is what `proposed_changes` (below) fixes.

### `proposed_changes` — the structured execution contract

`Finding` (`web/src/agents/schema.ts`) carries an optional `proposed_changes?: ProposedChange[]`, where `ProposedChange = { type: "add_keyword" | "add_negative" | "add_sitelink" | "add_callout" | "create_rsa" | "adjust_bid" | "adjust_budget" | "create_ad_group", params: Record<string, unknown> }` (`create_ad_group` added by the structure-proposals addition, see "Strategic gap-closing additions" above). This is distinct from `action` (free-text prose for the human reading the dashboard, capped at 1000 chars) — `implementation.ts` reads `proposed_changes` to actually execute a change, never parses `action`. `normalizeProposedChanges()` validates/drops malformed entries the same defensive way the rest of `schema.ts` does; never throws. Matching nullable `jsonb` columns exist on both `findings` and `action_plan` (`web/scripts/migrate-proposed-changes-column.ts`), copied through in `planFormatter.ts` the same way `missing_data` already flows from finding to action-plan row.

Two ways a finding gets `proposed_changes` populated:
- **LLM-authored** (the default): the analyst's prompt instructs the LLM to emit a `proposed_changes` array, using real ids/URLs copied from the DATA section (never invented) — see Section 1/2 of `searchIntelligenceAnalyst.ts` (`add_keyword`/`add_negative`), the sitelink/callout instructions in `qualityStructureAnalyst.ts` (`add_sitelink`/`add_callout`), and the copy-finding instructions in `audienceCopyAnalyst.ts` (`create_rsa`). `runAnalyst.ts`'s shared `buildSystemPrompt`/`buildRuleSystemPrompt` document the field generically; each analyst's own `instructions` string spells out the exact shape for its own id prefixes and tells the LLM to leave `proposed_changes: []` for everything else.
- **Deterministic** (pure arithmetic, no LLM involved): `Candidate.proposedChanges` (`runAnalyst.ts`) lets a rule-based `detect()` function build the structured change itself when it's pure math on already-known data — used by the new keyword-level bid-opportunity rule (`qualityStructureAnalyst.ts`, see below). When set, it takes precedence over anything the LLM writes for that candidate (`runRuleBasedAnalyst`'s merge step: `c.proposedChanges ?? normalizeProposedChanges(p.proposed_changes)`), since there's no reason to trust an LLM to re-derive a number `detect()` already computed correctly.

### `web/src/agents/googleAdsClient.ts` — the sole Google Ads API touchpoint

Mirrors how `google_ads_script.js` was the sole `AdsApp` touchpoint. Uses the `google-ads-api` npm package. Exports one function per mutation: `setCampaignBudget`, `addNegativeKeyword`, `setKeywordBid`, `addKeyword`, `addSitelinks`, `addCallouts`, `createResponsiveSearchAd` — each returns `{ success, resourceName?, error? }` and never throws for an expected API error (only for missing env vars, which fails closed immediately). `createResponsiveSearchAd` always creates the ad `status: PAUSED` — **non-negotiable**: approval authorizes *creation*, not *going live*; enabling new ad copy is a deliberate separate step this migration does not automate.

Required env vars (added to `.env.local`; **still needs to be added to Vercel and GitHub Actions secrets** before `hourly-implementation`'s cron can use the live API path in production — confirmed working locally only as of this migration):
```
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_REFRESH_TOKEN
GOOGLE_ADS_LOGIN_CUSTOMER_ID
GOOGLE_ADS_CUSTOMER_ID
```
Generated once via `web/scripts/generate-refresh-token.ts` (one-time local OAuth flow, never run in CI, never committed). The developer token started at Test Account access tier; reads against the real production account already work at that tier (verified live), mutate operations have not yet been verified live against the real account (see "Verification status" below) — Basic access may be required if mutate calls fail with a tier-related error.

### `implementation.ts` rewrite

`deriveChanges()` now reads `proposed_changes` for every action type except `increase_budget` (which keeps its original "always apply the configured max-cap regardless of what was recommended" logic unchanged — there's no fidelity gap there since the rule never claimed a specific number). This also fixed a pre-existing bug as a side effect: `add_negatives` used to independently re-derive its own top-N negative-keyword candidates from the raw `search_terms` table instead of using the LLM-curated list the human actually approved on the dashboard — it now reads the approved finding's `proposed_changes` directly. If an auto-eligible finding has empty `proposed_changes` for any type other than `increase_budget`, `implementation.ts` skips it with a logged reason rather than silently no-op'ing or falling back to old behavior (a deliberate regression guard).

`persistChange()` is now synchronous: under `DRY_RUN=true` it short-circuits to an immediate simulated `change_log` row exactly as before; under `DRY_RUN=false` it calls the matching `googleAdsClient.ts` function inline and logs the real `MutateResult`. `pending_changes` is kept as a same-shape **local** audit table only (no longer polled by anything) — its status lifecycle simplified from `queued`/`executing`/`done`/`error` to `dry_run`/`done`/`error`; re-execution is blocked only on `status="done"` (a genuinely completed mutation), so a transient API error or a dry-run review can be retried on the next hourly pass.

### Auto-scope expansion

"Aggressive but goes live after approval" — the human approval gate (`action_plan.status='approved'`) remains the only checkpoint; once approved, the system acts with no further manual step (except `update_copy`, which only ever creates a paused ad). `actionMeta.ts` now routes these additional id prefixes to `action_category: "auto"`:

| id prefix | agent | action_type | notes |
|---|---|---|---|
| `new-keyword-*` | Search Intelligence | `add_keywords` | was manual; Section 1's prompt now requires `proposed_changes` |
| `extension-no-extensions-account`, `extension-no-sitelinks-*`, `extension-few-sitelinks-*`, `extension-no-callouts-*` | Quality & Structure | `add_extensions` | only these 4 sub-types — `extension-no-snippets-*` and `extension-weak-ext-*` stay manual, no mutate function exists for structured snippets or replacing existing asset copy yet |
| `bid-opportunity-*` (**new rule**, `qualityStructureAnalyst.ts`) | Quality & Structure | `adjust_bid` | a converting keyword (CPA ≤ target) on Manual CPC / Enhanced CPC with bid headroom — proposes +20% (config `RULE_BID_OPP_INCREASE_PCT`, capped again against `MAX_BID_SHIFT_PCT`=30% in `validateChange`). Deliberately keyword-scoped: `rank-locked-*` (Performance & Budget, campaign-scoped) stays manual permanently since campaign-level "rank lost" isn't a single keyword-level mutate target |
| `copy-*`, `low-ctr-ad-*` | Audience & Copy | `update_copy` | creates a PAUSED RSA only; `audience-*` findings (RLSA/Customer Match/lookalike strategy) stay manual — not a single executable change |

New `qualityStructureAnalyst.ts` config knobs: `RULE_BID_OPP_MIN_CLICKS` (default 10), `RULE_BID_OPP_MIN_CONV` (default 3), `RULE_BID_OPP_INCREASE_PCT` (default 0.20) — see the `RULE_*` table further down.

### Disposition of `/api/pending-changes` and `/api/execute-result`

Marked `@deprecated` in their doc comments, left functional, not deleted — a clean rollback path (revert `implementation.ts`, restore the script's execute block) if the API integration misbehaves. Nothing currently calls either route.

### Verification status (read before assuming this is fully proven in production)

- Typecheck and lint pass clean across every file in this migration.
- `npm run hourly-implementation` was smoke-tested against the real Supabase DB with `DRY_RUN=true`: the new `readApprovedAutoItems()` join query ran without error (0 approved+auto rows existed at the time, so no `deriveChanges`/`validateChange`/`persistChange` code path was exercised end-to-end with real data yet).
- **Now verified live** (see "Production incident: gaxios + sitelink validation" below): real `add_keyword` and `add_sitelink` mutations have succeeded against the real "Baidyanath" account under `DRY_RUN=false`. The developer token's Test-tier access is sufficient for mutate calls — that earlier open question is resolved.

---

## Production incident: CI auth failures + a real validation bug (June 2026)

The first live (`DRY_RUN=false`) `hourly-implementation` runs failed 100% of the time with `2 UNKNOWN: Getting metadata from plugin failed... Premature close` while fetching an OAuth token from `oauth2.googleapis.com` — every mutation, every run, in GitHub Actions only (never locally, with the exact same credentials). Root-caused through direct experimentation, ruling out causes in this order: retry with backoff (no change — failed identically 4/4 attempts), Node 22 vs Node 24 (both failed identically), `--dns-result-order=ipv4first` in case of an IPv6 happy-eyeballs gap (no change). What did work: plain `curl` and Node's native `fetch()` to the exact same endpoint, from the exact same failing run, succeeded instantly every time — proving it wasn't network reachability, Node version, or IPv6.

Traced into `google-ads-api`'s source: `customer.query()` uses a REST path (`OAuth2Client.getAccessToken()`) and `customer.mutateResources()` uses a gRPC path (`UserRefreshClient` via `grpc.credentials.createFromGoogleCredential`) — two different code paths that both failed identically, because both ultimately call into `google-auth-library`'s shared `gaxios` HTTP client internally. `gaxios` itself was broken in that specific GitHub Actions runner environment; nothing else was.

**Fix** (`googleAdsClient.ts`): `fetchAccessTokenManually()` does the refresh_token→access_token exchange directly via Node's native `fetch()` (the one thing proven to work), cached with a 2-minute-early-refresh TTL. `getCustomer()` then overrides both of the package's internal token-fetch methods at the instance level (no `node_modules` patching) — `getAccessToken()` for the REST path, `getCredentials()` for the gRPC path via `grpc.credentials.createFromMetadataGenerator()` — to use it instead. Added `@grpc/grpc-js` as an explicit direct dependency since `googleAdsClient.ts` now imports it.

**A second, unrelated bug surfaced once the auth layer was fixed and real errors could finally surface**: `describeError()` was rendering Google's actual API error objects as the useless literal `"[object Object]"` (no `.message` property on decoded `GoogleAdsFailure` objects) — fixed to fall back to `util.inspect(e, {depth: null})`, since even `JSON.stringify` wasn't enough (the nested `errors[]` entries are protobuf message instances whose fields aren't all enumerable own properties). That fix immediately revealed the real, separate bug it had been hiding: sitelink `description1`/`description2` have a **35-character limit**, not the 90-character limit that applies to RSA ad descriptions — a limit this codebase had conflated in both `validateChange()` (which never checked sitelink description length at all) and `qualityStructureAnalyst.ts`'s prompt instructions (which told the LLM 90 chars was fine). Also fixed: sending an empty string for an unused optional description field is rejected by the real API as "required field not present" — `addSitelinks()` now omits the field entirely instead of defaulting to `""`.

**Also fixed along the way**: `persistChange()` returned `void` and the caller logged `[executed]`/counted every attempted change as successful regardless of the real API result — so the first two failed production runs printed `executed=4 skipped=0` and GitHub Actions showed a **green checkmark** despite 100% of mutations failing silently. `persistChange()` now returns the real result; `runHourlyImplementation.ts` exits non-zero when any live mutation fails, so a failure is visible without manually checking `change_log`.

**Status**: auth fix confirmed live (a real `add_keyword` mutation succeeded). Sitelink length/empty-field fixes pushed but not yet re-verified live as of this writing — the next `hourly-implementation` run (manual or scheduled) will be the real test once a fresh `daily-audit` run regenerates sitelink findings with the corrected character limit (the currently-approved one will safely keep getting validation-rejected, not retried forever, since its stored description text predates the fix).

---

## Strategic gap-closing additions (June 2026)

A full pipeline audit (every detection rule in all 6 analysts, traced against current — 2026 — real-world PPC strategist practice, not just opinion) found the system was strong on tactical/deterministic hygiene (QS, extensions, CTR, budget pacing, anomaly detection) but had three concrete strategic gaps: it could *flag* structural debt but never *propose* the new structure; it had no memory of whether its own past mutations actually worked; and "competitive" findings were Brain-knowledge-only with zero real auction data (and `businessRules.ts` already capped them at P3 *because* of that gap). Three additions close these:

### 1. Structure proposals — `structure-bloated-ag-*` now proposes a real split, not just a flag

`qualityStructureAnalyst.ts`'s `clusterKeywordsForSplit()` does deterministic token-overlap clustering on a bloated ad group's keyword list: it finds the largest set of keywords (≥3, but ≤60% of the group — large enough to be worth a dedicated ad group, small enough that splitting it off doesn't just relabel the whole group) sharing a distinctive token (a word *not* already in the ad group's own name, since that's the shared theme everything has by definition). When a cluster clears the bar, the candidate gets a deterministic `Candidate.proposedChanges` (same precedence pattern as the keyword-level bid-opportunity rule — pure arithmetic/string-matching beats trusting an LLM to re-derive it) of `{"type":"create_ad_group","params":{"campaign_id","new_ad_group_name","keywords":[{"text","match_type"}]}}`.

`googleAdsClient.ts`'s `createAdGroup()` creates the new ad group + keyword criteria atomically (temp-resource-id pattern, same as `addSitelinks`). **Purely additive — never touches the ad group the keywords are being split out of**, so it carries none of the risk of an actual move/merge. Created with `status: ENABLED`, not PAUSED: `google_ads_script.js`'s collect queries all filter `ad_group.status = 'ENABLED'`, so a paused new ad group would be invisible to tomorrow's data collection and never get flagged for the obvious next step. Being enabled with zero ads is safe (Google Ads serves nothing from an ad group with no ads) — the account's existing `structure-understaffed-ag-*` rule will naturally pick the new empty ad group up next run and recommend adding ads, closing the loop without this rule also having to write ad copy itself. `structure-bloated-ag-*` routes to `action_category: "auto"` in `actionMeta.ts` (only when a split was actually found — the regression guard in `implementation.ts` skips the rest).

### 2. 30-day change-outcome feedback loop — did our own past changes actually help?

`performanceBudgetAnalyst.ts`'s `loadChangeOutcomeCandidates()` (the async DB-querying data-prep step, not `detect()` itself, which must stay pure) queries `change_log` for `adjust_budget` changes ≥30 days old (`RULE_CHANGE_REVIEW_DAYS`), not yet `reviewed`, then pulls a wide enough `campaigns_daily` window to compare the 14 days before vs the 14 days after each change for that campaign. **Scoped to `adjust_budget` only** — that's the one change type with genuine before/after data, since `campaigns_daily` has day-level granularity but keyword/ad-level snapshots don't (they're a point-in-time rolling-window aggregate, replaced wholesale each collect run — no historical per-day keyword/ad table to diff against). Every evaluated row gets `reviewed=true` regardless of outcome (a 30+-day-old change has no more "after" data coming, so re-checking it next run would produce the identical verdict) — new `change_log.reviewed` column, migration `web/scripts/migrate-change-log-reviewed-column.ts`.

`detectChangeOutcomes()` in the same file always produces a finding, never silently discards an evaluated change: low-confidence "insufficient data" if either window's conversions are below `RULE_ANOMALY_MIN_BASELINE_CONV`, otherwise a real verdict — **worse** (CPA ratio ≥ `RULE_CHANGE_REVIEW_WORSE_RATIO`, default 1.2x) gets a deterministic revert-to-the-old-budget `proposed_changes` entry and routes to `action_category: "auto"` in `actionMeta.ts`; **better** (≤ `RULE_CHANGE_REVIEW_BETTER_RATIO`, default 0.85x) or **neutral** are informational-only (`action_category: "insight"`, nothing to execute). This directly answers the "no agent-health/quality monitor over time" gap flagged in this file's own "Known gaps" section below — though only for budget changes specifically, not full cross-run agent-quality drift, which remains open.

### 3. Real Auction Insights data — manual import, since the API won't give it to us

Tested directly against this account: the dedicated GAQL fields (`metrics.auction_insight_search_impression_share`, `segments.auction_insight_domain`) are rejected outright — confirmed via web research this isn't account-specific, it's a general API limitation (allowlist-only, and Google removed third-party/API access to this report entirely in August 2024). The standard `search_impression_share`/`search_budget_lost_impression_share` fields *do* work, but those are the same account-level IS metrics already collected (no per-competitor breakdown) — nothing new there.

`web/scripts/import-auction-insights.ts` parses a CSV manually exported from the Ads UI (Campaigns → Auction insights → Download) — handles Google's quoted-field CSV format and a leading title row before the real header, matches column names case-insensitively against known label variants (Google has renamed these across UI versions), aggregates per-domain across however many campaign-level rows each competitor domain appears in, and upserts a single rolling Brain entry (`brain_auction_insights_latest`, category `competitive`) — re-running the script after a fresh export keeps it current. This is a periodic manual step, not part of the automated collect pipeline; re-run whenever you re-export (e.g. monthly).

### Verification status

All three: typecheck and lint pass clean. `clusterKeywordsForSplit`/`createAdGroup` and `loadChangeOutcomeCandidates`/`detectChangeOutcomes` were run against the real account's live data with no LLM call (pure rule functions) — both executed without error; neither currently has a real candidate to fire on (no ad group has >20 keywords yet; no `adjust_budget` change_log row is 30+ days old yet), which is correct given the account's actual current state, not a gap in the logic. The CSV importer was tested against a synthetic sample file (parsed correctly, including the `--` no-data placeholder and a leading title row) and the test Brain entry it created was deleted afterward — it has not yet been run against a real Auction Insights export.

---

## Dashboard authentication — `web/src/proxy.ts`

**Critical fix (June 2026):** the dashboard and every mutation API route (`/api/approve`, `/api/config`, `/api/config/[key]`, `/api/brain`, `/api/brain/[id]`) had **zero authentication** despite CLAUDE.md long claiming "password-gated" — confirmed live and exploitable: a bare unauthenticated `POST /api/approve` on the public Vercel URL approved a real `action_plan` row. `DASHBOARD_PASSWORD`/`DASHBOARD_USERNAME` Vercel env vars existed (set weeks earlier, both empty strings) but no code ever checked them — the intent was there, the enforcement never shipped.

Fixed via `web/src/proxy.ts` — Next.js 16 renamed `middleware.ts` to `proxy.ts` (the file MUST be named `proxy.ts`, exporting a `proxy` function; `middleware.ts` is silently ignored in this version, see `node_modules/next/dist/docs/.../proxy.md`). It gates **every** page and API route behind HTTP Basic Auth, except the three routes the Google Ads Script itself calls (`/api/ingest`, `/api/pending-changes`, `/api/execute-result` — these already enforce their own `Authorization: Bearer <INGEST_SECRET>` check inside the route handler, which is a separate, intentional credential from the dashboard password).

- Env vars: `DASHBOARD_USERNAME` (default `"admin"` if unset), `DASHBOARD_PASSWORD` (**required** — if unset or empty, `proxy.ts` fails closed and rejects every gated request rather than failing open).
- Set in `.env.local` for dev, and as Vercel **and** GitHub Actions secrets for anywhere this needs to be replicated.
- This is exactly the kind of gap that must not recur when this system is replicated to other accounts — confirm `proxy.ts` exists and `DASHBOARD_PASSWORD` is a real (non-empty) value before considering a new account "set up."

---

## Operational status (read this before assuming the cron is running)

- **`daily-audit` schedule is currently PAUSED** (commented out in `.github/workflows/daily-audit.yml`, not deleted) — the user runs it manually via Actions → daily-audit → "Run workflow" while the pipeline below is being stabilized. Re-enable by uncommenting the `schedule:` block once satisfied with run quality. `hourly-implementation` and `weekly-brain-learning` are unaffected (still on their normal schedules).
- This account is a **pilot** — if the findings-quality pipeline holds up, the user intends to **replicate this entire system for other Google Ads accounts**. Treat correctness and documentation discipline here as setting the template for that replication, not as one-off cleanup.

---

## Multi-provider LLM client (`web/src/agents/llm.ts`)

`callLLM()` is no longer Groq-only. It builds a ranked provider list from whichever API keys are set and fails over automatically — a provider being at its daily ceiling, erroring, or returning unparseable output all trigger a fall-through to the next provider, not a thrown error (only throws if *every* configured provider fails):

| Provider id(s) | Env var | Model | Notes |
|---|---|---|---|
| `groq_1`..`groq_4` | `GROQ_API_KEY`, `GROQ_API_KEY_2/_3/_4` | `llama-3.3-70b-versatile` | Primary. 100K tokens/day **per key** — multiple free Groq accounts each get an independent quota. Only `GROQ_API_KEY` is required; `_2/_3/_4` are optional extra accounts. |
| `cerebras` | `CEREBRAS_API_KEY` | `zai-glm-4.7` (override: `CEREBRAS_MODEL`) | 1M tokens/day free tier, but only an **8,192-token context cap**, and this account's available models (`zai-glm-4.7`, `gpt-oss-120b`) intermittently emit a hidden chain-of-thought `reasoning` field before `content` — sent with `reasoning_effort: "none"` (verified live: drops `reasoning_tokens` to 0) plus a 1200-token safety-margin headroom. |
| `openrouter` | `OPENROUTER_API_KEY` | `google/gemma-4-26b-a4b-it:free` (override: `OPENROUTER_MODEL`) | 50–1000 requests/day depending on credit purchased, 20 RPM. Free catalog rotates — `llama-3.3-70b-instruct:free` and `qwen3-next-80b-a3b-instruct:free` were both congested when last checked (June 2026); `nemotron-3-super-120b-a12b:free` is also a reasoning model. `gemma-4-26b-a4b-it:free` verified clean (no reasoning overhead). |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.0-flash` (override: `GEMINI_MODEL`) | Not currently configured. OpenAI-compatible endpoint. |

**Provider ordering**: Groq → Cerebras → OpenRouter → Gemini by default. For analysts that send large data tables (`largePrompt: true` on the `AnalystSpec` — currently `searchIntelligenceAnalyst`, `marketIntelligenceAnalyst`, `qualityStructureAnalyst`, and the recommendation validator agent), Cerebras is moved to *last* instead of second, since its 8K context cap is the most likely failure point for those prompts.

**Token usage** is tracked per provider id (not per "groq") in `token_usage`, so each key/provider has its own independent daily ceiling — exhausting `groq_1` doesn't touch `groq_2`'s budget. Proactive ceiling override: `config.<PROVIDER_ID_UPPER>_DAILY_TOKEN_CEILING` (e.g. `GROQ_1_DAILY_TOKEN_CEILING`).

GitHub Actions secrets needed for the cron to use the full provider list: `GROQ_API_KEY` (required) plus any of `GROQ_API_KEY_2/_3/_4`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` (all optional — unset ones are simply skipped, no error).

---

## The Brain — persistent strategic knowledge base (carried over from v1)

The Brain is what makes this system strategically intelligent rather than purely reactive. Every Analyst queries it before calling Groq.

### v2 storage

`brain_entries` table in Postgres (see schema below). Managed via the `/brain` dashboard page (add/edit entries directly — file upload via Drive indexing is deferred, lowest-value part of v1 to port).

### Brain entry schema

```json
{
  "id": "brain_001",
  "category": "copy|bidding|structure|scaling|brand|keywords|audience|competitive|landing_page|pmax|reddit_intel|general|products",
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
| `products` | **(v2 addition, June 2026)** Real product catalog data — exact names, prices, pack sizes, ingredients, certifications, USPs scraped from the brand's own site. Added because analysts writing ad copy (`audienceCopyAnalyst.ts`, `qualityStructureAnalyst.ts`) previously had to infer product details from sparse ad-group names and the LLM defaulted to generic brand boilerplate — real per-product facts let copy be genuinely specific instead of templated. |

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

## Agent architecture — 14 agents (v1) → 6 Analysts + 1 Recommendation Validator (v2)

Each Analyst = one rules pass (if applicable) + **one** LLM call (multi-provider, see above). Same universal findings schema, dedup, cross-agent patterns, and `ImpactScorer` formula carry over from v1 — ported from `apps_script/agents/synthesis/DeduplicationAgent.js`, `ImpactScorer.js`, `apps_script/managers/SynthesisManager.js`. **v2 adds a synthesis-stage business-rules gate and a 7th agent (the Recommendation Validator) that v1 never had** — see "Synthesis pipeline v2 additions" below.

| Analyst | Merges (v1 agents) | Pattern | Brain categories | `largePrompt` |
|---|---|---|---|---|
| **Performance & Budget Analyst** | PerformanceAnalyst, BidBudgetAnalyst, ConversionHealthChecker | rule-based, 1 LLM call | bidding, scaling, general | no |
| **Quality & Structure Analyst** | QualityScoreInspector, AccountStructureReviewer, ExtensionAuditor | rule-based, 1 LLM call | structure, copy, landing_page, brand, competitive, products | yes |
| **Audience & Copy Analyst** | AudienceAnalyst, AdCopyCritic | rule-based, 1 LLM call | audience, copy, brand, competitive, products | no |
| **Search Intelligence Analyst** | KeywordMiner, NegativeKwHunter, SearchTermPatternAnalyzer | pure LLM, 1 call, structured multi-section output | keywords, structure, audience | yes |
| **Market Intelligence Analyst** | CompetitiveIntel, CategoryTrendSpotter | pure LLM, 1 call | competitive, brand, general, pmax | yes |
| **Landing Page Scorer** | LandingPageScorer (unchanged) | LLM + URL fetch | landing_page, copy | no |
| **Recommendation Validator** (NEW, v2 only — `web/src/agents/analysts/recommendationValidatorAgent.ts`) | none (v1 had no equivalent) | reviews *output*, doesn't produce new findings — 1 batched call over all surviving findings | n/a (doesn't query Brain) | yes |

Result: **7 LLM calls/day** (was "6 instead of 14" before the validator was added), each with a richer prompt and bigger token budget per call (no 6-min ceiling), producing more specific `action` text.

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

## Synthesis pipeline v2 additions — Business Rules Gate + Recommendation Validator

**Pipeline order** (`web/src/agents/synthesis/synthesisManager.ts`):
```
dedup → crossAgentPatterns → applyBusinessRules (NEW) → runRecommendationValidator (NEW) → ImpactScorer.run → formatActionPlan → write
```

### `businessRules.ts` (deterministic, zero LLM cost)

Added after a real incident: a Market Intelligence finding recommended *"Increase the budget of [campaign] to ₹100000"* (a 47x jump) for a campaign that **another finding in the same run** had already flagged as missing its CPA target — nothing in the pipeline cross-checked the two. Rules:

- **ROAS/CPA gate**: any finding recommending a budget/bid increase — matched either by known id prefix (`budget-locked-*`, `sp-budget-misalloc-*`) OR by a regex catching free-text "increase/raise ... budget/bid" language from *any* analyst (Market Intelligence has no shared id convention for this) — gets demoted one severity tier if the same `target.id` has an open `roas-shortfall-*` or `cpa-overage-*` finding, with the reason appended to `why` and recorded in `validation_flags`.
- **Rank-vs-budget gate**: same demotion when `searchRankLostIs > searchBudgetLostIs` on the target campaign — a budget increase won't fix a rank-capped campaign.
- **Evidence-density floor**: findings with <2 numeric evidence points get `confidence` capped at `"low"` regardless of LLM self-rating.
- **Insufficient-data cap**: findings in `category="competitive"` capped at P3 with `missing_data` auto-populated. Originally because Auction Insights / share-of-voice data wasn't available at all; as of June 2026 a real (if manually-imported) source exists — see "Strategic gap-closing additions" above — but this gate is unchanged since the API still can't supply it automatically, and the cap is a reasonable default regardless of data freshness.

**Known fragility fixed alongside this**: `ImpactScorer.run()` originally recomputed priority purely from `magnitude × confidence / effort`, completely ignoring any severity `businessRules.ts` had already set — a gate's demotion would silently get reverted back up. Fixed: final priority is now whichever of (formula-computed, finding's current severity) is the *lower-urgency* one, so gates can demote but the formula can never silently promote a gated finding back up.

### `recommendationValidatorAgent.ts` (1 batched LLM call/run, the 7th agent)

Reviews the surviving candidate list (after business rules) in **one** call — not one call per finding — and returns per-finding: `is_generic` (demotes one tier if true and not rescued by evidence), `missing_data[]`, `alternative_explanations[]`, optional `confidence_override`. This is the judgment-based check a regex/threshold layer can't do reliably (deciding genericness in context, proposing real alternative causes). Never silently drops a finding — every override lands in `validation_flags`, shown on the dashboard as an amber "⚠ flagged" chip.

### Schema additions backing the above

`Finding` (`web/src/agents/schema.ts`) gained two **optional** fields: `missing_data?: string[]`, `alternative_explanations?: string[]` (analysts and the validator can both populate them; default `[]`). `SynthFinding` additionally has `validation_flags?: string[]` (synthesis-stage bookkeeping only, not analyst output). Matching nullable `jsonb` columns were migrated onto `findings` and `action_plan` (`web/scripts/migrate-validator-columns.ts`).

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
| `BRAND_KEYWORDS` | (empty) | Audience & Copy Analyst + Quality & Structure Analyst — comma-separated brand keywords for campaign/keyword classification |
| `RULE_ANOMALY_CPA_JUMP_RATIO` | 1.30 | Performance & Budget Analyst — 7d-vs-prior-14d CPA jump ratio to flag |
| `RULE_ANOMALY_CVR_DROP_RATIO` | 0.70 | Performance & Budget Analyst — 7d-vs-prior-14d CVR drop ratio to flag |
| `RULE_ANOMALY_MIN_BASELINE_CONV` | 5 | Performance & Budget Analyst — min baseline-window conversions to trust the comparison |
| `RULE_QS_BRAND_MAX` | 8 | Quality & Structure Analyst — QS at or below this = "low" for **pure** brand keywords (stricter than `RULE_QS_MAX`) |
| `RULE_MIN_VIABLE_CONVERSIONS` | 10 | Quality & Structure Analyst — campaign conversions below this = structurally too small to optimize |
| `RULE_MIN_BUDGET_CPC_MULTIPLE` | 5 | Quality & Structure Analyst — daily budget below (account avg CPC × this) = too small to gather daily data |
| `RULE_BID_OPP_MIN_CLICKS` | 10 | Quality & Structure Analyst — min clicks for the keyword-level `bid-opportunity-*` rule to trust the CPA comparison |
| `RULE_BID_OPP_MIN_CONV` | 3 | Quality & Structure Analyst — min conversions for `bid-opportunity-*` |
| `RULE_BID_OPP_INCREASE_PCT` | 0.20 | Quality & Structure Analyst — proposed bid increase for `bid-opportunity-*` (capped again at `MAX_BID_SHIFT_PCT`=30% in `implementation.ts`) |
| `MAX_BUDGET_SHIFT_PCT` | 0.20 | `implementation.ts` — max fraction of a campaign's daily budget moved per run (`adjust_budget`) |
| `MAX_BID_SHIFT_PCT` | 0.30 | `implementation.ts` — max fraction a keyword's CPC bid can change per run (`adjust_bid`) |
| `RULE_CHANGE_REVIEW_DAYS` | 30 | Performance & Budget Analyst — how old an `adjust_budget` change_log row must be before the 30-day feedback loop evaluates it |
| `RULE_CHANGE_REVIEW_WINDOW_DAYS` | 14 | Performance & Budget Analyst — size of the before/after `campaigns_daily` comparison window around the change date |
| `RULE_CHANGE_REVIEW_WORSE_RATIO` | 1.2 | Performance & Budget Analyst — after-CPA/before-CPA ratio at or above this = "got worse", triggers a revert proposal |
| `RULE_CHANGE_REVIEW_BETTER_RATIO` | 0.85 | Performance & Budget Analyst — after-CPA/before-CPA ratio at or below this = "got better" (confirmation only, no action) |

---

## v2 additions from external audit-framework review (June 2026)

User supplied ~44 third-party "Google/Meta Ads skill" reference docs (`skills to look for/`, not committed — personal reference material). Cross-referenced against this system's existing rules to find genuinely new, concrete, **implementable-with-data-we-already-collect** detection logic (explicitly rejected anything requiring new GAQL segments we don't collect — device/geo/hour-of-day/multi-touch-attribution — those are noted as future data-collection work below, not implemented).

**Added (all additive, all in existing analysts, no new agents):**
- **Trend/anomaly detection** (`performanceBudgetAnalyst.ts`, `anomaly-cpa-jump-*`/`anomaly-cvr-drop-*`) — first period-over-period comparison anywhere in this system. Uses `campaigns_daily` (added `readCampaignsDaily()` to `data.ts`) to compare the last 7 days against the prior 14-day baseline per campaign; requires a minimum baseline conversion count so low-volume noise doesn't get reported as an anomaly.
- **Search-term cross-ad-group overlap** (`searchIntelligenceAnalyst.ts` Section 4, `cannibalization-*`) — true match-type cannibalization isn't detectable (search_terms has no matched-keyword field), so this is the closest reliable proxy: the same query served from 2+ different ad groups with a ≥1.3x CPC gap between them.
- **Brand vs non-brand QS split** (`qualityStructureAnalyst.ts`) — brand keywords get a stricter QS bar (`RULE_QS_BRAND_MAX`, default 8) than non-brand (`RULE_QS_MAX`, default 5). **Important nuance discovered while building this**: for manufacturer-brand accounts where `BRAND_KEYWORDS` is the product line's own name (e.g. `"baidyanath"`), a naive substring match flags nearly every keyword as "brand" (47/70 candidates in testing) because product searches legitimately contain the manufacturer name (`"baidyanath chyawanprash"` is a product search, not a navigational brand search). Fixed with `isPureBrandKeyword()` — only counts as brand if, after removing the brand term(s) and common navigational stopwords (official/store/login/etc.), zero words remain. Dropped the false-positive rate to 2/70 on the same data.
- **Irrelevant-intent auto-negatives** (`searchIntelligenceAnalyst.ts` Section 2 addition) — common junk-intent fragments (jobs/salary/how to/tutorial/login/DIY/reddit/etc., see `JUNK_INTENT_RE`) get flagged as negative-keyword candidates regardless of spend, not gated behind the `NEGATIVE_KW_MIN_WASTE` cost floor like the rest of Section 2.
- **Low-volume / tiny-budget structural flags** (`qualityStructureAnalyst.ts`, `structure-low-volume-*`/`structure-tiny-budget-*`) — a different failure mode than budget-capped: campaigns that structurally can't gather enough signal to optimize regardless of budget level (conversions below `RULE_MIN_VIABLE_CONVERSIONS`), or whose daily budget can't buy enough clicks at the account's average CPC to matter (`RULE_MIN_BUDGET_CPC_MULTIPLE`).
- **UTM/tracking validator** (`qualityStructureAnalyst.ts`, `structure-utm-*`) — checks `ads.finalUrls` (data already collected, never checked before) for missing `utm_source`/`utm_medium` or a `utm_source` that isn't `google`/`adwords` (a common copy-paste artifact from Meta UTM templates).

**Explicitly deferred — would need new data collection, not a quick rule addition:**
- Device/geo/hour-of-day segmentation (`segments.device`, `segments.geo_target_region`, `segments.hour` — new GAQL fields, new collect-mode queries, new tables)
- A/B test statistical framework (Z-score/sample-size validator — needs Google Ads "Experiments" data, `campaign_experiment` resource, not currently queried)
- Extension staleness tracking (needs an asset `creation_time` field not currently stored)
- Negative-keyword recency tracking (needs an `added_at` timestamp not currently stored)
- Marginal-ROAS / diminishing-returns curve fitting (possible from existing `campaigns_daily` via regression, but materially more complex than the additions above — a candidate for a future pass, not bundled into this one)
- Multi-touch attribution model comparison, external industry benchmarking — need data sources this system doesn't have access to at all

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
      "brain_sources": ["brain_001", "brain_042"],
      "missing_data": ["data that would make this more defensible — [] if confidence is high"],
      "alternative_explanations": ["a plausible alternative cause the analyst considered — [] if none"],
      "proposed_changes": [{"type": "add_keyword|add_negative|add_sitelink|add_callout|create_rsa|adjust_bid|adjust_budget|create_ad_group", "params": {}}]
    }
  ],
  "summary": "One sentence summary",
  "token_count": 0,
  "run_time_ms": 0
}
```

`brain_sources` tracks which Brain entries informed each finding — full traceability. `missing_data`/`alternative_explanations` are v2 additions (see "Synthesis pipeline v2 additions" below) — optional, default `[]`, populated by analysts directly or filled in later by the Recommendation Validator agent. `proposed_changes` is the Execute-mode migration's structured execution contract (see that section above) — optional, default `[]`, the only field `implementation.ts` reads to actually mutate Google Ads; distinct from `action` (free-text prose for the dashboard). `SynthFinding` (the in-pipeline shape, `agent`/`runDate`/`mode` attached) additionally carries `validation_flags?: string[]` once synthesis has run — not analyst output, bookkeeping only.

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
- `action_category`: `auto` (implementable directly via the Google Ads API, see "Execute-mode migration" above, under safety rails), `manual` (human must act — e.g. structural changes), or `insight` (informational only, e.g. competitive/trend findings)
- `action_type`: specific operation. Original v1 set: `add_negatives`, `increase_budget`, `decrease_budget`, `adjust_bid`, `pause_keyword`, `pause_ad`, `read_insight`. v2 (`web/src/agents/synthesis/actionMeta.ts`) routes by `agent` + `finding.id` prefix and adds: `add_extensions` (Quality & Structure's `extension-*`), `restructure` (`structure-*` and Search Intelligence's `search-term-pattern-*` — `structure-bloated-ag-*` specifically routes to `auto` when a split was found, see "Strategic gap-closing additions" above), `fix_quality_score` (`low-qs-*`/`no-qs-spend-*`), `reallocate_budget` (`idle-budget-*` and the generalized `pacing-*`), `adjust_bid` (`rank-locked-*` and the keyword-level `bid-opportunity-*`), `decrease_budget` (the 30-day `change-outcome-*` revert case, auto only when a revert is actually proposed), `update_copy` (Audience & Copy findings, and Performance Budget's `low-ctr-*`), `fix_landing_page` (Landing Page Scorer), `fix_conversion_tracking` (`troas-no-value-*`/`no-conv-*`/`no-value-*`/`high-cvr-*`/`low-cvr-*`), `change_bid_strategy` (Performance Budget's default fallback, also covers non-revert `change-outcome-*` outcomes as `insight`).

Logic ported from `_deriveActionMeta_()` in `apps_script/agents/synthesis/PlanFormatter.js`, extended for v2's id-prefix conventions documented in `agentNames.ts`. **`action_category: "auto"` scope as of the Execute-mode migration** — see the table in "Execute-mode migration" above for exactly which id prefixes are auto vs. manual within each `action_type`; several `action_type`s (e.g. `add_keywords`, `add_extensions`, `update_copy`) are a MIX of auto and manual depending on the specific id prefix, not uniformly one or the other.

---

## Safety rules for implementation — NON-NEGOTIABLE (unchanged from v1)

1. **Never delete** — only pause (ads, keywords, ad groups, extensions). New ad copy is created PAUSED, never auto-enabled (see "Execute-mode migration" above).
2. **Bid limit**: max ±30% change per run — enforced in `implementation.ts`'s `validateChange()` (config `MAX_BID_SHIFT_PCT`), rejected (not silently clamped) if exceeded
3. **Budget limit**: max 20% of campaign daily budget moved per run — same enforcement point (config `MAX_BUDGET_SHIFT_PCT`)
4. **Ad minimum**: ad group must retain ≥ 2 active ads before pausing any ad
5. **Dry-run**: if `config.DRY_RUN = true` → log to `change_log` but never call the Google Ads API
6. **Change log**: every mutate appends a row to `change_log` (before/after/agent/timestamp)
7. **Approval check**: read `action_plan.status` (must be `approved`) before every mutate — skip if not approved. Since the Execute-mode migration this is the **only** checkpoint before a real account change — there is no human-in-the-loop step after approval anymore for `auto` items (except `update_copy`, which only ever creates a paused ad).

---

## Database schema (Postgres) — `web/src/db/schema.ts` is authoritative

Direct ports of the v1 Sheet schemas, with `*_json` columns becoming `jsonb`. Tables:
`campaigns`, `campaigns_daily`, `ad_groups`, `keywords`, `ads`, `search_terms`, `extensions`, `negative_keywords` (raw snapshots, replaced wholesale on each collect run, except `campaigns_daily` which appends/upserts by date), and `findings`, `action_plan`, `approvals`, `pending_changes`, `change_log`, `brain_entries`, `config`, `token_usage` (agent layer).

**v2 additions to the agent layer** (see "Synthesis pipeline v2 additions" above): `findings.missing_data` / `findings.alternative_explanations` (nullable `jsonb`, default `[]`); `action_plan.missing_data` / `action_plan.alternative_explanations` / `action_plan.validation_flags` (same). `brain_entries.status` (`active` default — also `staged` for Brain Learning Agent candidates awaiting review, `rejected`). `token_usage.provider` is now a provider **id** (`groq_1`, `cerebras`, `openrouter`, ...), not a fixed `"groq"` string — see "Multi-provider LLM client" above. `findings.proposed_changes` / `action_plan.proposed_changes` (nullable `jsonb`, default `[]`) added by the Execute-mode migration — see "Execute-mode migration" above (migration script: `web/scripts/migrate-proposed-changes-column.ts`). `pending_changes.status` values changed from `queued`/`executing`/`done`/`error` to `dry_run`/`done`/`error` as part of the same migration — it's now a synchronously-written local audit table, not a poll queue. `change_log.reviewed` (boolean, default `false`) added by the 30-day change-outcome feedback loop — migration script: `web/scripts/migrate-change-log-reviewed-column.ts` (see "Strategic gap-closing additions" above).

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
│                                   #   collect mode ONLY: POSTs to /api/ingest
│                                   #   (execute mode retired — see "Execute-mode migration")
│
├── apps_script/                    # LEGACY v1 (Apps Script + Sheets) — kept for reference until cutover (Phase J)
│
└── web/                             # Next.js app (Vercel)
    ├── drizzle.config.ts
    ├── scripts/
    │   ├── generate-refresh-token.ts        # one-time local OAuth flow for GOOGLE_ADS_REFRESH_TOKEN — never run in CI
    │   ├── migrate-proposed-changes-column.ts
    │   ├── migrate-change-log-reviewed-column.ts
    │   ├── import-auction-insights.ts       # manual CSV import (Ads UI export) -> Brain competitive entry
    │   ├── list-advertised-product-urls.ts  # companion to seed-product-catalog-brain.ts
    │   ├── seed-competitive-brain.ts        # one-time: real Dabur/Patanjali/Kapiva positioning -> Brain
    │   └── seed-product-catalog-brain.ts    # one-time: real product facts scraped from the brand's site -> Brain
    ├── src/
    │   ├── db/
    │   │   ├── schema.ts            # Drizzle schema — authoritative DB shape
    │   │   └── index.ts             # db client
    │   ├── app/
    │   │   ├── page.tsx              # Overview (KPIs, budget pacing)
    │   │   ├── action-plan/          # Action Plan page (approve/reject), renders proposed_changes verbatim
    │   │   ├── history/              # Past runs, change log
    │   │   ├── brain/                # Brain entry management
    │   │   ├── config/                # RULE_* / targets editor
    │   │   └── api/
    │   │       ├── ingest/route.ts
    │   │       ├── action-plan/route.ts
    │   │       ├── approve/route.ts
    │   │       ├── pending-changes/route.ts   # @deprecated — see "Execute-mode migration"
    │   │       └── execute-result/route.ts    # @deprecated — see "Execute-mode migration"
    │   └── agents/                    # Agent pipeline (run by GitHub Actions)
    │       ├── analysts/              # 6 Analyst modules + recommendationValidatorAgent.ts (7th, reviews output) + brainLearningAgent.ts (weekly)
    │       ├── synthesis/             # dedup, cross-agent patterns, businessRules.ts (NEW), scoring, action-meta
    │       ├── rules/                 # ported RulesEngine + detect_() functions
    │       ├── llm.ts                 # multi-provider client: Groq/Cerebras/OpenRouter/Gemini failover (NOT Groq-only anymore)
    │       ├── googleAdsClient.ts     # sole Google Ads API touchpoint — see "Execute-mode migration"
    │       └── implementation.ts      # reads approved 'auto' action_plan rows, calls googleAdsClient.ts directly
    └── .github/workflows/
        ├── daily-audit.yml            # cron PAUSED — see "Operational status" above
        ├── hourly-implementation.yml
        └── weekly-brain-learning.yml
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
| **H** | `/api/pending-changes` + `/api/execute-result` + repoint execute mode + `hourly-implementation` workflow | ✅ done — **superseded June 2026** by the Execute-mode migration to the direct Google Ads API; see that section above |
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
- **This file is the master brief and MUST be updated whenever architecture changes — not just when a "phase" completes.** New agents, new synthesis-pipeline stages, new providers, new schema fields, new safety-relevant behavior all go in CLAUDE.md in the same session they're built, before moving to the next task. This was skipped for several real changes (businessRules.ts, the Recommendation Validator agent, the multi-provider LLM client) until the user caught the drift — don't let it happen again.

---

## Known gaps / open questions (read honestly, don't paper over)

- **No agent-health/quality monitor over time (partially addressed).** v1 had Manager/Director modules (`apps_script/managers/*.js`: `AuditManager`, `CampaignDirector`, `CopyIntelManager`, `ImplementationManager`, `SynthesisManager`) that orchestrated *and*, to some degree, sat between the raw agents and the rest of the pipeline. v2's equivalent orchestration is `runDailyAudit.ts` (sequences the 7 agents, isolates failures per-agent so one bad call doesn't abort the run) and `synthesisManager.ts` (sequences dedup → patterns → business rules → validator → scoring → write). The June 2026 "30-day change-outcome feedback loop" (see "Strategic gap-closing additions" above) closes part of this — it does check whether a past `adjust_budget` mutation actually helped, 30 days later — but it's scoped to one change type, evaluating *mutations*, not analyst *quality drift*. **Still missing**: nothing watches the *analysts themselves* for drift over time — e.g. "Search Intelligence Analyst returned 0 findings for 5 days straight," "Performance & Budget Analyst's average confidence dropped this week," "an agent's findings are getting flagged by the Recommendation Validator at a rising rate." The Recommendation Validator reviews individual findings within a single run; nothing reviews an agent's behavior *across* runs. If a meta-monitor like this is wanted, it should be scoped as a new piece (likely a small weekly/daily job reading `findings`/`action_plan` history per `agent`), separate from the change-outcome loop, which answers a different question ("did this change work" vs "is this analyst still reliable").

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
- 6 consolidated Analyst agents (3 rule-based, 3 pure-LLM) + 7th Recommendation Validator agent (reviews output, doesn't produce new findings — see "Synthesis pipeline v2 additions")
- Full synthesis pipeline (dedup, cross-agent patterns, business-rules gate, recommendation validator, impact scoring, action classification)
- Multi-provider LLM failover (Groq×4 keys / Cerebras / OpenRouter / Gemini — see "Multi-provider LLM client")
- GitHub Actions automation (daily-audit — **cron currently paused**, hourly-implementation every hour, weekly-brain-learning Mondays)
- API endpoints for data collection (/api/ingest), approvals (/api/approve); execution now calls the Google Ads API directly via googleAdsClient.ts (/api/pending-changes, /api/execute-result deprecated — see "Execute-mode migration")
- Safety rails (budget caps, bid limits, dry-run mode, approval gates) — enforced in implementation.ts's validateChange() against the real Google Ads API
- Slack notifications (optional digest when action items ready)
- Brain knowledge base (add/edit/delete strategy entries, plus weekly autonomous Brain Learning Agent staging candidates)
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
