/**
 * proxy.ts — Next.js 16's renamed `middleware.ts` convention. Gates every
 * page and API route behind HTTP Basic Auth EXCEPT the three routes the
 * Google Ads Script itself calls (those already check `Authorization: Bearer
 * <INGEST_SECRET>` in their own route handlers — see ingest/route.ts,
 * pending-changes/route.ts, execute-result/route.ts).
 *
 * Added after discovering live (June 2026) that /api/approve, /api/config,
 * /api/config/[key], /api/brain, and /api/brain/[id] had NO authentication
 * at all — confirmed exploitable: a bare POST to /api/approve on the public
 * Vercel URL approved an action_plan row with zero credentials. Those routes
 * can approve 'auto' actions that mutate live Google Ads spend within the
 * hour, flip DRY_RUN off, change safety-rail thresholds, or inject content
 * into brain_entries that every Analyst's LLM prompt reads — this is the
 * entire write surface of the system, and it was wide open.
 *
 * DASHBOARD_PASSWORD is required — if unset, every gated request is
 * rejected (fail closed, not fail open). Set DASHBOARD_USERNAME /
 * DASHBOARD_PASSWORD in .env.local (dev) and as Vercel project env vars
 * (production).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const UNGATED_PREFIXES = ["/api/ingest", "/api/pending-changes", "/api/execute-result"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (UNGATED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const expectedUser = process.env.DASHBOARD_USERNAME || "admin";
  const expectedPass = process.env.DASHBOARD_PASSWORD;

  if (!expectedPass) {
    console.error("[proxy] DASHBOARD_PASSWORD is not set — rejecting all requests (fail closed). Set it in env vars.");
    return unauthorized();
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Basic ")) {
    return unauthorized();
  }

  let decoded: string;
  try {
    decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
  } catch {
    return unauthorized();
  }

  const sepIndex = decoded.indexOf(":");
  const user = sepIndex === -1 ? decoded : decoded.slice(0, sepIndex);
  const pass = sepIndex === -1 ? "" : decoded.slice(sepIndex + 1);

  if (user !== expectedUser || pass !== expectedPass) {
    return unauthorized();
  }

  return NextResponse.next();
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Google Ads Agent Fleet"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
