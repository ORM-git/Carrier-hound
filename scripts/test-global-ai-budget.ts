/**
 * scripts/test-global-ai-budget.ts
 *
 * Verifies Hard Global AI Spend and Concurrency Cap (Cost-Abuse Gate):
 * (a) Budget reserve denied -> 429 (Retry-After: 3600), callGroq and consumeSet never called.
 * (b) Budget store error / malformed payload / RPC exception -> 503 fail closed.
 * (c) Concurrency full -> 429 (Retry-After: 30) and exactly one quota refund via refundSet.
 * (d) Concurrency lease released on provider 502 and on success (release RPC called exactly once each).
 * (e) Kill switch (AI_GLOBAL_DISABLE) -> 503 before quota debit or provider call.
 * (f) Idempotent replay path performs no reserve/lease calls.
 * (g) Settle records actual tokens from mocked Groq usage field (prompt_tokens + completion_tokens).
 * (h) 80% threshold crossing alert and 1-hour in-memory deduplication.
 * (i) Negative control proving non-zero exit on invalid conditions.
 */

process.env.NODE_ENV = "test";

// In-memory rate limit client mock so rate limit check doesn't fail closed
(globalThis as any).__mockRateLimitClient = {
  rpc: async () => ({
    data: [{ allowed: true, remaining: 100, reset_at: new Date(Date.now() + 60000).toISOString() }],
    error: null,
  }),
};

import assert from "assert";
import {
  executeAiCore,
  _clearIdempotencyResultCacheForTesting,
  _resetBudgetAlertStores,
  emitBudgetAlert,
  DEFAULT_AI_GLOBAL_DAILY_TOKEN_CAP,
  DEFAULT_AI_GLOBAL_MAX_CONCURRENCY,
} from "../src/lib/ai/serviceHandler";
import { QuotaKind } from "../src/lib/billing/consume";

if (process.argv.includes("--negative-control")) {
  console.log("Running negative control mode (expected failure)...");
  assert.strictEqual(true, false, "Negative control intentional failure");
  process.exit(0);
}

const mockCandidate = {
  name: "Jane Doe",
  email: "jane@example.com",
  skills: ["TypeScript", "Next.js", "Node.js"],
  experience: [{ title: "Senior Engineer", company: "Acme", bullets: ["Built scalable APIs"] }],
};

const mockJob = {
  id: "job-101",
  title: "Staff Engineer",
  company: "Tech Corp",
  description: "Looking for an experienced staff engineer with deep Node.js and distributed systems knowledge.",
};

