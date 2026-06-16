/**
 * seed-brain.ts — seeds ACCOUNT_DESCRIPTION config + Brain entries for Baidyanath.
 * Run: npx tsx --require ./scripts/load-env.cjs scripts/seed-brain.ts
 */

import { db } from "@/db";
import { brainEntries, config } from "@/db/schema";

if (!db) {
  console.error("❌ DATABASE_URL not configured");
  process.exit(1);
}

async function main() {
  console.log("Seeding ACCOUNT_DESCRIPTION + Brain entries for Baidyanath...");

  // ── 1. Config: ACCOUNT_DESCRIPTION ──────────────────────────────────────
  const accountDesc =
    "Baidyanath is India's leading Ayurvedic heritage brand (100+ years) selling herbal health products " +
    "including Chyawanprash, Amla Juice, Shilajit Gold, Isabgol, KaminiVidrawan Ras, and hundreds of " +
    "classical Ayurvedic formulations. Products are sold via baidyanath.com and marketplaces. " +
    "Brand campaigns (HM_Search_Brand_*) defend navigational searches — people who already know the brand. " +
    "Non-brand campaigns (Sok_Google_Search_*) target health/wellness intent keywords (immunity, digestion, " +
    "joint pain, stamina). Primary conversion: completed online purchase. Target audience: health-conscious " +
    "Indians aged 25-55, skewing towards Tier 1-2 cities. Main competitors: Dabur, Himalaya, Zandu, Patanjali. " +
    "Currency: INR (₹).";

  await db!
    .insert(config)
    .values({ key: "ACCOUNT_DESCRIPTION", value: accountDesc, updatedAt: new Date() })
    .onConflictDoUpdate({ target: config.key, set: { value: accountDesc, updatedAt: new Date() } });

  console.log("✅ ACCOUNT_DESCRIPTION set");

  // ── 2. Brain entries ─────────────────────────────────────────────────────
  const entries = [
    {
      id: "brain_baidyanath_001",
      category: "brand",
      source: "account-setup",
      sourceType: "manual",
      dateAdded: "2026-06-17",
      title: "Baidyanath brand positioning & product portfolio",
      summary:
        "Baidyanath is India's oldest and most trusted Ayurvedic brand, founded in 1917. " +
        "Core products: Chyawanprash (flagship, seasonal demand), Amla Juice (immunity), " +
        "Shilajit Gold (men's vitality), Isabgol (digestion), Kamini Vidrawan Ras (sexual wellness), " +
        "Bhringraj Oil (hair care). Competes on trust, authenticity, and Ayurvedic heritage vs. " +
        "Dabur (mass market), Himalaya (modern Ayurveda), and Patanjali (price).",
      keyPoints: [
        "Brand = trust and authenticity — 100+ years of heritage is a key differentiator vs competitors",
        "Chyawanprash is seasonal (Oct-Mar); Amla Juice, Shilajit, and Isabgol are year-round",
        "Navigational brand searches (baidyanath, baidyanath amla juice) are the highest-intent queries",
        "Competitor conquesting by Dabur/Himalaya/Patanjali on branded terms is a persistent risk",
        "Product category pages (e.g. /products/isabgol) are key landing pages for non-brand campaigns",
      ],
      rawText: "",
    },
    {
      id: "brain_baidyanath_002",
      category: "bidding",
      source: "account-setup",
      sourceType: "manual",
      dateAdded: "2026-06-17",
      title: "Smart bidding thresholds and strategy guidance",
      summary:
        "Google's smart bidding algorithms need sufficient conversion volume to learn. " +
        "tROAS requires ≥50 conversions/month in the campaign; tCPA requires ≥30. " +
        "Below those thresholds, Maximize Conversions (no target) or eCPC is safer. " +
        "Brand campaigns typically have higher CVR and can graduate to tCPA faster than non-brand. " +
        "Budget increases should be ≤20% per change to avoid disrupting the learning phase.",
      keyPoints: [
        "tROAS: need ≥50 conv/month — below this, switch to Maximize Conversion Value",
        "tCPA: need ≥30 conv/month — below this, switch to Maximize Conversions",
        "Never change budget >20% or bids >30% in a single change — risks re-triggering learning phase",
        "Brand campaigns: higher CVR (10-30%) vs non-brand (1-5%) — set separate tCPA targets",
        "If a campaign is in learning phase (< 7 days post-change), hold off on further changes",
      ],
      rawText: "",
    },
    {
      id: "brain_baidyanath_003",
      category: "keywords",
      source: "account-setup",
      sourceType: "manual",
      dateAdded: "2026-06-17",
      title: "Keyword strategy and negative keyword framework",
      summary:
        "Brand campaigns use exact and phrase match on brand terms (baidyanath, baidyanath amla juice, etc.). " +
        "Non-brand campaigns target health/wellness intent keywords in broad or phrase match with smart bidding. " +
        "Key negative keyword themes: competitor brand names (dabur, himalaya, patanjali, zandu), " +
        "irrelevant medical queries (medicine, prescription, doctor), and non-purchase intent (wiki, side effects, " +
        "what is, meaning). Search terms report is the most valuable daily signal.",
      keyPoints: [
        "Branded exact-match keywords belong in brand campaigns only — add as negatives in non-brand",
        "Competitors (dabur, himalaya, patanjali, zandu) should be negatives in all non-brand campaigns unless running conquesting campaigns",
        "Informational intent queries (what is, meaning, wiki, side effects) rarely convert — add as negatives",
        "High-impression zero-conversion search terms after ₹500+ spend should be negated",
        "Emerging query themes (e.g. baidyanath kamini) signal new ad group opportunities",
      ],
      rawText: "",
    },
    {
      id: "brain_baidyanath_004",
      category: "copy",
      source: "account-setup",
      sourceType: "manual",
      dateAdded: "2026-06-17",
      title: "Ad copy best practices for Ayurvedic/health brands",
      summary:
        "RSAs should have 8-15 headlines with diverse themes: brand authority (100 Years of Trust), " +
        "product benefits (Boost Immunity Naturally), social proof (Trusted by Millions), urgency/offer " +
        "(Free Delivery on ₹499+), and product-specific USPs. Avoid pinning headlines unless legally required. " +
        "Healthcare copy must avoid medical claims — say 'supports immunity' not 'cures'. " +
        "CTAs: Shop Now, Buy Online, Order Today. Target Ad Strength: Excellent.",
      keyPoints: [
        "Headline themes to cover: brand trust, product benefit, social proof, price/offer, and CTA",
        "Avoid medical claims (cures, treats, prevents) — use 'supports', 'helps', 'promotes'",
        "Include product name in at least 2 headlines for relevance",
        "Descriptions: lead with the key benefit, close with a CTA and differentiator (e.g. 'Authentic Ayurveda Since 1917')",
        "Low CTR ads (<40% of ad group median) should be paused and replaced after ≥200 impressions",
      ],
      rawText: "",
    },
    {
      id: "brain_baidyanath_005",
      category: "structure",
      source: "account-setup",
      sourceType: "manual",
      dateAdded: "2026-06-17",
      title: "Campaign structure: brand vs non-brand separation",
      summary:
        "Brand campaigns (HM_Search_Brand_*) and non-brand campaigns (Sok_Google_Search_*) must be kept separate " +
        "with brand terms as negatives in non-brand campaigns. This allows independent bid strategies and budget " +
        "allocation. Brand campaigns typically 3-5x higher ROAS than non-brand. " +
        "Product-level campaigns (e.g. a campaign per product line) are preferred over single catch-all campaigns " +
        "for non-brand to allow granular budget and bidding control.",
      keyPoints: [
        "Brand terms must be negatives in all non-brand campaigns — prevents brand cannibalization",
        "Brand ROAS is typically 3-10x non-brand ROAS — never blend them in reporting",
        "Ad groups should be Single Theme Ad Groups (STAG): one keyword theme, matching ad copy",
        "Max 20 keywords per ad group — bloated ad groups dilute relevance and QS",
        "New product launches should get their own ad group before scaling to a campaign",
      ],
      rawText: "",
    },
    {
      id: "brain_baidyanath_006",
      category: "scaling",
      source: "account-setup",
      sourceType: "manual",
      dateAdded: "2026-06-17",
      title: "Budget pacing and scaling framework",
      summary:
        "Monthly budget target is set in config (monthly_budget). Budget should be front-loaded in the first " +
        "3 weeks and conserved in week 4. Campaigns losing >30% impression share to budget should be prioritised " +
        "for budget increases if they are performing at or above tCPA/tROAS targets. " +
        "Scale budgets in 15-20% increments — larger jumps trigger Google's learning phase. " +
        "Chyawanprash seasonal budget should ramp up from September and peak in November-January.",
      keyPoints: [
        "Budget-capped campaigns performing at target: increase budget up to 20% immediately",
        "Budget-capped campaigns underperforming: fix strategy/QS first, then increase budget",
        "Seasonal ramp for Chyawanprash: start increasing budgets in September, peak Oct-Jan",
        "Underpacing campaigns (spending <50% of budget with no IS loss): reallocate budget to capped campaigns",
        "Never increase total account spend >20% in a single week to avoid disrupting smart bidding",
      ],
      rawText: "",
    },
    {
      id: "brain_baidyanath_007",
      category: "landing_page",
      source: "account-setup",
      sourceType: "manual",
      dateAdded: "2026-06-17",
      title: "Landing page strategy for baidyanath.com",
      summary:
        "Key landing pages: homepage (baidyanath.com), product category pages (/products), " +
        "and individual product pages (e.g. /products/baidyanath-chyawanprash-special). " +
        "Non-brand campaigns should link to specific product pages, not the homepage. " +
        "Page speed is critical — Google's Core Web Vitals affect QS. " +
        "Pages >2MB or >3s load time are flagged for optimisation.",
      keyPoints: [
        "Non-brand ads must link to the specific product page matching the keyword theme — not homepage",
        "Homepage is for brand navigational campaigns only",
        "Page response >750ms or size >1.5MB signals optimisation opportunity",
        "Missing CTA buttons (Buy Now, Add to Cart) above the fold reduces CVR",
        "Landing page relevance directly affects Quality Score — keyword in URL and headline improves QS",
      ],
      rawText: "",
    },
  ];

  for (const entry of entries) {
    await db!
      .insert(brainEntries)
      .values({
        id: entry.id,
        category: entry.category as never,
        source: entry.source,
        sourceType: entry.sourceType as never,
        dateAdded: entry.dateAdded,
        title: entry.title,
        summary: entry.summary,
        keyPoints: entry.keyPoints,
        rawText: entry.rawText,
      })
      .onConflictDoUpdate({
        target: brainEntries.id,
        set: {
          title: entry.title,
          summary: entry.summary,
          keyPoints: entry.keyPoints,
        },
      });
    console.log(`✅ Brain entry: ${entry.id} — ${entry.title}`);
  }

  console.log("\n✅ Done. 1 config entry + 7 Brain entries seeded.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌", e);
    process.exit(1);
  });
