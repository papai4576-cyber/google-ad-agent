import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  date,
} from "drizzle-orm/pg-core";

/* ============================================================
 * Raw snapshots — replaced wholesale on each collect run
 * ============================================================ */

export const campaigns = pgTable("campaigns", {
  campaignId: text("campaign_id").primaryKey(),
  runDate: date("run_date").notNull(),
  campaignName: text("campaign_name").notNull(),
  status: text("status").notNull(),
  channelType: text("channel_type"),
  biddingStrategy: text("bidding_strategy"),
  targetCpaMicros: bigint("target_cpa_micros", { mode: "number" }),
  targetRoas: doublePrecision("target_roas"),
  budgetMicros: bigint("budget_micros", { mode: "number" }),
  impressions: bigint("impressions", { mode: "number" }).default(0),
  clicks: bigint("clicks", { mode: "number" }).default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).default(0),
  conversions: doublePrecision("conversions").default(0),
  conversionValue: doublePrecision("conversion_value").default(0),
  ctr: doublePrecision("ctr"),
  avgCpcMicros: bigint("avg_cpc_micros", { mode: "number" }),
  searchIs: doublePrecision("search_is"),
  searchBudgetLostIs: doublePrecision("search_budget_lost_is"),
  searchRankLostIs: doublePrecision("search_rank_lost_is"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const campaignsDaily = pgTable(
  "campaigns_daily",
  {
    campaignId: text("campaign_id").notNull(),
    date: date("date").notNull(),
    runDate: date("run_date").notNull(),
    campaignName: text("campaign_name").notNull(),
    impressions: bigint("impressions", { mode: "number" }).default(0),
    clicks: bigint("clicks", { mode: "number" }).default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).default(0),
    conversions: doublePrecision("conversions").default(0),
    conversionValue: doublePrecision("conversion_value").default(0),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.date] })]
);

export const adGroups = pgTable("ad_groups", {
  adGroupId: text("ad_group_id").primaryKey(),
  runDate: date("run_date").notNull(),
  adGroupName: text("ad_group_name").notNull(),
  status: text("status").notNull(),
  campaignId: text("campaign_id").notNull(),
  cpcBidMicros: bigint("cpc_bid_micros", { mode: "number" }),
  targetCpaMicros: bigint("target_cpa_micros", { mode: "number" }),
  impressions: bigint("impressions", { mode: "number" }).default(0),
  clicks: bigint("clicks", { mode: "number" }).default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).default(0),
  conversions: doublePrecision("conversions").default(0),
  conversionValue: doublePrecision("conversion_value").default(0),
  avgQualityScore: doublePrecision("avg_quality_score"),
});

export const keywords = pgTable("keywords", {
  keywordId: text("keyword_id").primaryKey(),
  runDate: date("run_date").notNull(),
  text: text("text").notNull(),
  matchType: text("match_type"),
  status: text("status").notNull(),
  campaignId: text("campaign_id").notNull(),
  campaignName: text("campaign_name").notNull(),
  adGroupId: text("ad_group_id").notNull(),
  adGroupName: text("ad_group_name").notNull(),
  cpcBidMicros: bigint("cpc_bid_micros", { mode: "number" }),
  qualityScore: integer("quality_score"),
  creativeQuality: text("creative_quality"),
  postClickQuality: text("post_click_quality"),
  searchPredictedCtr: text("search_predicted_ctr"),
  impressions: bigint("impressions", { mode: "number" }).default(0),
  clicks: bigint("clicks", { mode: "number" }).default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).default(0),
  conversions: doublePrecision("conversions").default(0),
  conversionValue: doublePrecision("conversion_value").default(0),
  ctr: doublePrecision("ctr"),
  avgCpcMicros: bigint("avg_cpc_micros", { mode: "number" }),
});

export const ads = pgTable("ads", {
  adId: text("ad_id").primaryKey(),
  runDate: date("run_date").notNull(),
  status: text("status").notNull(),
  approvalStatus: text("approval_status"),
  adGroupId: text("ad_group_id").notNull(),
  adGroupName: text("ad_group_name").notNull(),
  campaignId: text("campaign_id").notNull(),
  headlines: jsonb("headlines").$type<string[]>().default([]),
  descriptions: jsonb("descriptions").$type<string[]>().default([]),
  finalUrls: jsonb("final_urls").$type<string[]>().default([]),
  impressions: bigint("impressions", { mode: "number" }).default(0),
  clicks: bigint("clicks", { mode: "number" }).default(0),
  costMicros: bigint("cost_micros", { mode: "number" }).default(0),
  conversions: doublePrecision("conversions").default(0),
  ctr: doublePrecision("ctr"),
  avgCpcMicros: bigint("avg_cpc_micros", { mode: "number" }),
});

