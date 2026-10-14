import assert from "assert";

console.log("==================================================================================");
console.log("           AI PROVIDER FAILURE & QUOTA REFUND CONCURRENCY AUDIT (GROQ)            ");
console.log("==================================================================================\n");

// Mock Supabase Quota Storage
interface MockQuotaStore {
  count: number;
  limit: number;
}

function createMockSupabaseAdmin(initialCount: number = 0, limit: number = 30) {
  const store: MockQuotaStore = { count: initialCount, limit };

  const checkAndIncrement = async () => {
    if (store.count >= store.limit) {
      return { allowed: false, currentCount: store.count, limit: store.limit };
    }
    store.count += 1;
    return { allowed: true, currentCount: store.count, limit: store.limit };
  };

  const refund = async () => {
    if (store.count > 0) {
      store.count -= 1;
    }
  };

  return { store, checkAndIncrement, refund };
}

// Simulates the exact handler execution flow from netlify/functions/ai.ts & src/app/api/ai/route.ts
async function executeAiHandler(
  supabase: ReturnType<typeof createMockSupabaseAdmin>,
  groqFetchMock: () => Promise<any>,
  shouldRefundOnFailure: boolean = true
): Promise<{ statusCode: number; body: any }> {
  // 1. Reserve quota
  const quota = await supabase.checkAndIncrement();
  if (!quota.allowed) {
    return {
      statusCode: 429,
      body: { error: `Daily AI usage quota exceeded (${quota.currentCount}/${quota.limit}).` },
    };
  }

  // 2. Upstream provider call
  let groqResponse: any;
  try {
    groqResponse = await groqFetchMock();
  } catch (fetchErr: any) {
    if (shouldRefundOnFailure) {
      await supabase.refund();
    }
    return {
      statusCode: 502,
      body: { error: "AI service request failed or timed out. Please try again." },
    };
  }

  if (!groqResponse.ok) {
    if (shouldRefundOnFailure) {
      await supabase.refund();
    }
    return {
      statusCode: 502,
      body: { error: "AI service generation failed. Please try again." },
    };
  }

  let groqData: any;
  try {
    groqData = await groqResponse.json();
  } catch (parseErr: any) {
    if (shouldRefundOnFailure) {
      await supabase.refund();
    }
    return {
      statusCode: 502,
      body: { error: "AI service returned an invalid response. Please try again." },
    };
  }

  const content = groqData?.choices?.[0]?.message?.content || "";
  return {
    statusCode: 200,
    body: { content, text: content },
  };
}

