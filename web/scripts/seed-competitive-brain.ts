/**
 * seed-competitive-brain.ts — adds real competitive-intelligence Brain entries
 * (researched via web search: Dabur, Patanjali, Kapiva/Himalaya positioning in
 * the Indian Ayurvedic/wellness market) and fixes the existing brain_baidyanath_004
 * "copy" entry, which gave the LLM verbatim example phrases ("100 Years of Trust",
 * "Trusted by Millions", "Authentic Ayurveda Since 1917") that it was copying
 * near-literally into every ad instead of treating as illustrative structure only.
 *
 * Run: npx tsx --require ./scripts/load-env.cjs scripts/seed-competitive-brain.ts
 */

import { db } from "@/db";
import { brainEntries } from "@/db/schema";
import { eq } from "drizzle-orm";

if (!db) {
  console.error("DATABASE_URL not configured");
  process.exit(1);
}

async function main() {
  // 1. Fix the existing copy entry — remove verbatim phrase examples, keep structural guidance only.
  await db!
    .update(brainEntries)
    .set({
      summary:
        "RSAs should have 8-15 headlines with diverse themes: brand authority, product-specific benefit, " +
        "social proof, price/offer/urgency, and a CTA. Avoid pinning headlines unless legally required. " +
        "Healthcare copy must avoid medical claims — say 'supports immunity' not 'cures'. Never reuse the same " +
        "headline/description wording across two different products — ground every headline in the SPECIFIC " +
        "product it's for, not a generic brand tagline.",
      keyPoints: [
        "Headline themes to cover: brand trust, PRODUCT-SPECIFIC benefit (not a generic wellness claim), social proof, price/offer, and CTA",
        "Avoid medical claims (cures, treats, prevents) — use 'supports', 'helps', 'promotes'",
        "Include the actual product name in at least 2 headlines for relevance",
        "Never reuse the same brand-tagline phrase (e.g. a founding year or trust claim) across more than one ad in a batch — it reads as templated, not authentic",
        "Low CTR ads (<40% of ad group median) should be paused and replaced after >=200 impressions",
      ],
    })
    .where(eq(brainEntries.id, "brain_baidyanath_004"));
  console.log("Updated brain_baidyanath_004 (removed verbatim phrase examples)");

  // 2. New competitive entries, grounded in real research (sources noted in raw_text).
  const entries = [
    {
      id: "brain_competitive_001",
      category: "competitive",
      source: "web research: dabur.com, daburchyawanprash.com, 1mg.com (June 2026)",
      sourceType: "manual",
      dateAdded: "2026-06-22",
      title: "Dabur Chyawanprash positioning — herb-count and immunity-multiplier claims",
      summary:
        "Dabur is the category leader (~60% market share) and leads on scale/authority claims: '41 Ayurvedic " +
        "herbs', '2X/3X Immunity', 'clinically tested', and named hero ingredients (Amla, Giloy, Ashwagandha, " +
        "Shatavari, Mulethi, Pippali). Pricing is framed with visible discount percentages (e.g. ₹895 -> ₹672).",
      keyPoints: [
        "Dabur's headline angle is QUANTIFIED scale: herb count, immunity multiplier (2X/3X), clinical testing — not vague wellness language",
        "Dabur names specific hero ingredients by name rather than saying 'Ayurvedic formula' generically",
        "Dabur surfaces discount % prominently — Baidyanath should consider showing a concrete price/value comparison where one exists, not just 'best price'",
        "Copy implication: don't compete with Dabur on 'biggest scale' claims (they own that) — Baidyanath's differentiator is 1917 heritage + classical/authentic formulation, a credibility angle Dabur's mass-market positioning doesn't claim",
      ],
      rawText:
        "Dabur Chyawanprash: first branded Chyawanprash in India, >60% market share, 41-herb formulation, " +
        "2X/3X immunity claim, clinically tested. Key ingredients called out by name: Amla (antioxidant), " +
        "Pippali (respiratory), Ashwagandha (energy), Shatavari & Mulethi (strength), Giloy (immunity). " +
        "Pricing shown with explicit discount (e.g. 2kg jar ₹895 MRP, ₹672 sale price).",
    },
    {
      id: "brain_competitive_002",
      category: "competitive",
      source: "web research: Patanjali marketing case studies, patanjaliayurvedus.com (June 2026)",
      sourceType: "manual",
      dateAdded: "2026-06-22",
      title: "Patanjali positioning — swadeshi, lowest price, no-chemicals, sugar-free variant",
      summary:
        "Patanjali competes almost entirely on price and 'swadeshi' (Indian-made) nationalism, plus 'no chemicals/" +
        "preservatives' clean-label cues. They also offer a no-added-sugar Chyawanprash variant targeting health-" +
        "conscious/diabetic-adjacent buyers — a concrete product-line differentiation, not just a tagline.",
      keyPoints: [
        "Patanjali's core angle: lowest price + Indian-made (swadeshi) + no chemicals/preservatives — a values-and-price play, not a heritage play",
        "Patanjali has a dedicated no-added-sugar variant as a distinct product/USP — Baidyanath should check if it has (or should call out) sugar-free/diabetic-friendly variants instead of leaving that white space to Patanjali",
        "Copy implication: don't try to out-price Patanjali — they win on price by design. Baidyanath should compete on authenticity/heritage/trust, the dimension Patanjali's mass-discount positioning doesn't own",
      ],
      rawText:
        "Patanjali Ayurved: founded by Baba Ramdev, positions on swadeshi (Indian-made), low price, natural/" +
        "herbal with no chemicals or preservatives, farmer-sourcing and domestic-manufacturing pride narrative. " +
        "Sells a Chyawanprabha Advanced (No Added Sugar) variant explicitly for sugar-conscious buyers.",
    },
    {
      id: "brain_competitive_003",
      category: "competitive",
      source: "web research: Kapiva, Himalaya Wellness brand coverage (June 2026)",
      sourceType: "manual",
      dateAdded: "2026-06-22",
      title: "Kapiva / Himalaya positioning — modern Ayurveda, condition-led framing, free expert consultation",
      summary:
        "Kapiva repositions Ayurveda for urban millennials with condition-led product framing (gut health, hair, " +
        "metabolic health) rather than generic 'immunity', and uses free Ayurvedic-expert consultations (80,000+/" +
        "month) as a conversion hook and trust signal. Himalaya leans on its legacy + omni-channel availability " +
        "(D2C, pharmacy, international) as the trust cue.",
      keyPoints: [
        "Kapiva frames products by SPECIFIC CONDITION/USE-CASE (gut health, hair, metabolic) rather than a blanket immunity claim — a sharper angle than generic wellness copy",
        "Kapiva's 'free expert consultation' is a concrete, differentiated CTA/sitelink idea ('Ask an Ayurvedic Expert') that's more specific than 'Shop Now'",
        "Himalaya's trust cue is omni-channel ubiquity/legacy, similar lane to Baidyanath's heritage angle — means heritage alone won't differentiate from Himalaya; pair it with something Himalaya doesn't claim (e.g. classical/traditional formulation fidelity vs Himalaya's modern-herbal-science framing)",
        "Copy implication: where Baidyanath sitelinks/callouts currently say generic things like 'Boost Immunity Naturally', a condition/use-case-specific angle (e.g. naming the actual ailment or audience a product addresses) reads as more credible and differentiated, matching how Kapiva frames its range",
      ],
      rawText:
        "Kapiva: D2C Ayurvedic nutrition brand (founded 2016), repositions Ayurveda for urban millennials with " +
        "condition-led formulations (gut/hair/metabolic health), research-backed by in-house Ayurveda academy, " +
        "free expert consultations as a major engagement/conversion hook (80,000+/month). Himalaya Wellness: " +
        "legacy herbal brand, strong in skincare/child health, omni-channel D2C + pharmacy + international presence.",
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
        set: { title: entry.title, summary: entry.summary, keyPoints: entry.keyPoints, rawText: entry.rawText },
      });
    console.log(`Brain entry: ${entry.id} — ${entry.title}`);
  }

  console.log("\nDone. Fixed 1 copy entry + seeded 3 competitive entries.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
