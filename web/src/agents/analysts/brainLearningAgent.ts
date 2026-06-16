/**
 * brainLearningAgent.ts — Autonomous Brain Learning Agent
 *
 * Runs weekly. Discovers new strategic knowledge from 3 sources:
 *   1. Account performance data  — what patterns exist in campaigns/findings
 *   2. Approved findings feedback — crystallise repeated approvals into rules
 *   3. Web search (compound-beta) — real-time PPC + industry-specific insights
 *
 * New entries are staged with status='staged' for human approval at /brain.
 * Only active entries (status='active') are queried by analysts.
 */

import { db } from "@/db";
import { brainEntries, campaigns, findings, actionPlan, config } from "@/db/schema";
import { eq, desc, gte, sql, and } from "drizzle-orm";
import { callLLM } from "../llm";
import { micros } from "../data";
import { getConfigValue } from "../rules/rulesEngine";
import { daysAgoUTC, todayUTC } from "@/lib/dates";

/* ── types ── */
interface CandidateEntry {
  id: string;
  category: string;
  source: string;
  sourceType: "agent_performance" | "agent_feedback" | "agent_web_search";
  title: string;
  summary: string;
  key_points: string[];
  raw_text: string;
}

/* ── main export ── */
export async function runBrainLearningAgent(): Promise<{ staged: number; skipped: number; errors: string[] }> {
  if (!db) return { staged: 0, skipped: 0, errors: ["No database connection"] };

  const errors: string[] = [];
  const allCandidates: CandidateEntry[] = [];

  console.log("[brain-learning] Starting Brain Learning Agent run...");

  // Phase 1: Account performance patterns
  try {
    const perfEntries = await discoverFromAccountData();
    allCandidates.push(...perfEntries);
    console.log(`[brain-learning] Phase 1 (account data): ${perfEntries.length} candidates`);
  } catch (e) {
    const msg = `Phase 1 (account data) failed: ${String(e)}`;
    errors.push(msg);
    console.error(`[brain-learning] ${msg}`);
  }

  // Phase 2: Approved findings feedback
  try {
    const feedbackEntries = await discoverFromApprovedFindings();
    allCandidates.push(...feedbackEntries);
    console.log(`[brain-learning] Phase 2 (approved feedback): ${feedbackEntries.length} candidates`);
  } catch (e) {
    const msg = `Phase 2 (approved feedback) failed: ${String(e)}`;
    errors.push(msg);
    console.error(`[brain-learning] ${msg}`);
  }

  // Phase 3: Web search (Groq compound-beta)
  try {
    const webEntries = await discoverFromWebSearch();
    allCandidates.push(...webEntries);
    console.log(`[brain-learning] Phase 3 (web search): ${webEntries.length} candidates`);
  } catch (e) {
    const msg = `Phase 3 (web search) failed: ${String(e)}`;
    errors.push(msg);
    console.error(`[brain-learning] ${msg}`);
  }

  if (allCandidates.length === 0) {
    console.log("[brain-learning] No candidates generated.");
    return { staged: 0, skipped: 0, errors };
  }

  // Deduplicate against existing entries
  const existingTitles = new Set(
    (await db.select({ title: brainEntries.title }).from(brainEntries)).map((r) => r.title.toLowerCase().trim())
  );

  const today = todayUTC();
  let staged = 0;
  let skipped = 0;

  for (const candidate of allCandidates) {
    const titleKey = candidate.title.toLowerCase().trim();
    if (existingTitles.has(titleKey)) {
      skipped++;
      console.log(`[brain-learning] Skipped duplicate: "${candidate.title}"`);
      continue;
    }
    existingTitles.add(titleKey);

    try {
      await db.insert(brainEntries).values({
        id: candidate.id,
        category: candidate.category,
        source: candidate.source,
        sourceType: candidate.sourceType,
        dateAdded: today,
        title: candidate.title,
        summary: candidate.summary,
        keyPoints: candidate.key_points,
        rawText: candidate.raw_text,
        status: "staged",
      }).onConflictDoNothing();
      staged++;
      console.log(`[brain-learning] Staged: "${candidate.title}" (${candidate.category})`);
    } catch (e) {
      errors.push(`Failed to stage "${candidate.title}": ${String(e)}`);
    }
  }

  console.log(`[brain-learning] Done. staged=${staged} skipped=${skipped} errors=${errors.length}`);
  return { staged, skipped, errors };
}

