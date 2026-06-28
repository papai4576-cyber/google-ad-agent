/**
 * runHourlyImplementation.ts — the `hourly-implementation` GitHub Actions
 * entry point (Phase H).
 *
 * Calls runImplementation(), which executes newly-approved
 * `action_category='auto'` `action_plan` rows directly against the Google
 * Ads API (see implementation.ts, googleAdsClient.ts) — no more queue/poll
 * handshake with google_ads_script.js's execute mode.
 *
 * Run via `npm run hourly-implementation` (tsx --require ./scripts/load-env.cjs,
 * which loads .env / .env.local into process.env before this module's import
 * graph — including @/db — is evaluated).
 */

import { runImplementation } from "./implementation";

function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function main() {
  const runDate = todayUTC();
  console.log("===========================================");
  console.log(`hourly-implementation starting (run_date=${runDate})`);
  console.log("===========================================");

  const result = await runImplementation(runDate);

  console.log("-------------------------------------------");
  console.log(
    `dry_run=${result.dryRun} approved=${result.approved} executed=${result.executed} skipped=${result.skipped} failed=${result.failed}`
  );
  for (const c of result.changes.slice(0, 10)) {
    console.log(`  ${c.changeType} ${c.targetType} "${c.targetName}": ${c.beforeValue} -> ${c.afterValue}`);
  }
  console.log("===========================================");

  if (result.dryRun) {
    console.log("DRY_RUN=true in config. Review change_log, then set DRY_RUN=false to allow execution.");
  }

  // Fail the GitHub Actions run (red X, not a silent green checkmark) if any live mutation failed —
  // otherwise a run where every single change_log row is status='error' still reports as "success",
  // which is exactly how a real production failure went unnoticed until checked manually.
  if (!result.dryRun && result.failed > 0) {
    console.error(`[hourly-implementation] ${result.failed} change(s) failed — see change_log for details.`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("[hourly-implementation] FATAL:", e);
    process.exit(1);
  });
