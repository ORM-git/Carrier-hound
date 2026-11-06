/**
 * Dunning outbox dispatcher cron entrypoint (audit BE #30).
 * Sends queued dunning emails from dunning_logs via the Apps Script mail route.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      APPS_SCRIPT_MAIL_URL, APPS_SCRIPT_MAIL_SECRET
 * Run: npx tsx scripts/dunning-dispatch-cron.ts
 */
import { createClient } from "@supabase/supabase-js";
import { dispatchQueuedDunningEmails } from "../src/lib/billing/dunningDispatcher";
import { reportCronFailure } from "./lib/cron-sentry";
import { startCronHeartbeat } from "./lib/cron-heartbeat";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const supabase = createClient(url, key);

  const summary = await dispatchQueuedDunningEmails({ supabase });
  console.log(
    `[DunningDispatch] scanned=${summary.scanned} sent=${summary.sent} failed=${summary.failed} skipped_no_recipient=${summary.skippedNoRecipient} capped_out=${summary.cappedOut} missing_mail_env=${summary.missingMailEnv}`
  );
  if (summary.missingMailEnv) {
    // Owner step pending: pass with a notice instead of a daily red run.
    console.log("::notice::APPS_SCRIPT_MAIL_URL/APPS_SCRIPT_MAIL_SECRET not configured (owner step pending); dunning dispatch skipped.");
    process.exit(0);
  }
  if (summary.failed > 0) {
    // Rows stay queued for the next run; signal partial failure without
    // failing hard so one bad address does not block the outbox forever.
    process.exit(1);
  }
}

const heartbeat = startCronHeartbeat("dunning-dispatch");

main()
  .then(() => heartbeat.ok())
  .catch(async (err) => {
  console.error("[DunningDispatch] fatal:", err?.message || err);
  await reportCronFailure("dunning-dispatch", err);
  await heartbeat.error();
  process.exit(2);
});
