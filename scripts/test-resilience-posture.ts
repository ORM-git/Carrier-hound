/**
 * Ranks 45-49 (posture guard, not new capability) - locks in the reviewed
 * resilience posture so a later refactor can't silently drop it. Every
 * assertion names a real code constant or call site verified on main;
 * nothing here introduces a threshold of its own.
 *
 *   45 API Gateways: the public unauthenticated routes keep the shared
 *      rate limiter; the shared helpers exist.
 *   46 Retries: ingestion polite-fetch keeps MAX_RETRIES=2 and honors
 *      Retry-After; billing keeps its deliberate refund-instead-of-retry.
 *   47 Exponential Backoff: polite-fetch and billing subscription keep
 *      their 2^n backoff expressions.
 *   48 Event-Driven: Razorpay verify route keeps the fulfil_payment_order
 *      RPC path; webhook signature verification stays HMAC + timing-safe.
 *   49 Saga: rollbackAllQuotas compensation stays wired into the AI
 *      service handler's failure exits.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`PASS: ${label}`); }
  else { failed += 1; console.log(`FAIL: ${label}`); }
}
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function main(): void {
  // ---------- rank 45: API gateway posture (shared helpers on public routes) ----------
  check(fs.existsSync(path.join(ROOT, "src/lib/api/sharedRateLimit.ts")),
    "45: shared rate-limit helper exists (src/lib/api/sharedRateLimit.ts)");
  check(fs.existsSync(path.join(ROOT, "src/lib/api/envCheck.ts")),
    "45: shared env-check helper exists (src/lib/api/envCheck.ts)");
  for (const route of ["src/app/api/stats/route.ts", "src/app/api/ticker/route.ts", "src/app/api/early-access/route.ts"]) {
    const src = read(route);
    check(src.includes("checkSharedRateLimit"),
      `45: public route ${route.split("/").slice(-2).join("/")} keeps the shared rate limiter`);
  }

  // ---------- rank 46: retry posture ----------
  const polite = read("scripts/utils/polite-fetch.ts");
  check(/MAX_RETRIES = 2/.test(polite),
    "46: ingestion polite-fetch keeps MAX_RETRIES=2 (bounded retries)");
  check(/retryAfter/.test(polite) && /parseInt\(retryAfter/.test(polite),
    "46: polite-fetch honors the Retry-After header on 429");
  check(/refund/i.test(read("src/lib/billing/consume.ts")),
    "46: billing keeps the deliberate refund path (live payment paths do not retry)");

  // ---------- rank 47: exponential backoff posture ----------
  check(/2000 \* Math\.pow\(2, attempt\)/.test(polite),
    "47: polite-fetch keeps 2000*2^attempt backoff (Retry-After fallback)");
  check(/1500 \* Math\.pow\(2, attempt - 1\)/.test(polite),
    "47: polite-fetch keeps 1500*2^(attempt-1) backoff");
  check(/500 \* Math\.pow\(2, attempt\)/.test(read("src/lib/billing/subscription.ts")),
    "47: billing subscription keeps 500*2^attempt backoff");

  // ---------- rank 48: event-driven fulfil posture ----------
  const verify = read("src/app/api/billing/razorpay/verify/route.ts");
  check(verify.includes('"fulfil_payment_order"') || verify.includes("'fulfil_payment_order'"),
    "48: razorpay verify route keeps the fulfil_payment_order RPC (event-style fulfilment)");
  const razorpayLib = read("src/lib/billing/razorpay.ts");
  check(/createHmac\("sha256"/.test(razorpayLib) && /timingSafeEqual/.test(razorpayLib),
    "48: webhook signature verification stays HMAC-SHA256 + timing-safe comparison");

  // ---------- rank 49: saga compensation posture ----------
  const handler = read("src/lib/ai/serviceHandler.ts");
  check(/const rollbackAllQuotas = async \(\) =>/.test(handler),
    "49: rollbackAllQuotas compensation is defined in the AI service handler");
  check(/settleBudget\(0\);\s*\n\s*await rollbackAllQuotas\(\)/.test(handler),
    "49: failure exit settles budget to 0 and rolls back quotas (compensation wired)");

  // ---------- suite registration ----------
  const sr = read("scripts/suite-runner.ts");
  check(sr.includes("test-resilience-posture.ts"), "suite registered in scripts/suite-runner.ts");

  console.log(`\n[PASS-LOCAL] ${passed} resilience-posture checks passed${failed ? `; ${failed} FAILED` : ""}\n`);
  process.exit(failed ? 1 : 0);
}

main();
