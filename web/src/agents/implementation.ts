/**
 * implementation.ts — Phase H "write side": turns newly-approved `auto`
 * action_plan rows into real Google Ads mutations, calling googleAdsClient.ts
 * directly (no more queue-and-poll handshake with google_ads_script.js —
 * that script's execute mode has been retired; collect mode is unaffected).
 *
 * Ported from apps_script/managers/ImplementationManager.js, then migrated
 * off Google Ads Scripts entirely for the execute side (see CLAUDE.md
 * "Execute-mode migration"):
 *   - _deriveChanges_ / _deriveNegatives_  -> deriveChanges()
 *   - _validateChange_                     -> validateChange()
 *   - _persistChange_ / _appendChangeLog_  -> persistChange()
 *   - _readApprovedPlanItems_              -> readApprovedAutoItems()
 *
 * `deriveChanges()` reads `finding.proposed_changes` — the structured,
 * machine-executable version of a recommendation, populated by the analyst
 * that produced it (see schema.ts ProposedChange). This replaced two prior
 * bugs: `add_negatives` used to independently re-derive a DIFFERENT set of
 * terms than what the human actually approved on the dashboard, and
 * `add_keywords`/`add_extensions`/`update_copy` had no way to auto-implement
 * at all since there was no structured channel for "the exact thing to
 * create." `increase_budget` is the one exception — it has no fidelity gap
 * (the rule never claimed a specific number, only the +20% cap policy), so
 * it keeps its original fresh-DB-lookup-and-apply-cap behavior unchanged.
 *
 * Safety rails (CLAUDE.md, NON-NEGOTIABLE):
 *   - never delete, only pause/add-negative/adjust budget within caps
 *   - budget shift capped at MAX_BUDGET_SHIFT_PCT (default 0.20), bid shift
 *     capped at MAX_BID_SHIFT_PCT (default 0.30)
 *   - DRY_RUN logs to change_log immediately with success:true but never
 *     calls the Google Ads API; live runs call it inline and log the real result
 *   - approval check: only action_plan rows with status='approved' and
 *     action_category='auto' are considered
 *   - new RSAs are always created PAUSED — approval authorizes creation, not
 *     going live (see googleAdsClient.ts createResponsiveSearchAd)
 */

import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { actionPlan, pendingChanges, changeLog, campaigns } from "@/db/schema";
import { getConfigValue, isDryRun } from "./rules/rulesEngine";
import { micros } from "./data";
import type { ProposedChange } from "./schema";
import * as googleAds from "./googleAdsClient";

export interface DerivedChange {
  changeId: string;
  planId: string;
  findingId: string | null;
  changeType: ProposedChange["type"];
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
  executed: number;
  skipped: number;
  failed: number;
  changes: DerivedChange[];
}

interface ApprovedItem {
  planId: string;
  findingId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  targetName: string | null;
  proposedChanges: ProposedChange[];
}

interface Context {
  maxBudgetPct: number;
  maxBidPct: number;
}

