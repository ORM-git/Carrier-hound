/**
 * CareerMonke — Failed Email Dead-Letter Replay Cron Runner
 *
 * Cron-safe runner that picks pending failed_events rows for email dispatches
 * (sources: gmail_notification, early_access_digest, digest, thank_you),
 * checks email_suppressions before dispatching, retries with exponential backoff,
 * and marks rows dead after 5 attempts.
 *
 * Usage:
 *   npx tsx scripts/email-retry-cron.ts
 *   npx tsx scripts/email-retry-cron.ts --force
 *   npx tsx scripts/email-retry-cron.ts --dry
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { replayFailedEmailEvents } from "../src/lib/events/failedEvents";
import { reportCronFailure } from "./lib/cron-sentry";
import { startCronHeartbeat } from "./lib/cron-heartbeat";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dry = args.includes("--dry");

  console.log("============================================================");
  console.log("  CareerMonke Email Retry Dead-Letter Cron Runner");
  console.log("============================================================");
  console.log(`Execution Mode: ${dry ? "DRY RUN (no DB updates)" : force ? "FORCE (ignore backoff delay)" : "CRON-SAFE (respects backoff delay)"}\n`);

  if (dry) {
    console.log("Dry run mode requested; exiting without mutations.");
    process.exit(0);
  }

  const startTime = Date.now();
  const summary = await replayFailedEmailEvents({
    force,
    maxAttempts: 5,
  });
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("------------------------------------------------------------");
  console.log(`Status:         ${summary.ok ? "✓ SUCCESS" : "✗ PARTIAL/FAILED"}`);
  console.log(`Inspected:      ${summary.total}`);
  console.log(`Replayed:       ${summary.replayed}`);
  console.log(`Still Pending:  ${summary.pending}`);
  console.log(`Marked Dead:    ${summary.dead}`);
  console.log(`Duration:       ${durationSec}s`);
  console.log("------------------------------------------------------------\n");

  if (!summary.ok) {
    console.warn("Some events failed during replay. Check failed_events logs for details.");
  }
}

const heartbeat = startCronHeartbeat("email-retry");

main()
  .then(() => heartbeat.ok())
  .catch(async (err) => {
  console.error("Fatal unhandled email retry cron error:", err);
  await reportCronFailure("email-retry", err);
  await heartbeat.error();
  process.exit(1);
});