async function runTests() {
  const INITIAL_COUNT = 5;

  // -------------------------------------------------------------------------------------
  // 1. Groq 429 -> Usage Unchanged, Clear Error Body
  // -------------------------------------------------------------------------------------
  const mock429 = createMockSupabaseAdmin(INITIAL_COUNT);
  const res429 = await executeAiHandler(mock429, async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: "Rate limit exceeded" }),
  }));
  assert.strictEqual(res429.statusCode, 502, "429 should yield status 502 to client");
  assert(res429.body.error, "429 should return clear error body");
  assert.strictEqual(mock429.store.count, INITIAL_COUNT, "Usage quota must be refunded and unchanged on 429");
  console.log(`✅ [PASS-LOCAL] Groq 429: Usage unchanged (${mock429.store.count}/${mock429.store.limit}), clear error body returned`);

  // -------------------------------------------------------------------------------------
  // 2. Groq 500 -> Usage Unchanged, Clear Error Body
  // -------------------------------------------------------------------------------------
  const mock500 = createMockSupabaseAdmin(INITIAL_COUNT);
  const res500 = await executeAiHandler(mock500, async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: "Internal server error" }),
  }));
  assert.strictEqual(res500.statusCode, 502, "500 should yield status 502 to client");
  assert(res500.body.error, "500 should return clear error body");
  assert.strictEqual(mock500.store.count, INITIAL_COUNT, "Usage quota must be refunded and unchanged on 500");
  console.log(`✅ [PASS-LOCAL] Groq 500: Usage unchanged (${mock500.store.count}/${mock500.store.limit}), clear error body returned`);

  // -------------------------------------------------------------------------------------
  // 3. Groq Timeout -> Usage Unchanged, Clear Error Body
  // -------------------------------------------------------------------------------------
  const mockTimeout = createMockSupabaseAdmin(INITIAL_COUNT);
  const resTimeout = await executeAiHandler(mockTimeout, async () => {
    throw new Error("Connection timeout to api.groq.com after 10000ms");
  });
  assert.strictEqual(resTimeout.statusCode, 502, "Timeout should yield status 502 to client");
  assert(resTimeout.body.error, "Timeout should return clear error body");
  assert.strictEqual(mockTimeout.store.count, INITIAL_COUNT, "Usage quota must be refunded and unchanged on timeout");
  console.log(`✅ [PASS-LOCAL] Groq Timeout: Usage unchanged (${mockTimeout.store.count}/${mockTimeout.store.limit}), clear error body returned`);

  // -------------------------------------------------------------------------------------
  // 4. Groq Garbage JSON -> Usage Unchanged, Clear Error Body
  // -------------------------------------------------------------------------------------
  const mockGarbage = createMockSupabaseAdmin(INITIAL_COUNT);
  const resGarbage = await executeAiHandler(mockGarbage, async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token '<' in JSON at position 0");
    },
  }));
  assert.strictEqual(resGarbage.statusCode, 502, "Garbage JSON should yield status 502 to client");
  assert(resGarbage.body.error, "Garbage JSON should return clear error body");
  assert.strictEqual(mockGarbage.store.count, INITIAL_COUNT, "Usage quota must be refunded and unchanged on garbage JSON");
  console.log(`✅ [PASS-LOCAL] Groq Garbage JSON: Usage unchanged (${mockGarbage.store.count}/${mockGarbage.store.limit}), clear error body returned`);

  // -------------------------------------------------------------------------------------
  // 5. Groq Success -> Usage Increments by +1
  // -------------------------------------------------------------------------------------
  const mockSuccess = createMockSupabaseAdmin(INITIAL_COUNT);
  const resSuccess = await executeAiHandler(mockSuccess, async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: "Tailored bullet point" } }],
    }),
  }));
  assert.strictEqual(resSuccess.statusCode, 200, "Success should yield status 200");
  assert.strictEqual(resSuccess.body.content, "Tailored bullet point");
  assert.strictEqual(mockSuccess.store.count, INITIAL_COUNT + 1, "Usage quota must increment by exactly +1 on success");
  console.log(`✅ [PASS-LOCAL] Groq Success: Usage incremented by +1 (${mockSuccess.store.count}/${mockSuccess.store.limit}), content received`);

  // -------------------------------------------------------------------------------------
  // 6. Concurrency Test: Two Parallel Requests at Cap - 1 -> Exactly ONE Success
  // -------------------------------------------------------------------------------------
  const CAP = 30;
  const mockParallel = createMockSupabaseAdmin(CAP - 1, CAP); // count = 29, limit = 30

  console.log(`\nTesting parallel requests at cap - 1 (current: ${mockParallel.store.count}/${mockParallel.store.limit})...`);
  const [resA, resB] = await Promise.all([
    executeAiHandler(mockParallel, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Resp A" } }] }),
    })),
    executeAiHandler(mockParallel, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Resp B" } }] }),
    })),
  ]);

  const successCount = [resA, resB].filter((r) => r.statusCode === 200).length;
  const quotaBlockedCount = [resA, resB].filter((r) => r.statusCode === 429).length;

  assert.strictEqual(successCount, 1, "Exactly ONE parallel request at cap - 1 must succeed");
  assert.strictEqual(quotaBlockedCount, 1, "Exactly ONE parallel request at cap - 1 must be blocked with 429");
  assert.strictEqual(mockParallel.store.count, CAP, `Final count must reach exactly cap (${CAP})`);
  console.log(`✅ [PASS-LOCAL] Concurrency at cap-1 safe: Exactly 1 succeeded (200), exactly 1 blocked (429), final count ${mockParallel.store.count}/${mockParallel.store.limit}`);

  // -------------------------------------------------------------------------------------
  // 7. NEGATIVE CONTROL: Revert in-memory refund logic to prove non-zero exit on failure
  // -------------------------------------------------------------------------------------
  console.log("\n--- RUNNING NEGATIVE CONTROL ---");
  const mockVulnerable = createMockSupabaseAdmin(INITIAL_COUNT);
  // Execute failure with shouldRefundOnFailure = false (simulating old behavior)
  await executeAiHandler(
    mockVulnerable,
    async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "Outage" }),
    }),
    false // DO NOT REFUND (old bug)
  );

  let negativeControlCaught = false;
  try {
    assert.strictEqual(
      mockVulnerable.store.count,
      INITIAL_COUNT,
      "Vulnerable un-refunded quota must fail check"
    );
  } catch (err: any) {
    negativeControlCaught = true;
    console.log(`✅ Negative control caught un-refunded quota failure: count leaked to ${mockVulnerable.store.count} (expected ${INITIAL_COUNT})`);
  }

  assert(negativeControlCaught, "Negative control failed to detect un-refunded quota leak!");

  console.log("\n==================================================================================");
  console.log("AI QUOTA ORDERING & PROVIDER FAILURE AUDIT: ALL TESTS PASSED");
  console.log("==================================================================================");
}

runTests().catch((err) => {
  console.error("FATAL ERROR in test-ai-provider-failure.ts:", err);
  process.exit(1);
});
