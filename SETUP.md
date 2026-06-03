# Setup Guide — Google Ads Agent Fleet

This guide walks you through every manual step required outside the codebase.
We do **one phase at a time**.

> ⚠️ **Tip:** open this file in a plain-text editor (Notepad, VS Code, Sublime) —
> not Microsoft Word. Word re-saves Markdown as UTF-16 and breaks formatting.

---

## Phase 1 — Foundation (Sheet + Apps Script + Brain folder) ✅

(Completed. Phase 1 status: green.)

If you ever need to re-bootstrap, the steps are:

1. Get a Groq API key from https://console.groq.com/keys
2. Create a Google Sheet, open Extensions → Apps Script
3. Paste `apps_script/config.js` and `apps_script/setup.js` into the editor
4. Add `GROQ_API_KEY` to Script Properties
5. Run `setupEverything`

---

## Phase 2 — Google Ads Script data collector (webhook architecture)

### Why this architecture

Google Ads Scripts in a Workspace tenant often can't authorize direct Google Sheet access because Workspace blocks unverified OAuth scopes. To sidestep this entirely, the Ads Script never touches the Sheet — it POSTs all collected data to your Apps Script Web App, which writes to the Sheet (Apps Script already owns the Sheet, so no permission issues).

```
Google Ads Script → POST JSON → Apps Script Web App → Sheet
   (no Sheet auth)              (writes Raw_* tabs)
```

### What this phase delivers

- An Apps Script Web App deployed at a stable HTTPS URL
- A Google Ads Script that fetches 6 data categories and POSTs them to that URL
- All 6 `Raw_*` tabs populated on each run

---

### Step 1 — Add `ingest.js` to your Apps Script project

1. Open your Google Sheet → **Extensions → Apps Script**
2. Click the **`+`** next to **Files** → **Script** → name it **`ingest`**
3. Open `apps_script/ingest.js` from this repo, copy the entire contents, paste into the `ingest` file. Save (Ctrl+S).

You should now have three files in the Apps Script editor: **`config`**, **`setup`**, **`ingest`**.

### Step 2 — Add an INGEST_SECRET to Script Properties

This is a shared password between your Apps Script and your Google Ads Script. It prevents anyone who finds your Web App URL from sending fake data.

1. In Apps Script, click the gear icon ⚙️ (**Project Settings**)
2. Scroll to **Script Properties** → **Add script property**
   - **Property:** `INGEST_SECRET`
   - **Value:** make up a random string — e.g. `kf8a-92mxz-7qwer-aabb-cc33` (any 20+ random characters)
3. Click **Save script properties**
4. **Copy this exact secret to a notepad** — you'll paste it into the Google Ads Script in Step 5

### Step 3 — Deploy the Apps Script as a Web App

1. In the Apps Script editor, click **Deploy** (top right) → **New deployment**
2. Click the gear icon ⚙️ next to "Select type" → choose **Web app**
3. Fill in:
   - **Description:** `Ads Agent Ingest v1`
   - **Execute as:** **Me** *(your-email)*
   - **Who has access:** **Anyone** *(yes, even "Anyone" — the secret protects it)*
4. Click **Deploy**
5. Apps Script will ask for permissions one more time — **Allow**
6. You'll see a **Web app URL** like:
   ```
   https://script.google.com/macros/s/AKfycby...long.../exec
   ```
7. **Copy this URL** to a notepad — you'll need it in Step 5

### Step 4 — Sanity-check the Web App

1. Paste the Web App URL into a browser
2. You should see JSON like:
   ```json
   {"ok":true,"service":"google-ads-agent-fleet ingest","hint":"POST data here...","has_secret":true}
   ```
   - `has_secret: true` means INGEST_SECRET is set correctly
   - If `has_secret: false`, go back to Step 2

### Step 5 — Create the Google Ads Script

