/**
 * scripts/test-shared-rate-limit-fail-closed.ts
 *
 * Verification suite for AI shared rate limiter fail-closed hardening:
 * (a) RPC error -> executeAiCore returns 503; mock callGroq and consumeSet are never called.
 * (b) RPC allows -> request proceeds normally (200 OK, Groq & consumeSet invoked).
 * (c) RPC denies -> 429 with Retry-After header unchanged.
 * (d) missing SUPABASE_URL / service key env -> same fail-closed 503 for AI.
 * (e) a public-route limiter (e.g. search) still falls back to memory as documented.
 * (f) alert dedupe emits once per 5-minute window per key class with [RATE-LIMIT-SHARED-STORE-DOWN].
 *
 * Run with: npx tsx scripts/test-shared-rate-limit-fail-closed.ts
 * Run negative control: npx tsx scripts/test-shared-rate-limit-fail-closed.ts --negative-control
 */

process.env.NODE_ENV = "test";

import assert from "assert";
import { executeAiCore, _resetAiRateLimitStore } from "../src/lib/ai/serviceHandler";
import {
  checkSharedRateLimit,
  checkSharedRateLimitStrict,
  _resetRateLimitClient,
  _resetRateLimitAlertStores,
  _getAlertDedupeStore,
  getKeyClass,
} from "../src/lib/api/sharedRateLimit";

const isNegativeControl = process.argv.includes("--negative-control");