export async function runImplementation(runDate: string): Promise<ImplementationResult> {
  const dryRun = await isDryRun();
  const items = await readApprovedAutoItems();
  console.log(`[implementation] ${items.length} approved 'auto' plan item(s) to action.`);

  if (items.length === 0) {
    return { dryRun, approved: 0, executed: 0, skipped: 0, failed: 0, changes: [] };
  }

  const ctx: Context = {
    maxBudgetPct: parseFloat(await getConfigValue("MAX_BUDGET_SHIFT_PCT", "0.20")) || 0.2,
    maxBidPct: parseFloat(await getConfigValue("MAX_BID_SHIFT_PCT", "0.30")) || 0.3,
  };

  const executed: DerivedChange[] = [];
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
    let derived: DerivedChange[] = [];
    try {
      derived = await deriveChanges(item, ctx);
    } catch (e) {
      console.error(`[implementation]  derive failed for ${item.planId}: ${(e as Error)?.message || e}`);
      continue;
    }

    if (derived.length === 0 && item.actionType !== "increase_budget") {
      // Regression guard (per CLAUDE.md): an auto-eligible finding with no proposed_changes means the
      // analyst that produced it forgot to populate them — surfaces loudly instead of silently no-op'ing.
      console.log(`[implementation]  skip ${item.planId}: actionType=${item.actionType} has no proposed_changes`);
      skipped++;
      continue;
    }

    for (const ch of derived) {
      const v = validateChange(ch, ctx);
      if (!v.ok) {
        console.log(`[implementation]  skip ${ch.changeType} ${ch.targetId}: ${v.reason}`);
        skipped++;
        continue;
      }
      const persisted = await persistChange(ch, runDate, dryRun);
      if (persisted.success) {
        executed.push(ch);
        console.log(
          `[implementation]  [${dryRun ? "dry-run" : "executed"}] ${ch.changeType} on ${ch.targetType} ` +
            `${ch.targetId} (${ch.beforeValue} -> ${ch.afterValue})`
        );
      } else {
        failed++;
        console.log(
          `[implementation]  [FAILED] ${ch.changeType} on ${ch.targetType} ${ch.targetId} ` +
            `(${ch.beforeValue} -> ${ch.afterValue}): ${persisted.error}`
        );
      }
    }
  }

  return { dryRun, approved: items.length, executed: executed.length, skipped, failed, changes: executed };
}

/* ===========================================================================
 * Derivers — approved item (+ its proposed_changes) -> concrete change(s).
 * ========================================================================= */

async function deriveChanges(item: ApprovedItem, ctx: Context): Promise<DerivedChange[]> {
  if (item.actionType === "increase_budget") {
    // Unchanged from before the migration — see header comment on why this one stays as-is.
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
        params: { campaign_id: String(camp.campaignId), new_budget_micros: Math.round(after * 1e6) },
      },
    ];
  }

  // Everything else reads the structured proposed_changes the analyst populated directly on the finding.
  return item.proposedChanges.map((pc, i) => toDerivedChange(item, pc, i));
}