1. Sign in to https://ads.google.com
2. Click **Tools & Settings** (wrench icon) → under **Bulk Actions** click **Scripts**
3. Click **`+`** → **New script**
4. Name it: **`Ads Agent — Data Collector`**
5. **Delete all placeholder code** in the editor
6. Open `google_ads_script.js` from this repo and **copy the entire contents** into the editor
7. At the top of the file, find the `CONFIG` block and replace the two `PASTE_...` values:
   ```javascript
   const CONFIG = {
     APPS_SCRIPT_WEBHOOK_URL: 'https://script.google.com/macros/s/AKfycby.../exec', // ← from Step 3
     INGEST_SECRET:           'kf8a-92mxz-7qwer-aabb-cc33',                          // ← from Step 2
     ...
   };
   ```
8. Click **Save**

### Step 6 — Authorize (Ads Script side)

1. Click **Authorize** (button at top)
2. Pick your Google account
3. **You will only see ONE permission request**: external URL fetch
4. Approve it
5. Because the script does not request Sheets/Drive access, the Workspace block does NOT trigger

> If you do still see "This app is blocked", let me know — there's one more workaround to try.

### Step 7 — Preview run

1. Click **Preview** (bottom of the script editor) — runs once in dry mode
2. Check the **Logs** tab — you should see:
   ```
   Google Ads Agent Fleet — collect mode
   Customer: 148-474-3796
   Date range: LAST_30_DAYS, run_date: 2026-06-02
   
   Collection summary:
     [OK  ] Raw_Campaigns     12 rows
     [OK  ] Raw_AdGroups      34 rows
     [OK  ] Raw_Keywords      287 rows
     [OK  ] Raw_Ads           41 rows
     [OK  ] Raw_SearchTerms   1850 rows
     [OK  ] Raw_Extensions    18 rows
   
   Posting to Apps Script ingest endpoint…
   Ingest response: HTTP 200 — Raw_Campaigns=12, Raw_AdGroups=34, ...
   Done.
   ```
3. Open your Sheet — the 6 `Raw_*` tabs should now contain data

### Step 8 — Confirm Phase 2 is done

Reply to me with one of:

- **"Phase 2 green"** — all 6 tabs populated → I'll start Phase 3 (Apps Script Web App skeleton + Groq helper for the agents).
- **"Failed at step N"** — paste the relevant log output and we'll fix it.

---

## Phase 3 — LLM helper (`callLLM` via Groq)

### What this phase delivers

A single function — `callLLM(systemPrompt, userPrompt, options)` — that every one of the 15 agents will use to talk to Groq's Llama 3.3 70B. It handles JSON-mode output, rate-limit retries, token telemetry, and structured error reporting.

### Step 1 — Add `llm.js` to your Apps Script project

1. Open your Sheet → **Extensions → Apps Script**
2. Click the **`+`** next to **Files** → **Script** → name it **`llm`**
3. Open `apps_script/llm.js` from this repo, copy the contents, paste into the `llm` file. Save (Ctrl+S).

Your Apps Script project should now have four files: **`config`**, **`setup`**, **`ingest`**, **`llm`**.

### Step 2 — Run the end-to-end LLM test

1. In the function dropdown at the top of the editor, select **`testLLM`**
2. Click **Run** ▶️
3. Open the **Execution log** at the bottom. You should see:
   ```
   [test] Testing callLLM with a realistic agent-style prompt
   [llm]  test_perf_analyst OK attempt=1 ms=850 tokens=327
   [test] Model:    llama-3.3-70b-versatile
   [test] Attempts: 1
   [test] Time:     850ms
   [test] Tokens:   prompt=235, completion=92, total=327
   [test] Raw text:
   [test] {"agent":"performance_analyst","findings":[...],"summary":"..."}
   [test]   [OK  ] agent field
   [test]   [OK  ] findings is array
   [test]   [OK  ] summary is string
   [test]   [OK  ] first finding has id
   [test]   [OK  ] first finding has severity
   [test] ✅ callLLM is working. Phase 3 ready.
   ```
4. The exact numbers will vary. What matters is **all five validation checks show OK** and you see the JSON output.

### Step 3 — (Optional) Quick wire-only check

If anything failed in Step 2 and you want to isolate whether it's auth vs. output shape, select **`testLLMPing`** in the dropdown and Run. It calls Groq with a one-word prompt — no JSON parsing — so success here means the wire works and any earlier failure was in the JSON-mode contract.

