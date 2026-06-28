/**
 * googleAdsClient.ts — the SOLE place the `google-ads-api` package is
 * imported, mirroring how `google_ads_script.js` was the sole `AdsApp`
 * touchpoint before this migration (see CLAUDE.md "Execute-mode migration").
 *
 * Every function here performs exactly one mutate operation and returns a
 * normalized { success, resourceName?, error? } shape — callers
 * (implementation.ts) decide what to do with failures, this module never
 * throws for an expected API error (PERMISSION_DENIED, INVALID_ARGUMENT,
 * etc.), only for genuine misconfiguration (missing env vars).
 *
 * Required env vars: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
 * GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_REFRESH_TOKEN,
 * GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID. Fails closed (throws
 * immediately, does not silently no-op) if any is missing when a live call
 * is attempted — mirrors proxy.ts's DASHBOARD_PASSWORD fail-closed pattern.
 */

import * as grpc from "@grpc/grpc-js";
import { GoogleAdsApi, enums, ResourceNames, type Customer } from "google-ads-api";

export interface MutateResult {
  success: boolean;
  resourceName?: string;
  error?: string;
}

let cachedClient: GoogleAdsApi | null = null;
let cachedCustomer: Customer | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `googleAdsClient: ${name} is not set. Required env vars: GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, ` +
        `GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID.`
    );
  }
  return v;
}

/**
 * Manual OAuth token exchange via Node's native `fetch()` — bypasses `google-auth-library`'s
 * internal `gaxios`-based HTTP client entirely.
 *
 * Root-caused live, four separate experiments deep: `google-ads-api`'s gRPC path
 * (`mutateResources`, via `UserRefreshClient`) AND its REST path (`query`, via
 * `OAuth2Client.getAccessToken()`) both failed 100% of the time in the
 * `hourly-implementation` GitHub Actions runner with "Getting metadata from plugin
 * failed... Premature close" while fetching a token from oauth2.googleapis.com — but
 * plain `curl` and Node's own `fetch()` to that exact same endpoint, from that exact
 * same run, succeeded instantly every time. Retrying (4 attempts w/ backoff), pinning
 * Node 22 instead of 24, and forcing `--dns-result-order=ipv4first` (in case of an
 * IPv6 happy-eyeballs gap) each made zero difference — all rule out network
 * reachability, Node version, and IPv6 as the cause. Since `UserRefreshClient` and
 * `OAuth2Client.getAccessToken()` both ultimately go through the same `gaxios` HTTP
 * layer internally, and that's the one thing different between the failing calls and
 * the succeeding ones, `gaxios` itself is the common point of failure in this specific
 * runner environment. Fetching the token with the same `fetch()` that's proven to work
 * sidesteps it completely.
 */
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function fetchAccessTokenManually(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_ADS_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_ADS_CLIENT_SECRET"),
      refresh_token: requireEnv("GOOGLE_ADS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`manual token fetch failed: HTTP ${res.status} ${body.error || ""} ${body.error_description || ""}`.trim());
  }
  // Refresh 2 minutes before actual expiry (tokens last ~1hr) to avoid using one that
  // expires mid-flight on a slow call.
  cachedAccessToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - 120_000 };
  return cachedAccessToken.token;
}

function getCustomer(): Customer {
  if (cachedCustomer) return cachedCustomer;

  if (!cachedClient) {
    cachedClient = new GoogleAdsApi({
      client_id: requireEnv("GOOGLE_ADS_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_ADS_CLIENT_SECRET"),
      developer_token: requireEnv("GOOGLE_ADS_DEVELOPER_TOKEN"),
    });
  }

  cachedCustomer = cachedClient.Customer({
    customer_id: requireEnv("GOOGLE_ADS_CUSTOMER_ID"),
    login_customer_id: requireEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
    refresh_token: requireEnv("GOOGLE_ADS_REFRESH_TOKEN"),
  });

  // Override both of the package's internal token-fetch paths (see fetchAccessTokenManually's
  // doc comment) — REST (`getAccessToken`, used by `query`/`report`) and gRPC (`getCredentials`,
  // used by `mutateResources`) — with the version that doesn't go through the broken gaxios path.
  // Instance-property overrides shadow the inherited prototype methods; doesn't touch node_modules.
  const customerWithInternals = cachedCustomer as unknown as {
    getAccessToken: () => Promise<string>;
    getCredentials: () => grpc.ChannelCredentials;
  };
  customerWithInternals.getAccessToken = fetchAccessTokenManually;
  customerWithInternals.getCredentials = () => {
    const sslCreds = grpc.credentials.createSsl();
    const callCreds = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
      fetchAccessTokenManually()
        .then((token) => {
          const metadata = new grpc.Metadata();
          metadata.set("authorization", `Bearer ${token}`);
          callback(null, metadata);
        })
        .catch((err) => callback(err instanceof Error ? err : new Error(String(err))));
    });
    return grpc.credentials.combineChannelCredentials(sslCreds, callCreds);
  };

  return cachedCustomer;
}