/* ── Phase 1: Account Performance Discovery ── */
async function discoverFromAccountData(): Promise<CandidateEntry[]> {
  const [campaignRows, accountDesc, currency] = await Promise.all([
    db!.select().from(campaigns).limit(20),
    getConfigValue("ACCOUNT_DESCRIPTION", ""),
    getConfigValue("CURRENCY_SYMBOL", "₹"),
  ]);

  // Build a summary of account performance
  const enabled = campaignRows.filter((c) => c.status === "ENABLED");
  const perfLines: string[] = [];
  for (const c of enabled) {
    const spend = micros(c.costMicros);
    const conv = Number(c.conversions) || 0;
    const convVal = Number(c.conversionValue) || 0;
    const roas = spend > 0 && convVal > 0 ? (convVal / spend).toFixed(2) + "x" : "n/a";
    const cpa = conv > 0 ? (spend / conv).toFixed(0) : "n/a";
    const bLost = ((Number(c.searchBudgetLostIs) || 0) * 100).toFixed(0);
    const rLost = ((Number(c.searchRankLostIs) || 0) * 100).toFixed(0);
    perfLines.push(`"${c.campaignName}" | ${c.channelType} | ${c.biddingStrategy} | spend=${currency}${spend.toFixed(0)} conv=${conv} roas=${roas} cpa=${currency}${cpa} budgetLost=${bLost}% rankLost=${rLost}%`);
  }

  // Recent finding patterns
  const recentFindings = await db!.select({
    category: findings.category,
    severity: findings.severity,
    count: sql<string>`count(*)`,
  }).from(findings)
    .where(gte(findings.runDate, daysAgoUTC(30)))
    .groupBy(findings.category, findings.severity)
    .orderBy(desc(sql`count(*)`));

  const findingsSummary = recentFindings.map((r) =>
    `${r.severity} ${r.category}: ${r.count} occurrences`
  ).join("\n");

  const systemPrompt = `You are a Google Ads strategist who learns from account data.

Given account performance data, extract 2-3 strategic insights specific to THIS account.
Focus on patterns that recur, structural strengths/weaknesses, and account-specific rules of thumb.

Output STRICT JSON:
{
  "entries": [
    {
      "category": "performance|bidding|structure|keywords|copy|scaling|general",
      "title": "Short descriptive title (max 80 chars)",
      "summary": "2-3 sentence insight derived from the data",
      "key_points": ["specific actionable point 1", "point 2", "point 3"]
    }
  ]
}

Rules:
- Every insight must reference actual data from the account (campaign names, numbers)
- Do NOT produce generic PPC advice — this must be account-specific
- 2-3 entries maximum
- Return ONLY the JSON object`;

  const userPrompt = `ACCOUNT: ${accountDesc || "Google Ads account"}

CAMPAIGN PERFORMANCE:
${perfLines.join("\n")}

FINDING PATTERNS (last 30 days):
${findingsSummary || "No findings yet"}

Based on this data, what account-specific strategic insights can be learned?`;

  const llm = await callLLM(systemPrompt, userPrompt, {
    label: "brain-learning-account",
    max_tokens: 1500,
    temperature: 0.3,
  });

  return parseBrainEntries(llm.json, "agent_performance", "account-performance-analysis");
}

/* ── Phase 2: Approved Findings Feedback ── */
async function discoverFromApprovedFindings(): Promise<CandidateEntry[]> {
  const approved = await db!.select({
    actionType: actionPlan.actionType,
    actionCategory: actionPlan.actionCategory,
    title: actionPlan.title,
    what: actionPlan.what,
    why: actionPlan.why,
    action: actionPlan.action,
    runDate: actionPlan.runDate,
  }).from(actionPlan)
    .where(and(eq(actionPlan.status, "approved"), gte(actionPlan.runDate, daysAgoUTC(60))))
    .orderBy(desc(actionPlan.runDate))
    .limit(30);

  if (approved.length < 3) {
    console.log("[brain-learning] Not enough approved findings for feedback phase (need 3+)");
    return [];
  }

  // Group by actionType and count
  const byType = new Map<string, typeof approved>();
  for (const row of approved) {
    const key = row.actionType || "general";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key)!.push(row);
  }

  // Only use types with 2+ approvals (confirmed patterns)
  const confirmedPatterns = Array.from(byType.entries())
    .filter(([, rows]) => rows.length >= 2)
    .map(([type, rows]) => ({
      type,
      count: rows.length,
      examples: rows.slice(0, 3).map((r) => `  - ${r.title}: ${r.action}`).join("\n"),
    }));

  if (confirmedPatterns.length === 0) {
    console.log("[brain-learning] No confirmed patterns (need 2+ approvals of same type)");
    return [];
  }

  const patternsText = confirmedPatterns.map((p) =>
    `Action type: ${p.type} (approved ${p.count} times)\nExamples:\n${p.examples}`
  ).join("\n\n");

  const systemPrompt = `You are a Google Ads strategist learning from an account's approval history.

The user has approved certain types of actions repeatedly — this reveals their strategic preferences and what works for this account.
Crystallise each repeated approval pattern into a reusable strategic insight for the Brain knowledge base.

Output STRICT JSON:
{
  "entries": [
    {
      "category": "bidding|keywords|structure|copy|scaling|performance|general",
      "title": "Short descriptive title (max 80 chars)",
      "summary": "2-3 sentences: what this account consistently does and why it works for them",
      "key_points": ["key point 1", "key point 2", "key point 3"]
    }
  ]
}

Rules:
- Each entry captures ONE recurring pattern
- Write as a durable strategic rule ("For this account, X consistently works because Y")
- 1 entry per confirmed pattern, maximum 3 entries total
- Return ONLY the JSON object`;

  const llm = await callLLM(systemPrompt, patternsText, {
    label: "brain-learning-feedback",
    max_tokens: 1200,
    temperature: 0.3,
  });

  return parseBrainEntries(llm.json, "agent_feedback", "approved-findings-pattern");
}

