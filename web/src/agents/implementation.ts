/**
 * implementation.ts — Phase H "write side": turns newly-approved `auto`
 * action_plan rows into `pending_changes` rows for the Google Ads Script's
 * execute mode to pick up (or, under DRY_RUN, straight into `change_log`).
 *
 * Ported from apps_script/managers/ImplementationManager.js:
 *   - _deriveChanges_ / _deriveNegatives_  -> deriveChanges()
 *   - _validateChange_                     -> validateChange()
 *   - _persistChange_ / _appendChangeLog_  -> persistChange()
 *   - _readApprovedPlanItems_              -> readApprovedAutoItems()
 *
 * Safety rails (CLAUDE.md, NON-NEGOTIABLE):
 *   - never delete, only pause/add-negative/adjust budget within caps
 *   - budget shift capped at MAX_BUDGET_SHIFT_PCT (default 0.20)
 *   - DRY_RUN writes change_log immediately with success:true but never queues
 *     a real change; live writes go to pending_changes with status 'queued'
 *   - approval check: only action_plan rows with status='approved' and
 *     action_category='auto' are considered
 */

import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { actionPlan, pendingChanges, changeLog, campaigns } from "@/db/schema";
import { getConfigValue, isDryRun } from "./rules/rulesEngine";
import { readSearchTerms, readNegativeKeywords, micros, type SearchTermRow, type NegativeKeywordRow } from "./data";

export interface DerivedChange {
  changeId: string;
  planId: string;
  findingId: string | null;
  changeType: "adjust_budget" | "add_negative";
  targetType: string;
  targetId: string;
  targetName: string | null;
  field: string;
  beforeValue: string;
  afterValue: string;
  params: Record<string, unknown>;
}

export interface ImplementationResult {
  dryRun: boolean;
  approved: number;
  queued: number;
  skipped: number;
  changes: DerivedChange[];
}

interface ApprovedItem {
  planId: string;
  findingId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  targetName: string | null;
}

interface Context {
  maxBudgetPct: number;
  maxNegatives: number;
  minWaste: number;
  searchTerms: SearchTermRow[];
  negatives: NegativeKeywordRow[];
}

export async function runImplementation(runDate: string): Promise<ImplementationResult> {
  const dryRun = await isDryRun();
  const items = await readApprovedAutoItems();
  console.log(`[implementation] ${items.length} approved 'auto' plan item(s) to action.`);

  if (items.length === 0) {
    return { dryRun, approved: 0, queued: 0, skipped: 0, changes: [] };
  }

  const ctx: Context = {
    maxBudgetPct: parseFloat(await getConfigValue("MAX_BUDGET_SHIFT_PCT", "0.20")) || 0.20,
    maxNegatives: parseFloat(await getConfigValue("NEGATIVE_MAX_PER_RUN", "20")) || 20,
    minWaste: parseFloat(await getConfigValue("NEGATIVE_KW_MIN_WASTE", "50")) || 50,
    searchTerms: await readSearchTerms(),
    negatives: await readNegativeKeywords(),
  };

  const queued: DerivedChange[] = [];
  let skipped = 0;

  for (const item of items) {
    let derived: DerivedChange[] = [];
    try {
      derived = await deriveChanges(item, ctx);
    } catch (e) {
      console.error(`[implementation]  derive failed for ${item.planId}: ${(e as Error)?.message || e}`);
      continue;
    }

    for (const ch of derived) {
      const v = validateChange(ch, ctx);
      if (!v.ok) {
        console.log(`[implementation]  skip ${ch.changeType} ${ch.targetId}: ${v.reason}`);
        skipped++;
        continue;
      }
      await persistChange(ch, runDate, dryRun);
      queued.push(ch);
      console.log(
        `[implementation]  [${dryRun ? "dry-run" : "queued"}] ${ch.changeType} on ${ch.targetType} ` +
          `${ch.targetId} (${ch.beforeValue} -> ${ch.afterValue})`
      );
    }
  }

  return { dryRun, approved: items.length, queued: queued.length, skipped, changes: queued };
}

/* ===========================================================================
 * Derivers — approved item + live data -> concrete change(s).
 * ========================================================================= */

