import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  campaigns,
  campaignsDaily,
  adGroups,
  keywords,
  ads,
  searchTerms,
  extensions,
  negativeKeywords,
} from "@/db/schema";

export const maxDuration = 60;

const CHUNK_SIZE = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function numOrNull(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function strOrNull(v: unknown): string | null {
  if (v === "" || v === null || v === undefined) return null;
  return String(v);
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== "string" || v === "") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type Row = Record<string, unknown>;

function mapCampaign(r: Row) {
  return {
    campaignId: String(r.campaign_id),
    runDate: String(r.run_date),
    campaignName: String(r.campaign_name ?? ""),
    status: String(r.status ?? ""),
    channelType: strOrNull(r.channel_type),
    biddingStrategy: strOrNull(r.bidding_strategy),
    targetCpaMicros: numOrNull(r.target_cpa_micros),
    targetRoas: numOrNull(r.target_roas),
    budgetMicros: numOrNull(r.budget_micros),
    impressions: numOrNull(r.impressions) ?? 0,
    clicks: numOrNull(r.clicks) ?? 0,
    costMicros: numOrNull(r.cost_micros) ?? 0,
    conversions: numOrNull(r.conversions) ?? 0,
    conversionValue: numOrNull(r.conversion_value) ?? 0,
    ctr: numOrNull(r.ctr),
    avgCpcMicros: numOrNull(r.avg_cpc_micros),
    searchIs: numOrNull(r.search_is),
    searchBudgetLostIs: numOrNull(r.search_budget_lost_is),
    searchRankLostIs: numOrNull(r.search_rank_lost_is),
  };
}

function mapCampaignDaily(r: Row) {
  return {
    campaignId: String(r.campaign_id),
    date: String(r.date),
    runDate: String(r.run_date),
    campaignName: String(r.campaign_name ?? ""),
    impressions: numOrNull(r.impressions) ?? 0,
    clicks: numOrNull(r.clicks) ?? 0,
    costMicros: numOrNull(r.cost_micros) ?? 0,
    conversions: numOrNull(r.conversions) ?? 0,
    conversionValue: numOrNull(r.conversion_value) ?? 0,
  };
}

function mapAdGroup(r: Row) {
  return {
    adGroupId: String(r.ad_group_id),
    runDate: String(r.run_date),
    adGroupName: String(r.ad_group_name ?? ""),
    status: String(r.status ?? ""),
    campaignId: String(r.campaign_id),
    cpcBidMicros: numOrNull(r.cpc_bid_micros),
    targetCpaMicros: numOrNull(r.target_cpa_micros),
    impressions: numOrNull(r.impressions) ?? 0,
    clicks: numOrNull(r.clicks) ?? 0,
    costMicros: numOrNull(r.cost_micros) ?? 0,
    conversions: numOrNull(r.conversions) ?? 0,
    conversionValue: numOrNull(r.conversion_value) ?? 0,
    avgQualityScore: numOrNull(r.avg_quality_score),
  };
}

function mapKeyword(r: Row) {
  return {
    keywordId: String(r.keyword_id),
    runDate: String(r.run_date),
    text: String(r.text ?? ""),
    matchType: strOrNull(r.match_type),
    status: String(r.status ?? ""),
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name ?? ""),
    adGroupId: String(r.ad_group_id),
    adGroupName: String(r.ad_group_name ?? ""),
    cpcBidMicros: numOrNull(r.cpc_bid_micros),
    qualityScore: numOrNull(r.quality_score),
    creativeQuality: strOrNull(r.creative_quality),
    postClickQuality: strOrNull(r.post_click_quality),
    searchPredictedCtr: strOrNull(r.search_predicted_ctr),
    impressions: numOrNull(r.impressions) ?? 0,
    clicks: numOrNull(r.clicks) ?? 0,
    costMicros: numOrNull(r.cost_micros) ?? 0,
    conversions: numOrNull(r.conversions) ?? 0,
    conversionValue: numOrNull(r.conversion_value) ?? 0,
    ctr: numOrNull(r.ctr),
    avgCpcMicros: numOrNull(r.avg_cpc_micros),
  };
}

function mapAd(r: Row) {
  return {
    adId: String(r.ad_id),
    runDate: String(r.run_date),
    status: String(r.status ?? ""),
    approvalStatus: strOrNull(r.approval_status),
    adGroupId: String(r.ad_group_id),
    adGroupName: String(r.ad_group_name ?? ""),
    campaignId: String(r.campaign_id),
    headlines: parseJsonArray(r.headlines_json),
    descriptions: parseJsonArray(r.descriptions_json),
    finalUrls: parseJsonArray(r.final_urls_json),
    impressions: numOrNull(r.impressions) ?? 0,
    clicks: numOrNull(r.clicks) ?? 0,
    costMicros: numOrNull(r.cost_micros) ?? 0,
    conversions: numOrNull(r.conversions) ?? 0,
    ctr: numOrNull(r.ctr),
    avgCpcMicros: numOrNull(r.avg_cpc_micros),
  };
}

function mapSearchTerm(r: Row) {
  return {
    runDate: String(r.run_date),
    term: String(r.term ?? ""),
    status: strOrNull(r.status),
    campaignId: String(r.campaign_id),
    campaignName: String(r.campaign_name ?? ""),
    adGroupId: String(r.ad_group_id),
    adGroupName: String(r.ad_group_name ?? ""),
    impressions: numOrNull(r.impressions) ?? 0,
    clicks: numOrNull(r.clicks) ?? 0,
    costMicros: numOrNull(r.cost_micros) ?? 0,
    conversions: numOrNull(r.conversions) ?? 0,
    ctr: numOrNull(r.ctr),
    avgCpcMicros: numOrNull(r.avg_cpc_micros),
  };
}

