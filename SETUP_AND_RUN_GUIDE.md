# Google Ads Agent Fleet v2 — Setup & Run Guide

**Status:** v2 complete, ready for deployment and parallel validation (Phase J)

---

## Part 1: Prerequisites

Ensure you have:
- [ ] Google Ads account with access to Scripts and API
- [ ] Supabase account (free tier) — project created at `tqdvbbfhgcqzwhpgwhdw`
- [ ] Vercel account (free tier) — app deployed at https://web-seven-rho-96.vercel.app
- [ ] GitHub account with this repo
- [ ] Node.js 22+ and npm installed locally
- [ ] Groq API key (free tier)

---

## Part 2: Local Environment Setup

### 2.1 Clone & Install

```bash
cd ~/projects
git clone https://github.com/papai4576/google-ads-agent.git
cd google-ads-agent/web
npm install
```

### 2.2 Configure `.env.local`

Create `web/.env.local` with:

```bash
# Database (Supabase Postgres, use pooler connection)
DATABASE_URL="postgresql://postgres.tqdvbbfhgcqzwhpgwhdw:[PASSWORD]@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres"

# LLM (Groq — free tier)
GROQ_API_KEY="[your-groq-api-key]"

# API Auth (shared across v1/v2)
INGEST_SECRET="873f1fe208b9a445b34ecad0aaf0650931b7da98cc9d91e6"

# Optional: Slack notifications
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
```

**How to get Supabase password:**
1. Go to https://app.supabase.com/project/tqdvbbfhgcqzwhpgwhdw/settings/database
2. Copy the connection string (pool mode, port 6543)

**How to get Groq API key:**
1. https://console.groq.com/keys
2. Create a new API key

### 2.3 Verify Connection

```bash
npm run build
# Should succeed with no errors
```

---

## Part 3: Running Locally (Development)

### 3.1 Start Dev Server

```bash
npm run dev
```

Open http://localhost:3000 → should show Overview page with "0 campaigns" (expected, no data yet).

### 3.2 Manual Daily Audit (Local Testing)

```bash
npm run daily-audit
```

**Expected output:**
```
===========================================
daily-audit starting (run_date=2026-06-12)
...
[performance_budget_analyst] findings=X tokens=Y (Zms)
...
Dedup: X → Y (Z merged).
Score: P1=?, P2=?, P3=?
Action plan: wrote ? rows
daily-audit done. X raw findings -> Y action items...
===========================================
```

### 3.3 Check Dashboard

After audit, visit http://localhost:3000:
- **Overview** → should show KPIs (even if all zeros, page should render)
- **Action Plan** → should show items from the audit run
- **History** → should show change_log entries (empty until you approve items)

---

## Part 4: Deploy to Production (Vercel)

### 4.1 Already Deployed

v2 is already live at https://web-seven-rho-96.vercel.app (via GitHub Actions auto-deploy on push to `master`).

To redeploy after changes:
```bash
git add .
git commit -m "Updates"
git push origin master
```

Vercel auto-rebuilds and deploys.

### 4.2 Set Vercel Secrets

