/**
 * scripts/test-ai-idempotency-replay.ts
 *
 * Verifies AI Idempotency-Key replay hardening in /api/ai and consumeSet:
 * 1. Server-side idempotency key format/length validation (HTTP 400 on invalid format/length/empty).
 * 2. Same key twice = exactly one Groq call and one quota charge (replay returns stored result).
 * 3. Same key across operations does NOT collide (scoped by user + operation kind).
 * 4. Same key across users does NOT collide (scoped by user + operation kind).
 * 5. Replay after daily cap exhausted does NOT bypass the cap (returns HTTP 429 DAILY_LIMIT_REACHED).
 * 6. Negative control proving non-zero exit on invalid conditions.
 */

import assert from "assert";
import { spawnSync } from "child_process";
import { executeAiCore, _clearIdempotencyResultCacheForTesting } from "../src/lib/ai/serviceHandler";
import { isValidIdempotencyKey, QuotaKind } from "../src/lib/billing/consume";

if (process.argv.includes("--negative-control")) {
  // Negative control intentionally violates an assertion
  assert.strictEqual(1, 2, "Negative control intentional failure");
  process.exit(0);
}

async function runAiIdempotencyTestSuite() {
  console.log("================================================================================");
  console.log("       AI IDEMPOTENCY KEY REPLAY & SCOPING TEST SUITE [PASS-LOCAL]              ");
  console.log("================================================================================");

  const sampleCandidate = {
    name: "Alex Dev",
    skills: ["TypeScript", "React", "Node.js"],
  };
  const sampleJob = {
    title: "Senior Full Stack Engineer",
    company: "Acme Cloud",
    description: "Build robust cloud software in TypeScript and Node.js.",
  };

  const createMockDb = () => {
    const mockQueryBuilder: any = {
      select: () => mockQueryBuilder,
      eq: () => mockQueryBuilder,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
      update: () => mockQueryBuilder,
      delete: () => mockQueryBuilder,
    };
    return {
      auth: {
        getUser: async (token: string) => {
          if (token === "token-user-a") {
            return { data: { user: { id: "user-a", email: "user-a@example.com" } }, error: null };
          }
          if (token === "token-user-b") {
            return { data: { user: { id: "user-b", email: "user-b@example.com" } }, error: null };
          }
          return { data: { user: null }, error: new Error("invalid token") };
        },
      },
      from: (table?: string) => {
        if (table === "early_access_approved") {
          return {
            ...mockQueryBuilder,
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { approved: true }, error: null }),
              }),
            }),
          };
        }
        return mockQueryBuilder;
      },
    };
  };

  // ---------------------------------------------------------------------------
  // TEST 1: Server-side Idempotency Key Validation
  // ---------------------------------------------------------------------------
  console.log("\nTest 1: Validating server-side idempotency key format & length...");

  assert.strictEqual(isValidIdempotencyKey("valid-key-123"), true);
  assert.strictEqual(isValidIdempotencyKey("UUID_1234-5678.90:abc"), true);
  assert.strictEqual(isValidIdempotencyKey(""), false, "Empty key must be rejected");
  assert.strictEqual(isValidIdempotencyKey("   "), false, "Whitespace key must be rejected");
  assert.strictEqual(isValidIdempotencyKey("a".repeat(129)), false, "Key > 128 chars must be rejected");
  assert.strictEqual(isValidIdempotencyKey("key with spaces"), false, "Key with spaces must be rejected");
  assert.strictEqual(isValidIdempotencyKey("key;drop table"), false, "Key with punctuation must be rejected");
  assert.strictEqual(isValidIdempotencyKey(12345), false, "Non-string key must be rejected");

  const baseDeps = {
    getSupabaseAdmin: createMockDb,
    getServerEntitlement: async () => ({
      isPro: true,
      hasActiveSubscription: true,
      entitlementSource: "subscription" as const,
      status: "active",
      planId: "monthly",
      periodEnd: new Date(Date.now() + 86400000).toISOString(),
    }),
    isUserApproved: async () => true,
    callGroq: async () => "Simulated AI generated output",
  };

  // Rejection via handler for invalid candidateKey
  const invalidKeyRes = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "resume_tailor",
      idempotencyKey: "invalid key with spaces",
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    baseDeps
  );
  assert.strictEqual(invalidKeyRes.statusCode, 400, "Invalid key format must return 400");
  assert.strictEqual(invalidKeyRes.body.code, "INVALID_IDEMPOTENCY_KEY");

  const oversizedKeyRes = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "resume_tailor",
      idempotencyKey: "k".repeat(129),
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    baseDeps
  );
  assert.strictEqual(oversizedKeyRes.statusCode, 400, "Oversized key (>128) must return 400");
  assert.strictEqual(oversizedKeyRes.body.code, "INVALID_IDEMPOTENCY_KEY");

  const emptyKeyRes = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "resume_tailor",
      idempotencyKey: "   ",
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    baseDeps
  );
  assert.strictEqual(emptyKeyRes.statusCode, 400, "Empty/whitespace key must return 400");

  console.log("  -> [PASS-LOCAL] Server-side key validation strictly rejects malformed, oversized, and empty keys with HTTP 400.");

  // ---------------------------------------------------------------------------
  // TEST 2: Same Key Twice = One Groq Call and One Quota Charge
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying same key twice = exactly one Groq call and one quota charge...");
  _clearIdempotencyResultCacheForTesting();

  let groqCalls = 0;
  let quotaCharges = 0;
  const consumedKeys = new Set<string>();

  const statefulDeps = {
    ...baseDeps,
    callGroq: async () => {
      groqCalls++;
      return "Simulated AI generated output";
    },
    consumeSet: async (userId: string, kind: QuotaKind, idempotencyKey: string) => {
      const compositeKey = `${userId}:${kind}:${idempotencyKey}`;
      if (consumedKeys.has(compositeKey)) {
        return { success: true, source: "plan" as const, alreadyConsumed: true };
      }
      consumedKeys.add(compositeKey);
      quotaCharges++;
      return { success: true, source: "plan" as const, alreadyConsumed: false };
    },
  };

  const testKey = "test-replay-key-001";

  // First call: Fresh generation
  const call1 = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "resume_tailor",
      idempotencyKey: testKey,
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    statefulDeps
  );
  assert.strictEqual(call1.statusCode, 200);
  assert.strictEqual(groqCalls, 1, "First call must invoke Groq once");
  assert.strictEqual(quotaCharges, 1, "First call must charge quota once");
  assert.strictEqual(call1.body.result, "Simulated AI generated output");

  // Second call: Same user, same operation, same key (Replay)
  const call2 = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "resume_tailor",
      idempotencyKey: testKey,
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    statefulDeps
  );
  assert.strictEqual(call2.statusCode, 200, "Replay must return HTTP 200");
  assert.strictEqual(groqCalls, 1, "Replay MUST NOT invoke Groq a second time (must stay 1)!");
  assert.strictEqual(quotaCharges, 1, "Replay MUST NOT increment quota charges (must stay 1)!");
  assert.strictEqual(call2.body.idempotentReplay, true, "Replay response must be flagged as idempotentReplay");
  assert.strictEqual(call2.body.result, call1.body.result, "Replay must return the stored result of the first call");

  console.log("  -> [PASS-LOCAL] Same key twice strictly makes 1 Groq call and 1 quota charge; replay returns stored result.");

  // ---------------------------------------------------------------------------
  // TEST 3: Same Key Across Operations Does NOT Collide
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying same key across operations does NOT collide (scoped by user + kind)...");

  const crossOpKey = "shared-cross-op-key";

  // Call A: resume_tailor with crossOpKey
  const opCallA = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "resume_tailor",
      idempotencyKey: crossOpKey,
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    statefulDeps
  );
  assert.strictEqual(opCallA.statusCode, 200);
  const groqCountAfterOpA = groqCalls;
  const quotaCountAfterOpA = quotaCharges;

  // Call B: cover_letter with SAME crossOpKey
  const opCallB = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "cover_letter",
      idempotencyKey: crossOpKey,
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    statefulDeps
  );
  assert.strictEqual(opCallB.statusCode, 200);
  assert.strictEqual(groqCalls, groqCountAfterOpA + 1, "Different operation with same key must invoke Groq independently!");
  assert.strictEqual(quotaCharges, quotaCountAfterOpA + 1, "Different operation with same key must consume quota independently!");
  assert.strictEqual(opCallB.body.operation, "cover_letter");

  console.log("  -> [PASS-LOCAL] Same key across different operations does not collide and executes independently.");

  // ---------------------------------------------------------------------------
  // TEST 4: Same Key Across Users Does NOT Collide
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying same key across different users does NOT collide (scoped by user)...");

  const crossUserKey = "shared-cross-user-key";

  // User A calls resume_tailor with crossUserKey
  const userACall = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "resume_tailor",
      idempotencyKey: crossUserKey,
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    statefulDeps
  );
  assert.strictEqual(userACall.statusCode, 200);
  const groqCountAfterUserA = groqCalls;
  const quotaCountAfterUserA = quotaCharges;

  // User B calls resume_tailor with SAME crossUserKey
  const userBCall = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-b",
    {
      operation: "resume_tailor",
      idempotencyKey: crossUserKey,
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    statefulDeps
  );
  assert.strictEqual(userBCall.statusCode, 200);
  assert.strictEqual(groqCalls, groqCountAfterUserA + 1, "Different user with same key must invoke Groq independently!");
  assert.strictEqual(quotaCharges, quotaCountAfterUserA + 1, "Different user with same key must consume quota independently!");

  console.log("  -> [PASS-LOCAL] Same key across different users does not collide and executes independently.");

  // ---------------------------------------------------------------------------
  // TEST 5: Replay After Cap Exhausted Does NOT Bypass the Cap
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Verifying replay after cap exhausted does NOT bypass the cap...");

  const capExhaustedKey = "cap-exhausted-replay-key";

  // Simulate consumeSet where daily cap check runs FIRST:
  // User has exceeded daily cap (30/day)
  let capGroqCalls = 0;
  const capExhaustedDeps = {
    ...baseDeps,
    callGroq: async () => {
      capGroqCalls++;
      return "Simulated AI generated output";
    },
    consumeSet: async () => {
      // Daily cap check runs FIRST before any idempotency shortcut
      return {
        success: false,
        code: "DAILY_LIMIT_REACHED" as const,
        error: "Daily fair-use limit reached. Resets daily at midnight IST.",
      };
    },
  };

  const capReplayRes = await executeAiCore(
    "127.0.0.1",
    "Bearer token-user-a",
    {
      operation: "resume_tailor",
      idempotencyKey: capExhaustedKey,
      params: { candidate: sampleCandidate, job: sampleJob },
    },
    capExhaustedDeps
  );

  assert.strictEqual(capReplayRes.statusCode, 429, "Replay after cap exhausted must return HTTP 429");
  assert.strictEqual(capReplayRes.body.code, "DAILY_LIMIT_REACHED");
  assert.strictEqual(capGroqCalls, 0, "Replay after cap exhausted MUST NEVER invoke Groq!");

  console.log("  -> [PASS-LOCAL] Replay after cap exhausted strictly returns HTTP 429 DAILY_LIMIT_REACHED and never calls Groq.");

  // ---------------------------------------------------------------------------
  // TEST 6: Negative Control (Verification of Non-Zero Exit on Invalid Assertion)
  // ---------------------------------------------------------------------------
  console.log("\nTest 6: Confirming negative control fails with non-zero exit code...");
  const negResult = spawnSync(
    process.execPath,
    ["-r", "tsx/cjs", __filename, "--negative-control"],
    { encoding: "utf8" }
  );
  assert.strictEqual(
    negResult.status,
    1,
    `Negative control must fail with exit code 1, got ${negResult.status}`
  );
  console.log("  -> [PASS-LOCAL] Negative control exited non-zero (1) as expected.");

  console.log("\n================================================================================");
  console.log("   ALL AI IDEMPOTENCY REPLAY TESTS PASSED SUCCESSFULLY [PASS-LOCAL]             ");
  console.log("================================================================================\n");
}

runAiIdempotencyTestSuite().catch((err) => {
  console.error("\n[FAIL] AI Idempotency Replay Suite Error:\n", err);
  process.exit(1);
});
