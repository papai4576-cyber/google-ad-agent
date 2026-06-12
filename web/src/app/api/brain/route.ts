import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { brainEntries } from "@/db/schema";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

interface Body {
  category: string;
  source?: string;
  sourceType?: string;
  title: string;
  summary?: string;
  keyPoints?: string[];
  rawText?: string;
}

export async function POST(req: NextRequest) {
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500 }
    );
  }

  try {
    const body = (await req.json()) as Body;

    if (!body.category || !body.title) {
      return NextResponse.json(
        { ok: false, error: "category and title are required" },
        { status: 400 }
      );
    }

    const today = new Date();
    const dateString = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;

    const entry = await db
      .insert(brainEntries)
      .values({
        id: `brain_${nanoid(12)}`,
        category: body.category,
        source: body.source || null,
        sourceType: body.sourceType || "manual",
        dateAdded: dateString,
        title: body.title,
        summary: body.summary || null,
        keyPoints: body.keyPoints || [],
        rawText: body.rawText || null,
      })
      .returning();

    return NextResponse.json({ ok: true, entry: entry[0] });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 400 }
    );
  }
}