function describeError(e: unknown): string {
  const msg = String((e as Error)?.message || e);
  if (/UNAUTHENTICATED|invalid_grant/i.test(msg)) {
    return (
      `${msg} — refresh token may be invalid/expired. Check the OAuth consent screen is "In production", ` +
      `not "Testing" (Testing-status refresh tokens expire after 7 days).`
    );
  }
  return msg.slice(0, 500);
}

function customerId(): string {
  return requireEnv("GOOGLE_ADS_CUSTOMER_ID");
}

/**
 * Retries on transient OAuth-token-fetch failures from oauth2.googleapis.com —
 * "Getting metadata from plugin failed... Premature close" and similar network-
 * level errors during gRPC's auth-metadata callback. Confirmed live: this is a
 * known, documented gap in google-auth-library-nodejs (e.g. googleapis/google-
 * auth-library-python#343 — "the current implementation doesn't retry on such
 * failures" — same underlying issue, Node client has no built-in retry either),
 * not a credentials/permissions problem; reads with the exact same credentials
 * succeed immediately before/after. Every mutate/query call below goes through
 * this — without it, a single transient blip on Google's end fails the call
 * outright with no recovery, which is exactly what happened in production
 * (confirmed: 4/4 sitelink creates failed identically on two separate hourly runs).
 */
const RETRYABLE_TRANSPORT_ERROR = /getting metadata from plugin failed|premature close|econnreset|etimedout|socket hang up|unavailable/i;

