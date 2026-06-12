# Phase J Runbook: Parallel Validation & Cutover

## Overview

Phase J runs v1 (Apps Script + Google Sheets) and v2 (Postgres + Next.js + GitHub Actions) **in parallel for ~1 week**, validates that v2 findings are equivalent or better than v1, then cuts over and decommissions v1.

---

## Step 1: Ensure v2 is Fully Running

**Prerequisites:**
- [ ] All 6 Analysts running in v2 (Phases D–E complete)
- [ ] `daily-audit` GitHub Actions running on schedule (Phase F)
- [ ] Dashboard pages working: Overview, Action Plan, History, Brain, Config (Phases G–I)
- [ ] `hourly-implementation` running to process approved changes (Phase H)

**Verification:**
```bash
# Check latest action_plan run
npm run compare 2026-06-12  # (today's date)
```

Expected output: findings summary with P1/P2/P3 breakdown.

---

## Step 2: Start Parallel Runs (Week 1)

### Enable Both Systems

**v1 (Apps Script + Sheets):**
- Google Ads Script set to `mode: 'collect'` (already running, unchanged)
- Apps Script webhook POSTs data to v1 Sheet (already running)
- Manual action approvals in v1 Sheets > Approvals tab (existing workflow)
- Execute mode pulls from v1 Config.EXECUTE_QUEUE (existing workflow)

**v2 (Next.js + GitHub Actions):**
- `daily-audit` workflow runs at 06:00 UTC (Phase F setup) → populates v2 Postgres
- Dashboard at https://web-seven-rho-96.vercel.app shows v2 findings
- Approvals via dashboard buttons (Phase G)
- `hourly-implementation` workflow runs hourly to process approved `auto` items (Phase H)

### Daily Comparison Routine

**Each morning (after 06:00 UTC audit completes):**

1. **Run comparison script:**
   ```bash
   npm run compare
   ```
   Shows v2's P1/P2/P3 breakdown and action items by category.

2. **Manual spot-check vs v1:**
   - Open v1 Google Sheet "Action_Plan" tab (same date)
   - Count P1/P2/P3 in both systems
   - Pick 3–5 high-priority items from v2 and verify:
     - Same targets flagged (campaign/ad group names match)
     - Similar findings (copy issue, budget waste, quality score, etc.)
     - v2's reasoning makes sense (what/why/action)
   - Note any surprises (v2 found more, found less, or different priorities)

3. **Track in progress notes:**
   - Keep daily notes in `state/progress.json` or a separate `PHASE_J_LOG.md`
   - Example: `2026-06-12: P1=1, P2=0, P3=0 (match v1 exactly). v2 flagged one additional CTR issue on adgroup_xyz.`

---

## Step 3: Validate Equivalence or Better (Days 2–7)

Over the week, you're looking for:

✅ **Equivalent:** Same P1/P2/P3 counts, same targets flagged, v2 gives same or better explanations
✅ **Better:** v2 catches issues v1 misses, or prioritizes correctly where v1 gets it wrong
❌ **Red flag:** v2 misses critical issues v1 finds, or flags unimportant things as P1

### Adjustment Thresholds

If v2's P1/P2/P3 distribution looks wrong after day 2–3:
- Adjust `RULE_*` thresholds in `/config` page to tune sensitivity
- Re-run `daily-audit` manually if needed (`workflow_dispatch`)
- Document adjustments in progress notes

### Success Criteria

By end of Week 1, v2 should:
- [ ] Catch ≥95% of critical issues (P1) that v1 catches
- [ ] Not miss entire categories (e.g., no QS issues when v1 flags them)
- [ ] Provide clearer/more specific action text
- [ ] Run reliably (no persistent Groq API failures, no database issues)

---

## Step 4: Cutover (Day 7+)

### Pre-Cutover Checklist

- [ ] Spot-check log shows v2 ≥ v1 in finding quality
- [ ] No P1 regressions over the week
- [ ] Dashboard is stable, no data loss
- [ ] Approvals workflow tested (approve/reject in v2 dashboard works)
- [ ] `hourly-implementation` has processed at least one approved `auto` item successfully
- [ ] v1 and v2 both running without errors for ≥5 days

### Cutover Steps (Go-Live)

**1. Freeze v1 approvals (day before cutover)**
   - Tell yourself: "No more approvals in v1 Sheets Approvals tab after EOD"
   - Any pending v1 approvals → manually move to v2 dashboard as notes, or re-approve in v2