function toDerivedChange(item: ApprovedItem, pc: ProposedChange, index: number): DerivedChange {
  const changeId = `chg_${item.planId}_${index}`;
  const base = { changeId, planId: item.planId, findingId: item.findingId };

  switch (pc.type) {
    case "add_negative":
      return {
        ...base,
        changeType: "add_negative",
        targetType: String(pc.params.scope ?? item.targetType),
        targetId: String(pc.params.scope_id ?? item.targetId),
        targetName: item.targetName,
        field: "negative_keyword",
        beforeValue: "(not blocked)",
        afterValue: `-"${String(pc.params.text ?? "").trim()}" (${String(pc.params.match_type ?? "PHRASE")})`,
        params: pc.params,
      };
    case "add_keyword":
      return {
        ...base,
        changeType: "add_keyword",
        targetType: "adgroup",
        targetId: String(pc.params.ad_group_id ?? item.targetId),
        targetName: item.targetName,
        field: "keyword",
        beforeValue: "(not present)",
        afterValue: `+[${String(pc.params.text ?? "")}] (${String(pc.params.match_type ?? "EXACT")})`,
        params: pc.params,
      };
    case "adjust_bid":
      return {
        ...base,
        changeType: "adjust_bid",
        targetType: "keyword",
        targetId: String(pc.params.criterion_id ?? item.targetId),
        targetName: item.targetName,
        field: "cpc_bid",
        beforeValue: String(pc.params.current_cpc_bid_micros ?? ""),
        afterValue: String(pc.params.new_cpc_bid_micros ?? ""),
        params: pc.params,
      };
    case "add_sitelink":
      return {
        ...base,
        changeType: "add_sitelink",
        targetType: "campaign",
        targetId: String(pc.params.campaign_id ?? item.targetId),
        targetName: item.targetName,
        field: "sitelink",
        beforeValue: "(not present)",
        afterValue: `+"${String(pc.params.link_text ?? "")}"`,
        params: pc.params,
      };
    case "add_callout":
      return {
        ...base,
        changeType: "add_callout",
        targetType: "campaign",
        targetId: String(pc.params.campaign_id ?? item.targetId),
        targetName: item.targetName,
        field: "callout",
        beforeValue: "(not present)",
        afterValue: `+"${String(pc.params.text ?? "")}"`,
        params: pc.params,
      };
    case "create_rsa":
      return {
        ...base,
        changeType: "create_rsa",
        targetType: "adgroup",
        targetId: String(pc.params.ad_group_id ?? item.targetId),
        targetName: item.targetName,
        field: "ad_copy",
        beforeValue: "(no new ad)",
        afterValue: `+RSA (PAUSED): ${JSON.stringify(pc.params.headlines ?? [])}`,
        params: pc.params,
      };
    case "create_ad_group": {
      const kws = Array.isArray(pc.params.keywords) ? (pc.params.keywords as Array<{ text: string }>) : [];
      return {
        ...base,
        changeType: "create_ad_group",
        targetType: "campaign",
        targetId: String(pc.params.campaign_id ?? item.targetId),
        targetName: item.targetName,
        field: "ad_group",
        beforeValue: "(not present)",
        afterValue: `+"${String(pc.params.new_ad_group_name ?? "")}" (${kws.length} keywords)`,
        params: pc.params,
      };
    }
    default:
      return {
        ...base,
        changeType: pc.type,
        targetType: item.targetType,
        targetId: item.targetId,
        targetName: item.targetName,
        field: "unknown",
        beforeValue: "",
        afterValue: "",
        params: pc.params,
      };
  }
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
    if (!ch.params.text) return { ok: false, reason: "empty term" };
    return { ok: true };
  }

  if (ch.changeType === "add_keyword") {
    if (!ch.params.text || !ch.params.ad_group_id) return { ok: false, reason: "missing keyword text or ad_group_id" };
    return { ok: true };
  }

  if (ch.changeType === "adjust_bid") {
    const before = Number(ch.params.current_cpc_bid_micros) || 0;
    const after = Number(ch.params.new_cpc_bid_micros) || 0;
    if (before <= 0 || after <= 0) return { ok: false, reason: "missing current/new bid" };
    const pct = Math.abs(after - before) / before;
    if (pct > ctx.maxBidPct + 1e-9) {
      return { ok: false, reason: `bid shift ${(pct * 100).toFixed(0)}% > cap ${ctx.maxBidPct * 100}%` };
    }
    return { ok: true };
  }

  if (ch.changeType === "add_sitelink") {
    const text = String(ch.params.link_text ?? "");
    if (!text) return { ok: false, reason: "empty sitelink text" };
    if (text.length > 25) return { ok: false, reason: `sitelink text ${text.length} chars > Google's 25-char limit` };
    if (!ch.params.final_url) return { ok: false, reason: "missing final_url" };
    // Sitelink descriptions have a 35-char limit — NOT the 90-char limit that applies to RSA
    // descriptions. Confirmed live: a 50-char description1 was rejected by the real API with
    // "Too long." before this check existed.
    const desc1 = String(ch.params.description1 ?? "");
    const desc2 = String(ch.params.description2 ?? "");
    if (desc1.length > 35) return { ok: false, reason: `sitelink description1 "${desc1}" (${desc1.length} chars) > Google's 35-char limit` };
    if (desc2.length > 35) return { ok: false, reason: `sitelink description2 "${desc2}" (${desc2.length} chars) > Google's 35-char limit` };
    // Confirmed live: Google's API requires sitelink descriptions as a matched pair — sending
    // only one (the other empty/omitted) is rejected as "The required field was not present."
    if (Boolean(desc1) !== Boolean(desc2)) {
      return { ok: false, reason: "sitelink description1/description2 must both be set or both omitted" };
    }
    return { ok: true };
  }

  if (ch.changeType === "add_callout") {
    const text = String(ch.params.text ?? "");
    if (!text) return { ok: false, reason: "empty callout text" };
    if (text.length > 25) return { ok: false, reason: `callout text ${text.length} chars > Google's 25-char limit` };
    return { ok: true };
  }

  if (ch.changeType === "create_rsa") {
    const headlines = Array.isArray(ch.params.headlines) ? (ch.params.headlines as string[]) : [];
    const descriptions = Array.isArray(ch.params.descriptions) ? (ch.params.descriptions as string[]) : [];
    if (headlines.length < 3) return { ok: false, reason: `only ${headlines.length} headlines, need >= 3` };
    if (descriptions.length < 2) return { ok: false, reason: `only ${descriptions.length} descriptions, need >= 2` };
    const longHeadline = headlines.find((h) => h.length > 30);
    if (longHeadline) return { ok: false, reason: `headline "${longHeadline}" > Google's 30-char limit` };
    const longDesc = descriptions.find((d) => d.length > 90);
    if (longDesc) return { ok: false, reason: `description "${longDesc}" > Google's 90-char limit` };
    if (!ch.params.ad_group_id) return { ok: false, reason: "missing ad_group_id" };
    return { ok: true };
  }

  if (ch.changeType === "create_ad_group") {
    const name = String(ch.params.new_ad_group_name ?? "");
    if (!name) return { ok: false, reason: "empty ad group name" };
    if (name.length > 255) return { ok: false, reason: `ad group name ${name.length} chars > Google's 255-char limit` };
    if (!ch.params.campaign_id) return { ok: false, reason: "missing campaign_id" };
    const keywords = Array.isArray(ch.params.keywords) ? (ch.params.keywords as Array<{ text?: string }>) : [];
    if (keywords.length === 0) return { ok: false, reason: "no keywords to seed the new ad group with" };
    const empty = keywords.find((k) => !k.text);
    if (empty) return { ok: false, reason: "one or more keywords have empty text" };
    return { ok: true };
  }

  return { ok: false, reason: `unsupported change type ${ch.changeType}` };
}

