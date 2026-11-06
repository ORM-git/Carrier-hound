/**
 * CareerMonke — Daily Early-Access Owner Digest Cron Runner
 * Sends ONE daily digest email to EARLY_ACCESS_NOTIFY_EMAIL containing all
 * early_access_emails rows created since the last digest (tracked in gmail_send_log).
 * Sends nothing if there are no new rows.
 *
 * Usage:
 *   npx tsx scripts/early-access-digest-cron.ts
 *   npx tsx scripts/early-access-digest-cron.ts --dry
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { runEarlyAccessDigestCron } from "../src/lib/early-access/gmail";
import { reportCronFailure } from "./lib/cron-sentry";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");

  console.log("============================================================");
  console.log("  CareerMonke Early-Access Daily Digest Cron");
  console.log("============================================================");
  console.log(`Mode: ${dryRun ? "DRY RUN (no email sent / no DB writes)" : "LIVE EXECUTION"}\n`);

  const startTime = Date.now();
  const result = await runEarlyAccessDigestCron({ dryRun });
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("------------------------------------------------------------");
  console.log(`Status:         ${result.status === "success" ? "✓ SUCCESS" : "✗ FAILED"}`);
  console.log(`Reason:         ${result.reason}`);
  console.log(`Digest Sent:    ${result.sent ? "YES" : "NO"}`);
  console.log(`New Signups:    ${result.rowCount}`);
  console.log(`Digest Cursor:  ${result.lastDigestAt || "(none)"}`);
  console.log(`Duration:       ${durationSec}s`);
  console.log("------------------------------------------------------------\n");

  if (result.status === "failed") {
    // Surface cron failures in the dead-letter queue (admin replay view),
    // not only in GitHub Actions email. One row per day per reason.
    try {
      const { recordFailedEvent } = await import("../src/lib/events/failedEvents");
      await recordFailedEvent({
        source: "cron_early_access_digest",
        eventId: `ead-${new Date().toISOString().slice(0, 10)}`,
        payload: { reason: result.reason, rowCount: result.rowCount, dryRun },
        error: `Early-access digest cron failed: ${result.reason}`,
      });
    } catch (captureErr) {
      console.error("Failed to record cron failure to failed_events:", captureErr);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal unhandled early-access digest cron error:", err);
  await reportCronFailure("early-access-digest", err);
  process.exit(1);
});
