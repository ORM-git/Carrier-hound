/**
 * TTFB SLO check (docs/slo.md: server response TTFB p75 <= 800 ms, the
 * web.dev "good" threshold, consistent with the existing LCP p75 target).
 *
 * Reads client-reported RUM TTFB samples from the web_vitals table
 * (collected by /api/track), evaluates, and exits non-zero on breach so a
 * cron/CI run or the owner can wire it to paging.
 *
 * Usage: npx tsx scripts/check-ttfb-slo.ts [windowHours=24]
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from "@supabase/supabase-js";
import { evaluateSlo, percentile } from "../src/lib/observability/slo";

const TTFB_SLO_TARGETS = [{ percentile: 75, maxMs: 800 }] as const;

async function main() {
  const windowHours = Number(process.argv[2] ?? 24);
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    console.error("windowHours must be a positive number");
    process.exit(2);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("Supabase env not configured; cannot evaluate TTFB SLO.");
    process.exit(2);
  }

  const client = createClient(url, key);
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("web_vitals")
    .select("value")
    .eq("name", "TTFB")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10000);

  if (error) {
    console.error(`[SLO-CHECK-ERROR] web_vitals query failed: ${error.message}`);
    process.exit(2);
  }

  const samples = (data ?? []).map((r: any) => Number(r.value));
  const result = evaluateSlo(samples, TTFB_SLO_TARGETS);

  console.log(
    `TTFB SLO (last ${windowHours}h): n=${result.sampleCount} ` +
      `p50=${percentile(samples, 50)?.toFixed(0) ?? "n/a"}ms ` +
      `p75=${result.percentiles.p75?.toFixed(0) ?? "n/a"}ms (target <= 800ms) ` +
      `p95=${percentile(samples, 95)?.toFixed(0) ?? "n/a"}ms`
  );

  if (result.status === "no_data") {
    console.log("No TTFB samples in window - nothing to evaluate.");
    process.exit(0);
  }
  if (result.status === "breach") {
    for (const b of result.breaches) {
      console.error(
        `[SLO-ALERT] TTFB p${b.percentile} ${b.actualMs.toFixed(0)}ms exceeds target ${b.maxMs}ms over the last ${windowHours}h (n=${result.sampleCount})`
      );
    }
    process.exit(1);
  }
  console.log("TTFB SLO met.");
}

main().catch((err) => {
  console.error("[SLO-CHECK-ERROR]", err);
  process.exit(2);
});
