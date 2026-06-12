import { db } from "@/db";
import { actionPlan, approvals } from "@/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

const VALID_ACTIONS = new Set(["approve", "reject"]);

export async function POST(req: Request) {
  if (!db) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  let body: { planId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { planId, action } = body;
  if (!planId || !action || !VALID_ACTIONS.has(action)) {
    return NextResponse.json({ error: "planId and action ('approve'|'reject') are required" }, { status: 400 });
  }

  const [plan] = await db.select().from(actionPlan).where(eq(actionPlan.planId, planId));
  if (!plan) {
    return NextResponse.json({ error: `action_plan row ${planId} not found` }, { status: 404 });
  }

  const status = action === "approve" ? "approved" : "rejected";

  await db
    .update(actionPlan)
    .set({ status, updatedAt: new Date() })
    .where(eq(actionPlan.planId, planId));

  await db.insert(approvals).values({
    id: `appr_${planId}_${Date.now()}`,
    planId,
    findingId: plan.findingId,
    status,
  });

  return NextResponse.json({ ok: true, planId, status });
}