### Step 4 — Confirm Phase 3 is done

Reply to me with one of:

- **"Phase 3 green"** — all five validations OK → I'll start Phase 4 (The Brain — Drive folder indexer).
- **"Failed at <step>"** — paste the execution log output and we'll fix it.

---

## Phase 4 — The Brain (Drive folder → indexed knowledge)

### What this phase delivers

A living strategy knowledge base. You drop files (PDFs, Google Docs, .md/.txt, .docx) into your **Ads Agent Brain** Drive folder anytime. `refreshBrain()` scans the folder, extracts text, calls Groq to generate structured metadata (`category`, `title`, `summary`, `key_points`), and writes one row per file to the **Brain** sheet tab.

Every audit/copy agent will then call `BrainStore.query(['bidding','scaling'])` before talking to Groq, so each agent sees both live account data AND your curated strategy library.

### Step 1 — Enable Drive Advanced Service (needed for PDF/DOCX support)

1. Open your Sheet → **Extensions → Apps Script**
2. In the left sidebar, look for **Services** (just under Files)
3. Click the **`+`** next to Services
4. Scroll the dialog to find **Drive API** → version **v2** → click **Add**
5. Make sure the **Identifier** is exactly `Drive` (capital D)
6. Click **Add** to confirm

> If you skip this, plain text and Google Docs still work, but PDFs/DOCX will fail with a clear error message.

### Step 2 — Add the two Brain files to the project

1. Click **`+`** next to **Files** → **Script** → name it **`brain/BrainStore`**
2. Open `apps_script/brain/BrainStore.js` from this repo, copy contents, paste, save
3. Click **`+`** next to **Files** → **Script** → name it **`brain/BrainCurator`**
4. Open `apps_script/brain/BrainCurator.js` from this repo, copy contents, paste, save

> Apps Script doesn't have real folders, but filenames with slashes render as folders in the sidebar. You should now see a `brain/` folder containing both files.

### Step 3 — Verify the LLM extraction works (no Drive needed)

This test uses an in-memory document and just exercises the Groq call. No file uploads required yet.

1. Select **`testBrainCuratorExtract`** in the function dropdown
2. Click **Run** ▶️
3. Check the execution log. You should see:
   ```
   [test] category:   bidding
   [test] title:      Target ROAS bidding playbook (or similar)
   [test] summary:    Target ROAS bidding works best with 50+ conversions...
   [test] key_points: (3-5 items)
   [test]   - Need at least 50 conversions per 30 days before tROAS
   [test]   - Start at 75% of trailing ROAS to give algo room to learn
   [test]   - Adjust target by max 10–15% per week
   [test] ✅ Routed to "bidding" as expected.
   ```
4. Specific wording will vary; what matters is `category: bidding` and 3–5 key points.

### Step 4 — Verify BrainStore (writes a test row)

1. Select **`testBrainStore`** → Run
2. You should see:
   ```
   [test] Before: 0 brain entries
   [test] Added entry id=brain_001
   [test] Query (bidding+scaling, limit 3) → 1 entries:
   [test]   - [brain_001] (bidding) Test entry — tROAS for ecommerce
   [test] After: 1 brain entries (delta 1)
   [test] ✅ BrainStore working. You can manually delete the test row...
   ```
3. Switch to the Sheet, click the **Brain** tab — you should see one row. Feel free to delete it.

### Step 5 — Drop a real file in your Brain folder and index it

1. Go to Google Drive → open the **Ads Agent Brain** folder
2. Upload **1–2 strategy resources** to start. Anything works — examples:
   - A PDF of a Google Ads strategy article
   - A Google Doc with your brand voice guide
   - A `.md` or `.txt` file with notes on competitor positioning
3. Back in Apps Script, select **`refreshBrain`** → **Run**
4. Execution log should show one block per file:
   ```
   [brain] Brain folder: "Ads Agent Brain" (...)
   [brain] Already indexed: 0 entries
   [brain] Files in folder: 2
   [brain] New files to process: 2
   [brain] ── my-tcpa-guide.pdf (application/pdf)
   [brain]    OK   → brain_001 (bidding)
   [brain] ── brand-voice.gdoc (application/vnd.google-apps.document)
   [brain]    OK   → brain_002 (brand)
   [brain] Done. processed=2, skipped=0, failed=0
   ```
