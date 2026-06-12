/**
 * rulesEngine.ts — config-tunable thresholds for the rule-based Analysts.
 *
 * Ported from apps_script/rules/RulesEngine.js. Convention unchanged: every
 * threshold is a `config` table row keyed `RULE_<NAME>`. If the row is
 * absent (or non-numeric), the default passed to `load()` is used.
 *
 * Example: to make the budget-capped rule fire at 25% IS loss instead of 30%,
 * upsert a config row: key="RULE_BUDGET_LOST_IS", value="0.25"
 */

import { db } from "@/db";
import { config } from "@/db/schema";

/** One query for the whole `config` table — cheap, and every Analyst needs it. */
async function loadConfigMap(): Promise<Map<string, string>> {
  if (!db) return new Map();
  const rows = await db.select({ key: config.key, value: config.value }).from(config);
  return new Map(rows.map((r) => [r.key, r.value]));
}

export const RulesEngine = {
  /**
   * Read a numeric rule threshold from `config` (key `RULE_<name>`), falling
   * back to `dflt`. Non-numeric / blank config values fall back too.
   */
  async num(name: string, dflt: number): Promise<number> {
    const map = await loadConfigMap();
    const raw = map.get(`RULE_${name}`);
    if (raw === undefined || raw === "") return dflt;
    const n = parseFloat(raw);
    return isNaN(n) ? dflt : n;
  },

  /**
   * Pull a whole block of thresholds at once. Pass `{ NAME: default }` and
   * get back `{ name: value }` (lowercased keys for use in `detect()`).
   * One config query total, regardless of how many keys are requested.
   */
  async load(defaults: Record<string, number>): Promise<Record<string, number>> {
    const map = await loadConfigMap();
    const out: Record<string, number> = {};
    for (const key of Object.keys(defaults)) {
      const raw = map.get(`RULE_${key}`);
      let val = defaults[key];
      if (raw !== undefined && raw !== "") {
        const n = parseFloat(raw);
        if (!isNaN(n)) val = n;
      }
      out[key.toLowerCase()] = val;
    }
    return out;
  },
};

/** Read a single non-`RULE_*` config value (e.g. TARGET_CPA, DRY_RUN). */
export async function getConfigValue(key: string, fallback: string): Promise<string> {
  const map = await loadConfigMap();
  const v = map.get(key);
  return v === undefined || v === "" ? fallback : v;
}

export interface Targets {
  currency_symbol: string;
  target_cpa: number;
  target_roas: number;
  monthly_budget: number;
}

/** Account targets, read from `config` so non-developers can adjust live. */
export async function getTargets(): Promise<Targets> {
  const map = await loadConfigMap();
  const num = (key: string, dflt: number) => {
    const raw = map.get(key);
    if (raw === undefined || raw === "") return dflt;
    const n = parseFloat(raw);
    return isNaN(n) ? dflt : n;
  };
  return {
    currency_symbol: map.get("CURRENCY_SYMBOL") || "₹",
    target_cpa: num("TARGET_CPA", 200),
    target_roas: num("TARGET_ROAS", 4.0),
    monthly_budget: num("MONTHLY_BUDGET_TARGET", 100000),
  };
}

export async function isDryRun(): Promise<boolean> {
  const v = (await getConfigValue("DRY_RUN", "true")).toLowerCase().trim();
  return ["true", "1", "yes", "y", "on"].includes(v);
}
