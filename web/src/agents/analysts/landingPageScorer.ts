/**
 * landingPageScorer.ts — Landing Page Scorer (v2 Analyst #6, unchanged scope
 * from v1 per CLAUDE.md's 6-Analyst table).
 *
 * Fetches the actual landing pages top-impression ads point to and scores
 * them on quick-CRO signals: HTTP status, redirect chains, response time
 * (page-speed proxy), response size (page-weight proxy), presence of
 * conversion-critical elements (H1, form, CTA verb), mobile viewport meta,
 * and soft-404 detection.
 *
 * Ported from apps_script/agents/copy_intel/LandingPageScorer.js — UrlFetchApp
 * calls replaced with Node's global `fetch`. GitHub Actions has no 6-minute
 * ceiling, but LP_MAX_PAGES still caps fetch volume to be polite to the
 * advertiser's own servers.
 *
 * `finding.id` prefix: "landing-page-<id>". Reads: ads. Brain categories:
 * landing_page, copy, general.
 */

import type { AnalystSpec } from "../runAnalyst";
import { AGENTS } from "../synthesis/agentNames";
import { loadAccountData } from "../data";

const LP_MAX_PAGES = 15;
const LP_SLOW_RESPONSE_MS = 2500;
const LP_HEAVY_BYTES = 1500000;
const LP_FETCH_TIMEOUT_MS = 15000;
const LP_USER_AGENT = "google-ads-agent-fleet/2.0 (LP scorer; fetch)";
const CTA_VERBS = ["shop", "buy", "get", "start", "sign up", "book", "order", "subscribe", "try", "request", "download", "add to cart"];
const SOFT_404_RE = /\b(404|page not found|we couldn't find|page unavailable|doesn't exist|no longer available)\b/i;

interface PageContext {
  adId: string;
  adGroupId: string;
  campaignId: string;
  impressions: number;
}

interface PageScore {
  url: string;
  ctx: PageContext;
  statusCode: number;
  responseMs: number;
  responseBytes: number;
  hasH1: boolean;
  hasForm: boolean;
  hasViewport: boolean;
  hasCtaVerb: boolean;
  redirectsTo: string | null;
  redirectCode: number;
  soft404: boolean;
  error: string | null;
}

interface LandingPageData {
  scores: PageScore[];
}

export async function buildLandingPageScorerSpec(): Promise<AnalystSpec<LandingPageData>> {
  const { ads } = await loadAccountData();

  const urlSet = new Set<string>();
  const urlContexts = new Map<string, PageContext>();

  for (const ad of ads.slice().sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0))) {
    const urls = Array.isArray(ad.finalUrls) ? ad.finalUrls : [];
    for (const url of urls) {
      if (!url || typeof url !== "string" || !url.startsWith("http")) continue;
      if (urlSet.has(url)) continue;
      urlSet.add(url);
      urlContexts.set(url, {
        adId: String(ad.adId),
        adGroupId: String(ad.adGroupId),
        campaignId: String(ad.campaignId),
        impressions: Number(ad.impressions) || 0,
      });
    }
  }

  const urls = Array.from(urlSet).slice(0, LP_MAX_PAGES);

  const scores: PageScore[] = [];
  for (const url of urls) {
    const ctx = urlContexts.get(url) || { adId: "", adGroupId: "", campaignId: "", impressions: 0 };
    scores.push({ url, ctx, ...(await scorePage(url)) });
  }

  return {
    agentName: AGENTS.LANDING_PAGE,
    persona:
      "You are a Google Ads landing-page / CRO specialist. You read live page-scoring data (HTTP, speed, content " +
      "checks) and identify the landing pages dragging down post-click conversion the most.",
    instructions:
      "Analyze the landing-page scores and surface up to 5 findings. Focus:\n" +
      "  1. Broken pages: status_code != 200 -> P1.\n" +
      "  2. Soft 404: soft_404=true (200 response but \"page not found\" text) -> P1.\n" +
      "  3. Redirect chain: redirect=YES -- note the destination and flag if it adds latency.\n" +
      `  4. Slow pages: response_ms > ${LP_SLOW_RESPONSE_MS} -> P1/P2.\n` +
      "  5. Missing H1 + missing has_cta_verb -> combined P1 (no message, no action).\n" +
      `  6. Heavy pages: response_bytes > ${LP_HEAVY_BYTES} -> P2/P3.\n` +
      "  7. Missing viewport meta -> mobile issue.\n\n" +
      'Group findings by URL -- one finding per problematic LP, with id prefix "landing-page-". ' +
      "Every finding must include specific numbers from the data. " +
      'Use category="landing_page". target.type="ad" or "campaign".',
    brainCategories: ["landing_page", "copy", "general"],
    brainLimit: 5,
    maxTokens: 3000,
    data: { scores },
    formatDataForPrompt,
  };
}

