/**
 * ImpactScorer.js — applies the canonical scoring formula and assigns priority.
 *
 * Per CLAUDE.md:
 *   score = (magnitude × confidence) / effort
 *
 *   magnitude:  high=3, medium=2, low=1
 *   confidence: high=1.0, medium=0.7, low=0.4
 *   effort:     easy=1.0, medium=1.5, hard=2.5
 *
 *   P1: score >= 2.0  → act today
 *   P2: 1.0 – 1.99   → this week
 *   P3: < 1.0         → consider
 *
 * The Findings sheet rows already include a `score` (computed when each
 * agent wrote them). We RE-COMPUTE here so the synthesis layer is the
 * single source of truth — if weights are tuned later, all rows get
 * re-evaluated consistently. We also override `severity` with the formula-
 * derived priority, because LLMs occasionally label severity inconsistently
 * with their own magnitude/confidence/effort fields.
 *
 * Pure function. No I/O. No LLM.
 */

const ImpactScorer = {

  /**
   * @param {Array} findings — deduped findings
   * @returns {{
   *   scored: Array,     // findings with `.score` and `.priority` fields set
   *   stats: { p1, p2, p3, overrides }
   * }}
   */
  run(findings) {
    let p1 = 0, p2 = 0, p3 = 0, overrides = 0;
    const scored = findings.map(f => {
      const computed = ImpactScorer._score_(f);
      const priority = ImpactScorer._priority_(computed);
      if (priority !== f.severity) overrides++;
      if (priority === 'P1') p1++;
      else if (priority === 'P2') p2++;
      else p3++;
      return Object.assign({}, f, {
        score:    computed,
        priority: priority,
      });
    });

    // Sort by score desc, then priority (already implied by score but stable).
    scored.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

    return {
      scored: scored,
      stats:  { p1, p2, p3, overrides },
    };
  },

  /* ===== internals — kept private inside the agent ===== */

  _score_(f) {
    const m = SCORE_WEIGHTS.magnitude[f.impact_magnitude];
    const c = SCORE_WEIGHTS.confidence[f.confidence];
    const e = SCORE_WEIGHTS.effort[f.effort];
    if (!m || !c || !e) return 0;
    return Math.round((m * c / e) * 100) / 100;
  },

  _priority_(score) {
    if (score >= PRIORITY_THRESHOLDS.P1) return 'P1';
    if (score >= PRIORITY_THRESHOLDS.P2) return 'P2';
    return 'P3';
  },
};
