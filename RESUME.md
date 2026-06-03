# Resume Brief — Read This First

If you are a Claude instance starting a fresh session in this repo, read these files in order and then confirm you understand before doing anything:

1. **`CLAUDE.md`** — full project architecture, all 15 agents, schemas, safety rules, scoring formula
2. **`state/progress.json`** — exactly what phase we are on
3. **`SETUP.md`** — phase-by-phase setup instructions and what the user has done

Do not modify any files until the user confirms what they want to work on next.

---

## What this project is (60-second summary)

A fully autonomous, strategically intelligent multi-agent system that audits a Google Ads account daily/weekly using 15 specialized agents, grounds every analysis in a curated strategy knowledge base ("The Brain"), synthesizes findings into a P1/P2/P3 plan, asks for human approval in Slack, then executes approved changes via 6 write agents with strict safety rails.

**Cost: ~$0/month.** Everything runs on Google's free tier (Apps Script, Sheets, Drive) + Groq's free Llama 3.3 70B API tier.

## Architecture (very condensed)

```
Google Ads Script (collect mode, scheduled)
  → POSTs all data to Apps Script Web App as JSON
  → Apps Script writes to Google Sheet (Raw_* tabs)
  → 15 agents (audit + copy/intel) read Raw_* + query Brain
  → Each agent calls Groq via callLLM() with a domain prompt
  → Findings written to Findings sheet tab
  → Synthesis dedups + scores + sorts → Action_Plan tab
  → Slack approval gate (hard stop)
  → Implementation agents call back to Google Ads Script
     execute mode for approved mutations
```

## Where we are right now

See `state/progress.json` for the authoritative status. As of last update:

- **Phases 1–6 complete and green** (foundation, data collector, LLM helper, Brain, ContentHunter, audit batch 1)
- **Phase 7 built** (audit batch 2: AdCopyCritic, KeywordMiner, NegativeKwHunter, SearchTermPatternAnalyzer) — **awaiting user to paste 4 files into Apps Script and run `testAuditBatch2`**
- **Phases 8–14 not started** (audit batch 3, managers, synthesis, Slack gate, implementation fleet, dashboard, scheduling)

## Things that live in the cloud (not in this repo)

- Google Sheet with all data (Brain, Raw_*, Findings, Config) — accessed via `SPREADSHEET_ID` Script Property
- Apps Script project — paste files from `apps_script/` here, holds `GROQ_API_KEY`, `INGEST_SECRET`, `BRAIN_DRIVE_FOLDER_ID`, `SPREADSHEET_ID` as Script Properties
- Google Ads Script — paste `google_ads_script.js` here, holds `APPS_SCRIPT_WEBHOOK_URL` + `INGEST_SECRET` as in-file CONFIG constants
- "Ads Agent Brain" Drive folder (file uploads → indexed into Brain sheet by BrainCurator)

The user signs in with the same Google account on their new laptop and everything's already there.

## Key gotchas learned the hard way

1. **Reddit blocks Apps Script** — public JSON 403s from Google Cloud IPs. We pivoted to RSS feeds via `ContentHunter.js`. RedditHunter.js is gone from the repo. Do not re-suggest Reddit unless asked.

2. **Apps Script V8 ≠ modern JS** — no numeric separators (`5_000_000`), no optional chaining (`?.`), no nullish coalescing (`??`). Use plain numbers and `||` fallbacks.

3. **Flat global namespace** — every Apps Script file shares one namespace. Two files can't both define a function with the same name (the later one wins silently). Use object namespaces (`AgentCommon.x`, `BrainStore.x`) for helpers and prefix private helpers (`_namePrefix`).

4. **Sheets auto-parses YYYY-MM-DD as Date** — `getValues()` returns Date objects, not strings. Normalize in the reader (already done in `BrainStore._readAll_`).

5. **Workspace tenants block unverified OAuth** — that's why we use the webhook architecture for Google Ads Script (UrlFetchApp doesn't need Sheets OAuth). Don't make the Ads Script touch Sheets directly.

6. **Groq free tier: 30 RPM, 14,400 RPD, 6,000 TPM** — single requests over 12K tokens get 413'd. Each agent pre-filters its data and caps row counts to stay safely under. `callLLM` retries 429/5xx with exponential backoff.

7. **LLM target.type drift** — without explicit guidance, the LLM invents `"budget"`, `"strategy"`, etc. The hardened prompt in `_common.js` (lines around "target.type MUST be EXACTLY") fixes this. Budget findings → `target.type = "campaign"`.

## Suggested first message from user on resume

```
I'm continuing this project on a new machine. Read CLAUDE.md, state/progress.json,
SETUP.md, and this RESUME.md. Then confirm you understand the system and what
the next user action is. Don't start building until I confirm.
```

## Working principles (carry these into every session)

- One phase at a time. Complete it, test it, then move on.
- Every file must be immediately runnable — no TODOs, no placeholders.
- Each agent is independent: receives data + brain context, returns findings array.
- Fail loudly with descriptive error messages.
- The Slack gate is sacred — no code path runs without checking the Approvals sheet.
- Brain context is mandatory — every audit/copy agent calls `BrainStore.query()` before talking to Groq.