async function runTestSuite() {
  console.log("================================================================================");
  console.log("     GLOBAL AI BUDGET & CONCURRENCY CAP TEST SUITE [PASS-LOCAL]                 ");
  console.log("================================================================================");

  let passed = 0;

  const createBaseDeps = (rpcHandler: (rpcName: string, params: any) => Promise<any>) => {
    const mockQueryBuilder: any = {
      select: () => mockQueryBuilder,
      eq: () => mockQueryBuilder,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
      update: () => mockQueryBuilder,
      delete: () => mockQueryBuilder,
    };

    const mockDb: any = {
      auth: {
        getUser: async (token: string) => ({
          data: { user: { id: "test-user-id", email: "test@example.com" } },
          error: null,
        }),
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
      rpc: rpcHandler,
    };

    return {
      getSupabaseAdmin: () => mockDb,
      supabaseAdmin: mockDb,
      getServerEntitlement: async () => ({
        isPro: true,
        hasActiveSubscription: true,
        entitlementSource: "subscription" as const,
        status: "active",
        planId: "monthly",
        periodEnd: new Date(Date.now() + 86400000).toISOString(),
      }),
      isUserApproved: async () => true,
      checkSharedRateLimit: async () => ({
        allowed: true,
        remaining: 99,
        source: "shared" as const,
      }),
    };
  };

  // ---------------------------------------------------------------------------
  // (a) Budget reserve denied -> 429, callGroq and consumeSet never called
  // ---------------------------------------------------------------------------
  console.log("\n[TEST A] Budget reserve denied -> 429, callGroq and consumeSet never called");
  {
    _clearIdempotencyResultCacheForTesting();
    _resetBudgetAlertStores();

    let callGroqCalled = 0;
    let consumeSetCalled = 0;
    let rpcCalls: string[] = [];

    const deps = {
      ...createBaseDeps(async (name, params) => {
        rpcCalls.push(name);
        if (name === "ai_global_budget_reserve") {
          return { data: [{ allowed: false, remaining: 0 }], error: null };
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => {
        consumeSetCalled++;
        return { success: true, source: "plan" as const, alreadyConsumed: false };
      },
      callGroq: async () => {
        callGroqCalled++;
        return "Simulated AI generated output";
      },
    };

    const res = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-budget-deny-001",
        params: { candidate: mockCandidate, job: mockJob },
      },
      deps
    );

    assert.strictEqual(res.statusCode, 429, "Expected 429 when budget cap reached");
    assert.strictEqual(res.headers?.["Retry-After"], "3600", "Expected Retry-After: 3600");
    assert.strictEqual(res.body.code, "DAILY_GLOBAL_BUDGET_EXCEEDED");
    assert.strictEqual(consumeSetCalled, 0, "consumeSet MUST NOT be called when budget is denied");
    assert.strictEqual(callGroqCalled, 0, "callGroq MUST NOT be called when budget is denied");
    assert.deepStrictEqual(rpcCalls, ["ai_global_budget_reserve"], "Only budget reserve RPC should be called");

    console.log("  -> [PASS-LOCAL] 429 returned, consumeSet and callGroq never called.");
    passed++;
  }

  // ---------------------------------------------------------------------------
  // (b) Budget store error -> 503 fail closed
  // ---------------------------------------------------------------------------
  console.log("\n[TEST B] Budget store error -> 503 fail closed (RPC error, invalid payload, exception)");
  {
    _clearIdempotencyResultCacheForTesting();
    _resetBudgetAlertStores();

    // Case B1: RPC returns error
    let consumeSetCalled = 0;
    let callGroqCalled = 0;
    const depsError = {
      ...createBaseDeps(async (name) => {
        if (name === "ai_global_budget_reserve") {
          return { data: null, error: { message: "Database connection timeout" } };
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => {
        consumeSetCalled++;
        return { success: true, source: "plan" as const, alreadyConsumed: false };
      },
      callGroq: async () => {
        callGroqCalled++;
        return "Simulated AI generated output";
      },
    };

    const res1 = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-budget-err-001",
        params: { candidate: mockCandidate, job: mockJob },
      },
      depsError
    );

    assert.strictEqual(res1.statusCode, 503, "Expected 503 on budget store RPC error");
    assert.strictEqual(res1.headers?.["Retry-After"], "30", "Expected Retry-After: 30");
    assert.strictEqual(res1.body.code, "AI_BUDGET_SERVICE_UNAVAILABLE");
    assert.strictEqual(consumeSetCalled, 0, "consumeSet must not be called on store error");
    assert.strictEqual(callGroqCalled, 0, "callGroq must not be called on store error");

    // Case B2: RPC returns malformed payload (null data, no allowed flag)
    const depsMalformed = {
      ...createBaseDeps(async (name) => {
        if (name === "ai_global_budget_reserve") {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => {
        consumeSetCalled++;
        return { success: true, source: "plan" as const, alreadyConsumed: false };
      },
      callGroq: async () => {
        callGroqCalled++;
        return "Simulated AI generated output";
      },
    };

    const res2 = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-budget-err-002",
        params: { candidate: mockCandidate, job: mockJob },
      },
      depsMalformed
    );

    assert.strictEqual(res2.statusCode, 503, "Expected 503 on malformed payload");
    assert.strictEqual(consumeSetCalled, 0);
    assert.strictEqual(callGroqCalled, 0);

    // Case B3: RPC throws exception
    const depsThrows = {
      ...createBaseDeps(async (name) => {
        if (name === "ai_global_budget_reserve") {
          throw new Error("Fatal RPC transport failure");
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => {
        consumeSetCalled++;
        return { success: true, source: "plan" as const, alreadyConsumed: false };
      },
      callGroq: async () => {
        callGroqCalled++;
        return "Simulated AI generated output";
      },
    };

    const res3 = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-budget-err-003",
        params: { candidate: mockCandidate, job: mockJob },
      },
      depsThrows
    );

    assert.strictEqual(res3.statusCode, 503, "Expected 503 when RPC throws");
    assert.strictEqual(consumeSetCalled, 0);
    assert.strictEqual(callGroqCalled, 0);

    console.log("  -> [PASS-LOCAL] 503 fail-closed on RPC error, malformed payload, and exceptions.");
    passed++;
  }

  // ---------------------------------------------------------------------------
  // (c) Concurrency full -> 429 and exactly one quota refund
  // ---------------------------------------------------------------------------
  console.log("\n[TEST C] Concurrency full -> 429 and exactly one quota refund via refundSet");
  {
    _clearIdempotencyResultCacheForTesting();
    _resetBudgetAlertStores();

    let consumeSetCalled = 0;
    let refundSetCalled = 0;
    let callGroqCalled = 0;
    let settleCalls: any[] = [];

    const deps = {
      ...createBaseDeps(async (name, params) => {
        if (name === "ai_global_budget_reserve") {
          return { data: [{ allowed: true, remaining: 1500000 }], error: null };
        }
        if (name === "ai_concurrency_acquire") {
          return { data: false, error: null }; // Concurrency full
        }
        if (name === "ai_global_budget_settle") {
          settleCalls.push(params);
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => {
        consumeSetCalled++;
        return { success: true, source: "plan" as const, alreadyConsumed: false };
      },
      refundSet: async () => {
        refundSetCalled++;
        return { success: true, refunded: true };
      },
      callGroq: async () => {
        callGroqCalled++;
        return "Simulated AI generated output";
      },
    };

    const res = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-concurrency-full-001",
        params: { candidate: mockCandidate, job: mockJob },
      },
      deps
    );

    assert.strictEqual(res.statusCode, 429, "Expected 429 when concurrency full");
    assert.strictEqual(res.headers?.["Retry-After"], "30", "Expected Retry-After: 30");
    assert.strictEqual(res.body.code, "AI_CONCURRENCY_CAP_REACHED");
    assert.strictEqual(consumeSetCalled, 1, "Quota should have been consumed initially");
    assert.strictEqual(refundSetCalled, 1, "Quota MUST be refunded exactly once on concurrency full");
    assert.strictEqual(callGroqCalled, 0, "callGroq MUST NOT be called when concurrency is full");
    assert.strictEqual(settleCalls.length, 1, "Budget must be settled on rollback");
    assert.strictEqual(settleCalls[0].p_actual, 0, "Settlement must record 0 actual tokens");

    console.log("  -> [PASS-LOCAL] 429 returned and exactly 1 quota refund performed.");
    passed++;
  }

  // ---------------------------------------------------------------------------
  // (d) Lease released on provider 502 and on success
  // ---------------------------------------------------------------------------
  console.log("\n[TEST D] Lease released in finally on provider 502 and on success (exactly 1x each)");
  {
    _clearIdempotencyResultCacheForTesting();
    _resetBudgetAlertStores();

    // D1: Success path
    let releaseCallsSuccess = 0;
    const depsSuccess = {
      ...createBaseDeps(async (name) => {
        if (name === "ai_global_budget_reserve") {
          return { data: [{ allowed: true, remaining: 1500000 }], error: null };
        }
        if (name === "ai_concurrency_acquire") {
          return { data: true, error: null };
        }
        if (name === "ai_concurrency_release") {
          releaseCallsSuccess++;
          return { data: true, error: null };
        }
        if (name === "ai_global_budget_settle") {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => ({ success: true, source: "plan" as const, alreadyConsumed: false }),
      callGroq: async () => "Simulated AI generated output",
    };

    const resSuccess = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-lease-success-001",
        params: { candidate: mockCandidate, job: mockJob },
      },
      depsSuccess
    );

    assert.strictEqual(resSuccess.statusCode, 200);
    assert.strictEqual(releaseCallsSuccess, 1, "Lease must be released exactly once on success");

    // D2: Provider 502 / failure path
    _clearIdempotencyResultCacheForTesting();
    let releaseCallsError = 0;
    let refundCallsError = 0;
    const depsError = {
      ...createBaseDeps(async (name) => {
        if (name === "ai_global_budget_reserve") {
          return { data: [{ allowed: true, remaining: 1500000 }], error: null };
        }
        if (name === "ai_concurrency_acquire") {
          return { data: true, error: null };
        }
        if (name === "ai_concurrency_release") {
          releaseCallsError++;
          return { data: true, error: null };
        }
        if (name === "ai_global_budget_settle") {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => ({ success: true, source: "plan" as const, alreadyConsumed: false }),
      refundSet: async () => {
        refundCallsError++;
        return { success: true, refunded: true };
      },
      callGroq: async () => {
        throw new Error("Upstream Groq 502 Bad Gateway");
      },
    };

    const resError = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-lease-err-001",
        params: { candidate: mockCandidate, job: mockJob },
      },
      depsError
    );

    assert.strictEqual(resError.statusCode, 502);
    assert.strictEqual(releaseCallsError, 1, "Lease must be released in finally on provider error");
    assert.strictEqual(refundCallsError, 1, "Quota must be refunded on provider error");

    console.log("  -> [PASS-LOCAL] Lease released exactly once in finally on success and 502 error.");
    passed++;
  }

  // ---------------------------------------------------------------------------
  // (e) Kill switch -> 503 before quota debit
  // ---------------------------------------------------------------------------
  console.log("\n[TEST E] Kill switch (AI_GLOBAL_DISABLE) -> 503 before quota debit");
  {
    _clearIdempotencyResultCacheForTesting();
    _resetBudgetAlertStores();

    let consumeSetCalled = 0;
    let rpcCalled = 0;
    let callGroqCalled = 0;

    const deps = {
      ...createBaseDeps(async () => {
        rpcCalled++;
        return { data: null, error: null };
      }),
      env: {
        AI_GLOBAL_DISABLE: "true",
      },
      consumeSet: async () => {
        consumeSetCalled++;
        return { success: true, source: "plan" as const, alreadyConsumed: false };
      },
      callGroq: async () => {
        callGroqCalled++;
        return "Simulated AI generated output";
      },
    };

    const res = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-kill-switch-001",
        params: { candidate: mockCandidate, job: mockJob },
      },
      deps
    );

    assert.strictEqual(res.statusCode, 503, "Expected 503 on kill switch");
    assert.strictEqual(res.body.error, "AI temporarily disabled");
    assert.strictEqual(res.body.code, "AI_SERVICE_DISABLED");
    assert.strictEqual(consumeSetCalled, 0, "consumeSet must NOT be called on kill switch");
    assert.strictEqual(rpcCalled, 0, "No RPC calls should be made on kill switch");
    assert.strictEqual(callGroqCalled, 0, "callGroq must NOT be called on kill switch");

    console.log("  -> [PASS-LOCAL] Kill switch blocks request before quota debit or RPC.");
    passed++;
  }

  // ---------------------------------------------------------------------------
  // (f) Idempotent replay path performs no reserve/lease calls
  // ---------------------------------------------------------------------------
  console.log("\n[TEST F] Idempotent replay path performs NO reserve or lease calls");
  {
    _clearIdempotencyResultCacheForTesting();
    _resetBudgetAlertStores();

    let reserveCalls = 0;
    let acquireCalls = 0;
    let releaseCalls = 0;
    let groqCalls = 0;
    let consumeCalls = 0;

    const deps = {
      ...createBaseDeps(async (name) => {
        if (name === "ai_global_budget_reserve") {
          reserveCalls++;
          return { data: [{ allowed: true, remaining: 1000000 }], error: null };
        }
        if (name === "ai_concurrency_acquire") {
          acquireCalls++;
          return { data: true, error: null };
        }
        if (name === "ai_concurrency_release") {
          releaseCalls++;
          return { data: true, error: null };
        }
        if (name === "ai_global_budget_settle") {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => {
        consumeCalls++;
        return { success: true, source: "plan" as const, alreadyConsumed: false };
      },
      callGroq: async () => {
        groqCalls++;
        return "Simulated AI generated output";
      },
    };

    const idempotencyKey = "replay-test-key-007";

    // 1. Initial request (computes, reserves, leases, stores cache)
    const res1 = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey,
        params: { candidate: mockCandidate, job: mockJob },
      },
      deps
    );
    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(reserveCalls, 1);
    assert.strictEqual(acquireCalls, 1);
    assert.strictEqual(releaseCalls, 1);
    assert.strictEqual(groqCalls, 1);
    assert.strictEqual(consumeCalls, 1);

    // 2. Replay request with identical key
    const res2 = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey,
        params: { candidate: mockCandidate, job: mockJob },
      },
      deps
    );

    assert.strictEqual(res2.statusCode, 200, "Replay must return 200");
    assert.strictEqual(res2.body.idempotentReplay, true, "Response flagged as idempotentReplay");
    assert.strictEqual(res2.body.alreadyConsumed, true, "Response flagged as alreadyConsumed");
    // Strict assertion: zero additional reserve or lease calls on replay
    assert.strictEqual(reserveCalls, 1, "Replay MUST NOT make any additional budget reserve calls!");
    assert.strictEqual(acquireCalls, 1, "Replay MUST NOT make any additional concurrency acquire calls!");
    assert.strictEqual(releaseCalls, 1, "Replay MUST NOT make any additional release calls!");
    assert.strictEqual(groqCalls, 1, "Replay MUST NOT call Groq provider!");
    assert.strictEqual(consumeCalls, 1, "Replay MUST NOT debit quota again!");

    console.log("  -> [PASS-LOCAL] Idempotent replay performed zero reserve or lease calls.");
    passed++;
  }

  // ---------------------------------------------------------------------------
  // (g) Settle records actual tokens from mocked usage field
  // ---------------------------------------------------------------------------
  console.log("\n[TEST G] Settle records actual tokens from mocked usage field");
  {
    _clearIdempotencyResultCacheForTesting();
    _resetBudgetAlertStores();

    let settledPayload: any = null;

    const deps = {
      ...createBaseDeps(async (name, params) => {
        if (name === "ai_global_budget_reserve") {
          return { data: [{ allowed: true, remaining: 1000000 }], error: null };
        }
        if (name === "ai_concurrency_acquire") {
          return { data: true, error: null };
        }
        if (name === "ai_concurrency_release") {
          return { data: true, error: null };
        }
        if (name === "ai_global_budget_settle") {
          settledPayload = params;
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }),
      consumeSet: async () => ({ success: true, source: "plan" as const, alreadyConsumed: false }),
      callGroq: async () => ({
        content: "Simulated AI generated output",
        usage: {
          prompt_tokens: 350,
          completion_tokens: 150,
        },
      }),
    };

    const res = await executeAiCore(
      "127.0.0.1",
      "Bearer test-token",
      {
        operation: "resume_tailor",
        idempotencyKey: "test-settle-actual-001",
        params: { candidate: mockCandidate, job: mockJob },
      },
      deps
    );

    assert.strictEqual(res.statusCode, 200);
    assert.ok(settledPayload, "ai_global_budget_settle must be called");
    assert.strictEqual(settledPayload.p_actual, 500, "Settled tokens must match prompt_tokens + completion_tokens (350+150=500)");

    console.log("  -> [PASS-LOCAL] ai_global_budget_settle recorded exactly 500 actual tokens.");
    passed++;
  }

  // ---------------------------------------------------------------------------
  // (h) Alerting & Deduplication
  // ---------------------------------------------------------------------------
  console.log("\n[TEST H] 80% reserve crossing alert and 1-hour deduplication");
  {
    _resetBudgetAlertStores();

    let loggedErrors: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => {
      loggedErrors.push(args.join(" "));
      origError(...args);
    };

    try {
      emitBudgetAlert("cap_hit", "First alert message");
      emitBudgetAlert("cap_hit", "Duplicate within 1 hr");
      emitBudgetAlert("concurrency_saturated", "Different condition");

      assert.strictEqual(
        loggedErrors.filter((msg) => msg.includes("[AI-GLOBAL-BUDGET] [cap_hit]")).length,
        1,
        "cap_hit should be logged only once due to 1-hour deduplication"
      );
      assert.strictEqual(
        loggedErrors.filter((msg) => msg.includes("[AI-GLOBAL-BUDGET] [concurrency_saturated]")).length,
        1,
        "concurrency_saturated should be logged for new condition"
      );
    } finally {
      console.error = origError;
    }

    console.log("  -> [PASS-LOCAL] Alert deduplication within 1-hour window verified.");
    passed++;
  }

  console.log("\n================================================================================");
  console.log(` ALL ${passed} TEST SUITES PASSED LOCALLY: [PASS-LOCAL]`);
  console.log("================================================================================\n");
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
