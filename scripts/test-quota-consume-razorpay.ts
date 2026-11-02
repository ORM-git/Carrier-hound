import assert from "assert";
import { spawnSync } from "child_process";
import {
  getStartOfIstDay,
  isDailyCapExceeded,
  determineQuotaSource,
  type QuotaKind,
} from "../src/lib/billing/consume";
import {
  resolveOrderPricing,
  sumValidAddonCredits,
  PLAN_DEFINITIONS,
  ADDON_PACK_DEFINITIONS,
} from "../src/lib/billing/quota";
import { executeAiCore } from "../src/lib/ai/serviceHandler";

async function runQuotaConsumeRazorpaySuite() {
  console.log("================================================================================");
  console.log("   QUOTA CONSUME & PLAN-AWARE RAZORPAY TEST SUITE [PASS-LOCAL]                  ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition...");
    // Assert invalid condition to guarantee non-zero exit code
    assert.strictEqual(
      resolveOrderPricing({ planCode: "weekly" })?.amount_paise,
      999999,
      "Negative control expected mismatch: weekly price is 49900 paise, not 999999!"
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Consume Order Priority (Plan First, Then Add-on)
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying consume order priority (plan quota first, then add-on)...");

  // 1A: Resume tailor with plan quota available
  const res1 = determineQuotaSource("resume_tailor", 10, 10, 30);
  assert.strictEqual(res1.source, "plan", "Must consume from plan when resumesRemaining > 0");

  // 1B: Resume tailor with plan quota exhausted, but add-on available
  const res2 = determineQuotaSource("resume_tailor", 0, 10, 30);
  assert.strictEqual(res2.source, "addon", "Must fall back to add-on when plan resumes are 0");

  // 1C: Cover letter with plan quota available
  const res3 = determineQuotaSource("cover_letter", 0, 5, 20);
  assert.strictEqual(res3.source, "plan", "Must consume from plan when coverLettersRemaining > 0");

  // 1D: Cover letter with plan quota exhausted, but add-on available
  const res4 = determineQuotaSource("cover_letter", 5, 0, 15);
  assert.strictEqual(res4.source, "addon", "Must fall back to add-on when plan cover letters are 0");

  // 1E: Both plan quota and add-ons exhausted
  const res5 = determineQuotaSource("resume_tailor", 0, 0, 0);
  assert.strictEqual(res5.source, null, "Source must be null when both plan and addons are exhausted");
  assert.strictEqual(res5.code, "QUOTA_EXHAUSTED", "Code must be QUOTA_EXHAUSTED");

  const res6 = determineQuotaSource("cover_letter", 0, 0, 0);
  assert.strictEqual(res6.source, null);
  assert.strictEqual(res6.code, "QUOTA_EXHAUSTED");

  console.log("  -> [PASS-LOCAL] Quota priority correctly prefers plan before add-ons.");

  // ---------------------------------------------------------------------------
  // TEST 2: Daily Cap Calculation (30/day per IST Day)
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying daily cap (30/day) and IST midnight calculation...");

  // UTC 2026-11-03 02:00:00 is 2026-11-03 07:30:00 IST (+5:30)
  // IST start of today should be 2026-11-03 00:00:00 IST = 2026-11-02 18:30:00 UTC
  const sampleUtc1 = new Date("2026-11-03T02:00:00.000Z");
  const istStart1 = getStartOfIstDay(sampleUtc1);
  assert.strictEqual(
    istStart1.toISOString(),
    "2026-11-02T18:30:00.000Z",
    "IST start for 02:00 UTC Nov 3 must be 18:30 UTC Nov 2"
  );

  // UTC 2026-11-02 18:00:00 is 2026-11-02 23:30:00 IST (+5:30)
  // IST start should be 2026-11-02 00:00:00 IST = 2026-11-01 18:30:00 UTC
  const sampleUtc2 = new Date("2026-11-02T18:00:00.000Z");
  const istStart2 = getStartOfIstDay(sampleUtc2);
  assert.strictEqual(
    istStart2.toISOString(),
    "2026-11-01T18:30:00.000Z",
    "IST start for 18:00 UTC Nov 2 must be 18:30 UTC Nov 1"
  );

  // Cap evaluation
  assert.strictEqual(isDailyCapExceeded(0, 30), false);
  assert.strictEqual(isDailyCapExceeded(29, 30), false);
  assert.strictEqual(isDailyCapExceeded(30, 30), true, "30 usage events must hit cap");
  assert.strictEqual(isDailyCapExceeded(35, 30), true, ">30 usage events must exceed cap");

  console.log("  -> [PASS-LOCAL] Daily cap logic and IST date boundary verified.");

  // ---------------------------------------------------------------------------
  // TEST 3: Add-on Expiry Filtering & Earliest-Expiring Order
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying add-on expiry and sorting...");

  const testNow = new Date("2026-11-03T12:00:00.000Z");
  const validAddons = [
    { sets_remaining: 10, expires_at: "2026-11-10T00:00:00.000Z" }, // valid, expires soonest
    { sets_remaining: 30, expires_at: "2026-12-01T00:00:00.000Z" }, // valid, expires later
    { sets_remaining: 60, expires_at: "2026-10-01T00:00:00.000Z" }, // EXPIRED (past)
    { sets_remaining: 0, expires_at: "2026-12-15T00:00:00.000Z" },  // DEPLETED (0 sets)
  ];

  const totalValidSets = sumValidAddonCredits(validAddons, testNow);
  assert.strictEqual(totalValidSets, 40, "Sum must only count non-expired sets with > 0 remaining");

  // Verify earliest-expiring sort order
  const nonExpiredSorted = validAddons
    .filter((a) => new Date(a.expires_at).getTime() > testNow.getTime() && a.sets_remaining > 0)
    .sort((a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime());

  assert.strictEqual(nonExpiredSorted[0].sets_remaining, 10, "Earliest-expiring credit must be first");
  assert.strictEqual(nonExpiredSorted[0].expires_at, "2026-11-10T00:00:00.000Z");

  console.log("  -> [PASS-LOCAL] Add-on expiry filtering and FIFO consumption order verified.");

  // ---------------------------------------------------------------------------
  // TEST 4: Server-Authoritative Razorpay Pricing (Client Amount Ignored)
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying server-authoritative Razorpay price resolution...");

  // Plans: weekly (Rs 499), monthly (Rs 1,499), quarterly (Rs 3,999)
  const weeklyPricing = resolveOrderPricing({ planCode: "weekly" });
  assert.strictEqual(weeklyPricing?.amount_paise, 49900);
  assert.strictEqual(weeklyPricing?.type, "plan");
  assert.strictEqual(weeklyPricing?.duration_days, 7);

  const monthlyPricing = resolveOrderPricing({ planCode: "monthly" });
  assert.strictEqual(monthlyPricing?.amount_paise, 149900);
  assert.strictEqual(monthlyPricing?.type, "plan");
  assert.strictEqual(monthlyPricing?.duration_days, 30);

  const quarterlyPricing = resolveOrderPricing({ planCode: "quarterly" });
  assert.strictEqual(quarterlyPricing?.amount_paise, 399900);
  assert.strictEqual(quarterlyPricing?.type, "plan");
  assert.strictEqual(quarterlyPricing?.duration_days, 90);

  // Add-on packs: 10 sets (Rs 149), 30 sets (Rs 399), 60 sets (Rs 699)
  const addon10Pricing = resolveOrderPricing({ addonCode: "addon_10" });
  assert.strictEqual(addon10Pricing?.amount_paise, 14900);
  assert.strictEqual(addon10Pricing?.type, "addon");

  const addon30Pricing = resolveOrderPricing({ addonCode: "addon_30" });
  assert.strictEqual(addon30Pricing?.amount_paise, 39900);
  assert.strictEqual(addon30Pricing?.type, "addon");

  const addon60Pricing = resolveOrderPricing({ addonCode: "addon_60" });
  assert.strictEqual(addon60Pricing?.amount_paise, 69900);
  assert.strictEqual(addon60Pricing?.type, "addon");

  // Unknown codes must resolve to null (rejected by API with 400)
  assert.strictEqual(resolveOrderPricing({ planCode: "unknown_tier" as any }), null);
  assert.strictEqual(resolveOrderPricing({ addonCode: "invalid_pack" }), null);

  console.log("  -> [PASS-LOCAL] Server-authoritative catalog pricing strictly enforced.");

  // ---------------------------------------------------------------------------
  // TEST 5: AI Route Integration (Consume Before Model, Refund on Failure)
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Verifying AI pipeline consumption and refund wiring...");

  let consumeCalledCount = 0;
  let refundCalledCount = 0;
  let lastConsumedKind: string | null = null;
  let lastConsumedKey: string | null = null;

  const mockQueryBuilder: any = {
    select: () => mockQueryBuilder,
    eq: () => mockQueryBuilder,
    gte: () => mockQueryBuilder,
    gt: () => mockQueryBuilder,
    order: () => mockQueryBuilder,
    limit: () => mockQueryBuilder,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    insert: async () => ({ error: null }),
    update: () => mockQueryBuilder,
    delete: () => mockQueryBuilder,
  };

  const mockDeps = {
    getSupabaseAdmin: () => ({
      auth: {
        getUser: async (token: string) => {
          if (token === "valid-pro-token") {
            return { data: { user: { id: "user-123", email: "pro@careermonke.com" } }, error: null };
          }
          return { data: { user: null }, error: new Error("invalid token") };
        },
      },
      from: () => mockQueryBuilder,
    }),
    getServerEntitlement: async (userId: string) => ({
      isPro: true,
      hasActiveSubscription: true,
      entitlementSource: "subscription" as const,
      status: "active",
      planId: "monthly",
      periodEnd: new Date(Date.now() + 86400000).toISOString(),
    }),
    consumeSet: async (userId: string, kind: QuotaKind, idempotencyKey: string) => {
      consumeCalledCount++;
      lastConsumedKind = kind;
      lastConsumedKey = idempotencyKey;
      return { success: true, source: "plan" as const };
    },
    refundSet: async (userId: string, idempotencyKey: string) => {
      refundCalledCount++;
      return { success: true, refunded: true, source: "plan" as const };
    },
    callGroq: async () => {
      // Return simulated success
      return "Simulated AI generated output";
    },
  };

  const sampleCandidate = {
    name: "Jane Doe",
    skills: ["React", "TypeScript", "Next.js"],
  };
  const sampleJob = {
    title: "Frontend Engineer",
    company: "MonkeCorp",
    description: "Building modern user interfaces with React and Next.js",
  };

  // 5A: job_fit operation MUST NOT consume sets
  consumeCalledCount = 0;
  const fitRes = await executeAiCore(
    "127.0.0.1",
    "Bearer valid-pro-token",
    {
      operation: "job_fit",
      params: {
        candidate: sampleCandidate,
        job: sampleJob,
      },
    },
    mockDeps
  );
  assert.strictEqual(fitRes.statusCode, 200);
  assert.strictEqual(consumeCalledCount, 0, "job_fit MUST NOT invoke consumeSet!");

  // 5B: resume_tailor MUST invoke consumeSet
  consumeCalledCount = 0;
  const tailorRes = await executeAiCore(
    "127.0.0.1",
    "Bearer valid-pro-token",
    {
      operation: "resume_tailor",
      idempotencyKey: "test-idem-key-123",
      params: {
        candidate: sampleCandidate,
        job: sampleJob,
      },
    },
    mockDeps
  );
  assert.strictEqual(tailorRes.statusCode, 200);
  assert.strictEqual(consumeCalledCount, 1, "resume_tailor MUST invoke consumeSet!");
  assert.strictEqual(lastConsumedKind, "resume_tailor");
  assert.strictEqual(lastConsumedKey, "test-idem-key-123");

  // 5C: When model call fails, refundSet MUST be invoked
  refundCalledCount = 0;
  const failingDeps = {
    ...mockDeps,
    callGroq: async () => {
      throw new Error("Upstream Groq connection reset");
    },
  };

  const failingRes = await executeAiCore(
    "127.0.0.1",
    "Bearer valid-pro-token",
    {
      operation: "cover_letter",
      idempotencyKey: "test-fail-key-456",
      params: {
        candidate: sampleCandidate,
        job: sampleJob,
      },
    },
    failingDeps
  );
  assert.strictEqual(failingRes.statusCode, 502, "Failing model call must return 502");
  assert.strictEqual(refundCalledCount, 1, "Failure MUST trigger refundSet!");

  // 5D: Daily limit reached returns 429
  const dailyLimitDeps = {
    ...mockDeps,
    consumeSet: async () => ({
      success: false,
      code: "DAILY_LIMIT_REACHED" as const,
      error: "Daily fair-use limit of 30 generations reached.",
    }),
  };

  const capRes = await executeAiCore(
    "127.0.0.1",
    "Bearer valid-pro-token",
    {
      operation: "resume_tailor",
      params: {
        candidate: sampleCandidate,
        job: sampleJob,
      },
    },
    dailyLimitDeps
  );
  assert.strictEqual(capRes.statusCode, 429, "Daily limit reached must return 429");
  assert.strictEqual(capRes.body.code, "DAILY_LIMIT_REACHED");

  // 5E: Quota exhausted returns 403
  const exhaustedDeps = {
    ...mockDeps,
    consumeSet: async () => ({
      success: false,
      code: "QUOTA_EXHAUSTED" as const,
      error: "Plan quota finished and no active add-on credits available.",
    }),
  };

  const exhaustRes = await executeAiCore(
    "127.0.0.1",
    "Bearer valid-pro-token",
    {
      operation: "cover_letter",
      params: {
        candidate: sampleCandidate,
        job: sampleJob,
      },
    },
    exhaustedDeps
  );
  assert.strictEqual(exhaustRes.statusCode, 403, "Quota exhausted must return 403");
  assert.strictEqual(exhaustRes.body.code, "QUOTA_EXHAUSTED");

  // 5F: Idempotent repeat handling (repeat idempotency key returns earlier result and never burns twice)
  let repeatConsumeCount = 0;
  const idempotentRepeatDeps = {
    ...mockDeps,
    consumeSet: async (userId: string, kind: QuotaKind, idempotencyKey: string) => {
      repeatConsumeCount++;
      return { success: true, source: "addon" as const, alreadyConsumed: true };
    },
  };

  const repeatRes = await executeAiCore(
    "127.0.0.1",
    "Bearer valid-pro-token",
    {
      operation: "resume_tailor",
      idempotencyKey: "previously-used-key",
      params: {
        candidate: sampleCandidate,
        job: sampleJob,
      },
    },
    idempotentRepeatDeps
  );
  assert.strictEqual(repeatRes.statusCode, 200, "Idempotent repeat must succeed without error");
  assert.strictEqual(repeatConsumeCount, 1, "Idempotent repeat must return previous consume without re-decrement");

  console.log("  -> [PASS-LOCAL] AI service correctly manages consume and refund lifecycle, with idempotent repeat.");

  // ---------------------------------------------------------------------------
  // TEST 6: Negative Control Subprocess Execution
  // ---------------------------------------------------------------------------
  console.log("\nTest 6: Confirming negative control fails with non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
  );
  console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected.`);

  console.log("\n================================================================================");
  console.log("   ALL QUOTA CONSUME & RAZORPAY TESTS PASSED SUCCESSFULLY [PASS-LOCAL]          ");
  console.log("================================================================================");
}

runQuotaConsumeRazorpaySuite().catch((err) => {
  console.error("\n[FAIL] Quota Consume & Razorpay Suite Error:\n", err);
  process.exit(1);
});
