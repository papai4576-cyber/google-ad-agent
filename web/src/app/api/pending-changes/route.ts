import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { pendingChanges } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * GET /api/pending-changes
 *
 * @deprecated Retired by the Google Ads API migration — implementation.ts
 * now calls googleAdsClient.ts directly instead of queuing rows here for the
 * Google Ads Script's execute mode to poll (which has itself been removed
 * from google_ads_script.js). Left functional, not deleted, as a rollback
 * path: reverting implementation.ts and restoring the script's execute mode
 * would make this route load-bearing again. `pending_changes` rows are now
 * written and resolved synchronously by implementation.ts as a local audit
 * trail (status `dry_run` | `done` | `error`) — nothing currently polls this
 * route.
 *
 * Returns all `queued` pending_changes rows and atomically flips them to
 * `executing` so a second poll before /api/execute-result reports back
 * doesn't double-apply the same change.
 */
export async function GET(req: NextRequest) {
  if (!db) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500 });
  }

  const expectedSecret = process.env.INGEST_SECRET;
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: "INGEST_SECRET not configured" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const providedSecret = bearerSecret ?? req.nextUrl.searchParams.get("secret");
  if (providedSecret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const rows = await db.select().from(pendingChanges).where(eq(pendingChanges.status, "queued"));

  if (rows.length > 0) {
    await db
      .update(pendingChanges)
      .set({ status: "executing" })
      .where(and(eq(pendingChanges.status, "queued")));
  }

  const changes = rows.map((r) => ({
    change_id: r.changeId,
    plan_id: r.planId,
    finding_id: r.findingId,
    change_type: r.changeType,
    target_type: r.targetType,
    target_id: r.targetId,
    target_name: r.targetName,
    field: r.field,
    before_value: r.beforeValue,
    after_value: r.afterValue,
    params: r.params || {},
  }));

  return NextResponse.json({ ok: true, changes });
}
