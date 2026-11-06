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
  // A stable upper bound avoids mixing later arrivals into the window.
  // Supabase commonly caps each response at 1000 rows: paginate explicitly
  // and never label a truncated sample as the complete window.
  const until = new Date().toISOString();
  const samples: number[] = [];
  let expectedCount: number | null = null;
  for (let offset = 0; ; offset += 1000) {
    const { data, error, count } = await client
      .from("web_vitals")
      .select("id,value", { count: "exact" })
      .eq("name", "TTFB")
      .gte("created_at", since)
      .lte("created_at", until)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`web_vitals query failed: ${error.message}`);
    if (count === null || (expectedCount !== null && count !== expectedCount)) {
      throw new Error("TTFB sample window changed or count unavailable; retry the check.");
    }
    expectedCount = count;
    if (count > 10000) throw new Error("TTFB window exceeds 10000 samples; shorten window rather than truncate.");
    for (const row of data ?? []) {
      if (typeof row.value === "number" && Number.isFinite(row.value) && row.value >= 0) samples.push(row.value);
    }
    const returned = (data ?? []).length;
    if (offset + returned >= count) break;
    if (returned < 1000) throw new Error("TTFB response truncated before the full window; cannot evaluate safely.");
  }
  const result = evaluateSlo(samples, TTFB_SLO_TARGETS);

  console.log(
    `TTFB SLO (last ${windowHours}h): n=${result.sampleCount} ` +
      `p50=${percentile(samples, 50)?.toFixed(0) ?? "n/a"}ms ` +
      `p75=${result.percentiles.p75?.toFixed(0) ?? "n/a"}ms (target <= 800ms) ` +
      `p95=${percentile(samples, 95)?.toFixed(0) ?? "n/a"}ms`
  );

  if (result.status === "no_data") {
    console.error("No valid TTFB samples in window - monitoring has no data.");
    process.exit(2);
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