5. Check the **Brain** tab — you should see one row per indexed file with category, title, summary, and key_points populated.

### Step 6 — (Optional) Install the nightly trigger

After you've confirmed everything works, install the daily auto-refresh:

1. Select **`setupBrainNightlyTrigger`** → Run
2. Approve any new permissions if prompted
3. The trigger runs `refreshBrain` daily at the hour set in your Config tab's `BRAIN_REFRESH_HOUR` (default 3 AM)
4. You can verify in Apps Script left sidebar → **Triggers** (clock icon)

### Step 7 — Confirm Phase 4 is done

Reply to me with one of:

- **"Phase 4 green"** — Brain tab has entries from real uploaded files → I'll start Phase 5 (Reddit Hunter Agent).
- **"Failed at step N"** — paste the execution log output.

---

## Phase 5 — Content Hunter (auto-curated PPC industry intel via RSS)

> **Why RSS instead of Reddit:** Reddit blocks the public JSON API from cloud IPs (Apps Script runs on Google Cloud), and Reddit's data-access approval is a multi-week review process for personal scripts. RSS feeds from PPC industry blogs are public, no-auth, immediately reachable, and arguably higher signal-to-noise than Reddit — pro authors instead of random posters.
>
> If you ever want to revisit Reddit later, the original `RedditHunter.js` is still in the repo. We can wire it back in if Reddit approves your data-access request.

### What this phase delivers

Every Sunday morning, the system scans 4 high-quality PPC blogs via RSS:
- **PPC Hero**
- **Search Engine Land (PPC section)**
- **Search Engine Journal (PPC section)**
- **WordStream Blog**

Each new article from the past 7 days is filtered for PPC relevance, summarised by Groq into `{category, title, summary, key_points, confidence}`, and written to the **Brain** sheet alongside your manual uploads.

The top 5 newly-indexed insights are formatted as a Slack digest. If you've already set `SLACK_WEBHOOK_URL` in Script Properties, it posts automatically; otherwise it just logs the preview (wired in Phase 11).

### Step 1 — (Optional cleanup) Remove the unused Reddit Hunter file

If you already pasted `brain/RedditHunter.js` from the earlier Reddit attempt, you can delete it:

1. Apps Script editor → left sidebar → right-click `brain/RedditHunter` → **Delete**
2. (Optional) Project Settings → Script Properties → delete `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_TOKEN`, `REDDIT_TOKEN_EXPIRES_AT` if any exist

Skipping this cleanup is fine — those files/properties just sit unused.

### Step 2 — Re-paste `config` and `setup` to pick up the new Config defaults

I added two new Config keys (`CONTENT_LOOKBACK_DAYS`, `CONTENT_FEEDS_JSON`) so the Config tab gets them auto-seeded next time you run `setupEverything`.

Two paths — pick the one that's less work:

**Quick path** (no re-paste): just open the **Config** tab in your Sheet and add two new rows manually:

| key | value | description |
|-----|-------|-------------|
| `CONTENT_LOOKBACK_DAYS` | `7` | ContentHunter: how many days of items to index |
| `CONTENT_FEEDS_JSON` | *(leave blank)* | Optional override — leave blank to use the default 4 feeds |

**Thorough path**: re-paste `apps_script/setup.js` from the repo and re-run `setupEverything`. It's idempotent and will just add the two new Config rows.

### Step 3 — Add `brain/ContentHunter.js` to your project

1. Apps Script editor → click **`+`** next to **Files** → **Script** → name it **`brain/ContentHunter`**
2. Open `apps_script/brain/ContentHunter.js` from this repo, copy contents, paste, save

You should now see in the `brain/` folder: `BrainStore`, `BrainCurator`, `ContentHunter` (and optionally `RedditHunter` if you left it).

### Step 4 — Sanity-check the feeds (no LLM, no Brain writes)

