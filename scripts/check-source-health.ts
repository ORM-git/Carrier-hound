/** Scheduled source-health gate: service-role read of recent ingest_runs.
 * Exit 1 on degraded evidence, 2 on missing/unavailable evidence; never 0
 * silently. Alert delivery/paging is intentionally outside this script. */
import { createClient } from "@supabase/supabase-js";
import { evaluateSourceHealth } from "../src/lib/observability/sourceHealth";

const MAX_FAILURES_IN_WINDOW = 1;
const STALE_AFTER_HOURS = 26; // Daily ingest plus bounded schedule drift.

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Supabase service-role env is required.");

  const client = createClient(url, key);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("ingest_runs")
    .select("started_at,finished_at,status,per_source_counts")
    .gte("finished_at", since)
    .order("finished_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`ingest_runs query failed: ${error.message}`);

  const result = evaluateSourceHealth(data ?? [], { maxFailuresInWindow: MAX_FAILURES_IN_WINDOW, staleAfterHours: STALE_AFTER_HOURS }, new Date().toISOString());
  console.log(JSON.stringify(result));
  if (result.status === "degraded") {
    console.error(`[SOURCE-HEALTH-ALERT] ${result.reason}`);
    process.exit(1);
  }
  if (result.status !== "healthy") {
    console.error(`[SOURCE-HEALTH-UNAVAILABLE] ${result.reason || result.status}`);
    process.exit(2);
  }
  console.log("Source health is healthy.");
}

main().catch((error) => {
  console.error("[SOURCE-HEALTH-UNAVAILABLE]", error.message || error);
  process.exit(2);
});
