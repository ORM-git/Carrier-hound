/**
 * scripts/test-groq-timeout-circuit-breaker.ts
 *
 * Verification suite for:
 * 1. Hard timeout (~25s / configurable) on upstream Groq call using AbortController.
 * 2. Guaranteed release of concurrency lease and settlement of global budget reservation on timeout.
 * 3. Circuit breaker: after 5 consecutive failures/timeouts in 60s, trips to OPEN.
 * 4. Open-circuit fast fail: returns clean 503 "AI temporarily busy" for 30s without consuming
 *    user quota, global budget, or concurrency lease.
 * 5. Half-open state after 30s cooldown: allows exactly one probe request while failing other concurrent requests.
 * 6. Half-open recovery: probe success restores circuit to CLOSED; probe failure re-opens for 30s.
 * 7. Subprocess negative control (--negative-control) exits non-zero on assertion failure.
 *
 * Run with: npx tsx scripts/test-groq-timeout-circuit-breaker.ts
 * Run negative control: npx tsx scripts/test-groq-timeout-circuit-breaker.ts --negative-control
 */

process.env.NODE_ENV = "test";
(globalThis as any).__mockRateLimitClient = {
  rpc: async () => ({
    data: { allowed: true, retry_after: 0, current_count: 1 },
    error: null,
  }),
};

import assert from "assert";
import { spawnSync } from "child_process";
import {
  GroqCircuitBreaker,
  _resetGroqCircuitBreaker,
  executeAiCore,
} from "../src/lib/ai/serviceHandler";

// -----------------------------------------------------------------------------
// Negative Control Handling
// -----------------------------------------------------------------------------
if (process.argv.includes("--negative-control")) {
  console.log("Running simulated negative control: expecting deliberate failure...");
  assert.strictEqual(
    false,
    true,
    "NEGATIVE CONTROL: Simulated assertion failure proving test harness catches failures"
  );
  process.exit(1);
}

