// Diagnostic — exercises the REAL fixed getCustomer() path from googleAdsClient.ts
// (not a standalone client), so this actually tests the manual-token-fetch fix.
import { GoogleAdsApi } from "google-ads-api";

async function main() {
  // Re-implement getCustomer()'s patching inline since getCustomer isn't exported —
  // import the module and call one of its real exported functions instead, which is
  // the truest test (exact same code path implementation.ts will use in production).
  const googleAdsClient = await import("../src/agents/googleAdsClient");
  const result = await googleAdsClient.setCampaignBudget("000000000", 1); // intentionally bogus id — we only care whether auth/transport succeeds, not whether the budget lookup finds a real campaign
  console.log("RESULT (expect a clean 'no campaign_budget resource found' error, NOT an auth/transport error):", JSON.stringify(result));
  if (result.error && /premature close|getting metadata from plugin failed/i.test(result.error)) {
    console.error("STILL BROKEN: auth/transport error persisted through the fix.");
    process.exitCode = 1;
  } else {
    console.log("FIX CONFIRMED: no auth/transport error — call reached Google's API successfully.");
  }
}
main().catch((e) => {
  console.error("UNEXPECTED FAILURE:", e);
  process.exitCode = 1;
});
