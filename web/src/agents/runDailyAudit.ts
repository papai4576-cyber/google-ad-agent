/**
 * runDailyAudit.ts — the `daily-audit` GitHub Actions entry point.
 *
 * End-to-end pipeline (CLAUDE.md v2 architecture, "daily-audit" job):
 *   1. Run all 6 Analysts (3 rule-based, 3 pure-LLM) over the latest snapshot.
 *   2. Persist their raw findings to the `findings` table for today's run_date
 *      (replacing any rows from a previous run today — idempotent re-runs).
 *   3. Hand the combined findings to synthesisManager.ts: dedup -> cross-agent
 *      patterns -> impact scoring -> action_plan rows (also idempotent per
 *      run_date).
 *   4. Stamp `LAST_AUDIT_DATE` / `LAST_AUDIT_SUMMARY` in `config` and print a
 *      summary for the GitHub Actions log.
 *
 * Each Analyst is isolated in its own try/catch: one Analyst failing (e.g. a
 * transient Groq error, or the daily token ceiling being hit mid-run) does not
 * abort the whole pipeline — its findings are simply empty for this run.
 *
 * Run via `npm run daily-audit` (tsx --require ./scripts/load-env.cjs, which
 * loads .env / .env.local into process.env before this module's import graph
 * — including @/db — is evaluated).
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { findings as findingsTable, config } from "@/db/schema";
import { runPureLLMAnalyst, runRuleBasedAnalyst } from "./runAnalyst";
import type { AnalystOutput, SynthFinding } from "./schema";
import { AGENTS } from "./synthesis/agentNames";
import { runSynthesis } from "./synthesis/synthesisManager";
import { notifyActionPlanDigest } from "./slack";

import { buildPerformanceBudgetAnalystSpec } from "./analysts/performanceBudgetAnalyst";
import { buildQualityStructureAnalystSpec } from "./analysts/qualityStructureAnalyst";
import { buildAudienceCopyAnalystSpec } from "./analysts/audienceCopyAnalyst";
import { buildSearchIntelligenceAnalystSpec } from "./analysts/searchIntelligenceAnalyst";
import { buildMarketIntelligenceAnalystSpec } from "./analysts/marketIntelligenceAnalyst";
import { buildLandingPageScorerSpec } from "./analysts/landingPageScorer";

function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Run one Analyst, isolating failures so one bad call doesn't abort the pipeline. */
async function runAnalystSafely(
  agentName: string,
  runDate: string,
  run: () => Promise<AnalystOutput>
): Promise<AnalystOutput> {
  try {
    return await run();
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    console.error(`[daily-audit] ${agentName} FAILED: ${msg}`);
    return {
      agent: agentName,
      run_date: runDate,
      mode: "daily",
      findings: [],
      summary: `Agent failed: ${msg.slice(0, 200)}`,
      token_count: 0,
      run_time_ms: 0,
    };
  }
}