function mapExtension(r: Row) {
  return {
    extensionId: String(r.extension_id),
    runDate: String(r.run_date),
    type: String(r.type ?? ""),
    campaignId: strOrNull(r.campaign_id),
    adGroupId: strOrNull(r.ad_group_id),
    text: strOrNull(r.text),
    status: strOrNull(r.status),
    impressions: numOrNull(r.impressions) ?? 0,
    clicks: numOrNull(r.clicks) ?? 0,
    ctr: numOrNull(r.ctr),
  };
}

function mapNegativeKeyword(r: Row, i: number) {
  return {
    id: `${String(r.run_date)}_${i}`,
    runDate: String(r.run_date),
    scope: String(r.scope ?? ""),
    campaignId: strOrNull(r.campaign_id),
    campaignName: strOrNull(r.campaign_name),
    adGroupId: strOrNull(r.ad_group_id),
    adGroupName: strOrNull(r.ad_group_name),
    sharedSetId: strOrNull(r.shared_set_id),
    sharedSetName: strOrNull(r.shared_set_name),
    text: String(r.text ?? ""),
    matchType: String(r.match_type ?? ""),
  };
}

export async function POST(req: NextRequest) {
  if (!db) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500 });
  }

  const expectedSecret = process.env.INGEST_SECRET;
  if (!expectedSecret) {
    return NextResponse.json({ ok: false, error: "INGEST_SECRET not configured" }, { status: 500 });
  }

  let body: Row;
  try {
    body = (await req.json()) as Row;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const authHeader = req.headers.get("authorization");
  const bearerSecret = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const providedSecret = bearerSecret ?? (typeof body.secret === "string" ? body.secret : null);

  if (providedSecret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const data = body.data as Record<string, Row[]> | undefined;
  if (!data || typeof data !== "object") {
    return NextResponse.json({ ok: false, error: "missing data" }, { status: 400 });
  }

  const written: Record<string, number> = {};

  await db.transaction(async (tx) => {
    if (Array.isArray(data.Raw_Campaigns)) {
      const rows = data.Raw_Campaigns.map(mapCampaign);
      await tx.delete(campaigns);
      for (const c of chunk(rows, CHUNK_SIZE)) {
        await tx.insert(campaigns).values(c);
      }
      written.Raw_Campaigns = rows.length;
    }

    if (Array.isArray(data.Raw_Campaigns_Daily)) {
      const rows = data.Raw_Campaigns_Daily.map(mapCampaignDaily);
      for (const c of chunk(rows, CHUNK_SIZE)) {
        await tx
          .insert(campaignsDaily)
          .values(c)
          .onConflictDoUpdate({
            target: [campaignsDaily.campaignId, campaignsDaily.date],
            set: {
              runDate: sql`excluded.run_date`,
              campaignName: sql`excluded.campaign_name`,
              impressions: sql`excluded.impressions`,
              clicks: sql`excluded.clicks`,
              costMicros: sql`excluded.cost_micros`,
              conversions: sql`excluded.conversions`,
              conversionValue: sql`excluded.conversion_value`,
            },
          });
      }
      written.Raw_Campaigns_Daily = rows.length;
    }

    if (Array.isArray(data.Raw_AdGroups)) {
      const rows = data.Raw_AdGroups.map(mapAdGroup);
      await tx.delete(adGroups);
      for (const c of chunk(rows, CHUNK_SIZE)) {
        await tx.insert(adGroups).values(c);
      }
      written.Raw_AdGroups = rows.length;
    }

    if (Array.isArray(data.Raw_Keywords)) {
      const rows = data.Raw_Keywords.map(mapKeyword);
      await tx.delete(keywords);
      for (const c of chunk(rows, CHUNK_SIZE)) {
        await tx.insert(keywords).values(c);
      }
      written.Raw_Keywords = rows.length;
    }

    if (Array.isArray(data.Raw_Ads)) {
      const rows = data.Raw_Ads.map(mapAd);
      await tx.delete(ads);
      for (const c of chunk(rows, CHUNK_SIZE)) {
        await tx.insert(ads).values(c);
      }
      written.Raw_Ads = rows.length;
    }

    if (Array.isArray(data.Raw_SearchTerms)) {
      const rows = data.Raw_SearchTerms.map(mapSearchTerm);
      await tx.delete(searchTerms);
      for (const c of chunk(rows, CHUNK_SIZE)) {
        await tx.insert(searchTerms).values(c).onConflictDoNothing();
      }
      written.Raw_SearchTerms = rows.length;
    }

    if (Array.isArray(data.Raw_Extensions)) {
      const rows = data.Raw_Extensions.map(mapExtension);
      await tx.delete(extensions);
      for (const c of chunk(rows, CHUNK_SIZE)) {
        await tx.insert(extensions).values(c);
      }
      written.Raw_Extensions = rows.length;
    }

    if (Array.isArray(data.Raw_NegativeKeywords)) {
      const rows = data.Raw_NegativeKeywords.map(mapNegativeKeyword);
      await tx.delete(negativeKeywords);
      for (const c of chunk(rows, CHUNK_SIZE)) {
        await tx.insert(negativeKeywords).values(c);
      }
      written.Raw_NegativeKeywords = rows.length;
    }
  });

  return NextResponse.json({ ok: true, written });
}