1. Function dropdown → select **`testContentFetch`** → Run
2. Execution log should show counts per feed and titles of recent PPC articles:
   ```
   [test] ═══════════════════════════════════════════
   [test] ContentHunter feed diagnostic (no LLM)
   [test] ═══════════════════════════════════════════
   [test] PPC Hero: items=10 recent(7d)=4 relevant=4
   [test]   2026-06-02 — Three PMax asset group tweaks that doubled our CPL
   [test]   2026-05-31 — tCPA versus tROAS: which to pick for low-volume B2B
   [test] Search Engine Land (PPC): items=15 recent(7d)=6 relevant=5
   ...
   [test] TOTAL: items=50, recent=22, would-process=15
   [test] ✅ Pre-filter is producing candidates. Run testContentHunter for the full pipeline.
   ```
3. Real counts depend on what was published this week.
4. **If a feed shows `FAIL`** — usually a temporary network issue. Re-run after a minute. If consistent, that feed's URL may have moved; the other 3 will still work.

### Step 5 — Run the full pipeline

1. Function dropdown → select **`testContentHunter`** → Run
2. This calls `refreshContentIntel()` — fetches RSS, filters, runs Groq on each candidate, writes Brain entries
3. Execution log shows one block per article:
   ```
   [content] ── PPC Hero · Three PMax asset group tweaks that doubled our CPL
   [content]    OK   → brain_012 (pmax, high)
   [content] ── WordStream Blog · 2026 Google Ads benchmark report
   [content]    OK   → brain_013 (performance, medium)
   [content] ── Search Engine Land (PPC) · Q3 platform update news
   [content]    SKIP: confidence=low ("Q3 platform update news")
   ...
   [content] ─── Digest preview ───
   [content] *PPC Strategy Digest — week of 2026-06-03*
   ...
   [content] SLACK_WEBHOOK_URL not set — digest only logged. (Wired in Phase 11.)
   [content] Done. added=N, skipped_low_confidence=M, failed=0, digest_posted=false
   ```
4. Switch to your Sheet → **Brain** tab — new rows with `source_type=rss` and the article URL in the `source` column.

### Step 6 — (Optional) Install the weekly trigger

After confirming the pipeline works:

1. Function dropdown → **`setupContentWeeklyTrigger`** → Run
2. Approve any new permissions
3. Trigger runs every Sunday at the hour set in Config's `DAILY_RUN_HOUR` (default 3 AM)
4. Verify in Apps Script left sidebar → **Triggers** (clock icon)

### Step 7 — Confirm Phase 5 is done

Reply with one of:

- **"Phase 5 green"** — Brain tab has RSS-sourced entries (source_type=rss) → I'll start Phase 6 (first audit batch — Performance, Bid, QS, Conversion).
- **"No candidates"** — pipeline ran but no items passed the relevance filter. Widen `CONTENT_LOOKBACK_DAYS` in Config (e.g. `7` → `30`), or just say so — we'll move on and ContentHunter will catch articles over coming weeks once scheduled.
- **"Failed at step N"** — paste the relevant log.

---

## Phase 6 — Audit Batch 1 (4 audit agents)

### What this phase delivers

The first four audit agents — the ones that read your Raw_* data and produce structured findings:

| Agent | Reads | Surfaces |
|-------|-------|----------|
| **PerformanceAnalyst** | Raw_Campaigns + Raw_AdGroups | Campaigns over CPA target, under ROAS target, high spend with zero conversions |
| **BidBudgetAnalyst** | Raw_Campaigns | Wrong bid strategy for volume, budget-capped growth, rank-lost-IS issues, idle budgets |
| **QualityScoreInspector** | Raw_Keywords | Low-QS keywords costing real money, diagnosed by QS root cause |
| **ConversionHealthChecker** | Raw_Campaigns + Raw_Ads | Tracking gaps (spend without conversions), missing values, attribution outliers |

Every agent queries the **Brain** for relevant strategy categories before talking to Groq, so each finding is grounded in both live account data AND your strategy knowledge base.

All findings land in the **Findings** sheet tab as structured rows, ready for synthesis in Phase 10.

### Step 1 — Add the shared agent scaffold

