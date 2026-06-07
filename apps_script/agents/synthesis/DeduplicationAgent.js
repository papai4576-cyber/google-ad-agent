/**
 * DeduplicationAgent.js — merges genuinely duplicate findings across agents.
 *
 * Different agents often surface the SAME underlying issue on the same entity
 * from different angles — e.g. PerformanceAnalyst and BidBudgetAnalyst both
 * flag "impression share lost to budget" on one campaign. Those should collapse
 * to one Action_Plan row. But two DIFFERENT issues on the same campaign
 * ("CPA is too high" vs "conversion rate is suspiciously low") are distinct
 * actions and must BOTH survive.
 *
 * The earlier version keyed on (target_type, target_id, category) and merged
 * everything sharing that key. For the "performance" category that crushed
 * many distinct issues on one campaign into a single row — real, actionable
 * findings were silently dropped.
 *
 * New approach — two-stage:
 *   1. Bucket by ENTITY: `target_type::target_id` (account-wide findings, no
 *      target_id, bucket together under "acct").
 *   2. Within a bucket, cluster by TITLE SIMILARITY: two findings merge only if
 *      their "issue signatures" (title tokens, minus the shared entity name and
 *      stopwords) overlap by >= SIMILARITY_THRESHOLD (Jaccard), OR they share an
 *      identical finding_id (defensive against any residual same-day dupes).
 *
 * Bias: when in doubt we DO NOT merge (better to show a near-dup than to hide a
 * distinct action). Empty-signature findings (title was only the entity name)
 * are treated as unique.
 *
 * Pure function. No I/O. No LLM.
 */

const Dedup = {

  // Jaccard overlap on issue-signature tokens required to call two findings
  // "the same issue". 0.5 = at least half the distinguishing words shared.
  SIMILARITY_THRESHOLD: 0.5,

  // Words that carry no distinguishing meaning for an Ads finding title.
  STOPWORDS: new Set([
    'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'and', 'or',
    'vs', 'with', 'too', 'very', 'this', 'that', 'at', 'by', 'from', 'into',
    'over', 'under', 'above', 'below', 'high', 'low', 'has', 'have', 'no',
    'not', 'its', 'it', 'be', 'as', 'campaign', 'ad', 'group', 'adgroup',
    'keyword', 'kw',
  ]),

  /**
   * @param {Array} findings — raw finding objects from the Findings sheet
   * @returns {{
   *   deduped: Array,             // survivors (one per cluster)
   *   merge_log: Array<{primary_finding_id, merged_finding_ids, key}>,
   *   stats: {input, kept, merged}
   * }}
   */
  run(findings) {
    // Stage 1 — bucket by entity.
    const entityBuckets = new Map();   // entityKey → array of findings
    for (const f of findings) {
      const ek = Dedup._entityKey_(f);
      if (!entityBuckets.has(ek)) entityBuckets.set(ek, []);
      entityBuckets.get(ek).push(f);
    }

    const deduped = [];
    const mergeLog = [];
    let mergedCount = 0;

    // Stage 2 — within each entity, cluster by title similarity.
    for (const [entityKey, group] of entityBuckets.entries()) {
      const clusters = Dedup._cluster_(group);

      for (const cluster of clusters) {
        cluster.sort(Dedup._compare_);
        const primary = cluster[0];
        const merged  = cluster.slice(1);

        if (merged.length > 0) {
          const mergedIds = merged.map(m => m.finding_id);
          // Preserve traceability without changing the universal schema:
          // record merged ids inside the primary's evidence list.
          let evidence = [];
          try { evidence = JSON.parse(primary.evidence_json || '[]'); }
          catch (_e) { evidence = []; }
          evidence.push(`merged_from: ${mergedIds.join(', ')}`);
          primary.evidence_json = JSON.stringify(evidence);

          mergeLog.push({
            primary_finding_id: primary.finding_id,
            merged_finding_ids: mergedIds,
            key: entityKey,
          });
          mergedCount += merged.length;
        }
        deduped.push(primary);
      }
    }

    return {
      deduped:   deduped,
      merge_log: mergeLog,
      stats: {
        input:  findings.length,
        kept:   deduped.length,
        merged: mergedCount,
      },
    };
  },

  /* ===== internals ===== */

  /** Entity key — findings on the same target share this. */
  _entityKey_(f) {
    const ttype = String(f.target_type || '').trim();
    const tid   = String(f.target_id   || '').trim();
    if (tid) return `${ttype}::${tid}`;
    return 'acct';   // account-wide findings cluster among themselves
  },

  /**
   * Greedily cluster a group of same-entity findings by title similarity.
   * Each finding joins the first existing cluster it is "same issue" with,
   * else starts a new cluster. Returns an array of clusters (arrays).
   */
  _cluster_(group) {
    const clusters = [];   // each: { sig:Set, ids:Set, items:[] }
    for (const f of group) {
      const sig = Dedup._issueSignature_(f);
      const id  = String(f.finding_id || '').trim();

      let placed = false;
      for (const c of clusters) {
        const sameId = id && c.ids.has(id);
        const similar = Dedup._similarEnough_(sig, c.sig);
        if (sameId || similar) {
          c.items.push(f);
          if (id) c.ids.add(id);
          for (const t of sig) c.sig.add(t);
          placed = true;
          break;
        }
      }
      if (!placed) {
        const ids = new Set();
        if (id) ids.add(id);
        clusters.push({ sig: new Set(sig), ids: ids, items: [f] });
      }
    }
    return clusters.map(c => c.items);
  },

  /**
   * "Issue signature" = distinguishing title tokens. We strip the entity name
   * (constant within a bucket, so it would falsely inflate similarity) and
   * stopwords, leaving the words that describe the PROBLEM.
   */
  _issueSignature_(f) {
    const titleTokens = Dedup._tokens_(f.title);
    const nameTokens  = Dedup._tokens_(f.target_name);
    const sig = new Set();
    for (const t of titleTokens) {
      if (Dedup.STOPWORDS.has(t)) continue;
      if (nameTokens.has(t)) continue;
      sig.add(t);
    }
    return sig;
  },

  _tokens_(s) {
    const set = new Set();
    const cleaned = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!cleaned) return set;
    for (const w of cleaned.split(/\s+/)) {
      if (w.length >= 2) set.add(w);
    }
    return set;
  },

  /**
   * Two issue signatures are "the same issue" if their Jaccard overlap meets
   * the threshold. Empty signatures never match (treated as unique).
   */
  _similarEnough_(sigA, sigB) {
    if (sigA.size === 0 || sigB.size === 0) return false;
    let inter = 0;
    for (const t of sigA) if (sigB.has(t)) inter++;
    const union = sigA.size + sigB.size - inter;
    if (union === 0) return false;
    return (inter / union) >= Dedup.SIMILARITY_THRESHOLD;
  },

  _compare_(a, b) {
    const sa = Number(a.score) || 0;
    const sb = Number(b.score) || 0;
    if (sb !== sa) return sb - sa;
    const sevRank = { P1: 3, P2: 2, P3: 1 };
    return (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0);
  },
};