/* ===========================================================================
 * Persistence — calls the Google Ads API inline (or skips it under
 * DRY_RUN), then writes the change_log audit row. No more queue-and-poll.
 * ========================================================================= */

async function persistChange(ch: DerivedChange, runDate: string, dryRun: boolean): Promise<{ success: boolean; error?: string }> {
  if (!db) return { success: false, error: "no db" };

  let success = true;
  let errMsg = "";

  if (!dryRun) {
    const result = await executeOnGoogleAds(ch);
    success = result.success;
    errMsg = result.error || "";
  }

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
      status: dryRun ? "dry_run" : success ? "done" : "error",
      dryRun,
      executedAt: dryRun ? null : new Date(),
      result: dryRun ? null : success ? "success" : "",
      error: dryRun ? null : errMsg,
    })
    .onConflictDoUpdate({
      target: pendingChanges.changeId,
      set: {
        runDate,
        targetName: ch.targetName,
        beforeValue: ch.beforeValue,
        afterValue: ch.afterValue,
        params: ch.params,
        status: dryRun ? "dry_run" : success ? "done" : "error",
        dryRun,
        executedAt: dryRun ? null : new Date(),
        result: dryRun ? null : success ? "success" : "",
        error: dryRun ? null : errMsg,
      },
    });

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
      dryRun,
      success: dryRun ? true : success,
      errorMessage: dryRun ? "" : errMsg,
    })
    .onConflictDoUpdate({
      target: changeLog.id,
      set: {
        beforeValue: ch.beforeValue,
        afterValue: ch.afterValue,
        success: dryRun ? true : success,
        errorMessage: dryRun ? "" : errMsg,
      },
    });

  return dryRun ? { success: true } : { success, error: errMsg || undefined };
}