async function withAuthRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message || e);
      if (!RETRYABLE_TRANSPORT_ERROR.test(msg) || attempt === maxAttempts) throw e;
      const waitMs = attempt * 1500;
      console.log(`[googleAdsClient] transient auth/transport error (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms: ${msg.slice(0, 150)}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

/**
 * mutateResources() returns the raw MutateGoogleAdsResponse, whose actual
 * field is `mutate_operation_responses[]` (NOT `results[]` — that name only
 * exists on search/report responses, confirmed by typecheck against this
 * package's types). Each entry nests the result under an entity-specific key
 * (e.g. `campaign_budget_result`, `ad_group_criterion_result`) that isn't
 * statically typed here, so this extracts `resource_name` from whichever key
 * is present rather than guessing the exact name per call site.
 */
function extractResourceName(response: unknown, index: number): string | undefined {
  const ops = (response as { mutate_operation_responses?: Array<Record<string, unknown>> })?.mutate_operation_responses;
  const entry = ops?.[index];
  if (!entry) return undefined;
  for (const value of Object.values(entry)) {
    if (value && typeof value === "object" && "resource_name" in (value as object)) {
      return (value as { resource_name?: string }).resource_name;
    }
  }
  return undefined;
}

/* ===========================================================================
 * Budget
 * ========================================================================= */

/** `campaignId` is the campaign's id; resolves its campaign_budget resource name first (budget is its own resource, not a campaign field). */
export async function setCampaignBudget(campaignId: string, newBudgetMicros: number): Promise<MutateResult> {
  const customer = getCustomer();
  try {
    const rows = await withAuthRetry(() =>
      customer.query(`SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${Number(campaignId)} LIMIT 1`)
    );
    const budgetResourceName = (rows[0] as { campaign?: { campaign_budget?: string } })?.campaign?.campaign_budget;
    if (!budgetResourceName) return { success: false, error: `no campaign_budget resource found for campaign ${campaignId}` };

    await withAuthRetry(() =>
      customer.mutateResources([
        {
          entity: "campaign_budget",
          operation: "update",
          resource: { resource_name: budgetResourceName, amount_micros: Math.round(newBudgetMicros) },
        },
      ])
    );
    return { success: true, resourceName: budgetResourceName };
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
}

/* ===========================================================================
 * Negative keywords
 * ========================================================================= */

export async function addNegativeKeyword(
  scope: { type: "campaign" | "adgroup"; id: string },
  text: string,
  matchType: "EXACT" | "PHRASE" | "BROAD"
): Promise<MutateResult> {
  const customer = getCustomer();
  const cid = customerId();
  try {
    if (scope.type === "adgroup") {
      const result = await withAuthRetry(() =>
        customer.mutateResources([
          {
            entity: "ad_group_criterion",
            operation: "create",
            resource: {
              ad_group: ResourceNames.adGroup(cid, scope.id),
              negative: true,
              keyword: { text, match_type: enums.KeywordMatchType[matchType] },
            },
          },
        ])
      );
      return { success: true, resourceName: extractResourceName(result, 0) };
    }
    const result = await withAuthRetry(() =>
      customer.mutateResources([
        {
          entity: "campaign_criterion",
          operation: "create",
          resource: {
            campaign: ResourceNames.campaign(cid, scope.id),
            negative: true,
            keyword: { text, match_type: enums.KeywordMatchType[matchType] },
          },
        },
      ])
    );
    return { success: true, resourceName: extractResourceName(result, 0) };
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
}

/* ===========================================================================
 * Keyword bid + new keyword
 * ========================================================================= */

/** `adGroupId` + `criterionId` (the keyword's id, i.e. ad_group_criterion.criterion_id) — same plain-id convention as addKeyword/addNegativeKeyword, resource name built internally. */
export async function setKeywordBid(adGroupId: string, criterionId: string, newCpcBidMicros: number): Promise<MutateResult> {
  const customer = getCustomer();
  const cid = customerId();
  const resourceName = ResourceNames.adGroupCriterion(cid, adGroupId, criterionId);
  try {
    await withAuthRetry(() =>
      customer.mutateResources([
        {
          entity: "ad_group_criterion",
          operation: "update",
          resource: { resource_name: resourceName, cpc_bid_micros: Math.round(newCpcBidMicros) },
        },
      ])
    );
    return { success: true, resourceName };
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
}

export async function addKeyword(
  adGroupId: string,
  text: string,
  matchType: "EXACT" | "PHRASE" | "BROAD",
  cpcBidMicros?: number
): Promise<MutateResult> {
  const customer = getCustomer();
  const cid = customerId();
  try {
    const resource: Record<string, unknown> = {
      ad_group: ResourceNames.adGroup(cid, adGroupId),
      keyword: { text, match_type: enums.KeywordMatchType[matchType] },
      status: enums.AdGroupCriterionStatus.ENABLED,
    };
    if (cpcBidMicros) resource.cpc_bid_micros = Math.round(cpcBidMicros);

    const result = await withAuthRetry(() =>
      customer.mutateResources([{ entity: "ad_group_criterion", operation: "create", resource }])
    );
    return { success: true, resourceName: extractResourceName(result, 0) };
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
}

/* ===========================================================================
 * New ad group — create() + N keyword criteria, atomic in one mutate call
 * (temporary resource id -1, same pattern as addSitelinks below). Purely
 * additive — never touches the ad group(s) the keywords are being split out
 * of, so it carries none of the risk of an actual move/merge.
 *
 * Created with status ENABLED, not PAUSED — google_ads_script.js's collect
 * queries all filter `ad_group.status = 'ENABLED'`, so a paused new ad group
 * would be invisible to tomorrow's data collection and silently never get
 * flagged for the obvious next step (it has zero ads). Being enabled with no
 * ads is safe — Google Ads serves nothing from an ad group with no ads — and
 * it means the account's existing structure-understaffed-ag-* rule will
 * naturally pick it up next run and recommend adding ads, closing the loop
 * without this function needing to also create ad copy itself.
 * ========================================================================= */

export async function createAdGroup(
  campaignId: string,
  name: string,
  keywords: Array<{ text: string; matchType: "EXACT" | "PHRASE" | "BROAD" }>,
  cpcBidMicros?: number
): Promise<MutateResult> {
  const customer = getCustomer();
  const cid = customerId();
  const tempAdGroupResourceName = ResourceNames.adGroup(cid, "-1");
  try {
    const adGroupResource: Record<string, unknown> = {
      resource_name: tempAdGroupResourceName,
      campaign: ResourceNames.campaign(cid, campaignId),
      name,
      status: enums.AdGroupStatus.ENABLED,
      type: enums.AdGroupType.SEARCH_STANDARD,
    };
    if (cpcBidMicros) adGroupResource.cpc_bid_micros = Math.round(cpcBidMicros);

    const operations = [
      { entity: "ad_group", operation: "create", resource: adGroupResource },
      ...keywords.map((k) => ({
        entity: "ad_group_criterion",
        operation: "create",
        resource: {
          ad_group: tempAdGroupResourceName,
          keyword: { text: k.text, match_type: enums.KeywordMatchType[k.matchType] },
          status: enums.AdGroupCriterionStatus.ENABLED,
        },
      })),
    ];
    const result = await withAuthRetry(() => customer.mutateResources(operations as never));
    return { success: true, resourceName: extractResourceName(result, 0) };
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
}

/* ===========================================================================
 * Extensions — asset create + campaign_asset link, atomic in one mutate call
 * (temporary resource id -1, same pattern as the package's own budget+campaign example).
 * ========================================================================= */

export async function addSitelinks(
  campaignId: string,
  sitelinks: Array<{ linkText: string; description1?: string; description2?: string; finalUrl: string }>
): Promise<MutateResult[]> {
  const customer = getCustomer();
  const cid = customerId();
  const out: MutateResult[] = [];

  for (let i = 0; i < sitelinks.length; i++) {
    const s = sitelinks[i];
    const tempId = `-${i + 1}`;
    const assetResourceName = ResourceNames.asset(cid, tempId);
    try {
      const result = await withAuthRetry(() =>
        customer.mutateResources([
          {
            entity: "asset",
            operation: "create",
            resource: {
              resource_name: assetResourceName,
              sitelink_asset: {
                link_text: s.linkText,
                description1: s.description1 || "",
                description2: s.description2 || "",
              },
              final_urls: [s.finalUrl],
            },
          },
          {
            entity: "campaign_asset",
            operation: "create",
            resource: {
              campaign: ResourceNames.campaign(cid, campaignId),
              asset: assetResourceName, // resolved from the create operation above within the same atomic call
              field_type: enums.AssetFieldType.SITELINK,
            },
          },
        ])
      );
      out.push({ success: true, resourceName: extractResourceName(result, 1) });
    } catch (e) {
      out.push({ success: false, error: describeError(e) });
    }
  }
  return out;
}

export async function addCallouts(campaignId: string, calloutTexts: string[]): Promise<MutateResult[]> {
  const customer = getCustomer();
  const cid = customerId();
  const out: MutateResult[] = [];

  for (let i = 0; i < calloutTexts.length; i++) {
    const text = calloutTexts[i];
    const tempId = `-${i + 1}`;
    const assetResourceName = ResourceNames.asset(cid, tempId);
    try {
      const result = await withAuthRetry(() =>
        customer.mutateResources([
          {
            entity: "asset",
            operation: "create",
            resource: { resource_name: assetResourceName, callout_asset: { callout_text: text } },
          },
          {
            entity: "campaign_asset",
            operation: "create",
            resource: {
              campaign: ResourceNames.campaign(cid, campaignId),
              asset: assetResourceName,
              field_type: enums.AssetFieldType.CALLOUT,
            },
          },
        ])
      );
      out.push({ success: true, resourceName: extractResourceName(result, 1) });
    } catch (e) {
      out.push({ success: false, error: describeError(e) });
    }
  }
  return out;
}

/* ===========================================================================
 * Responsive Search Ad — always created PAUSED (see CLAUDE.md "update_copy
 * safety design" — approval authorizes creation, never going live).
 * ========================================================================= */

export async function createResponsiveSearchAd(
  adGroupId: string,
  headlines: string[],
  descriptions: string[],
  finalUrls: string[]
): Promise<MutateResult> {
  const customer = getCustomer();
  const cid = customerId();
  try {
    const result = await withAuthRetry(() =>
      customer.mutateResources([
        {
          entity: "ad_group_ad",
          operation: "create",
          resource: {
            ad_group: ResourceNames.adGroup(cid, adGroupId),
            status: enums.AdGroupAdStatus.PAUSED, // NEVER enabled at creation — non-negotiable, see header comment
            ad: {
              final_urls: finalUrls,
              responsive_search_ad: {
                headlines: headlines.map((text) => ({ text })),
                descriptions: descriptions.map((text) => ({ text })),
              },
            },
          },
        },
      ])
    );
    return { success: true, resourceName: extractResourceName(result, 0) };
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
}