async function main() {
  const runDate = todayUTC();
  console.log("===========================================");
  console.log(`daily-audit starting (run_date=${runDate})`);
  console.log("===========================================");

  const outputs: AnalystOutput[] = [];

  // 1a. Rule-based Analysts (cheap, run first).
  const perfBudgetSpec = await buildPerformanceBudgetAnalystSpec();
  outputs.push(
    await runAnalystSafely(AGENTS.PERFORMANCE_BUDGET, runDate, () => runRuleBasedAnalyst(perfBudgetSpec, runDate))
  );

  const qualityStructureSpec = await buildQualityStructureAnalystSpec();
  outputs.push(
    await runAnalystSafely(AGENTS.QUALITY_STRUCTURE, runDate, () => runRuleBasedAnalyst(qualityStructureSpec, runDate))
  );

  const audienceCopySpec = await buildAudienceCopyAnalystSpec();
  outputs.push(
    await runAnalystSafely(AGENTS.AUDIENCE_COPY, runDate, () => runRuleBasedAnalyst(audienceCopySpec, runDate))
  );

  // 1b. Pure-LLM Analysts.
  const searchIntelSpec = await buildSearchIntelligenceAnalystSpec();
  outputs.push(
    await runAnalystSafely(AGENTS.SEARCH_INTELLIGENCE, runDate, () => runPureLLMAnalyst(searchIntelSpec, runDate))
  );

  const marketIntelSpec = await buildMarketIntelligenceAnalystSpec();
  outputs.push(
    await runAnalystSafely(AGENTS.MARKET_INTELLIGENCE, runDate, () => runPureLLMAnalyst(marketIntelSpec, runDate))
  );

  const landingPageSpec = await buildLandingPageScorerSpec();
  outputs.push(
    await runAnalystSafely(AGENTS.LANDING_PAGE, runDate, () => runPureLLMAnalyst(landingPageSpec, runDate))
  );

  // 2. Flatten into SynthFinding[] and persist raw findings.
  const synthFindings: SynthFinding[] = [];
  let totalTokens = 0;
  for (const out of outputs) {
    totalTokens += out.token_count;
    for (const f of out.findings) {
      synthFindings.push({ ...f, agent: out.agent, runDate: out.run_date, mode: out.mode });
    }
  }

  console.log("-------------------------------------------");
  for (const out of outputs) {
    console.log(`  ${out.agent.padEnd(28)} findings=${out.findings.length} tokens=${out.token_count} (${out.run_time_ms}ms)`);
  }
  console.log(`  TOTAL findings=${synthFindings.length} tokens=${totalTokens}`);
  console.log("-------------------------------------------");

  await writeFindings(synthFindings, runDate);

  // 3. Synthesis: dedup -> cross-agent patterns -> scoring -> action_plan.
  const result = await runSynthesis(synthFindings, runDate);

  console.log("-------------------------------------------");
  console.log(
    `Dedup: ${result.input} -> ${result.deduped} (${result.merged} merged into others). +${result.patterns} cross-agent patterns.`
  );
  for (const m of result.mergeLog.slice(0, 5)) {
    console.log(`  merged ${m.merged_finding_ids.join(", ")} -> ${m.primary_finding_id}`);
  }
  console.log(`Score: P1=${result.p1}, P2=${result.p2}, P3=${result.p3} (${result.severityOverrides} severity overrides).`);
  console.log(`Action plan: wrote ${result.written} rows (cleared ${result.cleared} old rows for ${runDate}).`);
  console.log("===========================================");

  const summary =
    `${synthFindings.length} raw findings -> ${result.written} action items ` +
    `(P1=${result.p1}, P2=${result.p2}, P3=${result.p3}), ${totalTokens} tokens.`;
  await stampConfig(runDate, summary);

  // Send Slack notification if there are pending items and webhook is configured.
  try {
    await notifyActionPlanDigest(runDate);
  } catch (err) {
    console.log(`[slack] notification failed (non-fatal):`, err);
  }

  console.log(`daily-audit done. ${summary}`);
}

async function writeFindings(synthFindings: SynthFinding[], runDate: string): Promise<void> {
  if (!db) return;

  await db.delete(findingsTable).where(eq(findingsTable.runDate, runDate));
  if (synthFindings.length === 0) return;

  const rows = synthFindings.map((f) => ({
    id: `${runDate}_${f.agent}_${f.id}`,
    runDate: f.runDate,
    mode: f.mode,
    agent: f.agent,
    findingId: f.id,
    category: f.category,
    severity: f.severity,
    title: f.title,
    what: f.what,
    why: f.why,
    action: f.action,
    targetType: f.target.type,
    targetId: f.target.id,
    targetName: f.target.name,
    impactMetric: f.estimated_impact.metric,
    impactDirection: f.estimated_impact.direction,
    impactMagnitude: f.estimated_impact.magnitude,
    confidence: f.confidence,
    effort: f.effort,
    evidence: f.evidence,
    brainSources: f.brain_sources,
    status: "new",
  }));

  await db.insert(findingsTable).values(rows);
}

async function stampConfig(runDate: string, summary: string): Promise<void> {
  if (!db) return;
  const now = new Date();
  for (const [key, value] of [
    ["LAST_AUDIT_DATE", runDate],
    ["LAST_AUDIT_SUMMARY", summary],
  ]) {
    await db
      .insert(config)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: now } });
  }
}

main().catch((e) => {
  console.error("[daily-audit] FATAL:", e);
  process.exit(1);
});
