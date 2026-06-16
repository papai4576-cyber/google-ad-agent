import { runBrainLearningAgent } from "@/agents/analysts/brainLearningAgent";
import { notifyBrainLearning } from "@/agents/slack";

async function main() {
  console.log("[brain-learning] Starting...");
  const result = await runBrainLearningAgent();
  console.log(`[brain-learning] Result: staged=${result.staged} skipped=${result.skipped} errors=${result.errors.length}`);
  if (result.errors.length) {
    for (const e of result.errors) console.error(`[brain-learning] ERROR: ${e}`);
  }
  if (result.staged > 0) {
    console.log(`[brain-learning] ${result.staged} new entries staged for review at /brain`);
  }
  await notifyBrainLearning(result.staged, result.skipped, result.errors);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