**2. Point Google Ads Script to v2 APIs (day of cutover)**
   - Edit `google_ads_script.js` in Google Ads UI > Tools > Scripts
   - Line ~20: Change `APPS_SCRIPT_WEBHOOK_URL` to point to v2 API:
     ```js
     APPS_SCRIPT_WEBHOOK_URL: "https://web-seven-rho-96.vercel.app/api/ingest"
     ```
   - Line ~30: Ensure `INGEST_SECRET` is set to `873f1fe208b9a445b34ecad0aaf0650931b7da98cc9d91e6` (same for both v1/v2)
   - Test: Trigger a collect run manually → verify data lands in Supabase (`campaigns` table should update)

**3. Verify execute mode polls v2**
   - Google Ads Script execute mode already polls `_apiUrl_('pending-changes')` (Phase H rewrite)
   - Approve one item in v2 dashboard (e.g., a `manual` item → mark as approved)
   - Check `pending_changes` table: row should appear with `status='queued'`
   - Execute mode polls and flips it to `executing` → watch logs
   - Result posted back to `/api/execute-result` → `change_log` row created

**4. Disable v1 scheduler jobs (day after cutover)**
   - Google Ads Account > Scripts: Disable or delete the old v1 runs (time-based triggers)
   - Keep the script code (for archive reference, lives in `apps_script/`)
   - Stop Apps Script webhook from v1 (it's been repointed, so no more traffic)

**5. Monitor v2 for 2–3 days post-cutover**
   - Watch GitHub Actions logs for `daily-audit` and `hourly-implementation`
   - Check Vercel for API errors (https://vercel.com/preetam-das-projects/web)
   - Spot-check dashboard data freshness (is `updated_at` current?)

---

## Step 5: Decommission v1 (After Cutover Stabilizes)

Once v2 is live and stable for ≥3 days:

**1. Archive v1 code & config**
   ```bash
   # Keep for historical reference (mandatory per CLAUDE.md)
   # No deletion — just mark "decommissioned 2026-06-XX"
   # apps_script/ folder stays in git history
   ```

**2. In this repo:**
   - [ ] Remove v1-specific workflow files (if any exist outside `.github/workflows/`)
   - [ ] Update `CLAUDE.md` to reflect v2-only status
   - [ ] Add a note at the top: "v1 (Apps Script + Sheets) decommissioned [date]. Code kept in `apps_script/` for reference."
   - [ ] Update `state/progress.json`: mark Phase J "done" with cutover date

**3. Google Ads account cleanup (manual, out-of-scope):**
   - [ ] Keep Google Ads Script project (it drives both v1 and v2 now, just repointed)
   - [ ] Delete old Apps Script project if it's separate (confirm with user first)
   - [ ] Keep the collect + execute modes in the unified script indefinitely

**4. Supabase/Vercel:**
   - Keep running (cost-free tier)
   - No cleanup needed — v1 and v2 share no infrastructure

---

## Emergency Rollback (If Cutover Fails)

If v2 has a critical issue and needs to rollback:

1. **Stop v2 jobs immediately:**
   - Disable `daily-audit` and `hourly-implementation` GitHub Actions workflows
   - Dashboard still accessible for viewing old data (read-only until re-enabled)

2. **Revert Google Ads Script:**
   - Change `APPS_SCRIPT_WEBHOOK_URL` back to v1 webhook URL
   - Re-enable v1 Apps Script time-based triggers
   - Wait for next scheduled collect (v1 resumes)

3. **Post-mortem:**
   - Document what failed in v2
   - Assess if it's fixable (e.g., config tuning) or needs code work
   - If fixable: make changes → re-run validation → go-live again
   - If structural: escalate (may need extended Phase J)

---

## Comparison Script Usage

```bash
# Today's findings
npm run compare

# Specific date
npm run compare 2026-06-10

# Pipe to file for archiving
npm run compare > phase-j-log-2026-06-12.txt
```

Output includes:
- Raw findings count per agent
- Action plan breakdown by category (auto/manual/insight)
- P1/P2/P3 counts and scores
- Checklist for manual v1 comparison

---

## Success Metrics

✅ Phase J complete when:
- Week of parallel runs done with daily spot-checks logged
- No P1 regressions found in v2 vs v1
- Cutover executed without critical issues
- v2 live and stable for 3+ days
- v1 decommissioned and noted in `CLAUDE.md`
- `state/progress.json` updated: Phase J status = "done" + cutover date

---

## Notes

- **Both systems use the same Google Ads Script data source** (collect mode) — only the backend (v1 Sheets vs v2 Postgres) differs
- **Approvals are separate** — v1 approvals in Sheets, v2 in dashboard; manually sync during cutover week if needed
- **No data migration** — v2 learns from day-1 snapshots; no backfill from v1 needed (v1 continues to run in parallel, so new data flows to both)
- **Safe to run in parallel** — collect mode writes to both, execute mode can poll v1 or v2 (no conflicts)