/* ===========================================================================
 * Per-page scoring — ported from LandingPageScorer.js _scorePage, using
 * Node's global fetch instead of UrlFetchApp.
 * ========================================================================= */

async function scorePage(url: string): Promise<Omit<PageScore, "url" | "ctx">> {
  const start = Date.now();

  let redirectsTo: string | null = null;
  let redirectCode = 0;
  try {
    const rr = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": LP_USER_AGENT },
      signal: AbortSignal.timeout(LP_FETCH_TIMEOUT_MS),
    });
    redirectCode = rr.status;
    if (redirectCode >= 300 && redirectCode < 400) {
      redirectsTo = rr.headers.get("location") || null;
    }
  } catch {
    // ignore — the main fetch below will surface the real error
  }

  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": LP_USER_AGENT },
      signal: AbortSignal.timeout(LP_FETCH_TIMEOUT_MS),
    });
    const body = await resp.text();
    const elapsed = Date.now() - start;
    const bytes = body.length;
    const lower = body.toLowerCase();

    return {
      statusCode: resp.status,
      responseMs: elapsed,
      responseBytes: bytes,
      hasH1: /<h1[\s>]/i.test(body),
      hasForm: /<form[\s>]/i.test(body),
      hasViewport: /<meta[^>]+name=["']?viewport/i.test(body),
      hasCtaVerb: CTA_VERBS.some((v) => lower.includes(v)),
      redirectsTo,
      redirectCode,
      soft404: SOFT_404_RE.test(body),
      error: null,
    };
  } catch (e) {
    return {
      statusCode: 0,
      responseMs: Date.now() - start,
      responseBytes: 0,
      hasH1: false,
      hasForm: false,
      hasViewport: false,
      hasCtaVerb: false,
      redirectsTo,
      redirectCode,
      soft404: false,
      error: String((e as Error)?.message || e).slice(0, 200),
    };
  }
}

function formatDataForPrompt(d: LandingPageData): string {
  const lines: string[] = [];
  lines.push(`Landing page scores (${d.scores.length} URLs sampled, top by impressions):`);
  lines.push("url | status | redirect | soft_404 | response_ms | bytes | has_h1 | has_form | has_viewport | has_cta | impressions | ad_id");
  for (const s of d.scores) {
    const redirectFlag = s.redirectsTo ? "YES->" + String(s.redirectsTo).slice(0, 60) : "no";
    lines.push(
      `${s.url} | ${s.statusCode} | ${redirectFlag} | ${s.soft404} | ${s.responseMs}ms | ${s.responseBytes} | ` +
        `${s.hasH1} | ${s.hasForm} | ${s.hasViewport} | ${s.hasCtaVerb} | ${s.ctx.impressions} | ${s.ctx.adId}`
    );
    if (s.error) lines.push("  ERROR: " + s.error);
  }
  if (d.scores.length === 0) {
    lines.push("");
    lines.push("No ads with final URLs found — nothing to score this run.");
  }
  return lines.join("\n");
}
