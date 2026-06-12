import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { config } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500 }
    );
  }

  try {
    const { key: rawKey } = await params;
    const key = decodeURIComponent(rawKey);
    const result = await db
      .delete(config)
      .where(eq(config.key, key))
      .returning();

    if (result.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Config key not found" },
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