/** The one place DerivedChange.changeType maps to an actual googleAdsClient.ts call. */
async function executeOnGoogleAds(ch: DerivedChange): Promise<{ success: boolean; error?: string }> {
  switch (ch.changeType) {
    case "adjust_budget":
      return googleAds.setCampaignBudget(String(ch.params.campaign_id), Number(ch.params.new_budget_micros));

    case "add_negative":
      return googleAds.addNegativeKeyword(
        { type: ch.params.scope === "adgroup" ? "adgroup" : "campaign", id: String(ch.params.scope_id) },
        String(ch.params.text),
        (String(ch.params.match_type ?? "PHRASE").toUpperCase() as "EXACT" | "PHRASE" | "BROAD")
      );

    case "add_keyword":
      return googleAds.addKeyword(
        String(ch.params.ad_group_id),
        String(ch.params.text),
        (String(ch.params.match_type ?? "EXACT").toUpperCase() as "EXACT" | "PHRASE" | "BROAD"),
        ch.params.cpc_bid_micros ? Number(ch.params.cpc_bid_micros) : undefined
      );

    case "adjust_bid":
      return googleAds.setKeywordBid(
        String(ch.params.ad_group_id),
        String(ch.params.criterion_id),
        Number(ch.params.new_cpc_bid_micros)
      );

    case "add_sitelink": {
      const [result] = await googleAds.addSitelinks(String(ch.params.campaign_id), [
        {
          linkText: String(ch.params.link_text),
          description1: ch.params.description1 ? String(ch.params.description1) : undefined,
          description2: ch.params.description2 ? String(ch.params.description2) : undefined,
          finalUrl: String(ch.params.final_url),
        },
      ]);
      return result ?? { success: false, error: "no result returned" };
    }

    case "add_callout": {
      const [result] = await googleAds.addCallouts(String(ch.params.campaign_id), [String(ch.params.text)]);
      return result ?? { success: false, error: "no result returned" };
    }

    case "create_rsa":
      return googleAds.createResponsiveSearchAd(
        String(ch.params.ad_group_id),
        (ch.params.headlines as string[]) ?? [],
        (ch.params.descriptions as string[]) ?? [],
        (ch.params.final_urls as string[]) ?? []
      );

    case "create_ad_group": {
      const keywords = ((ch.params.keywords as Array<{ text: string; match_type?: string }>) ?? []).map((k) => ({
        text: k.text,
        matchType: (String(k.match_type ?? "BROAD").toUpperCase() as "EXACT" | "PHRASE" | "BROAD"),
      }));
      return googleAds.createAdGroup(
        String(ch.params.campaign_id),
        String(ch.params.new_ad_group_name),
        keywords,
        ch.params.cpc_bid_micros ? Number(ch.params.cpc_bid_micros) : undefined
      );
    }

    default:
      return { success: false, error: `unsupported change type ${ch.changeType}` };
  }
}

/* ===========================================================================
 * Approval gate — read newly-approved 'auto' action_plan rows, joined with
 * their finding's proposed_changes.
 * ========================================================================= */

async function readApprovedAutoItems(): Promise<ApprovedItem[]> {
  if (!db) return [];

  const approved = await db
    .select({
      planId: actionPlan.planId,
      findingId: actionPlan.findingId,
      actionType: actionPlan.actionType,
      targetType: actionPlan.targetType,
      targetId: actionPlan.targetId,
      targetName: actionPlan.targetName,
      proposedChanges: actionPlan.proposedChanges,
    })
    .from(actionPlan)
    .where(and(eq(actionPlan.status, "approved"), eq(actionPlan.actionCategory, "auto")));

  if (approved.length === 0) return [];

  // Block re-execution only for plans that already completed successfully. Errors and dry-runs
  // don't block, so a transient failure or a DRY_RUN review can be re-run on the next hourly pass.
  const already = new Set<string>();
  const rows = await db
    .select({ planId: pendingChanges.planId, status: pendingChanges.status })
    .from(pendingChanges)
    .where(inArray(pendingChanges.planId, approved.map((p) => p.planId)));
  for (const r of rows) {
    if (r.status === "done") already.add(r.planId);
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
      proposedChanges: ((p.proposedChanges as ProposedChange[] | null) ?? []),
    }));
}