export async function runSharedRateLimitFailClosedSuite() {
  console.log("================================================================================");
  console.log("   SHARED RATE LIMIT FAIL-CLOSED (P1 HARDENING) VERIFICATION SUITE              ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Intentionally asserting inverted expectation...");
    // Negative control: assert that an unavailable shared store returns 200 instead of 503
    (globalThis as any).__mockRateLimitClient = {
      rpc: async () => ({ data: null, error: new Error("simulated database failure") }),
    };
    const res = await executeAiCore("127.0.0.1", "Bearer valid-token", {
      operation: "resume_extraction",
      params: { rawText: "Sample candidate text" },
    });
    assert.strictEqual(
      res.statusCode,
      200,
      "Negative control expected mismatch: fail-closed must NOT return 200 on store failure!"
    );
    return;
  }

  process.env.EARLY_ACCESS_ALLOWED_EMAILS = "pro@careermonke.com";
  _resetAiRateLimitStore();
  _resetRateLimitAlertStores();
  _resetRateLimitClient();

  const mockApprovedUserDb = {
    auth: {
      getUser: async () => ({
        data: { user: { id: "user-p1-test", email: "pro@careermonke.com", user_metadata: {} } },
        error: null,
      }),
    },
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (table === "blocked_users") return { data: null, error: null };
          if (table === "early_access_approved") return { data: { approved: true }, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };

  let groqCalls = 0;
  let consumeSetCalls = 0;

  const createTestDeps = () => ({
    getSupabaseAdmin: () => mockApprovedUserDb,
    getServerEntitlement: async () => ({ isPro: true, status: "active" }),
    callGroq: async () => {
      groqCalls++;
      return "Simulated AI generated output";
    },
    consumeSet: async () => {
      consumeSetCalls++;
      return { success: true, source: "plan" as const };
    },
    isUserApproved: async () => true,
  });

  const payload = {
    operation: "resume_tailor",
    idempotencyKey: "p1-idem-key-1",
    params: {
      candidate: { name: "Alice", headline: "Engineer", skills: ["TypeScript"] },
      job: { title: "Software Engineer", company: "Acme", description: "Coding in TS" },
    },
  };

  // ---------------------------------------------------------------------------
  // (a) RPC error -> executeAiCore returns 503; mock callGroq & consumeSet never called
  // ---------------------------------------------------------------------------
  console.log("Test (a): Verifying RPC error returns 503 and halts execution before Groq/consume...");
  groqCalls = 0;
  consumeSetCalls = 0;
  (globalThis as any).__mockRateLimitClient = {
    rpc: async () => ({ data: null, error: new Error("PostgreSQL connection pool exhausted") }),
  };

  const resA = await executeAiCore("192.168.1.1", "Bearer valid-token", payload, createTestDeps());
  assert.strictEqual(resA.statusCode, 503, `Expected status 503, got ${resA.statusCode}`);
  assert.strictEqual(resA.headers?.["Retry-After"], "30", `Expected Retry-After: 30, got ${resA.headers?.["Retry-After"]}`);
  assert.strictEqual(
    resA.body?.error,
    "Service temporarily unavailable. Please retry in a moment.",
    `Expected generic unavailable error, got: ${resA.body?.error}`
  );
  assert.strictEqual(groqCalls, 0, "callGroq MUST NOT be called when rate limiter is unavailable!");
  assert.strictEqual(consumeSetCalls, 0, "consumeSet MUST NOT be called when rate limiter is unavailable!");
  console.log("  [PASS-LOCAL] (a) RPC error: 503 returned with Retry-After: 30; Groq and consumeSet never called.\n");

  // ---------------------------------------------------------------------------
  // (b) RPC allows -> request proceeds normally (200 OK, Groq & consumeSet called)
  // ---------------------------------------------------------------------------
  console.log("Test (b): Verifying RPC allows proceeds normally...");
  groqCalls = 0;
  consumeSetCalls = 0;
  (globalThis as any).__mockRateLimitClient = {
    rpc: async (fn: string) => {
      if (fn === "check_rate_limit") {
        return { data: { allowed: true, retry_after: 0, current_count: 1 }, error: null };
      }
      return { data: null, error: null };
    },
  };

  const resB = await executeAiCore("192.168.1.2", "Bearer valid-token", payload, createTestDeps());
  assert.strictEqual(resB.statusCode, 200, `Expected status 200, got ${resB.statusCode}`);
  assert.strictEqual(groqCalls, 1, "callGroq must be invoked once on allowed request");
  assert.strictEqual(consumeSetCalls, 1, "consumeSet must be invoked once on allowed request");
  console.log("  [PASS-LOCAL] (b) RPC allows: 200 OK, Groq called 1x, consumeSet charged 1x.\n");

  // ---------------------------------------------------------------------------
  // (c) RPC denies -> 429 with Retry-After header unchanged
  // ---------------------------------------------------------------------------
  console.log("Test (c): Verifying RPC denial returns 429 with Retry-After unchanged...");
  groqCalls = 0;
  consumeSetCalls = 0;
  (globalThis as any).__mockRateLimitClient = {
    rpc: async (fn: string) => {
      if (fn === "check_rate_limit") {
        return { data: { allowed: false, retry_after: 45, current_count: 21 }, error: null };
      }
      return { data: null, error: null };
    },
  };

  const resC = await executeAiCore("192.168.1.3", "Bearer valid-token", payload, createTestDeps());
  assert.strictEqual(resC.statusCode, 429, `Expected status 429, got ${resC.statusCode}`);
  assert.strictEqual(resC.headers?.["Retry-After"], "45", `Expected Retry-After: 45, got ${resC.headers?.["Retry-After"]}`);
  assert.strictEqual(groqCalls, 0, "callGroq MUST NOT be called on 429 rate limit denial!");
  assert.strictEqual(consumeSetCalls, 0, "consumeSet MUST NOT be called on 429 rate limit denial!");
  console.log("  [PASS-LOCAL] (c) RPC denies: 429 returned with exact Retry-After: 45; Groq not called.\n");

  // ---------------------------------------------------------------------------
  // (d) missing SUPABASE_URL / service key env -> same fail-closed 503 for AI
  // ---------------------------------------------------------------------------
  console.log("Test (d): Verifying missing env variables triggers fail-closed 503 for AI...");
  groqCalls = 0;
  consumeSetCalls = 0;
  delete (globalThis as any).__mockRateLimitClient;
  _resetRateLimitClient();

  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const savedBaseUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const savedServiceKey = process.env.SUPABASE_SERVICE_KEY;

  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_KEY;

  try {
    const resD = await executeAiCore("192.168.1.4", "Bearer valid-token", payload, createTestDeps());
    assert.strictEqual(resD.statusCode, 503, `Expected status 503 on unconfigured env, got ${resD.statusCode}`);
    assert.strictEqual(resD.headers?.["Retry-After"], "30", `Expected Retry-After: 30, got ${resD.headers?.["Retry-After"]}`);
    assert.strictEqual(groqCalls, 0, "callGroq MUST NOT be called when env is missing!");
    assert.strictEqual(consumeSetCalls, 0, "consumeSet MUST NOT be called when env is missing!");
    console.log("  [PASS-LOCAL] (d) Missing credentials: strict fail-closed 503 with Retry-After: 30.\n");
  } finally {
    // Restore saved env
    if (savedUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
    if (savedBaseUrl) process.env.SUPABASE_URL = savedBaseUrl;
    if (savedKey) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    if (savedServiceKey) process.env.SUPABASE_SERVICE_KEY = savedServiceKey;
    _resetRateLimitClient();
  }

  // ---------------------------------------------------------------------------
  // (e) public-route limiter (e.g. search) still falls back to memory as documented
  // ---------------------------------------------------------------------------
  console.log("Test (e): Verifying cheap public read endpoint (search) falls back to memory...");
  (globalThis as any).__mockRateLimitClient = {
    rpc: async () => ({ data: null, error: new Error("Supabase unavailable") }),
  };

  let memoryFallbackInvoked = false;
  const searchResult = await checkSharedRateLimit(
    "search:ip:10.0.0.1",
    60,
    60,
    () => {
      memoryFallbackInvoked = true;
      return { allowed: true, retryAfter: 0, currentCount: 1 };
    }
  );

  assert.strictEqual(searchResult.allowed, true, "Search rate limit must remain allowed via memory fallback");
  assert.strictEqual(searchResult.source, "memory", "Source must be 'memory' for public route fallback");
  assert.strictEqual(memoryFallbackInvoked, true, "memoryFallback callback must be invoked for public route");
  console.log("  [PASS-LOCAL] (e) Public read endpoints cleanly fall back to in-memory rate limiting.\n");

  // ---------------------------------------------------------------------------
  // (f) alert dedupe emits once per 5-minute window per key class
  // ---------------------------------------------------------------------------
  console.log("Test (f): Verifying alert dedupe emits once per 5-minute window per key class...");
  _resetRateLimitAlertStores();

  const originalConsoleError = console.error;
  const capturedErrors: string[] = [];
  console.error = (...args: any[]) => {
    capturedErrors.push(args.map((a) => String(a)).join(" "));
  };

  try {
    // Shared store is in error state
    (globalThis as any).__mockRateLimitClient = {
      rpc: async () => ({ data: null, error: new Error("simulated outage") }),
    };

    // 3 calls with same key class "ai:ip" but different IPs
    await checkSharedRateLimitStrict("ai:ip:10.1.1.1", 20, 60);
    await checkSharedRateLimitStrict("ai:ip:10.1.1.2", 20, 60);
    await checkSharedRateLimitStrict("ai:ip:10.1.1.3", 20, 60);

    const ipAlerts = capturedErrors.filter((e) => e.includes("[RATE-LIMIT-SHARED-STORE-DOWN]"));
    assert.strictEqual(
      ipAlerts.length,
      1,
      `Expected exactly 1 deduped error for 'ai:ip' class, got ${ipAlerts.length}`
    );
    assert(
      ipAlerts[0].includes("key class 'ai:ip'"),
      `Expected alert to state key class 'ai:ip', got: ${ipAlerts[0]}`
    );

    // 2 calls with different key class "ai:user"
    await checkSharedRateLimitStrict("ai:user:usr-100", 10, 60);
    await checkSharedRateLimitStrict("ai:user:usr-200", 10, 60);

    const userAlerts = capturedErrors.filter(
      (e) => e.includes("[RATE-LIMIT-SHARED-STORE-DOWN]") && e.includes("key class 'ai:user'")
    );
    assert.strictEqual(
      userAlerts.length,
      1,
      `Expected exactly 1 deduped error for 'ai:user' class, got ${userAlerts.length}`
    );

    // Total store-down alerts should now be 2 (1 for ai:ip, 1 for ai:user)
    const totalAlerts = capturedErrors.filter((e) => e.includes("[RATE-LIMIT-SHARED-STORE-DOWN]"));
    assert.strictEqual(totalAlerts.length, 2, `Expected 2 total alerts across the two classes, got ${totalAlerts.length}`);

    // Fast-forward dedupe window by resetting the timestamp in the dedupe store
    const dedupeStore = _getAlertDedupeStore();
    dedupeStore.set("ai:ip", Date.now() - 6 * 60 * 1000); // 6 minutes ago

    await checkSharedRateLimitStrict("ai:ip:10.1.1.4", 20, 60);
    const postExpiryAlerts = capturedErrors.filter(
      (e) => e.includes("[RATE-LIMIT-SHARED-STORE-DOWN]") && e.includes("key class 'ai:ip'")
    );
    assert.strictEqual(
      postExpiryAlerts.length,
      2,
      `Expected new alert after 5-minute window elapsed, got ${postExpiryAlerts.length}`
    );

    console.log("  [PASS-LOCAL] (f) Alert dedupe strictly limits [RATE-LIMIT-SHARED-STORE-DOWN] to 1 per 5m per key class.\n");
  } finally {
    console.error = originalConsoleError;
  }

  // Clean up global mock
  delete (globalThis as any).__mockRateLimitClient;
  _resetRateLimitAlertStores();
  _resetRateLimitClient();

  console.log("================================================================================");
  console.log("ALL SHARED RATE LIMIT FAIL-CLOSED (P1 HARDENING) TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

// Only invoke run when executed directly as script entrypoint
if (require.main === module || process.argv[1]?.endsWith("test-shared-rate-limit-fail-closed.ts")) {
  runSharedRateLimitFailClosedSuite().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
  });
}
