import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { brainEntries } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface Body {
  category?: string;
  source?: string;
  sourceType?: string;
  title?: string;
  summary?: string;
  keyPoints?: string[];
  rawText?: string;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500 }
    );
  }

  try {
    const { id } = await params;
    const body = (await req.json()) as Body;

    const updated = await db
      .update(brainEntries)
      .set({
        ...(body.category && { category: body.category }),
        ...(body.source !== undefined && { source: body.source || null }),
        ...(body.sourceType && { sourceType: body.sourceType }),
        ...(body.title && { title: body.title }),
        ...(body.summary !== undefined && { summary: body.summary || null }),
        ...(body.keyPoints && { keyPoints: body.keyPoints }),
        ...(body.rawText !== undefined && { rawText: body.rawText || null }),
      })
      .where(eq(brainEntries.id, id))
      .returning();

    if (updated.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Entry not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, entry: updated[0] });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 400 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500 }
    );
  }

  try {
    const { id } = await params;
    const deleted = await db
      .delete(brainEntries)
      .where(eq(brainEntries.id, id))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Entry not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 400 }
    );
  }
}