export const searchTerms = pgTable(
  "search_terms",
  {
    runDate: date("run_date").notNull(),
    term: text("term").notNull(),
    status: text("status"),
    campaignId: text("campaign_id").notNull(),
    campaignName: text("campaign_name").notNull(),
    adGroupId: text("ad_group_id").notNull(),
    adGroupName: text("ad_group_name").notNull(),
    impressions: bigint("impressions", { mode: "number" }).default(0),
    clicks: bigint("clicks", { mode: "number" }).default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).default(0),
    conversions: doublePrecision("conversions").default(0),
    ctr: doublePrecision("ctr"),
    avgCpcMicros: bigint("avg_cpc_micros", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.term, t.adGroupId] })]
);

export const extensions = pgTable("extensions", {
  extensionId: text("extension_id").primaryKey(),
  runDate: date("run_date").notNull(),
  type: text("type").notNull(),
  campaignId: text("campaign_id"),
  adGroupId: text("ad_group_id"),
  text: text("text"),
  status: text("status"),
  impressions: bigint("impressions", { mode: "number" }).default(0),
  clicks: bigint("clicks", { mode: "number" }).default(0),
  ctr: doublePrecision("ctr"),
});

export const negativeKeywords = pgTable("negative_keywords", {
  id: text("id").primaryKey(),
  runDate: date("run_date").notNull(),
  scope: text("scope").notNull(),
  campaignId: text("campaign_id"),
  campaignName: text("campaign_name"),
  adGroupId: text("ad_group_id"),
  adGroupName: text("ad_group_name"),
  sharedSetId: text("shared_set_id"),
  sharedSetName: text("shared_set_name"),
  text: text("text").notNull(),
  matchType: text("match_type").notNull(),
});

/* ============================================================
 * Agent layer
 * ============================================================ */

export const findings = pgTable("findings", {
  id: text("id").primaryKey(),
  runDate: date("run_date").notNull(),
  mode: text("mode").notNull(),
  agent: text("agent").notNull(),
  findingId: text("finding_id").notNull(),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  what: text("what").notNull(),
  why: text("why").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  targetName: text("target_name"),
  impactMetric: text("impact_metric"),
  impactDirection: text("impact_direction"),
  impactMagnitude: text("impact_magnitude"),
  confidence: text("confidence"),
  effort: text("effort"),
  evidence: jsonb("evidence").$type<string[]>().default([]),
  brainSources: jsonb("brain_sources").$type<string[]>().default([]),
  score: doublePrecision("score"),
  status: text("status").default("new"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const actionPlan = pgTable("action_plan", {
  planId: text("plan_id").primaryKey(),
  runDate: date("run_date").notNull(),
  findingId: text("finding_id").notNull(),
  priority: text("priority").notNull(),
  title: text("title").notNull(),
  what: text("what").notNull(),
  why: text("why").notNull(),
  action: text("action").notNull(),
  actionCategory: text("action_category").notNull(),
  actionType: text("action_type").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  targetName: text("target_name"),
  score: doublePrecision("score").notNull(),
  status: text("status").default("pending").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  planId: text("plan_id").notNull(),
  findingId: text("finding_id"),
  status: text("status").notNull(),
  userId: text("user_id"),
  notes: text("notes"),
});

export const pendingChanges = pgTable("pending_changes", {
  changeId: text("change_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  runDate: date("run_date").notNull(),
  planId: text("plan_id").notNull(),
  findingId: text("finding_id"),
  changeType: text("change_type").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  targetName: text("target_name"),
  field: text("field"),
  beforeValue: text("before_value"),
  afterValue: text("after_value"),
  params: jsonb("params"),
  status: text("status").default("queued").notNull(),
  dryRun: boolean("dry_run").default(false).notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  result: text("result"),
  error: text("error"),
});

export const changeLog = pgTable("change_log", {
  id: text("id").primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  planId: text("plan_id"),
  findingId: text("finding_id"),
  agent: text("agent").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  targetName: text("target_name"),
  fieldChanged: text("field_changed"),
  beforeValue: text("before_value"),
  afterValue: text("after_value"),
  dryRun: boolean("dry_run").default(false).notNull(),
  success: boolean("success").notNull(),
  errorMessage: text("error_message"),
});

export const brainEntries = pgTable("brain_entries", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  source: text("source"),
  sourceType: text("source_type"),
  dateAdded: date("date_added").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  keyPoints: jsonb("key_points").$type<string[]>().default([]),
  rawText: text("raw_text"),
});

export const config = pgTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tokenUsage = pgTable(
  "token_usage",
  {
    date: date("date").notNull(),
    provider: text("provider").notNull(),
    totalTokens: bigint("total_tokens", { mode: "number" }).default(0),
    requests: integer("requests").default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.provider] })]
);