1. Apps Script editor → click **`+`** next to **Files** → **Script** → name it **`agents/_common`**
2. Open `apps_script/agents/_common.js` from this repo, copy contents, paste, save

This is `AgentCommon` — the helper every audit/copy agent will use. It centralises Sheet reading, Brain context formatting, findings validation, and writes to the Findings tab.

### Step 2 — Add the 4 audit agent files

For each of these, the workflow is the same: `+` → Script → name it as shown → paste contents from the repo file → save.

| File name in Apps Script | Source in repo |
|--------------------------|----------------|
| `agents/audit/PerformanceAnalyst` | `apps_script/agents/audit/PerformanceAnalyst.js` |
| `agents/audit/BidBudgetAnalyst` | `apps_script/agents/audit/BidBudgetAnalyst.js` |
| `agents/audit/QualityScoreInspector` | `apps_script/agents/audit/QualityScoreInspector.js` |
| `agents/audit/ConversionHealthChecker` | `apps_script/agents/audit/ConversionHealthChecker.js` |

After this you should have an `agents/` folder in the Apps Script sidebar containing `_common` plus an `audit/` sub-folder with 4 agent files.

### Step 3 — Test one agent in isolation first

Always test individual agents before running the batch — easier to debug.

1. Function dropdown → select **`testPerformanceAnalyst`** → Run
2. Execution log should show:
   ```
   [test] ═══════════════════════════════════════════
   [test] PerformanceAnalyst dry run
   [test] ═══════════════════════════════════════════
   [agent] performance_analyst → 3 findings (written=3, dropped=0, tokens=2841, 2150ms)
   [test] Summary: Three campaigns are running CPA 40-80% above target; two have tracking issues.
   [test] Findings: 3, dropped: 0, tokens: 2841, 2150ms
   [test]   [P1] Brand-Search-EN CPA at $87 (target $50)
   [test]     target: campaign Brand-Search-EN (12345678)
   [test]     action: Lower tCPA target from $87 to $65 as a two-step move; expect ...
   [test] ...
   ```
3. Switch to your Sheet → **Findings** tab — you should see new rows with `agent=performance_analyst`, populated `severity`, `score`, `target_*`, etc.

### Step 4 — Test all 4 in sequence

1. Function dropdown → select **`testAuditBatch1`** → Run
2. The log shows one line per agent:
   ```
   [test] Audit Batch 1 — 4 agents in sequence
   [test]   [OK]   PerformanceAnalyst           findings=3 tokens=2841
   [test]   [OK]   BidBudgetAnalyst             findings=4 tokens=3120
   [test]   [OK]   QualityScoreInspector        findings=2 tokens=1980
   [test]   [OK]   ConversionHealthChecker      findings=1 tokens=2210
   [test] Batch complete: 10 findings, 10151 tokens, 8.4s.
   [test] Check the Findings sheet for the new rows.
   ```
3. Real numbers depend on your account. Common patterns:
   - **0 findings** from an agent = that agent didn't find anything actionable (healthy on its domain). Not an error.
   - **Some `dropped` count** = LLM produced a finding that failed schema validation. Usually harmless; the rest still write through.

> ⚠️ **Groq rate limits:** as you saw in Phase 5, running back-to-back LLM calls can hit Groq's free-tier 30/min cap. The retry logic in `callLLM` recovers automatically — you'll see `[llm] ... 429 attempt=1 → sleeping...` in the log followed by a successful retry.

### Step 5 — Confirm Phase 6 is done

Reply with one of:

- **"Phase 6 green"** — Findings tab has rows from all 4 agents → I'll start Phase 7 (audit batch 2: Copy, Keywords, Negatives, SearchTerm patterns — 4 more agents).
- **"Failed at <agent>"** — paste the relevant log section for the agent that errored.
- **"0 findings"** — fine, share the summary lines; some accounts genuinely don't have issues in batch 1's domain. We'll keep moving.

---

## Phase 7 — Audit Batch 2 (4 copy + intel agents)

### What this phase delivers

The next four agents — focused on copy and keyword-side optimisations:

