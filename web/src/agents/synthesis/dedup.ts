/**
 * dedup.ts — merges genuinely duplicate findings across Analysts.
 *
 * Ported from apps_script/agents/synthesis/DeduplicationAgent.js. Logic is
 * unchanged; only the data shape changed (nested `target`/`estimated_impact`
 * objects and an `evidence` array instead of flattened sheet-row fields +
 * `evidence_json` strings).
 *
 * Two-stage:
 *   1. Bucket by ENTITY: `target.type::target.id` (account-wide findings,
 *      no target.id, bucket together under "acct").
 *   2. Within a bucket, cluster by TITLE SIMILARITY: two findings merge only
 *      if their "issue signatures" (title tokens, minus the shared entity
 *      name and stopwords) overlap by >= SIMILARITY_THRESHOLD (Jaccard), or
 *      they share an identical id.
 *
 * Bias: when in doubt we DO NOT merge. Empty-signature findings (title was
 * only the entity name) are treated as unique.
 *
 * Pure function. No I/O. No LLM.
 */

import type { SynthFinding } from "../schema";

// Jaccard overlap on issue-signature tokens required to call two findings
// "the same issue". 0.5 = at least half the distinguishing words shared.
const SIMILARITY_THRESHOLD = 0.5;

// Words that carry no distinguishing meaning for an Ads finding title.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "is", "are", "and", "or",
  "vs", "with", "too", "very", "this", "that", "at", "by", "from", "into",
  "over", "under", "above", "below", "high", "low", "has", "have", "no",
  "not", "its", "it", "be", "as", "campaign", "ad", "group", "adgroup",
  "keyword", "kw",
]);

export interface MergeLogEntry {
  primary_finding_id: string;
  merged_finding_ids: string[];
  key: string;
}

export interface DedupResult {
  deduped: SynthFinding[];
  mergeLog: MergeLogEntry[];
  stats: { input: number; kept: number; merged: number };
}

export const Dedup = {
  SIMILARITY_THRESHOLD,
  STOPWORDS,

  run(findings: SynthFinding[]): DedupResult {
    // Stage 1 — bucket by entity.
    const entityBuckets = new Map<string, SynthFinding[]>();
    for (const f of findings) {
      const ek = entityKey(f);
      if (!entityBuckets.has(ek)) entityBuckets.set(ek, []);
      entityBuckets.get(ek)!.push(f);
    }

    const deduped: SynthFinding[] = [];
    const mergeLog: MergeLogEntry[] = [];
    let mergedCount = 0;

    // Stage 2 — within each entity, cluster by title similarity.
    for (const [entityKeyStr, group] of entityBuckets.entries()) {
      const clusters = cluster(group);

      for (const clusterItems of clusters) {
        clusterItems.sort(compare);
        const primary = clusterItems[0];
        const merged = clusterItems.slice(1);

        if (merged.length > 0) {
          const mergedIds = merged.map((m) => m.id);
          primary.evidence = [...primary.evidence, `merged_from: ${mergedIds.join(", ")}`];

          mergeLog.push({
            primary_finding_id: primary.id,
            merged_finding_ids: mergedIds,
            key: entityKeyStr,
          });
          mergedCount += merged.length;
        }
        deduped.push(primary);
      }
    }

    return {
      deduped,
      mergeLog,
      stats: { input: findings.length, kept: deduped.length, merged: mergedCount },
    };
  },
};

/* ===== internals ===== */

/** Entity key — findings on the same target share this. */
function entityKey(f: SynthFinding): string {
  const ttype = String(f.target?.type || "").trim();
  const tid = String(f.target?.id || "").trim();
  if (tid) return `${ttype}::${tid}`;
  return "acct"; // account-wide findings cluster among themselves
}

/**
 * Greedily cluster a group of same-entity findings by title similarity.
 * Each finding joins the first existing cluster it is "same issue" with,
 * else starts a new cluster.
 */
function cluster(group: SynthFinding[]): SynthFinding[][] {
  const clusters: { sig: Set<string>; ids: Set<string>; items: SynthFinding[] }[] = [];

  for (const f of group) {
    const sig = issueSignature(f);
    const id = String(f.id || "").trim();

    let placed = false;
    for (const c of clusters) {
      const sameId = !!id && c.ids.has(id);
      const similar = similarEnough(sig, c.sig);
      if (sameId || similar) {
        c.items.push(f);
        if (id) c.ids.add(id);
        for (const t of sig) c.sig.add(t);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const ids = new Set<string>();
      if (id) ids.add(id);
      clusters.push({ sig: new Set(sig), ids, items: [f] });
    }
  }

  return clusters.map((c) => c.items);
}

/**
 * "Issue signature" = distinguishing title tokens. We strip the entity name
 * (constant within a bucket, so it would falsely inflate similarity) and
 * stopwords, leaving the words that describe the PROBLEM.
 */
function issueSignature(f: SynthFinding): Set<string> {
  const titleTokens = tokens(f.title);
  const nameTokens = tokens(f.target?.name);
  const sig = new Set<string>();
  for (const t of titleTokens) {
    if (STOPWORDS.has(t)) continue;
    if (nameTokens.has(t)) continue;
    sig.add(t);
  }
  return sig;
}

function tokens(s: string | undefined): Set<string> {
  const set = new Set<string>();
  const cleaned = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!cleaned) return set;
  for (const w of cleaned.split(/\s+/)) {
    if (w.length >= 2) set.add(w);
  }
  return set;
}

/**
 * Two issue signatures are "the same issue" if their Jaccard overlap meets
 * the threshold. Empty signatures never match (treated as unique).
 */
function similarEnough(sigA: Set<string>, sigB: Set<string>): boolean {
  if (sigA.size === 0 || sigB.size === 0) return false;
  let inter = 0;
  for (const t of sigA) if (sigB.has(t)) inter++;
  const union = sigA.size + sigB.size - inter;
  if (union === 0) return false;
  return inter / union >= SIMILARITY_THRESHOLD;
}

function compare(a: SynthFinding, b: SynthFinding): number {
  const sa = Number(a.score) || 0;
  const sb = Number(b.score) || 0;
  if (sb !== sa) return sb - sa;
  const sevRank: Record<string, number> = { P1: 3, P2: 2, P3: 1 };
  return (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0);
}
