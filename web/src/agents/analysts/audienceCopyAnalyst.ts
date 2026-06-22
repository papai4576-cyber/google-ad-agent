/**
 * audienceCopyAnalyst.ts — Audience & Copy Analyst (v2 Analyst #3).
 *
 * Merges v1's AudienceAnalyst (audience-layering opportunities: brand vs
 * non-brand ROAS gap, RLSA underutilization, lookalike seeding, Customer
 * Match for Shopping/PMax) and AdCopyCritic (structurally weak RSAs: missing
 * CTA, no numbers, low CTR vs ad-group median, keyword mismatch, headline
 * fatigue) into a single rule-based pass + one LLM call.
 *
 * `finding.id` prefixes follow agentNames.ts conventions:
 *   "audience-<...>" for AudienceAnalyst rules, "low-ctr-ad-<id>" kept as-is
 *   per the documented convention, other AdCopyCritic rules prefixed "copy-".
 *
 * Reads: campaigns, adGroups, ads. Brain categories: audience, copy, brand.
 */

import type { Candidate, RuleBasedAnalystSpec } from "../runAnalyst";
import { RulesEngine, getConfigValue } from "../rules/rulesEngine";
import { AGENTS } from "../synthesis/agentNames";
import { loadAccountData, micros, type AdGroupRow, type AdRow, type CampaignRow } from "../data";

interface AudienceCopyData {
  campaigns: CampaignRow[];
  adGroups: AdGroupRow[];
  ads: AdRow[];
  brandKeywords: string[];
}

const RULE_DEFAULTS = {
  BRAND_ROAS_MULTIPLIER: 3.0,
  RLSA_MIN_CLICKS: 300,
  LOOKALIKE_MIN_CONV: 30,
  AUDIENCE_SHOP_SPEND: 5000,
  AD_CTR_FLOOR_RATIO: 0.4,
  AD_MIN_IMPR: 200,
};

const AD_CTA_VERBS =
  /\b(buy|shop|get|start|book|order|try|save|claim|see|learn|explore|discover|find|sign up|register|download|request|apply|call)\b/i;

export async function buildAudienceCopyAnalystSpec(): Promise<RuleBasedAnalystSpec<AudienceCopyData>> {
  const { campaigns, adGroups, ads } = await loadAccountData();
  const ruleConfig = await RulesEngine.load(RULE_DEFAULTS);
  const brandRaw = await getConfigValue("BRAND_KEYWORDS", "");
  const brandKeywords = brandRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  return {
    agentName: AGENTS.AUDIENCE_COPY,
    persona:
      "You are a senior Google Ads audience strategy and RSA copywriting specialist. " +
      "Every finding must include a specific number from the data as evidence. Do not write generic recommendations.",
    instructions:
      "For audience findings, explain exactly which audience type to add (RLSA, Customer Match, in-market segment) and in which mode " +
      "(observation vs targeting), framed as observation-mode tests since Raw_Audiences data is not yet collected. " +
      "For copy findings: the EVIDENCE contains the ACTUAL CURRENT HEADLINES. You MUST write 3-5 replacement headlines " +
      "(max 30 chars each) that are SPECIFIC to Baidyanath Ayurvedic products — NEVER write generic 'Buy Now', 'Shop Online', " +
      "'Learn More'. Good Baidyanath headlines: 'Buy Chyawanprash Online', '100% Ayurvedic Formula', 'Since 1917', " +
      "'Trusted by Millions', 'Shop Baidyanath Now'. Also write 2 descriptions (max 90 chars each). " +
      "Return `action` as a PLAIN TEXT string (NOT JSON, NOT an array), formatted exactly like:\n" +
      "Headlines: • [headline1] • [headline2] • [headline3] Descriptions: • [desc1] • [desc2]\n\n" +
      'For COPY findings only (id prefixes "copy-" and "low-ctr-ad-" — NOT "audience-"): ALSO populate `proposed_changes` ' +
      'with EXACTLY ONE entry: {"type":"create_rsa","params":{"ad_group_id":"<the ad_group_id given in this finding\'s ' +
      'evidence>","headlines":["<same 3-5 headlines as in action, <=30 chars each>"],"descriptions":["<same 2 descriptions ' +
      'as in action, <=90 chars each>"],"final_urls":["<the final_url given in this finding\'s evidence>"]}}. If evidence ' +
      "has no final_url, leave proposed_changes as [] (cannot auto-create an ad with no destination URL). Never populate " +
      "proposed_changes for audience-* findings — those are strategic recommendations, not a single executable change.",
    brainCategories: ["audience", "copy", "brand"],
    brainLimit: 5,
    data: { campaigns, adGroups, ads, brandKeywords },
    formatDataForPrompt: (d) => {
      // Map campaign names for lookup
      const campName = new Map(d.campaigns.map((c) => [c.campaignId, c.campaignName]));
      // Group ads by ad group
      const adsByAg = new Map<string, typeof d.ads>();
      for (const ad of d.ads) {
        const list = adsByAg.get(ad.adGroupId) ?? [];
        list.push(ad);
        adsByAg.set(ad.adGroupId, list);
      }
      const lines = [`AD GROUPS & ADS (brand keywords: ${d.brandKeywords.join(", ") || "none configured"}):`];
      for (const ag of d.adGroups.slice(0, 20)) {
        const campaign = campName.get(ag.campaignId) ?? ag.campaignId;
        const agAds = adsByAg.get(ag.adGroupId) ?? [];
        lines.push(`AdGroup "${ag.adGroupName}" [${ag.adGroupId}] (campaign: "${campaign}") | spend=${micros(ag.costMicros).toFixed(0)} conv=${ag.conversions || 0}`);
        for (const ad of agAds.slice(0, 3)) {
          const headlines = (ad.headlines ?? []).slice(0, 4).join(" | ");
          const ctr = ((Number(ad.ctr) || 0) * 100).toFixed(2);
          lines.push(`  Ad [${ad.adId}] ctr=${ctr}% impr=${ad.impressions || 0} headlines: "${headlines}"`);
        }
      }
      return lines.join("\n");
    },
    ruleConfig,
    detect: detectAudienceCopy,
    maxCandidates: 10,
    maxTokens: 3000,
  };
}