/* ── Phase 3: Web Search Discovery (compound-beta) ── */
async function discoverFromWebSearch(): Promise<CandidateEntry[]> {
  const accountDesc = await getConfigValue("ACCOUNT_DESCRIPTION", "Ayurvedic health supplement brand in India");

  const searches = [
    {
      query: `Google Ads best practices for Ayurvedic products and health supplements in India 2024 2025 - bidding strategy, ad copy, keywords`,
      category: "general" as const,
      source: "web-search: Ayurvedic Google Ads best practices",
    },
    {
      query: `Google Ads smart bidding strategy tROAS tCPA for health supplement brands high CPA products India - when to use which strategy`,
      category: "bidding" as const,
      source: "web-search: smart bidding for health products",
    },
    {
      query: `Google Ads RSA ad copy tactics for traditional medicine Ayurvedic wellness brands India - headlines CTAs that convert`,
      category: "copy" as const,
      source: "web-search: ad copy for Ayurvedic brands",
    },
  ];

  const allEntries: CandidateEntry[] = [];

  for (const search of searches) {
    try {
      // Step 1: Research with compound-beta (real web search)
      const researchText = await webSearch(search.query);
      if (!researchText) continue;

      // Step 2: Structure into Brain entries
      const systemPrompt = `You are a Google Ads strategist. Extract 1-2 actionable Brain knowledge entries from the research below.

Output STRICT JSON:
{
  "entries": [
    {
      "category": "${search.category}",
      "title": "Short descriptive title (max 80 chars)",
      "summary": "2-3 sentences summarising the core insight",
      "key_points": ["actionable point 1", "point 2", "point 3"]
    }
  ]
}

Rules:
- Extract only actionable insights applicable to: ${accountDesc}
- Be specific — cite tactics, thresholds, formulas where the research provides them
- Maximum 2 entries
- Return ONLY the JSON object`;

      const structLLM = await callLLM(systemPrompt, researchText, {
        label: `brain-learning-web-${search.category}`,
        max_tokens: 1200,
        temperature: 0.2,
      });

      const entries = parseBrainEntries(structLLM.json, "agent_web_search", search.source);
      allEntries.push(...entries);
    } catch (e) {
      console.warn(`[brain-learning] Web search failed for "${search.query.slice(0, 50)}...": ${e}`);
    }
  }

  return allEntries;
}

/* ── Web search via Groq compound-beta ── */
async function webSearch(query: string): Promise<string> {
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "compound-beta",
      messages: [
        {
          role: "user",
          content: `Research the following topic and provide comprehensive, specific, actionable information. Include current best practices, specific numbers/thresholds where available, and real tactical advice:\n\n${query}`,
        },
      ],
      max_tokens: 2000,
      // compound-beta does NOT support response_format: json_object
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`compound-beta HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || "";
}

/* ── Helper: parse LLM output into CandidateEntry[] ── */
function parseBrainEntries(
  json: Record<string, unknown> | null,
  sourceType: CandidateEntry["sourceType"],
  source: string
): CandidateEntry[] {
  if (!json || !Array.isArray(json.entries)) return [];

  const results: CandidateEntry[] = [];
  const ts = Date.now();

  for (let i = 0; i < (json.entries as unknown[]).length; i++) {
    const e = json.entries[i] as Record<string, unknown>;
    if (!e || typeof e.title !== "string" || typeof e.summary !== "string") continue;

    const category = String(e.category || "general");
    const title = String(e.title).slice(0, 200);
    const summary = String(e.summary).slice(0, 1000);
    const keyPoints = Array.isArray(e.key_points)
      ? (e.key_points as unknown[]).slice(0, 5).map((p) => String(p).slice(0, 300))
      : [];

    results.push({
      id: `brain_auto_${ts}_${i}`,
      category,
      source,
      sourceType,
      title,
      summary,
      key_points: keyPoints,
      raw_text: JSON.stringify(e),
    });
  }

  return results;
}
