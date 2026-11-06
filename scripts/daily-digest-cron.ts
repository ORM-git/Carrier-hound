/**
 * CareerMonke / Career Hound — Daily Automated Cron Runner
 * Scans connected job sources, computes match scores, queues idempotent daily digests.
 *
 * Usage:
 *   npx tsx scripts/daily-digest-cron.ts
 *   npx tsx scripts/daily-digest-cron.ts --dry
 *   npx tsx scripts/daily-digest-cron.ts --date=2026-10-08
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { runDailyDigestCron } from "../src/lib/cron/dailyDigestCron";
import { reportCronFailure } from "./lib/cron-sentry";
import { startCronHeartbeat } from "./lib/cron-heartbeat";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const dateArg = args.find((a) => a.startsWith("--date="))?.split("=")[1];
  const minScoreArg = args.find((a) => a.startsWith("--min-score="))?.split("=")[1];

  console.log("============================================================");
  console.log("  CareerMonke Daily Automated Cron — v1.2");
  console.log("============================================================");
  console.log(`Mode:       ${dryRun ? "DRY RUN (no DB writes)" : "LIVE EXECUTION"}`);
  if (dateArg) console.log(`Date:       ${dateArg}`);
  if (minScoreArg) console.log(`Min Score:  ${minScoreArg}%`);
  console.log("Starting job scan & candidate match evaluation...\n");

  const startTime = Date.now();
  const stats = await runDailyDigestCron({
    dryRun,
    forceDate: dateArg,
    minMatchScore: minScoreArg ? parseInt(minScoreArg, 10) : undefined,
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log("------------------------------------------------------------");
  console.log(`Execution Run ID:   ${stats.runId}`);
  console.log(`Status:             ${stats.status === "success" ? "✓ SUCCESS" : "✗ FAILED"}`);
  console.log(`Jobs Scanned:       ${stats.jobsScannedCount}`);
  console.log(`New Jobs (24h):     ${stats.newJobsCount}`);
  console.log(`Candidates Evaluated: ${stats.usersProcessedCount}`);
  console.log(`Digests Queued:     ${stats.digestsQueuedCount}`);
  console.log(`Duration:           ${durationSec}s`);
  if (stats.errorMessage) {
    console.error(`Error:              ${stats.errorMessage}`);
  }
  console.log("------------------------------------------------------------\n");

  if (stats.status === "failed") {
    process.exit(1);
  }
}

const heartbeat = startCronHeartbeat("daily-digest");

main()
  .then(() => heartbeat.ok())
  .catch(async (err) => {
  console.error("Fatal unhandled cron error:", err);
  await reportCronFailure("daily-digest", err);
  await heartbeat.error();
  process.exit(1);
});