function detectAudienceCopy(
  data: AudienceCopyData,
  ctx: { targets: { target_cpa: number; target_roas: number; monthly_budget: number }; cur: string; cfg: Record<string, number> }
): Candidate[] {
  const cfg = ctx.cfg;
  const cur = ctx.cur;
  const out: Candidate[] = [];

  out.push(...detectAudience(data, cfg, cur));
  out.push(...detectAdCopy(data, cfg));

  return out;
}

/* ===========================================================================
 * AudienceAnalyst rules — ported from apps_script/agents/audit/AudienceAnalyst.js
 * ========================================================================= */

function detectAudience(data: AudienceCopyData, cfg: Record<string, number>, cur: string): Candidate[] {
  const out: Candidate[] = [];

  function isBrand(name: string): boolean {
    if (data.brandKeywords.length === 0) return false;
    const lc = String(name).toLowerCase();
    return data.brandKeywords.some((b) => lc.includes(b));
  }

  const brandCampaigns: CampaignRow[] = [];
  const nonBrandSearch: CampaignRow[] = [];
  const shoppingCampaigns: CampaignRow[] = [];
  const allSearch: CampaignRow[] = [];

  for (const c of data.campaigns) {
    const ch = String(c.channelType || "").toUpperCase();
    if (ch === "SEARCH" || ch === "SEARCH_STANDARD") {
      allSearch.push(c);
      if (isBrand(c.campaignName)) brandCampaigns.push(c);
      else nonBrandSearch.push(c);
    }
    if (ch === "SHOPPING" || ch === "PERFORMANCE_MAX") {
      shoppingCampaigns.push(c);
    }
  }

  // 1. Brand/non-brand ROAS gap.
  if (brandCampaigns.length > 0 && nonBrandSearch.length > 0) {
    let brandSpend = 0;
    let brandVal = 0;
    let nbSpend = 0;
    let nbVal = 0;
    for (const c of brandCampaigns) {
      brandSpend += micros(c.costMicros);
      brandVal += Number(c.conversionValue) || 0;
    }
    for (const c of nonBrandSearch) {
      nbSpend += micros(c.costMicros);
      nbVal += Number(c.conversionValue) || 0;
    }
    const brandRoas = brandSpend > 0 ? brandVal / brandSpend : 0;
    const nbRoas = nbSpend > 0 ? nbVal / nbSpend : 0;
    if (nbRoas > 0 && brandRoas > cfg.brand_roas_multiplier * nbRoas) {
      out.push({
        id: "audience-brand-nonbrand-gap",
        category: "audience",
        severity: "P2",
        magnitude: "high",
        confidence: "medium",
        effort: "medium",
        metric: "ROAS",
        direction: "up",
        target: { type: "campaign", id: "account", name: "Account — brand vs non-brand" },
        hint:
          `Brand ROAS ${brandRoas.toFixed(1)}x is ${(brandRoas / nbRoas).toFixed(1)}x above non-brand ROAS ${nbRoas.toFixed(1)}x. ` +
          "Audience segmentation (RLSA past converters, Customer Match) on non-brand can close this gap.",
        evidence: [
          `brand ROAS ${brandRoas.toFixed(2)}`,
          `non-brand ROAS ${nbRoas.toFixed(2)}`,
          `brand spend ${cur}${brandSpend.toFixed(0)}`,
          `non-brand spend ${cur}${nbSpend.toFixed(0)}`,
        ],
      });
    }
  }

  // 2. RLSA underutilization on high-volume smart-bidding search campaigns.
  const smartBiddingPatterns = ["TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "ENHANCED_CPC"];
  for (const sc of allSearch) {
    const clicks = Number(sc.clicks) || 0;
    const strat = String(sc.biddingStrategy || "").toUpperCase();
    const isSmartBidding = smartBiddingPatterns.some((p) => strat.includes(p));
    const nameHasRlsa = String(sc.campaignName).toLowerCase().includes("rlsa");
    if (clicks > cfg.rlsa_min_clicks && isSmartBidding && !nameHasRlsa) {
      out.push({
        id: `audience-rlsa-missing-${sc.campaignId}`,
        category: "audience",
        severity: "P2",
        magnitude: "medium",
        confidence: "medium",
        effort: "easy",
        metric: "ROAS",
        direction: "up",
        target: { type: "campaign", id: String(sc.campaignId), name: sc.campaignName },
        hint:
          `High-volume search campaign (${clicks} clicks) on smart bidding with no RLSA signals visible. ` +
          "Adding Past Visitors (30d) + Past Converters (540d) in observation mode gives the algorithm richer signals at no extra cost.",
        evidence: [`clicks ${clicks}`, `bidding ${strat}`, "no RLSA in campaign name (heuristic)"],
      });
    }
  }

  // 3. Lookalike / similar-audience seeding readiness (one per run).
  for (const lc of data.campaigns) {
    const lconv = Number(lc.conversions) || 0;
    const lclicks = Number(lc.clicks) || 0;
    const lcvr = lclicks > 0 ? lconv / lclicks : 0;
    if (lconv >= cfg.lookalike_min_conv && lcvr > 0.01) {
      out.push({
        id: `audience-lookalike-seed-${lc.campaignId}`,
        category: "audience",
        severity: "P3",
        magnitude: "medium",
        confidence: "medium",
        effort: "easy",
        metric: "conversions",
        direction: "up",
        target: { type: "campaign", id: String(lc.campaignId), name: lc.campaignName },
        hint: `${lconv} conversions at ${(lcvr * 100).toFixed(1)}% CVR — strong converter list ready for seeding a Similar Audiences / lookalike list.`,
        evidence: [`conversions ${lconv}`, `CVR ${(lcvr * 100).toFixed(1)}%`, `clicks ${lclicks}`],
      });
      break;
    }
  }

  // 4. Shopping / PMax without Customer Match signal.
  const shopSpend = shoppingCampaigns.reduce((s, c) => s + micros(c.costMicros), 0);
  if (shoppingCampaigns.length > 0 && shopSpend >= cfg.audience_shop_spend) {
    const shopNames = shoppingCampaigns.map((c) => c.campaignName).join(", ");
    out.push({
      id: "audience-shopping-cm-missing",
      category: "audience",
      severity: "P2",
      magnitude: "medium",
      confidence: "low",
      effort: "medium",
      metric: "ROAS",
      direction: "up",
      target: { type: "campaign", id: "shopping_pmax", name: "Shopping / PMax campaigns" },
      hint:
        `${cur}${shopSpend.toFixed(0)} spent on Shopping/PMax (${shoppingCampaigns.length} campaigns). ` +
        "Adding Customer Match (CRM list) as an audience signal gives the bidder known high-intent users to optimise toward.",
      evidence: [`${shoppingCampaigns.length} Shopping/PMax campaigns`, `combined spend ${cur}${shopSpend.toFixed(0)}`, `campaigns: ${shopNames.slice(0, 100)}`],
    });
  }

  return out;
}

/* ===========================================================================
 * AdCopyCritic rules — ported from apps_script/agents/copy_intel/AdCopyCritic.js
 * ========================================================================= */

function detectAdCopy(data: AudienceCopyData, cfg: Record<string, number>): Candidate[] {
  const out: Candidate[] = [];

  // Top 30 ads by impressions — the universe worth critiquing.
  const top = data.ads
    .slice()
    .sort((a, b) => (Number(b.impressions) || 0) - (Number(a.impressions) || 0))
    .slice(0, 30);

  // Ad-group median CTR for the low-CTR rule.
  const agCtrs: Record<string, number[]> = {};
  for (const t of top) {
    const agId = String(t.adGroupId);
    (agCtrs[agId] = agCtrs[agId] || []).push(Number(t.ctr) || 0);
  }
  const agMedianCtr: Record<string, number> = {};
  for (const agKey of Object.keys(agCtrs)) {
    const arr = agCtrs[agKey].slice().sort((a, b) => a - b);
    agMedianCtr[agKey] = arr[Math.floor(arr.length / 2)];
  }

  // Ad-group name lookup.
  const agById = new Map<string, AdGroupRow>();
  for (const ag of data.adGroups) {
    agById.set(String(ag.adGroupId), ag);
  }

  for (const ad of top) {
    const impr = Number(ad.impressions) || 0;
    const adCtr = Number(ad.ctr) || 0;
    const agId = String(ad.adGroupId);
    const ag = agById.get(agId);
    const agName = ag ? String(ag.adGroupName) : "";

    const headlines = Array.isArray(ad.headlines) ? ad.headlines : [];
    const descs = Array.isArray(ad.descriptions) ? ad.descriptions : [];
    const allText = headlines.concat(descs).join(" ");

    const hlSnip = JSON.stringify(headlines).slice(0, 300);
    const dsSnip = JSON.stringify(descs).slice(0, 200);

    // Needed for any create_rsa proposed_changes entry — a new ad's final_url. No URL, no auto-implementable copy finding.
    const finalUrls = Array.isArray(ad.finalUrls) ? ad.finalUrls : [];
    const finalUrl = finalUrls.find((u) => typeof u === "string" && u.startsWith("http"));
    const newAdEvidence = [`ad_group_id: ${agId}`, ...(finalUrl ? [`final_url: ${finalUrl}`] : [])];

    // 1. No CTA verb anywhere in ad copy.
    if (!AD_CTA_VERBS.test(allText)) {
      out.push({
        id: `copy-no-cta-${ad.adId}`,
        category: "copy",
        severity: "P2",
        magnitude: "medium",
        confidence: "high",
        effort: "easy",
        metric: "CTR",
        direction: "up",
        target: { type: "ad", id: String(ad.adId), name: `${agName} / ad ${ad.adId}` },
        hint:
          `No CTA verb found. Ad group: ${agName}. Current headlines: ${hlSnip}. Current descriptions: ${dsSnip}. ` +
          "Write 3-5 new headlines (<=30 chars) with CTA verbs and 2 new descriptions (<=90 chars).",
        evidence: ["no CTA verb in any headline/description", `impressions ${impr}`, `current headlines: ${hlSnip}`, ...newAdEvidence],
      });
      continue;
    }

    // 2. No numbers in headlines.
    const headlineText = headlines.join(" ");
    if (impr > cfg.ad_min_impr && !/\d+/.test(headlineText)) {
      out.push({
        id: `copy-no-numbers-${ad.adId}`,
        category: "copy",
        severity: "P3",
        magnitude: "low",
        confidence: "medium",
        effort: "easy",
        metric: "CTR",
        direction: "up",
        target: { type: "ad", id: String(ad.adId), name: `${agName} / ad ${ad.adId}` },
        hint:
          `No numbers in headlines. Ad group: ${agName}. Current headlines: ${hlSnip}. ` +
          "Rewrite 3-5 headlines to include specific numbers (price, %, count, days) for credibility.",
        evidence: ["no digits in any headline", `impressions ${impr}`, `current headlines: ${hlSnip}`, ...newAdEvidence],
      });
      continue;
    }

    // 3. Low CTR vs ad-group median.
    const medCtr = agMedianCtr[agId] || 0;
    if (impr >= cfg.ad_min_impr && medCtr > 0 && adCtr < cfg.ad_ctr_floor_ratio * medCtr) {
      out.push({
        id: `low-ctr-ad-${ad.adId}`,
        category: "copy",
        severity: "P2",
        magnitude: "medium",
        confidence: "medium",
        effort: "easy",
        metric: "CTR",
        direction: "up",
        target: { type: "ad", id: String(ad.adId), name: `${agName} / ad ${ad.adId}` },
        hint:
          `CTR ${(adCtr * 100).toFixed(2)}% is below ${(cfg.ad_ctr_floor_ratio * 100).toFixed(0)}% of ad-group median ${(medCtr * 100).toFixed(2)}%. ` +
          `Ad group: ${agName}. Current headlines: ${hlSnip}. Propose copy that better matches search intent.`,
        evidence: [
          `ad CTR ${(adCtr * 100).toFixed(2)}%`,
          `ad-group median CTR ${(medCtr * 100).toFixed(2)}%`,
          `impressions ${impr}`,
          `current headlines: ${hlSnip}`,
          ...newAdEvidence,
        ],
      });
      continue;
    }

    // 4. Ad-group keyword mismatch: no token from agName appears in any headline.
    if (agName && impr > cfg.ad_min_impr) {
      const agTokens = agName
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 3);
      const hlLower = headlineText.toLowerCase();
      const hasMatch = agTokens.some((tok) => hlLower.includes(tok));
      if (!hasMatch && agTokens.length > 0) {
        out.push({
          id: `copy-kw-mismatch-${ad.adId}`,
          category: "copy",
          severity: "P2",
          magnitude: "medium",
          confidence: "low",
          effort: "easy",
          metric: "CTR",
          direction: "up",
          target: { type: "ad", id: String(ad.adId), name: `${agName} / ad ${ad.adId}` },
          hint:
            `Message-match gap: ad-group "${agName}" has no matching keyword in headlines. Current headlines: ${hlSnip}. ` +
            "Rewrite to include the ad group theme in at least 1-2 headlines for QS alignment.",
          evidence: [`ad-group: ${agName}`, "no agName token found in headlines", `impressions ${impr}`, `current headlines: ${hlSnip}`, ...newAdEvidence],
        });
        continue;
      }
    }

    // 5. Headline-copy fatigue: >2 headlines share the same 3-gram.
    if (headlines.length >= 3) {
      const trigramCounts: Record<string, number> = {};
      for (const h of headlines) {
        const words = h.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
        for (let wi = 0; wi <= words.length - 3; wi++) {
          const tri = `${words[wi]} ${words[wi + 1]} ${words[wi + 2]}`;
          trigramCounts[tri] = (trigramCounts[tri] || 0) + 1;
        }
      }
      const dupTri = Object.keys(trigramCounts).filter((k) => trigramCounts[k] > 2);
      if (dupTri.length > 0) {
        out.push({
          id: `copy-headline-fatigue-${ad.adId}`,
          category: "copy",
          severity: "P3",
          magnitude: "low",
          confidence: "medium",
          effort: "easy",
          metric: "CTR",
          direction: "up",
          target: { type: "ad", id: String(ad.adId), name: `${agName} / ad ${ad.adId}` },
          hint:
            `Headline fatigue: 3-gram "${dupTri[0]}" repeats in 3+ headlines. Ad group: ${agName}. Current headlines: ${hlSnip}. ` +
            "Replace the repetitive headlines with diverse angles (different value props, CTAs, specifics).",
          evidence: [
            `repeated 3-gram: "${dupTri[0]}" (${trigramCounts[dupTri[0]]} times)`,
            `${headlines.length} total headlines`,
            `current headlines: ${hlSnip}`,
            ...newAdEvidence,
          ],
        });
      }
    }
  }

  return out;
}