| Agent | Reads | Surfaces |
|-------|-------|----------|
| **AdCopyCritic** | Raw_Ads + Raw_AdGroups | Underperforming RSAs + proposed new headline/description copy |
| **KeywordMiner** | Raw_SearchTerms + Raw_Keywords | Converting search terms not yet exact-match (promote opportunities) |
| **NegativeKwHunter** | Raw_SearchTerms | Theme-clustered negative-keyword recommendations for wasted spend |
| **SearchTermPatternAnalyzer** | Raw_SearchTerms | Structural patterns: intent gaps, cross-campaign leakage, theme-level CVR outliers |

All four use the same Brain-context + universal findings schema, write to the same Findings tab.

### Step 1 — (Optional) Add new Config row

If you want to tweak the spend threshold for NegativeKwHunter:

| key | value | description |
|-----|-------|-------------|
| `NEGATIVE_KW_MIN_WASTE` | `50` | Minimum spend (in account currency) for a zero-conv term to be considered for negation. Lower this for tighter mining. |

(Or skip — it defaults to 50.)

### Step 2 — Add the 4 agent files

Each: `+` → Script → name as shown → paste contents → save.

| File name in Apps Script | Source in repo |
|--------------------------|----------------|
| `agents/copy_intel/AdCopyCritic` | `apps_script/agents/copy_intel/AdCopyCritic.js` |
| `agents/copy_intel/KeywordMiner` | `apps_script/agents/copy_intel/KeywordMiner.js` |
| `agents/copy_intel/NegativeKwHunter` | `apps_script/agents/copy_intel/NegativeKwHunter.js` |
| `agents/copy_intel/SearchTermPatternAnalyzer` | `apps_script/agents/copy_intel/SearchTermPatternAnalyzer.js` |

You should now have an `agents/copy_intel/` folder in the sidebar with all 4 files.

### Step 3 — Test one agent first

Function dropdown → **`testNegativeKwHunter`** → Run (usually the meatiest finder of issues on a real account).

Expected:

```
[test] NegativeKwHunter dry run
[llm] negative_kw_hunter OK attempt=1 ms=2800 tokens=4500
[agent] negative_kw_hunter → 4 findings (written=4, dropped=0, tokens=4500, 3100ms)
[test] Summary: Identified 4 wasted-spend themes that could save ~₹X/month if negated.
[test]   [P1] Block "free" / "cheap" intent across non-brand campaigns
[test]     target: campaign HM_Search_Generic (12345)
[test]     action: Add as campaign-level negatives: -free, -cheap, -no cost, ...
```

### Step 4 — Run the full batch

Function dropdown → **`testAuditBatch2`** → Run.

```
[test] Audit Batch 2 — 4 copy/intel agents in sequence
[test]   [OK]   AdCopyCritic                  findings=N tokens=NNNN
[test]   [OK]   KeywordMiner                  findings=N tokens=NNNN
[test]   [OK]   NegativeKwHunter              findings=N tokens=NNNN
[test]   [OK]   SearchTermPatternAnalyzer     findings=N tokens=NNNN
[test] Batch complete: N findings, NNNN tokens, Ns.
```

Expect 429s with auto-retry — same as Phase 6, the backoff handles them.

### Step 5 — Verify the Findings tab

After both batches your Findings tab should have ~50 rows from 8 different agents:
`performance_analyst`, `bid_budget_analyst`, `quality_score_inspector`, `conversion_health_checker`,
`ad_copy_critic`, `keyword_miner`, `negative_kw_hunter`, `search_term_pattern_analyzer`.

### Step 6 — Confirm Phase 7 is done

Reply with:

- **"Phase 7 green"** — Findings has rows from all 4 new agents → I'll start Phase 8 (audit batch 3: Audience, Structure, Extensions, Competitive, Trends, Landing Page — 6 more agents to complete the 14-agent fleet).
- **"Failed at <agent>"** — paste the relevant log; we'll fix.
- **"0 findings on <agent>"** — fine for some agents on healthy accounts; share the summary lines.

---

## What you do NOT need yet

| Item | Phase needed |
|------|--------------|
| Slack workspace + bot token | Phase 11 |
| Search Console verified site | Phase 2.5 (optional) |
