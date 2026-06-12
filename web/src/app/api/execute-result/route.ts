import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pendingChanges, changeLog } from "@/db/schema";

export const dynamic = "force-dynamic";

interface ExecuteResultRow {
  change_id?: string;
  success?: boolean;
  error?: string;
}

interface Body {
  secret?: string;
  run_date?: string;
  results?: ExecuteResultRow[];
}

/**
 * POST /api/execute-result — reports the outcome of applying each
 * pending_changes row via the Google Ads Script's execute mode.
 *
 * Updates pending_changes.status to 'done' or 'error' and appends a
 * change_log row per result.
 */
export async function POST(req: NextRequest) {
  if (!db) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500 });
  }

  const expectedSecret = process.env.INGEST_SECRET;
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: "INGEST_SECRET not configured" }, { status: 500 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const authHeader = req.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const providedSecret = bearerSecret ?? (typeof body.secret === "string" ? body.secret : null);
  if (providedSecret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const results = Array.isArray(body.results) ? body.results : [];
  let updated = 0;

  for (const r of results) {
    const changeId = r.change_id;
    if (!changeId) continue;

    const [pending] = await db.select().from(pendingChanges).where(eq(pendingChanges.changeId, changeId));
    if (!pending) continue;

    const success = !!r.success;
    const errMsg = r.error ? String(r.error).slice(0, 500) : "";

    await db
      .update(pendingChanges)
      .set({
        status: success ? "done" : "error",
        executedAt: new Date(),
        result: success ? "success" : "",
        error: errMsg,
      })
      .where(eq(pendingChanges.changeId, changeId));

    await db
      .insert(changeLog)
      .values({
        id: `clog_${changeId}`,
        planId: pending.planId,
        findingId: pending.findingId,
        agent: "implementation_manager",
        targetType: pending.targetType,
        targetId: pending.targetId,
        targetName: pending.targetName,
        fieldChanged: pending.field,
        beforeValue: pending.beforeValue,
        afterValue: pending.afterValue,
        dryRun: false,
        success,
        errorMessage: errMsg,
      })
      .onConflictDoUpdate({
        target: changeLog.id,
        set: { success, errorMessage: errMsg, dryRun: false },
      });

    updated++;
  }

  return NextResponse.json({ ok: true, updated });
}