async function deriveChanges(item: ApprovedItem, ctx: Context): Promise<DerivedChange[]> {
  if (item.actionType === "increase_budget") {
    if (!db) return [];
    const [camp] = await db.select().from(campaigns).where(eq(campaigns.campaignId, item.targetId));
    if (!camp) return [];
    const before = micros(camp.budgetMicros);
    if (before <= 0) return [];
    const after = Math.round(before * (1 + ctx.maxBudgetPct) * 100) / 100;
    return [
      {
        changeId: `chg_${item.planId}`,
        planId: item.planId,
        findingId: item.findingId,
        changeType: "adjust_budget",
        targetType: "campaign",
        targetId: String(camp.campaignId),
        targetName: camp.campaignName,
        field: "daily_budget",
        beforeValue: String(before),
        afterValue: String(after),
        params: { new_budget_micros: Math.round(after * 1e6) },
      },
    ];
  }

  if (item.actionType === "add_negatives") {
    return deriveNegatives(item, ctx);
  }

  return [];
}

function deriveNegatives(item: ApprovedItem, ctx: Context): DerivedChange[] {
  const scopeIsAdGroup = item.targetType === "adgroup";
  const isBlocked = buildNegativeMatcher(ctx.negatives);

  const inScope = ctx.searchTerms.filter((t) => {
    if ((Number(t.conversions) || 0) !== 0) return false;
    if (micros(t.costMicros) < ctx.minWaste) return false;
    if (scopeIsAdGroup) return String(t.adGroupId) === String(item.targetId);
    return String(t.campaignId) === String(item.targetId);
  });

  const candidates = inScope
    .filter((t) => !isBlocked(t))
    .sort((a, b) => (Number(b.costMicros) || 0) - (Number(a.costMicros) || 0))
    .slice(0, ctx.maxNegatives);

  return candidates.map((t, i) => ({
    changeId: `chg_${item.planId}_${i}`,
    planId: item.planId,
    findingId: item.findingId,
    changeType: "add_negative" as const,
    targetType: scopeIsAdGroup ? "adgroup" : "campaign",
    targetId: String(scopeIsAdGroup ? item.targetId : t.campaignId || item.targetId),
    targetName: item.targetName,
    field: "negative_keyword",
    beforeValue: "(not blocked)",
    afterValue: `-"${String(t.term).trim()}"  (phrase)`,
    params: { term: String(t.term).trim(), match_type: "PHRASE", scope: scopeIsAdGroup ? "ad_group" : "campaign" },
  }));
}

function buildNegativeMatcher(negatives: NegativeKeywordRow[]) {
  const byCampaign: Record<string, Array<{ text: string; match: string }>> = {};
  const byAdGroup: Record<string, Array<{ text: string; match: string }>> = {};
  const accountWide: Array<{ text: string; match: string }> = [];

  for (const n of negatives) {
    const entry = { text: String(n.text || "").toLowerCase().trim(), match: String(n.matchType || "").toUpperCase().trim() };
    if (!entry.text) continue;
    if (n.scope === "campaign") {
      const k = String(n.campaignId);
      (byCampaign[k] = byCampaign[k] || []).push(entry);
    } else if (n.scope === "ad_group") {
      const k = String(n.adGroupId);
      (byAdGroup[k] = byAdGroup[k] || []).push(entry);
    } else if (n.scope === "shared") {
      accountWide.push(entry);
    }
  }

  return function isAlreadyBlocked(term: SearchTermRow): boolean {
    const text = String(term.term || "").toLowerCase().trim();
    if (!text) return false;
    const candidates = ([] as Array<{ text: string; match: string }>)
      .concat(byCampaign[String(term.campaignId)] || [])
      .concat(byAdGroup[String(term.adGroupId)] || [])
      .concat(accountWide);
    for (const n of candidates) {
      if (negativeMatches(text, n.text, n.match)) return true;
    }
    return false;
  };
}

function negativeMatches(searchTerm: string, negText: string, matchType: string): boolean {
  if (!negText) return false;
  const mt = (matchType || "").toUpperCase();
  if (mt === "EXACT") return searchTerm === negText;
  if (mt === "PHRASE") {
    const re = new RegExp("\\b" + reEscape(negText) + "\\b");
    return re.test(searchTerm);
  }
  const words = negText.split(/\s+/).filter(Boolean);
  return words.every((w) => new RegExp("\\b" + reEscape(w) + "\\b").test(searchTerm));
}

