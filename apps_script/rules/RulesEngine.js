/**
 * RulesEngine.js — shared helpers for the deterministic, rule-based agents.
 *
 * The "rules" themselves live inside each agent's `detect()` function (so the
 * logic stays next to the domain it serves). What lives HERE is the bit you
 * tune most often: the numeric THRESHOLDS, read from the Config sheet so you
 * can change them without editing code or re-pushing.
 *
 * Config convention: every threshold is a Config-sheet row keyed `RULE_<NAME>`.
 * If the row is absent, the default below is used. To tune a rule, add/edit the
 * `RULE_<NAME>` row in the Config tab — no code change, no clasp push.
 *
 * Example: to make the budget-capped rule fire at 25% IS loss instead of 30%,
 * add a Config row:  RULE_BUDGET_LOST_IS = 0.25
 */

const RulesEngine = {

  /**
   * Read a numeric rule threshold from Config (key `RULE_<name>`), falling back
   * to `dflt`. Non-numeric / blank Config values fall back too.
   */
  num(name, dflt) {
    const raw = getConfig('RULE_' + name, null);
    if (raw === null || raw === '' || raw === undefined) return dflt;
    const n = parseFloat(raw);
    return isNaN(n) ? dflt : n;
  },

  /**
   * Convenience: pull a whole block of thresholds at once. Pass an object of
   * { NAME: default } and get back { name: value } (lowercased keys for use in
   * detect()). One Config read per key — fine for the handful each agent needs.
   */
  load(defaults) {
    const out = {};
    for (const key of Object.keys(defaults)) {
      out[key.toLowerCase()] = this.num(key, defaults[key]);
    }
    return out;
  },
};
