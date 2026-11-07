/**
 * Capacity headroom report (docs/capacity-headroom.md).
 *
 * Measures what is measurable via API and prints headroom against
 * provider-documented tier limits:
 *  - Supabase: exact row counts and 7-day growth for the large/hot tables.
 *    Disk GB and egress GB are dashboard-only (Owner steps in the doc).
 *    Documented ceilings (supabase.com/docs, fetched 2026-11-06): Pro
 *    includes 8 GB disk, 250 GB/month egress; Free is database-size limited
 *    with 5 GB/month egress.
 *  - Groq: per-model rate limits are returned by Groq itself in the
 *    x-ratelimit-* response headers (console.groq.com/docs/rate-limits),
 *    so the report reads Groq's own numbers instead of hardcoding any.
 *
 * Usage: npx tsx scripts/report-capacity-headroom.ts
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 *      GROQ_API_KEY.
 *
 * Exit codes: 0 = within headroom, 1 = a threshold was crossed,
 * 2 = required env missing (same convention as check-ttfb-slo.ts).
 */

const SUPABASE_TABLES = [
  "jobs",
  "companies",
  "web_vitals",
  "early_access_emails",
  "subscriptions",
  "payment_orders",
  "failed_events",
  "ingest_runs",
] as const;

// Chosen default (not provider-documented): warn when a measured dimension
// reaches 80% of its limit. Tighten or relax as launch traffic teaches us.
const WARN_FRACTION = 0.8;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const groqKey = process.env.GROQ_API_KEY;

if (!url || !serviceKey) {
  console.error("Supabase env not configured; cannot measure table growth.");
  process.exit(2);
}

let breaches = 0;

async function tableCount(table: string, sinceDays?: number): Promise<number | null> {
  let q = `${url}/rest/v1/${table}?select=*`;
  if (sinceDays) {
    const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
    q += `&created_at=gte.${since}`;
  }
  const res = await fetch(q, {
    method: "HEAD",
    headers: {
      apikey: serviceKey!,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "count=exact",
    },
  });
  const range = res.headers.get("content-range");
  if (!res.ok || !range) return null;
  return Number(range.split("/")[1]);
}

async function supabaseSection() {
  console.log("== Supabase ==");
  for (const t of SUPABASE_TABLES) {
    const total = await tableCount(t);
    if (total === null) {
      console.log(`  ${t}: count unavailable (check table name / permissions)`);
      continue;
    }
    let line = `  ${t}: ${total} rows`;
    if (t === "jobs" || t === "web_vitals") {
      const recent = await tableCount(t, 7);
      if (recent !== null) line += ` (+${recent} in 7d)`;
    }
    console.log(line);
  }
  console.log(
    "  Disk GB and egress GB are dashboard-only metrics (Owner steps in docs/capacity-headroom.md).",
  );
}

async function groqSection() {
  console.log("== Groq ==");
  if (!groqKey) {
    console.log("  GROQ_API_KEY not set; skipping (not counted as a breach).");
    return;
  }
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${groqKey}` },
  });
  if (!res.ok) {
    console.log(`  Groq /models returned ${res.status}; cannot read rate-limit headers.`);
    return;
  }
  const limitReq = Number(res.headers.get("x-ratelimit-limit-requests"));
  const remainReq = Number(res.headers.get("x-ratelimit-remaining-requests"));
  const limitTok = Number(res.headers.get("x-ratelimit-limit-tokens"));
  const remainTok = Number(res.headers.get("x-ratelimit-remaining-tokens"));
  if (!limitReq || Number.isNaN(remainReq)) {
    console.log("  Rate-limit headers absent on /models; read current limits in the Groq console.");
    return;
  }
  // Groq semantics (docs): request counters are per day, token counters per minute.
  const usedReq = limitReq - remainReq;
  const reqFrac = usedReq / limitReq;
  console.log(`  requests/day: ${usedReq} used of ${limitReq} (${(reqFrac * 100).toFixed(1)}%)`);
  if (limitTok && !Number.isNaN(remainTok)) {
    console.log(`  tokens/minute: ${limitTok - remainTok} used of ${limitTok}`);
  }
  if (reqFrac >= WARN_FRACTION) {
    console.log(`  BREACH: daily requests at ${(reqFrac * 100).toFixed(1)}% >= ${WARN_FRACTION * 100}% warning threshold (chosen default)`);
    breaches++;
  }
}

async function main() {
  await supabaseSection();
  await groqSection();
  console.log(
    breaches === 0
      ? "\nCapacity headroom OK."
      : `\n${breaches} dimension(s) past the warning threshold.`,
  );
  process.exit(breaches === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("capacity report failed:", err);
  process.exit(2);
});
