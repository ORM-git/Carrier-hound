/**
 * Scheduled Mandate Reconciliation Cron Runner.
 *
 * Scans for stuck/failed recurring mandates and runs the recovery consumer.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET (optional)
 * Run: npx tsx scripts/mandate-reconciliation-cron.ts
 */
import { createClient } from "@supabase/supabase-js";
import { runMandateReconciliationJob } from "../src/lib/billing/mandateReconciliationJob";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }

  const supabaseAdmin = createClient(url, key, { auth: { persistSession: false } });
  const cronSecret = process.env.CRON_SECRET;

  const result = await runMandateReconciliationJob({
    supabaseAdmin,
    jobAuthSecret: cronSecret,
    expectedSecret: cronSecret,
  });

  console.log(
    `[MandateReconciliationCron] scanned=${result.stuckOrdersFound} enqueued=${result.enqueuedCount} processed=${result.recoveryResult?.processed ?? 0} resolved=${result.recoveryResult?.resolved ?? 0} failed=${result.recoveryResult?.failed ?? 0}`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[MandateReconciliationCron] fatal:", err?.message || err);
  process.exit(1);
});
