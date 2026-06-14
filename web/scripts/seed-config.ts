import { db } from "@/db";
import { config } from "@/db/schema";

const DEFAULT_CONFIG = [
  // Performance & Budget Thresholds
  {
    key: "RULE_BUDGET_LOST_IS",
    value: "0.30",
    description:
      "Budget-capped threshold (impression share lost due to budget)",
  },
  {
    key: "RULE_RANK_LOST_IS",
    value: "0.40",
    description: "Rank-capped threshold (impression share lost due to rank)",
  },
  {
    key: "RULE_PERF_SPEND_FLOOR",
    value: "5000",
    description: "Minimum spend (micros) to flag zero-conversion campaigns",
  },
  {
    key: "RULE_CPA_OVERAGE_RATIO",
    value: "1.5",
    description: "CPA multiple above target to flag overage",
  },
  {
    key: "RULE_ROAS_SHORTFALL_RATIO",
    value: "0.70",
    description: "ROAS fraction below target to flag shortfall",
  },
  {
    key: "RULE_MIN_CONV_ROAS",
    value: "50",
    description: "Minimum conversions for tROAS to be trustworthy",
  },
  {
    key: "RULE_MIN_CONV_CPA",
    value: "30",
    description: "Minimum conversions for tCPA to be trustworthy",
  },
  {
    key: "RULE_IDLE_SPEND_RATIO",
    value: "0.50",
    description: "Idle budget detection threshold",
  },
  {
    key: "RULE_PACING_TOLERANCE",
    value: "0.30",
    description: "Budget pacing tolerance (±30% out-of-bounds)",
  },
  {
    key: "RULE_CAPPED_UNDERPERF_IS",
    value: "0.20",
    description:
      "Budget-capped AND ROAS underperforming threshold (both conditions)",
  },
  {
    key: "RULE_CTR_FLOOR_RATIO",
    value: "0.40",
    description: "CTR vs channel median floor (flag if below 40% of median)",
  },

  // Quality & Structure Thresholds
  {
    key: "RULE_QS_MIN_COST",
    value: "5",
    description: "Minimum spend (micros) to flag low Quality Score",
  },
  {
    key: "RULE_QS_MAX",
    value: "5",
    description: "Quality Score at or below this = low",
  },
  {
    key: "RULE_QS_P1_COST",
    value: "50",
    description: "Spend above this = P1 priority for low QS",
  },
  {
    key: "RULE_MAX_ADGROUPS_PER_CAMPAIGN",
    value: "30",
    description: "Maximum ad groups per campaign",
  },
  {
    key: "RULE_MAX_KEYWORDS_PER_ADGROUP",
    value: "20",
    description: "Maximum keywords per ad group",
  },
  {
    key: "RULE_MIN_ACTIVE_ADS",
    value: "2",
    description: "Minimum active ads per ad group (safety rail)",
  },
  {
    key: "RULE_MIN_SPEND_CONCENTRATION",
    value: "1000",
    description: "Single ad group spend threshold for concentration risk",
  },

  // Audience & Copy Thresholds
  {
    key: "RULE_BRAND_ROAS_MULTIPLIER",
    value: "3.0",
    description: "Brand vs non-brand ROAS gap multiplier",
  },
  {
    key: "RULE_AD_CTR_FLOOR_RATIO",
    value: "0.40",
    description:
      "Ad CTR vs ad-group median floor (flag if below 40% of median)",
  },
  {
    key: "RULE_AD_MIN_IMPR",
    value: "200",
    description: "Minimum impressions for ad CTR comparison",
  },
  {
    key: "RULE_RLSA_MIN_CLICKS",
    value: "300",
    description: "Minimum clicks floor for RLSA flag",
  },
  {
    key: "RULE_LOOKALIKE_MIN_CONV",
    value: "30",
    description: "Minimum conversions for lookalike seeding",
  },
  {
    key: "RULE_AUDIENCE_SHOP_SPEND",
    value: "5000",
    description: "Shopping spend threshold for Customer Match flag",
  },

  // Brand Keywords (optional, comma-separated)
  {
    key: "BRAND_KEYWORDS",
    value: "",
    description:
      "Comma-separated brand keywords (e.g., 'nike,adidas') for campaign classification",
  },

  // Implementation & Safety Rails
  {
    key: "DRY_RUN",
    value: "true",
    description:
      "If true, log changes but don't apply them. Set to false to enable real changes.",
  },
  {
    key: "MAX_BUDGET_SHIFT_PCT",
    value: "20",
    description: "Max budget change per run (percentage)",
  },
  {
    key: "NEGATIVE_KW_MIN_WASTE",
    value: "10",
    description: "Minimum cost (micros) to consider a search term for blocking",
  },
  {
    key: "NEGATIVE_MAX_PER_RUN",
    value: "10",
    description: "Maximum negative keywords added per run",
  },

  // Landing Page Scorer Limits
  {
    key: "LP_MAX_PAGES",
    value: "10",
    description: "Maximum landing pages to fetch and score per run",
  },
  {
    key: "LP_SLOW_RESPONSE_MS",
    value: "3000",
    description: "Landing page response time threshold (ms)",
  },
  {
    key: "LP_HEAVY_BYTES",
    value: "500000",
    description: "Landing page size threshold (bytes)",
  },

  // API & LLM Limits
  {
    key: "GROQ_DAILY_TOKEN_CEILING",
    value: "5000000",
    description: "Daily token usage ceiling for Groq API",
  },
];

async function seedConfig() {
  if (!db) {
    console.error("❌ DATABASE_URL not configured");
    process.exit(1);
  }

  try {
    console.log("🌱 Seeding config table...");

    for (const entry of DEFAULT_CONFIG) {
      await db
        .insert(config)
        .values({
          key: entry.key,
          value: entry.value,
          description: entry.description,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: config.key,
          set: {
            description: entry.description,
            updatedAt: new Date(),
          },
        });

      console.log(`  ✓ ${entry.key}`);
    }

    console.log(
      `\n✅ Seeded ${DEFAULT_CONFIG.length} config entries successfully!\n`
    );
    console.log("📊 Go to http://localhost:3000/config to view and edit them.");
  } catch (error) {
    console.error("❌ Seed failed:", error);
    process.exit(1);
  }
}

seedConfig();