function reEscape(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ===========================================================================
 * Safety rails — NON-NEGOTIABLE. Reject (never silently clamp past a cap).
 * ========================================================================= */

function validateChange(ch: DerivedChange, ctx: Context): { ok: boolean; reason?: string } {
  if (ch.changeType === "adjust_budget") {
    const before = parseFloat(ch.beforeValue) || 0;
    const after = parseFloat(ch.afterValue) || 0;
    if (before <= 0) return { ok: false, reason: "no current budget" };
    const pct = Math.abs(after - before) / before;
    if (pct > ctx.maxBudgetPct + 1e-9) {
      return { ok: false, reason: `budget shift ${(pct * 100).toFixed(0)}% > cap ${ctx.maxBudgetPct * 100}%` };
    }
    return { ok: true };
  }
  if (ch.changeType === "add_negative") {
    if (!ch.params.term) return { ok: false, reason: "empty term" };
    return { ok: true };
  }
  return { ok: false, reason: `unsupported change type ${ch.changeType}` };
}

/* ===========================================================================
 * Persistence — pending_changes queue + change_log audit.
 * ========================================================================= */

async function persistChange(ch: DerivedChange, runDate: string, dryRun: boolean): Promise<void> {
  if (!db) return;

  await db
    .insert(pendingChanges)
    .values({
      changeId: ch.changeId,
      runDate,
      planId: ch.planId,
      findingId: ch.findingId,
      changeType: ch.changeType,
      targetType: ch.targetType,
      targetId: ch.targetId,
      targetName: ch.targetName,
      field: ch.field,
      beforeValue: ch.beforeValue,
      afterValue: ch.afterValue,
      params: ch.params,
      status: dryRun ? "dry_run" : "queued",
      dryRun,
    })
    .onConflictDoUpdate({
      target: pendingChanges.changeId,
      set: {
        runDate,
        targetName: ch.targetName,
        beforeValue: ch.beforeValue,
        afterValue: ch.afterValue,
        params: ch.params,
        status: dryRun ? "dry_run" : "queued",
        dryRun,
      },
    });

  // In DRY_RUN we also write the audit row immediately (simulated success).
  if (dryRun) {
    await db
      .insert(changeLog)
      .values({
        id: `clog_${ch.changeId}`,
        planId: ch.planId,
        findingId: ch.findingId,
        agent: "implementation_manager",
        targetType: ch.targetType,
        targetId: ch.targetId,
        targetName: ch.targetName,
        fieldChanged: ch.field,
        beforeValue: ch.beforeValue,
        afterValue: ch.afterValue,
        dryRun: true,
        success: true,
      })
      .onConflictDoUpdate({
        target: changeLog.id,
        set: {
          beforeValue: ch.beforeValue,
          afterValue: ch.afterValue,
        },
      });
  }
}

/* ===========================================================================
 * Approval gate — read newly-approved 'auto' action_plan rows.
 * ========================================================================= */

async function readApprovedAutoItems(): Promise<ApprovedItem[]> {
  if (!db) return [];

  const approved = await db
    .select()
    .from(actionPlan)
    .where(and(eq(actionPlan.status, "approved"), eq(actionPlan.actionCategory, "auto")));

  if (approved.length === 0) return [];

  // Block re-queuing only for plans already in a REAL queue state. dry_run
  // rows don't block, so DRY_RUN can be re-run repeatedly while reviewing.
  const already = new Set<string>();
  const rows = await db
    .select({ planId: pendingChanges.planId, status: pendingChanges.status })
    .from(pendingChanges)
    .where(inArray(pendingChanges.planId, approved.map((p) => p.planId)));
  for (const r of rows) {
    if (r.status === "queued" || r.status === "executing" || r.status === "done") already.add(r.planId);
  }

  return approved
    .filter((p) => !already.has(p.planId))
    .filter((p) => p.targetType && p.targetId)
    .map((p) => ({
      planId: p.planId,
      findingId: p.findingId,
      actionType: p.actionType,
      targetType: p.targetType as string,
      targetId: p.targetId as string,
      targetName: p.targetName,
    }));
}
