/**
 * data.ts — read access to the raw snapshot tables for rule-based Analysts.
 *
 * Snapshot tables (`campaigns`, `ad_groups`, `keywords`, `ads`, `extensions`)
 * are replaced wholesale on each collect run (CLAUDE.md), so a plain
 * `select *` always returns the latest snapshot — no run_date filter needed.
 *
 * Ported from the `AgentCommon.readCampaigns/readAdGroups/readKeywords/
 * readAds/readExtensions` + `AgentCommon.micros` helpers in
 * apps_script/agents/_common.js.
 */

import { db } from "@/db";
import { campaigns, adGroups, keywords, ads, extensions, searchTerms, negativeKeywords } from "@/db/schema";

export type CampaignRow = typeof campaigns.$inferSelect;
export type AdGroupRow = typeof adGroups.$inferSelect;
export type KeywordRow = typeof keywords.$inferSelect;
export type AdRow = typeof ads.$inferSelect;
export type ExtensionRow = typeof extensions.$inferSelect;
export type SearchTermRow = typeof searchTerms.$inferSelect;
export type NegativeKeywordRow = typeof negativeKeywords.$inferSelect;

export interface AccountData {
  campaigns: CampaignRow[];
  adGroups: AdGroupRow[];
  keywords: KeywordRow[];
  ads: AdRow[];
  extensions: ExtensionRow[];
}

export async function loadAccountData(): Promise<AccountData> {
  if (!db) return { campaigns: [], adGroups: [], keywords: [], ads: [], extensions: [] };

  const [c, ag, kw, ad, ext] = await Promise.all([
    db.select().from(campaigns),
    db.select().from(adGroups),
    db.select().from(keywords),
    db.select().from(ads),
    db.select().from(extensions),
  ]);

  return { campaigns: c, adGroups: ag, keywords: kw, ads: ad, extensions: ext };
}

/** Read the search_terms snapshot table (ported from AgentCommon.readSearchTerms). */
export async function readSearchTerms(): Promise<SearchTermRow[]> {
  if (!db) return [];
  return db.select().from(searchTerms);
}

/** Read the negative_keywords snapshot table (ported from AgentCommon.readNegativeKeywords). */
export async function readNegativeKeywords(): Promise<NegativeKeywordRow[]> {
  if (!db) return [];
  return db.select().from(negativeKeywords);
}

/** Convert a micros amount (bigint/number/null) to currency units, e.g. 84316670000 -> 84316.67. */
export function micros(n: number | bigint | null | undefined): number {
  return Math.round((Number(n) || 0) / 10000) / 100;
}