async function runGroqTimeoutCircuitBreakerSuite() {
  console.log("================================================================================");
  console.log("       GROQ HARD TIMEOUT & CIRCUIT BREAKER VERIFICATION SUITE                   ");
  console.log("================================================================================\n");

  // Setup common environment variables
  process.env.EARLY_ACCESS_ALLOWED_EMAILS = "pro-tester@careermonke.com";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

  // ---------------------------------------------------------------------------
  // TEST 1: Hard Timeout with AbortController Releases Concurrency & Settles Budget
  // ---------------------------------------------------------------------------
  console.log("[TEST 1] Verifying hard timeout releases concurrency lease and settles global budget...");
  {
    const rpcCalls: { name: string; params: any }[] = [];
    let refundSetCalled = false;

    const mockQueryBuilder: any = {
      select: () => mockQueryBuilder,
      eq: () => mockQueryBuilder,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
      update: () => mockQueryBuilder,
      order: () => mockQueryBuilder,
      limit: () => mockQueryBuilder,
    };

    const mockAdmin: any = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-timeout-test", email: "pro-tester@careermonke.com" } },
          error: null,
        }),
      },
      from: () => mockQueryBuilder,
      rpc: async (name: string, params: any) => {
        rpcCalls.push({ name, params });
        if (name === "ai_global_budget_reserve") {
          return { data: [{ allowed: true, current_tokens: 500, remaining: 1500000 }], error: null };
        }
        if (name === "ai_concurrency_acquire") {
          return { data: true, error: null };
        }
        if (name === "ai_global_budget_settle") {
          return { data: { settled: true }, error: null };
        }
        if (name === "ai_concurrency_release") {
          return { data: { released: true }, error: null };
        }
        return { data: null, error: null };
      },
    };

    const breaker = new GroqCircuitBreaker();

    // Call with groqTimeoutMs = 30ms, while mock call takes 150ms
    const res = await executeAiCore(
      "127.0.0.1",
      "Bearer mock-token",
      {
        operation: "cover_letter",
        params: {
          candidate: { name: "Jane Doe", skills: ["TypeScript"] },
          job: { title: "Software Engineer", company: "Acme", description: "Build scalable web applications." },
        },
        idempotencyKey: `timeout_test_${Date.now()}`,
      },
      {
        getSupabaseAdmin: () => mockAdmin,
        getServerEntitlement: async () => ({ isPro: true, status: "active" }),
        circuitBreaker: breaker,
        groqTimeoutMs: 30, // Hard timeout fires at 30ms
        consumeSet: async () => ({ success: true, alreadyConsumed: false }),
        refundSet: async () => {
          refundSetCalled = true;
          return { refunded: true } as any;
        },
        callGroq: async () => {
          // Simulate hanging call that exceeds timeout
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { choices: [{ message: { content: "Late response" } }] };
        },
      }
    );

    // 1. Must fail with HTTP 502 Bad Gateway indicating timeout/failure
    assert.strictEqual(res.statusCode, 502, `Expected status 502 on timeout, got ${res.statusCode}`);
    assert.ok(
      JSON.stringify(res.body).includes("timed out") || JSON.stringify(res.body).includes("failed"),
      `Expected timeout error message in body: ${JSON.stringify(res.body)}`
    );

    // 2. Concurrency lease MUST be acquired then released
    const concurrencyAcquire = rpcCalls.find((c) => c.name === "ai_concurrency_acquire");
    const concurrencyRelease = rpcCalls.find((c) => c.name === "ai_concurrency_release");
    assert.ok(concurrencyAcquire, "ai_concurrency_acquire must be called before Groq call");
    assert.ok(concurrencyRelease, "ai_concurrency_release MUST be called when timeout fires");

    // 3. Global budget reservation MUST be reserved then settled with 0 actual tokens
    const budgetReserve = rpcCalls.find((c) => c.name === "ai_global_budget_reserve");
    const budgetSettle = rpcCalls.find((c) => c.name === "ai_global_budget_settle");
    assert.ok(budgetReserve, "ai_global_budget_reserve must be called before Groq call");
    assert.ok(budgetSettle, "ai_global_budget_settle MUST be called when timeout fires");
    assert.strictEqual(
      budgetSettle.params.p_actual,
      0,
      `ai_global_budget_settle must be called with p_actual: 0 on timeout, got ${budgetSettle.params.p_actual}`
    );

    // 4. User quota must be refunded
    assert.strictEqual(refundSetCalled, true, "User quota refundSet MUST be called on timeout");

    // 5. Breaker recorded 1 failure
    assert.strictEqual(breaker.getConsecutiveFailures(), 1, "Breaker must record consecutive failure on timeout");

    console.log("  -> [PASS-LOCAL] Hard timeout correctly releases concurrency, settles budget (0), and refunds quota.\n");
  }

  // ---------------------------------------------------------------------------
  // TEST 2: Circuit Breaker State Machine & 5 Consecutive Failures in 60s
  // ---------------------------------------------------------------------------
  console.log("[TEST 2] Verifying circuit breaker trips to OPEN after 5 consecutive failures in 60s...");
  {
    const breaker = new GroqCircuitBreaker({ failureThreshold: 5, failureWindowMs: 60000, cooldownMs: 30000 });
    const startTime = 1000000;

    // Failures 1 to 4: Breaker remains CLOSED
    for (let i = 1; i <= 4; i++) {
      breaker.recordFailure(startTime + i * 1000);
      assert.strictEqual(breaker.getState(startTime + i * 1000), "CLOSED", `Breaker should remain CLOSED at ${i} failures`);
      assert.strictEqual(breaker.canExecute(startTime + i * 1000).allowed, true, `Breaker should allow execution at ${i} failures`);
      assert.strictEqual(breaker.getConsecutiveFailures(), i, `Consecutive failures should be ${i}`);
    }

    // 5th failure within 60s: Breaker trips to OPEN
    breaker.recordFailure(startTime + 5000);
    assert.strictEqual(breaker.getState(startTime + 5000), "OPEN", "Breaker MUST trip to OPEN on 5th consecutive failure");
    assert.strictEqual(breaker.canExecute(startTime + 5000).allowed, false, "Breaker MUST NOT allow execution when OPEN");

    // Verify success resets consecutive count
    const breaker2 = new GroqCircuitBreaker({ failureThreshold: 5, failureWindowMs: 60000, cooldownMs: 30000 });
    breaker2.recordFailure(startTime + 1000);
    breaker2.recordFailure(startTime + 2000);
    breaker2.recordFailure(startTime + 3000);
    assert.strictEqual(breaker2.getConsecutiveFailures(), 3);
    breaker2.recordSuccess();
    assert.strictEqual(breaker2.getConsecutiveFailures(), 0, "Success must reset consecutive failures to 0");
    assert.strictEqual(breaker2.getState(), "CLOSED");

    // Verify failures outside 60s window do NOT trip the breaker
    const breaker3 = new GroqCircuitBreaker({ failureThreshold: 5, failureWindowMs: 60000, cooldownMs: 30000 });
    breaker3.recordFailure(startTime); // t = 0s
    breaker3.recordFailure(startTime + 10000); // t = 10s
    breaker3.recordFailure(startTime + 20000); // t = 20s
    breaker3.recordFailure(startTime + 30000); // t = 30s
    // 5th failure happens at t = 75s (the first failure at t=0s is >60s old, so only 4 are within 60s)
    breaker3.recordFailure(startTime + 75000);
    assert.strictEqual(
      breaker3.getState(startTime + 75000),
      "CLOSED",
      "Failures spanning >60s must NOT trip breaker when pruned count < 5"
    );

    console.log("  -> [PASS-LOCAL] Circuit breaker trips to OPEN strictly upon 5 consecutive failures within 60s.\n");
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Open-Circuit Fast Fail (503 "AI temporarily busy" for 30s)
  // ---------------------------------------------------------------------------
  console.log("[TEST 3] Verifying open-circuit fast fail: 503 'AI temporarily busy' without consuming resources...");
  {
    const breaker = new GroqCircuitBreaker({ failureThreshold: 5, failureWindowMs: 60000, cooldownMs: 30000 });
    const now = Date.now();

    // Trip the breaker to OPEN
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(now);
    }
    assert.strictEqual(breaker.getState(now), "OPEN");

    let quotaConsumed = false;
    let budgetReserved = false;
    let concurrencyAcquired = false;
    let groqCalled = false;

    const mockQueryBuilder: any = {
      select: () => mockQueryBuilder,
      eq: () => mockQueryBuilder,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
      update: () => mockQueryBuilder,
      order: () => mockQueryBuilder,
      limit: () => mockQueryBuilder,
    };

    const mockAdmin: any = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-circuit-open-test", email: "pro-tester@careermonke.com" } },
          error: null,
        }),
      },
      from: () => mockQueryBuilder,
      rpc: async (name: string) => {
        if (name === "ai_global_budget_reserve") budgetReserved = true;
        if (name === "ai_concurrency_acquire") concurrencyAcquired = true;
        return { data: true, error: null };
      },
    };

    // Execute request while circuit is OPEN
    const res = await executeAiCore(
      "127.0.0.1",
      "Bearer mock-token",
      {
        operation: "cover_letter",
        params: {
          candidate: { name: "Jane Doe", skills: ["TypeScript"] },
          job: { title: "Software Engineer", company: "Acme", description: "Build scalable web applications." },
        },
      },
      {
        getSupabaseAdmin: () => mockAdmin,
        getServerEntitlement: async () => ({ isPro: true, status: "active" }),
        circuitBreaker: breaker,
        consumeSet: async () => {
          quotaConsumed = true;
          return { success: true, alreadyConsumed: false };
        },
        callGroq: async () => {
          groqCalled = true;
          return { choices: [{ message: { content: "Mock" } }] };
        },
      }
    );

    // Assert fast fail 503 with exact required message
    assert.strictEqual(res.statusCode, 503, `Expected status 503 when circuit is open, got ${res.statusCode}`);
    assert.strictEqual(res.body.error, "AI temporarily busy", `Expected error 'AI temporarily busy', got '${res.body.error}'`);
    assert.strictEqual(res.headers?.["Retry-After"], "30", "Expected Retry-After header of 30s");

    // CRITICAL: Breaker must NOT consume concurrency, quota, or budget
    assert.strictEqual(quotaConsumed, false, "Breaker MUST NOT consume user quota while open");
    assert.strictEqual(budgetReserved, false, "Breaker MUST NOT reserve global budget while open");
    assert.strictEqual(concurrencyAcquired, false, "Breaker MUST NOT acquire concurrency lease while open");
    assert.strictEqual(groqCalled, false, "Groq call MUST NOT be made while open");

    console.log("  -> [PASS-LOCAL] Open-circuit fast fail: HTTP 503 'AI temporarily busy' with zero resource consumption.\n");
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Half-Open State: Exactly One Probe Allowed & Concurrent Fail Fast
  // ---------------------------------------------------------------------------
  console.log("[TEST 4] Verifying half-open state: allows one probe request; concurrent requests fail fast...");
  {
    const breaker = new GroqCircuitBreaker({ failureThreshold: 5, failureWindowMs: 60000, cooldownMs: 30000 });
    const openedAt = 1000000;

    // Trip the breaker to OPEN at t = openedAt
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(openedAt);
    }
    assert.strictEqual(breaker.getState(openedAt), "OPEN");

    // At t = openedAt + 29s: still OPEN
    assert.strictEqual(breaker.getState(openedAt + 29000), "OPEN");
    assert.strictEqual(breaker.canExecute(openedAt + 29000).allowed, false);

    // At t = openedAt + 30s: transitions to HALF_OPEN
    assert.strictEqual(breaker.getState(openedAt + 30000), "HALF_OPEN");

    // First request at t = openedAt + 30s is granted probe status
    const probeCheck = breaker.canExecute(openedAt + 30000);
    assert.strictEqual(probeCheck.allowed, true, "First request in HALF_OPEN must be allowed as probe");
    assert.strictEqual(probeCheck.isProbe, true, "First request in HALF_OPEN must be flagged as isProbe");
    assert.strictEqual(breaker.isProbeInFlight(), true, "probeInFlight must be true");

    // Second concurrent request while probe is in flight MUST be denied
    const concurrentCheck = breaker.canExecute(openedAt + 30100);
    assert.strictEqual(concurrentCheck.allowed, false, "Concurrent request while probe in flight MUST be rejected");

    // Case 4A: Probe succeeds -> Breaker resets to CLOSED
    breaker.recordSuccess();
    assert.strictEqual(breaker.getState(openedAt + 30200), "CLOSED", "Successful probe must restore circuit to CLOSED");
    assert.strictEqual(breaker.getConsecutiveFailures(), 0, "Consecutive failures must reset to 0");
    assert.strictEqual(breaker.isProbeInFlight(), false, "probeInFlight must be cleared");

    // Normal requests now succeed
    assert.strictEqual(breaker.canExecute(openedAt + 30300).allowed, true, "Normal requests must succeed once CLOSED");

    console.log("  -> [PASS-LOCAL] Half-open state gates exactly 1 probe request; probe success restores CLOSED.\n");
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Half-Open Probe Request Failure Re-Opens Circuit for 30s
  // ---------------------------------------------------------------------------
  console.log("[TEST 5] Verifying half-open probe failure re-opens circuit for 30s cooldown...");
  {
    const breaker = new GroqCircuitBreaker({ failureThreshold: 5, failureWindowMs: 60000, cooldownMs: 30000 });
    const openedAt = 1000000;

    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(openedAt);
    }
    assert.strictEqual(breaker.getState(openedAt + 30000), "HALF_OPEN");

    // Probe request is allowed
    const probe = breaker.canExecute(openedAt + 30000);
    assert.strictEqual(probe.allowed, true);
    assert.strictEqual(probe.isProbe, true);

    // Probe fails at t = openedAt + 31s
    breaker.recordFailure(openedAt + 31000);

    // Must re-open for 30s starting from t = openedAt + 31s
    assert.strictEqual(breaker.getState(openedAt + 31000), "OPEN", "Failed probe must re-open circuit");
    assert.strictEqual(breaker.canExecute(openedAt + 31500).allowed, false, "Requests must fail fast after failed probe");

    // At t = openedAt + 31s + 29s: still OPEN
    assert.strictEqual(breaker.getState(openedAt + 31000 + 29000), "OPEN");

    // At t = openedAt + 31s + 30s: enters HALF_OPEN again
    assert.strictEqual(breaker.getState(openedAt + 31000 + 30000), "HALF_OPEN");

    console.log("  -> [PASS-LOCAL] Failed probe re-opens circuit for fresh 30s cooldown.\n");
  }

  // ---------------------------------------------------------------------------
  // TEST 6: Subprocess Negative Control
  // ---------------------------------------------------------------------------
  console.log("[TEST 6] Executing subprocess negative control...");
  {
    const sub = spawnSync("npx", ["tsx", "scripts/test-groq-timeout-circuit-breaker.ts", "--negative-control"], {
      encoding: "utf-8",
      shell: true,
    });
    assert.strictEqual(sub.status, 1, `Negative control process must exit with code 1, got ${sub.status}`);
    assert.ok(
      sub.stdout.includes("NEGATIVE CONTROL") || sub.stderr.includes("NEGATIVE CONTROL"),
      "Negative control output must reference NEGATIVE CONTROL failure"
    );
    console.log("  -> [PASS-LOCAL] Negative control verified: exited non-zero as expected.\n");
  }

  console.log("================================================================================");
  console.log("ALL 6 GROQ HARD TIMEOUT & CIRCUIT BREAKER CHECKS PASSED [PASS-LOCAL]            ");
  console.log("================================================================================\n");
}

runGroqTimeoutCircuitBreakerSuite().catch((err) => {
  console.error("FATAL SUITE FAILURE:", err);
  process.exit(1);
});
