import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { config } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface Body {
  key: string;
  value: string;
  description?: string;
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

    if (!body.key || !body.value) {
      return NextResponse.json(
        { ok: false, error: "key and value are required" },
        { status: 400 }
      );
    }

    const result = await db
      .insert(config)
      .values({
        key: body.key,
        value: body.value,
        description: body.description || null,
        updatedAt: new Date(),
      })
      .returning();

    return NextResponse.json({ ok: true, config: result[0] });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 400 }
    );
  }
}

export async function PUT(req: NextRequest) {
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500 }
    );
  }

  try {
    const body = (await req.json()) as Body;

    if (!body.key) {
      return NextResponse.json(
        { ok: false, error: "key is required" },
        { status: 400 }
      );
    }

    const result = await db
      .update(config)
      .set({
        value: body.value,
        description: body.description || null,
        updatedAt: new Date(),
      })
      .where(eq(config.key, body.key))
      .returning();

    if (result.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Config key not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, config: result[0] });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 400 }
    );
  }
}
