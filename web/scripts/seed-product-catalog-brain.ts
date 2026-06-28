/**
 * seed-product-catalog-brain.ts — seeds `products`-category Brain entries with
 * real per-product facts (exact names, prices, pack sizes, ingredients,
 * certifications) pulled directly from baidyanath.com product pages.
 *
 * Why this exists: copy-writing analysts (audienceCopyAnalyst.ts,
 * qualityStructureAnalyst.ts) previously only saw whatever fragments were in
 * collected ad data (ad group names, current headlines, final_urls) — never
 * the product itself. That's the other half of why copy defaulted to generic
 * brand boilerplate instead of citing a real ingredient or price point.
 *
 * Scoped to the 12 products currently being advertised (found via distinct
 * ad final_urls) — not the full 146-SKU catalog, since those are the only
 * ones any analyst's copy actually needs to reference today. Re-run this
 * script (or add more entries the same way) if new products start being
 * advertised.
 *
 * Run: npx tsx --require ./scripts/load-env.cjs scripts/seed-product-catalog-brain.ts
 */

import { db } from "@/db";
import { brainEntries } from "@/db/schema";

if (!db) {
  console.error("DATABASE_URL not configured");
  process.exit(1);
}

const entries = [
  {
    id: "brain_product_001",
    title: "Kesari Kalp Royal Chyawanprash — gold/silver/saffron formulation",
    summary:
      "Premium Chyawanprash variant (500gm/1kg, also combo with Madhu honey) enriched with Gold, Silver & Kashmiri " +
      "Saffron plus Swarna Bhasm (gold ash), Amla, Haritaki, Giloy, Ashwagandha, Pippali, Dalchini. ₹339 (1kg, MRP " +
      "₹417, 18% off). GMP-certified, 112 reviews/80% five-star.",
    keyPoints: [
      "Differentiator vs a plain Chyawanprash: named precious-metal ingredients (gold, silver, saffron) — a premium tier, not the everyday SKU",
      "Real claims: powerful antioxidant, boosts immunity/energy, nourishes cells/tissues, supports focus/cognition, promotes youthfulness",
      "Variants: 500gm, 1kg, and a 500gm Chyawanprash + 500gm Madhu (honey) combo",
      "Price/value angle available: ₹339 vs ₹417 MRP (18% off) — concrete, not vague 'best price'",
    ],
    rawText:
      "URL: baidyanath.com/products/baidyanath-kesari-kalp-royal-ayurvedic-chyawanprash... | MRP ₹417, sale ₹339 | " +
      "Ingredients: Gold, Silver, Kashmiri Saffron, Amla, Haritaki, Giloy, Ashwagandha, Pippali, Dalchini, Swarna Bhasm | GMP-certified.",
  },
  {
    id: "brain_product_002",
    title: "Premium Desi Cow Ghee (900ml) vs Premium Bengali Cow Ghee (450ml)",
    summary:
      "Two distinct ghee SKUs, not one product: Desi Cow Ghee (900ml, ₹599, general Ayurvedic/digestive framing — " +
      "balances Vata/Pitta, used in Panchakarma) and Bengali Cow Ghee (450ml, ₹369, regional 'rich aroma, grainy " +
      "texture' angle). Both single-ingredient (cow milk fat), GMP-certified, 'Since 1917'.",
    keyPoints: [
      "DO NOT write the same description for both ghee products — Desi is the general/Ayurvedic-benefit angle, Bengali is the regional texture/aroma angle",
      "Desi Cow Ghee (900ml, ₹599/₹669 MRP): energy, immunity, eye health (traditional), Vata/Pitta balance, Panchakarma use",
      "Bengali Cow Ghee (450ml, ₹369/₹398 MRP): distinct 'rich aroma, grainy texture', immunity & digestion, vitamin A",
      "Both: GMP-certified, made from indigenous cow milk, slow-cooked traditional method",
    ],
    rawText:
      "Desi: baidyanath.com/products/baidyanath-premium-desi-cow-ghee, 900ml, MRP ₹669 sale ₹599. " +
      "Bengali: baidyanath.com/products/baidyanath-premium-bengali-cow-ghee..., 450ml, MRP ₹398 sale ₹369.",
  },
  {
    id: "brain_product_003",
    title: "Vita-Ex Gold (17-herb) vs Vita-Ex Gold Plus — men's vitality capsules",
    summary:
      "Two related but distinct men's-vitality products. Vita-Ex Gold (₹508/₹530 MRP): 17 named herbs & minerals " +
      "(Kaunch Beej, Shodhit Shilajit, Safed Musli, Ashwagandha, Swarna Bhasma, Kesar, etc.) for strength/energy/" +
      "stress relief. Vita-Ex Gold Plus (20 capsules, ₹739/₹915 MRP, 4.9-star rating): positioned for strength & " +
      "endurance, sold standalone or as an oil+capsule combo.",
    keyPoints: [
      "Vita-Ex Gold's real differentiator is the 17-ingredient list by name (Kaunch Beej, Shilajit, Safed Musli, Ashwagandha, gold/saffron) — cite specific herbs, not 'Ayurvedic formula'",
      "Vita-Ex Gold Plus is the higher tier (20-capsule pack, ₹739) — frame as the upgraded/combo option vs the base Gold",
      "Use-case: daily strength/energy, physical performance, stress relief — not the same use-case as Kamini Vidrawan Ras (see brain_product_004), don't conflate the two men's-health products",
    ],
    rawText:
      "Vita-Ex Gold: baidyanath.com/products/vita-ex-gold, sale ₹508, MRP ₹530. 17 ingredients incl. Kaunch Beej, " +
      "Shodhit Shilajit, Safed Musli, Ashwagandha, Purified Kuchla, Vang Bhasma, Kesar, Swarna Bhasma. " +
      "Vita-Ex Gold Plus: baidyanath.com/products/vita-ex-gold-plus-10cp, 20 capsules, sale ₹739, MRP ₹915, 4.9 stars.",
  },
  {
    id: "brain_product_004",
    title: "Kaminividrawan Ras (Kesar Yukta) — men's vitality/libido, real product page differs from current ad URL",
    summary:
      "₹1,499 (MRP ₹1,998, 24% off), 5gm/10gm packs. Ingredients: Akarkara, Sonth, Kesar, Pipal, Jaiphal, Lawang, " +
      "Javitri, Chandan. Positioned for libido/vigor support, framed as an aphrodisiac and alterative tonic — must " +
      "take under physician supervision (not for self-medication claims in copy).",
    keyPoints: [
      "OPERATIONAL NOTE (not a copy fact): the actual product page is baidyanath.com/products/baidyanath-kaminividrawan-ras-kesar-yukta-helps-maintain-vigour-and-vitality-5-gms — at least one ad currently links to a SEARCH RESULTS page (baidyanath.com/search?q=kaminividrawan+ras) instead of this product page, a landing-page-quality issue worth fixing separately from copy",
      "Real ingredients to cite: Akarkara, Sonth, Kesar (saffron), Pipal, Jaiphal, Lawang, Javitri, Chandan — not generic 'classical Ayurvedic formulation'",
      "Price/value: ₹1,499 vs ₹1,998 MRP is a real, citable 24% discount",
      "Caution: this is a sensitive-health-category product — avoid explicit/exaggerated claims, the brand's own page recommends physician supervision",
    ],
    rawText:
      "URL: baidyanath.com/products/baidyanath-kaminividrawan-ras-kesar-yukta-helps-maintain-vigour-and-vitality-5-gms. " +
      "MRP ₹1998, sale ₹1499. Ingredients: Akarkara, Sonth, Kesar, Pipal, Jaiphal, Lawang, Javitri, Chandan, Hingul, Sulphur opium.",
  },
  {
    id: "brain_product_005",
    title: "Amla / Triphala juices, Isabgol variants, Ajwain Ark, Madhu honey, Bhringraj shampoo",
    summary:
      "Digestive/wellness range with concrete, citable facts: Triphala Juice (1L, ₹253, Amla+Harad+Baheda+Aloe Vera, " +
      "ISO 9001 certified) for gut/detox; Isabgol Orange Lax (250g, ₹339/₹399, psyllium husk) for overnight " +
      "constipation relief with cholesterol/gas benefits; Ajwain Ark (225ml, ₹80) as a post-meal digestive aid; " +
      "Madhu raw honey (500gm/1kg, ₹210/₹240, eucalyptus & litchi nectar, no added sugar) as an immunity booster and " +
      "sugar substitute; Bhringraj Shampoo (200ml, ₹229/₹266, Bhringraj+Amla+Reetha+Shikakai, paraben/SLS-free) for " +
      "hair fall and dandruff.",
    keyPoints: [
      "Triphala Juice: cite 'Amla, Harad, Baheda, Aloe Vera' and 'ISO 9001:2015 certified' — not generic 'herbal juice'",
      "Isabgol Orange Lax: differentiate from plain Isabgol via the orange flavour + 'overnight' positioning + cholesterol/gas relief claims",
      "Ajwain Ark: cheapest SKU in this set (₹80) — a low-commitment trial/upsell product, post-meal use-case specifically",
      "Madhu honey: 'no added sugar', eucalyptus/litchi floral source, sugar-substitute angle — distinct from the immunity-juice products",
      "Bhringraj Shampoo: name the 4 herbs (Bhringraj, Amla, Reetha, Shikakai) and 'paraben/SLS-free' — hair fall + dandruff are the two concerns it actually addresses, not generic 'hair care'",
    ],
    rawText:
      "Triphala Juice ₹253/1L. Isabgol Orange Lax ₹339 (MRP ₹399)/250g. Ajwain Ark ₹80/225ml. Madhu ₹210 (MRP ₹240)/500gm. " +
      "Bhringraj Shampoo ₹229 (MRP ₹266)/200ml. All GMP-certified, 'Trusted Ayurveda since 1917'.",
  },
  {
    id: "brain_product_006",
    title: "Baidyanath's own catalog taxonomy — 146 products, organized by type AND by health concern",
    summary:
      "The brand's own site organizes its 146-product catalog two ways: by product TYPE (Chyawanprash, Juices, " +
      "Capsules, Tablets, Ras-Rasayan, Medicated Oils/Ghritas, Churans, etc.) and by health CONCERN (Immunity " +
      "Booster, Men's Health, Women's Health, Hair Care, Digestive Care, Diabetic Care, Stress Relief, Kids " +
      "Wellness, Cardiac Care, Pain Relief, Weight Management, Memory & Brain Power, Skin Care, Oral Care, Elderly " +
      "Care, Cough & Cold Relief). Free shipping above ₹599, COD available sitewide.",
    keyPoints: [
      "When writing sitelinks/callouts for ANY campaign, the 'Shop By Concern' categories are a ready-made source of specific, non-generic sitelink ideas (e.g. 'Men's Health', 'Hair Care', 'Digestive Care') instead of a vague 'Shop Now'",
      "This matches the competitive insight that Kapiva wins on condition-led framing (brain_competitive_003) — Baidyanath's own catalog ALREADY supports that framing, it's just not being used in ad copy yet",
      "Sitewide trust signals usable in callouts: Free Shipping Above ₹599, COD Available — concrete and verifiable, better than a generic trust claim",
    ],
    rawText:
      "baidyanath.com/collections/baidyanath — 146 products. Shop By Product: Ark & Syrups, Asava & Aristhas, Bati, " +
      "Bhasma & Pishti, Churans, Chyawanprash, Capsules, Tablets, Juices, Food & Nutrition, Gold Medicines, Guggulu, " +
      "Medicated Ghritas, Medicated Oils, Ras-Rasayan. Shop By Concern: Cardiac, Cough & Cold, Diabetic, Digestive, " +
      "Elderly, Hair, Immunity, Oral, Pain Relief, Kids, Memory & Brain, Men's Health, Skin, Stress, Weight, Women's Health.",
  },
];

async function main() {
  for (const entry of entries) {
    await db!
      .insert(brainEntries)
      .values({
        id: entry.id,
        category: "products" as never,
        source: "web research: baidyanath.com product pages (June 2026)",
        sourceType: "manual" as never,
        dateAdded: "2026-06-23",
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
  console.log(`\nDone. Seeded ${entries.length} 'products' category Brain entries.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