In Vercel project settings (https://vercel.com/preetam-das-projects/web/settings/environment-variables), add:

```
DATABASE_URL = [same as local .env.local]
GROQ_API_KEY = [same as local]
SLACK_WEBHOOK_URL = [optional, same as local]
```

(INGEST_SECRET is hardcoded in code, no secret needed — it's public-facing API auth)

---

## Part 5: Google Ads Script Setup (Collect Mode)

### 5.1 Current Configuration

The Google Ads Script (`google_ads_script.js`) is currently configured as:

```js
APPS_SCRIPT_WEBHOOK_URL: "https://web-seven-rho-96.vercel.app/api/ingest"
INGEST_SECRET: "873f1fe208b9a445b34ecad0aaf0650931b7da98cc9d91e6"
MODE: "collect"  // (or "execute")
```

### 5.2 Deploy Script to Google Ads Account

1. Log in to your Google Ads account
2. Go to **Tools & Settings > Conversions > Scripts**
3. Create a new script, paste the contents of `google_ads_script.js`
4. Grant permissions (Google Ads API, UrlFetchApp)
5. **Set a time-based trigger:** Daily, 06:00 UTC (after v2's daily-audit completes at same time, or stagger by 30min)

### 5.3 Verify Collection

Run the script once manually (click Play in Google Ads Scripts UI).

Check v2 database:
```bash
npm run compare  # or check Supabase table browser
```

Expected: `campaigns`, `keywords`, `ads`, etc. tables populate with data.

### 5.4 Collect Mode Data Flow

```
Google Ads Script (06:00 UTC trigger)
   ↓ GAQL queries for: campaigns, campaigns_daily, ad_groups, keywords, ads, search_terms, extensions, negative_keywords
   ↓ POST /api/ingest with data
   ↓
Next.js API Route (/api/ingest)
   ↓ Parse + validate
   ↓ Write to Postgres (campaigns, campaigns_daily, ad_groups, etc.)
   ↓
Raw snapshot tables updated (ready for Analysts to query)
```

---

## Part 6: GitHub Actions Pipelines (Automation)

### 6.1 Daily Audit (06:00 UTC)

**File:** `.github/workflows/daily-audit.yml`

Automatically runs:
```bash
npm run daily-audit
```

**What it does:**
1. Run all 6 Analysts (3 rule-based, 3 pure-LLM) over latest snapshots
2. Deduplicate findings
3. Score and prioritize (P1/P2/P3)
4. Write to `action_plan` table
5. Send Slack notification (if webhook configured)

**To run manually:** GitHub > Actions > daily-audit > Run workflow > dispatch

### 6.2 Hourly Implementation (Every Hour)

**File:** `.github/workflows/hourly-implementation.yml`

Automatically runs:
```bash
npm run hourly-implementation
```

**What it does:**
1. Query `action_plan` for newly-approved `auto` items
2. Derive changes (budget increase, add negatives)
3. Queue to `pending_changes` table
4. Log queued changes

**To run manually:** GitHub > Actions > hourly-implementation > Run workflow

---

## Part 7: Dashboard & Approval Workflow

### 7.1 Views

**Overview** (`/`)
- Total daily budget (from `campaigns` table)
- Budget pacing (MTD vs target)
- KPIs (7d/30d/MTD): spend, conversions, ROAS, CPA
- Latest audit date and summary

**Action Plan** (`/action-plan`)
- Tabs: Auto / Manual / Insight
- Sortable by score, filterable by category
- Approve/Reject buttons for pending items

**History** (`/history`)
- Past audit runs
- Change log entries (before/after values)

**Brain** (`/brain`)
- Strategy knowledge base (add/edit/delete entries)
- Categories: copy, bidding, structure, scaling, audience, etc.

**Config** (`/config`)
- Edit `RULE_*` thresholds (e.g., `RULE_BUDGET_LOST_IS = 0.30`)
- Edit other config values (DRY_RUN, MAX_BUDGET_SHIFT_PCT, etc.)

### 7.2 Approval Flow

1. **Daily audit runs** → findings classified as `auto` / `manual` / `insight`
2. **Auto items appear in Action Plan** → Approve / Reject buttons, with the exact structured change shown (`proposed_changes` — full keyword lists, sitelink/callout copy, RSA headlines, not just the summary text)
3. **Approve** → status = `approved`, entry in `approvals` table
4. **Hourly-implementation detects it** → calls the Google Ads API **directly** via `googleAdsClient.ts` (no script involved) and writes the result to `change_log` (or a simulated row if `DRY_RUN=true`) — see "Execute-Mode Migration" in Part 8 below

---

## Part 8: Execute-Mode Migration & Real Changes

⚠️ **This runs real changes to your Google Ads account — keep `DRY_RUN=true` until you've reviewed simulated `change_log` rows and are confident in the output.**

**Execute mode (the Google Ads Script polling `/api/pending-changes`, applying via `AdsApp`, reporting to `/api/execute-result`) was retired in June 2026.** `google_ads_script.js` now runs **collect mode only**. The execute side moved to `web/src/agents/implementation.ts`, which calls the real Google Ads API directly via `web/src/agents/googleAdsClient.ts` — see CLAUDE.md's "Execute-mode migration" section for the full design. `MODE: "execute"` no longer exists as an option in `google_ads_script.js`.

### 8.1 No script change needed

There is nothing to flip in `google_ads_script.js` to enable execution — `google_ads_script.js`'s `MODE` only ever needs to be `"collect"`. The approval gate (`action_plan.status = 'approved'`) plus `config.DRY_RUN` are the only switches that matter now.

### 8.2 What the `hourly-implementation` job does

1. Reads `action_plan` rows where `status='approved'` and `action_category='auto'`
2. Reads each finding's `proposed_changes` (the structured, machine-executable version of the recommendation — e.g. exact keyword text, exact sitelink copy, exact RSA headlines)
3. If `DRY_RUN=true`: writes a simulated `change_log` row (`dry_run=true, success=true`) and skips the real API call
4. If `DRY_RUN=false`: calls the matching `googleAdsClient.ts` function (e.g. `addNegativeKeyword`, `setKeywordBid`, `addSitelinks`, `createResponsiveSearchAd`) and writes the real result to `change_log`
5. New ad copy (`update_copy` / `create_rsa`) is always created **PAUSED** — approval authorizes creation, never going live

### 8.3 Safety Rails (Non-Negotiable)

```
- Never delete (only pause). New ads created PAUSED, never auto-enabled.
- Bid limit: ±30% per run (config MAX_BID_SHIFT_PCT), enforced in implementation.ts's validateChange()
- Budget limit: 20% per run (config MAX_BUDGET_SHIFT_PCT), same enforcement point
- Ad minimum: ≥2 active per ad group
- DRY_RUN mode: log changes, don't call the Google Ads API (default: true unless config.DRY_RUN = false)
```

Check config table:
```
DRY_RUN = "true"  (or "false" for real changes)
```

---

## Part 9: Daily Operations (Phase J — Week 1)

### 9.1 Each Morning (After 06:00 UTC Audit)

```bash
# 1. Check v2's findings
npm run compare

# 2. Open v1 Google Sheets Action_Plan tab (same date)

# 3. Compare P1/P2/P3 counts, spot-check top items

# 4. Log in PHASE_J_LOG.md
```

### 9.2 If You Need to Adjust Rules

1. Go to dashboard → Config page
2. Edit RULE_BUDGET_LOST_IS (or other thresholds)
3. Save
4. Trigger `daily-audit` manually via GitHub Actions (Workflow Dispatch)
5. Check updated findings

### 9.3 Monitor Slack (Optional)

If `SLACK_WEBHOOK_URL` is set, Slack messages post after daily-audit with action item count.

---

## Part 10: Cutover to v2 (Phase J, Day 7+)

Once Week 1 validation passes (v2 ≥ v1):

### 10.1 Repoint Google Ads Script

In Google Ads Scripts editor:
```js
// Already set to v2, but verify:
APPS_SCRIPT_WEBHOOK_URL: "https://web-seven-rho-96.vercel.app/api/ingest"
MODE: "collect"  // The only mode — execute mode was retired, see Part 8
```

### 10.2 Test the Direct-API Execute Path Once

1. Approve one **auto** item on the dashboard (e.g. an `add_negatives` finding — lowest risk) with `DRY_RUN=true` still set
2. Trigger `hourly-implementation` manually (`npm run hourly-implementation` or the GitHub Actions workflow_dispatch)
3. Verify a simulated row appeared in `change_log` (`dry_run=true, success=true`) with `before_value`/`after_value` matching the finding's `proposed_changes`
4. Once satisfied, set `config.DRY_RUN = "false"` and repeat — confirm one real mutation succeeds in the actual Google Ads account before approving anything else

### 10.3 Go Live

1. Leave `config.DRY_RUN = "false"` once step 10.2 is confirmed
2. Disable v1 scheduler jobs
3. Monitor logs for 2–3 days
4. If stable, decommission v1

---

## Part 11: Troubleshooting

### Dashboard Shows "0 campaigns"

**Cause:** No collect run has happened yet, or Google Ads Script not repointed to v2.

**Fix:**
1. Verify `google_ads_script.js` has correct `APPS_SCRIPT_WEBHOOK_URL`
2. Run collect manually in Google Ads Scripts UI
3. Check Supabase table browser: does `campaigns` table have rows?
4. Check `/api/ingest` logs in Vercel (https://vercel.com/preetam-das-projects/web/logs)

### Daily-Audit Fails

**Check:**
1. GitHub Actions logs (https://github.com/papai4576/google-ads-agent/actions)
2. Vercel logs (API route errors)
3. Groq API key valid? (check https://console.groq.com)
4. Database connection? (test locally: `npm run daily-audit`)

### Approve Button Does Nothing

**Check:**
1. Browser console for errors (F12)
2. Vercel `/api/approve` logs
3. Is `INGEST_SECRET` set in Vercel environment variables?

---

## Quick Reference: All Commands

```bash
# Local development
npm run dev                    # Start dev server (localhost:3000)
npm run build                  # Build for production
npm run lint                   # Check code style

# Automation (runs locally or via GitHub Actions)
npm run daily-audit            # Run all 6 Analysts, populate action_plan
npm run hourly-implementation  # Execute approved 'auto' items directly via the Google Ads API (or simulate under DRY_RUN)

# Validation & debugging
npm run compare [date]         # Show v2 findings for a date (default: today)
```

---

## System Architecture at a Glance

```
Google Ads Account
   │
   └→ collect-mode (the ONLY mode): Google Ads Script reads GAQL data
                    POSTs to /api/ingest
                    writes to: campaigns, keywords, ads, etc.

Google Ads API (direct, no script involved)
   └→ googleAdsClient.ts called by implementation.ts after dashboard
      approval — writes to: change_log (and pending_changes as a
      local audit log, no longer polled by anything)

Vercel (Next.js + API Routes)
   ├ GET /api/ingest          [collect data from Ads Script]
   ├ GET /api/pending-changes [@deprecated — rollback path only]
   ├ POST /api/execute-result [@deprecated — rollback path only]
   ├ POST /api/approve        [dashboard approves items]
   ├ GET / /action-plan ...   [dashboard pages]
   └ Dashboard (/, /action-plan, /history, /brain, /config)

Postgres (Supabase)
   ├ snapshots: campaigns, keywords, ads, search_terms, etc.
   ├ agent layer: findings, action_plan, pending_changes, change_log
   ├ config: RULE_*, targets, DRY_RUN, etc.
   └ brain_entries: strategy knowledge base

GitHub Actions (Automation)
   ├ daily-audit (06:00 UTC): run Analysts, populate action_plan
   └ hourly-implementation (every hour): queue approved changes
```

---

## Success Checklist

✅ **Setup complete when:**
- [ ] Local `.env.local` configured (DATABASE_URL, GROQ_API_KEY, INGEST_SECRET)
- [ ] `npm run dev` starts without errors
- [ ] `npm run build` succeeds
- [ ] Vercel secrets set (DATABASE_URL, GROQ_API_KEY)
- [ ] Google Ads Script deployed and repointed to v2

✅ **Ready for Phase J when:**
- [ ] `npm run daily-audit` runs without errors
- [ ] Google Ads Script collect mode returns data
- [ ] Dashboard shows data (campaigns, findings)
- [ ] Approval workflow tested (approve/reject button works)
- [ ] Slack notifications working (if configured)

✅ **Ready for cutover when:**
- [ ] 7 days of parallel spot-checks logged
- [ ] v2 findings ≥ v1 findings
- [ ] Direct-API execute path tested (Part 10.2: one DRY_RUN approval, then one real mutation)
- [ ] Monitoring plan in place
