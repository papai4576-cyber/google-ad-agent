import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { actionPlan } from "@/db/schema";
import { eq } from "drizzle-orm";
import { normalizeProposedChanges } from "@/agents/schema";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/action-plan/[planId] — edit a pending recommendation's
 * proposed_changes before approving it (e.g. swap in different sitelink
 * copy, a different headline, a different destination URL). Only allowed
 * while status='pending' — once approved, hourly-implementation may already
 * be mid-execution against the existing value, so editing after approval
 * is rejected rather than risking a race between an edit and a mutation.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ planId: string }> }) {
  if (!db) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500 });
  }

  try {
    const { planId } = await params;
    const body = (await req.json()) as { proposedChanges?: unknown };

    const [plan] = await db.select().from(actionPlan).where(eq(actionPlan.planId, planId));
    if (!plan) {
      return NextResponse.json({ ok: false, error: `action_plan row ${planId} not found` }, { status: 404 });
    }
    if (plan.status !== "pending") {
      return NextResponse.json(
        { ok: false, error: `cannot edit a ${plan.status} item — only pending items can be edited` },
        { status: 409 }
      );
    }

    const proposedChanges = normalizeProposedChanges(body.proposedChanges);

    const [updated] = await db
      .update(actionPlan)
      .set({ proposedChanges, updatedAt: new Date() })
      .where(eq(actionPlan.planId, planId))
      .returning();

    return NextResponse.json({ ok: true, planId, proposedChanges: updated.proposedChanges });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 400 });
  }
}
