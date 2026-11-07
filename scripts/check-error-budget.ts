/**
 * Error budget check (docs/slo.md "Error budget policy (BE#8)").
 *
 * Evaluates the digest-delivery surface from cron_run_logs: bad minutes
 * run from a failed run's start until the next successful run (see
 * src/lib/observability/errorBudget.ts). Fast burn (>14.4x for 1h) or an
 * exhausted monthly budget exits 1 so a cron/CI run can page; slow burn
 * (>6x for 6h) is reported for next-business-day triage.
 *
 * Site/API availability SLIs are measured by the external uptime monitor
 * (owner-side burn-rate alert configuration, docs/slo.md Measurement).
 *
 * Usage: npx tsx scripts/check-error-budget.ts
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from "@supabase/supabase-js";
import { evaluateErrorBudget, cronFailureBadMinutes } from "../src/lib/observability/errorBudget";

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("Supabase env not configured; cannot evaluate error budget.");
    process.exit(2);
  }

  const client = createClient(url, key);
  const now = new Date();
  const nowMs = now.getTime();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // Fetch this month's runs plus up to 6h of prior history so a failure
  // that started before the month or before the 6h window is recovered
  // against the correct next success.
  const since = new Date(Math.min(monthStart.getTime(), nowMs - 6 * 60 * 60 * 1000) - DAY_MS).toISOString();
  const { data, error } = await client
    .from("cron_run_logs")
    .select("status,started_at")
    .gte("started_at", since)
    .lte("started_at", now.toISOString())
    .order("started_at", { ascending: true })
    .limit(10000);
  if (error) throw new Error(`cron_run_logs query failed: ${error.message}`);
  const runs = data ?? [];
  if (runs.length >= 10000) throw new Error("cron_run_logs window exceeds 10000 rows; shorten the window.");

  const status = evaluateErrorBudget({
    now,
    badMinutes1h: cronFailureBadMinutes(runs, nowMs - 60 * 60 * 1000, nowMs),
    badMinutes6h: cronFailureBadMinutes(runs, nowMs - 6 * 60 * 60 * 1000, nowMs),
    badMinutesMonth: cronFailureBadMinutes(runs, monthStart.getTime(), nowMs),
  });

  console.log(
    [
      `surface=digest-delivery status=${status.status}`,
      `bad_minutes_1h=${status.badMinutes1h.toFixed(1)} (burn ${status.fastBurnMultiple.toFixed(2)}x, page > 14.4x)`,
      `bad_minutes_6h=${status.badMinutes6h.toFixed(1)} (burn ${status.slowBurnMultiple.toFixed(2)}x, issue > 6x)`,
      `month_consumption=${(status.consumptionFraction * 100).toFixed(1)}% of 0.5% budget`,
    ].join("\n"),
  );

  if (status.status === "fast_burn" || status.status === "exhausted") process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
