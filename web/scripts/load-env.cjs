/* eslint-disable @typescript-eslint/no-require-imports */
// Preload module (run via `tsx --require`) so DATABASE_URL etc. are set in
// process.env BEFORE any ESM module (e.g. @/db) is evaluated. ESM import
// graphs are resolved before a script's own top-level statements run, so
// dotenv calls inside runDailyAudit.ts itself are too late for modules that
// read process.env at module-eval time.
require("dotenv").config({ path: ".env" });
require("dotenv").config({ path: ".env.local", override: true });
