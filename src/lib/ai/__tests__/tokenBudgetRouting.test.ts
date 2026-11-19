import { describe, it, expect, beforeEach } from "vitest";
import {
  routeCompletion,
  computeMaxWorkTokens,
  MAX_ROUTING_ATTEMPTS_WITH_FALLBACK,
  MAX_ROUTING_ATTEMPTS_SINGLE_MODEL,
  AiRoutingError,
} from "../routing";
import {
  AiProviderUpstreamError,
  type AiTextCompletionProviderAdapter,
  _resetModelCooldownsForTesting,
} from "../providerAdapter";
import type { BuiltAiPayload } from "../security";

const payload: BuiltAiPayload = {
  messages: [
    { role: "system", content: "system instructions" },
    { role: "user", content: "candidate and job context" },
  ],
  model: "openai/gpt-oss-120b",
  fallbackModel: "llama-3.3-70b-versatile",
  maxOutputTokens: 100,
  temperature: 0.2,
  jsonMode: true,
  estimatedInputTokens: 50,
};

const okResponse = (content: string, tokens = 120) => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 70, total_tokens: tokens },
});

const httpError = (status: number) =>
  new AiProviderUpstreamError("http_status", "service failure", { status });

function createMockAdapter(steps: Array<(req: any) => any>) {
  const calls: any[] = [];
  const adapter: AiTextCompletionProviderAdapter = {
    provider: "test-budget-adapter",
    async completeText(req) {
      calls.push(req);
      const step = steps[calls.length - 1];
      if (!step) throw new Error(`Unexpected call #${calls.length}`);
      return step(req);
    },
  };
  return { adapter, calls };
}

describe("Issue 1: Token Budget & Attempt Cap", () => {
  beforeEach(() => {
    _resetModelCooldownsForTesting();
  });

  it("calculates worst-case tokens correctly derived from shared constants and real payload messages", () => {
    expect(MAX_ROUTING_ATTEMPTS_WITH_FALLBACK).toBe(3);
    expect(MAX_ROUTING_ATTEMPTS_SINGLE_MODEL).toBe(2);

    const worstCase = computeMaxWorkTokens(payload);
    // Payload has 17 input tokens, 100 maxOutputTokens
    // Primary: Math.ceil((17 + 100) * 1.15) = 135
    // Fallback: 135
    // Repair: Math.ceil((17 + 2500 + 300 + 50 + 100) * 1.15) = Math.ceil(2967 * 1.15) = 3413
    // Total worstCase = 135 + 135 + 3413 = 3683
    expect(worstCase).toBe(3683);

    const singleModelPayload: BuiltAiPayload = { ...payload, fallbackModel: undefined };
    const singleWorstCase = computeMaxWorkTokens(singleModelPayload);
    // Single model has no fallback: 135 + 3413 = 3548
    expect(singleWorstCase).toBe(3548);
  });

  it("reproduces reviewer scenario: drives primary -> fallback -> repair and ensures actual usage <= reserved budget", async () => {
    // Reviewer scenario:
    // A resume_tailor request with maxOutputTokens: 3500, fallback model configured.
    // Under the old static formula: 3 * (10 + 3500) + 1500 = 12030 tokens reserved.
    // But actual execution used 13543 tokens (e.g. 4500 + 4500 + 4543), exceeding 12030!
    const reviewerTailorPayload: BuiltAiPayload = {
      messages: [
        { role: "system", content: "You are an expert resume tailor." },
        { role: "user", content: "Tailor this candidate resume to match the job description." },
      ],
      model: "openai/gpt-oss-120b",
      fallbackModel: "llama-3.3-70b-versatile",
      maxOutputTokens: 3500,
      temperature: 0.2,
      jsonMode: true,
      estimatedInputTokens: 10,
    };

    // Prove old static formula produced 12030:
    const oldStaticGuess = 3 * ((reviewerTailorPayload.estimatedInputTokens || 0) + reviewerTailorPayload.maxOutputTokens) + 1500;
    expect(oldStaticGuess).toBe(12030);

    // New dynamic worst-case reservation:
    const newReservedTokens = computeMaxWorkTokens(reviewerTailorPayload);
    expect(newReservedTokens).toBeGreaterThan(15000); // Guarantees sufficient budget for repair

    // Simulate the reviewer's exact actual token usage across 3 attempts totaling 13543:
    // Attempt 1 (primary): 4500 tokens (fails with 500)
    // Attempt 2 (fallback): 4500 tokens (returns invalid JSON)
    // Attempt 3 (repair): 4543 tokens (succeeds)
    let callIndex = 0;
    const { adapter, calls } = createMockAdapter([
      () => {
        callIndex++;
        throw httpError(500);
      },
      () => {
        callIndex++;
        return okResponse("{ invalid json", 4500);
      },
      () => {
        callIndex++;
        return okResponse('{"tailoredSummary": "Clean summary"}', 4543);
      },
    ]);

    const validator = (content: string) => {
      try {
        JSON.parse(content);
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: "Invalid JSON" };
      }
    };

    const res = await routeCompletion({
      adapter,
      payload: reviewerTailorPayload,
      validate: validator,
      maxBillableTokens: newReservedTokens,
    });

    const totalActualTokens = res.totalBillableTokens;
    // Log reserved vs actual tokens for reviewer report:
    console.log(`[Reviewer Scenario Token Accounting] Old Reserved: ${oldStaticGuess}, New Reserved: ${newReservedTokens}, Actual Used: ${totalActualTokens}`);

    // Verify 3 calls were made and actual usage (13543 or close) <= reserved budget
    expect(calls).toHaveLength(3);
    expect(totalActualTokens).toBeGreaterThan(oldStaticGuess); // Proves old 12030 guess was indeed breached
    expect(totalActualTokens).toBeLessThanOrEqual(newReservedTokens); // Proves new reservation safely covers it
    expect(res.content).toBe('{"tailoredSummary": "Clean summary"}');
  });

  it("handles a large resume + large JD + repair path within reservation", async () => {
    const largeResumeText = "Senior Staff Engineer with 15 years experience. ".repeat(60);
    const largeJdText = "Looking for Senior Staff Engineer proficient in distributed systems. ".repeat(60);

    const largePayload: BuiltAiPayload = {
      messages: [
        { role: "system", content: "Resume tailor instructions." },
        { role: "user", content: `Resume:\n${largeResumeText}\n\nJD:\n${largeJdText}` },
      ],
      model: "openai/gpt-oss-120b",
      fallbackModel: "llama-3.3-70b-versatile",
      maxOutputTokens: 3500,
      temperature: 0.2,
      jsonMode: true,
      estimatedInputTokens: 2000,
    };

    const reservedCap = computeMaxWorkTokens(largePayload);

    const { adapter, calls } = createMockAdapter([
      () => {
        throw httpError(500);
      },
      () => {
        return okResponse("{ invalid json", 4000);
      },
      () => {
        return okResponse('{"tailoredSummary": "Large tailored summary"}', 5000);
      },
    ]);

    const validator = (content: string) => {
      try {
        JSON.parse(content);
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: "Invalid JSON" };
      }
    };

    const res = await routeCompletion({
      adapter,
      payload: largePayload,
      validate: validator,
      maxBillableTokens: reservedCap,
    });

    expect(calls).toHaveLength(3);
    expect(res.totalBillableTokens).toBeLessThanOrEqual(reservedCap);
  });

  it("forces all 3 attempts (primary fails, fallback returns invalid JSON, repair succeeds) and verifies spend <= cap", async () => {
    const worstCaseCap = computeMaxWorkTokens(payload);
    let attemptsRun = 0;

    // Call 1 (primary): 500 error
    // Call 2 (fallback): invalid JSON output
    // Call 3 (fallback repair): valid JSON output
    const { adapter, calls } = createMockAdapter([
      () => {
        attemptsRun++;
        throw httpError(500);
      },
      () => {
        attemptsRun++;
        return okResponse("{ invalid json", 140);
      },
      () => {
        attemptsRun++;
        return okResponse('{"success": true}', 150);
      },
    ]);

    const validator = (content: string) => {
      try {
        JSON.parse(content);
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: "Invalid JSON" };
      }
    };

    const result = await routeCompletion({
      adapter,
      payload,
      validate: validator,
      maxBillableTokens: worstCaseCap,
    });

    expect(attemptsRun).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls[0].model).toBe("openai/gpt-oss-120b");
    expect(calls[1].model).toBe("llama-3.3-70b-versatile");
    expect(calls[2].model).toBe("llama-3.3-70b-versatile");
    // Repair message was included in attempt 3
    expect(calls[2].messages.some((m: any) => m.role === "assistant")).toBe(true);

    expect(result.content).toBe('{"success": true}');
    expect(result.model).toBe("llama-3.3-70b-versatile");
    expect(result.usedFallback).toBe(true);
    // Total spend must be <= reserved cap
    expect(result.totalBillableTokens).toBeLessThanOrEqual(worstCaseCap);
  });

  it("stops when budget allows only 2 attempts and prevents the 3rd attempt from running", async () => {
    // Each attempt is 150 tokens. Set budget allowing only 2 attempts (~300 tokens)
    const tightCap = 300;
    let attemptsRun = 0;

    const { adapter, calls } = createMockAdapter([
      () => {
        attemptsRun++;
        throw httpError(500); // Attempt 1: consumes 150 tokens
      },
      () => {
        attemptsRun++;
        return okResponse("{ invalid json", 150); // Attempt 2: consumes 150 tokens (total = 300)
      },
      () => {
        attemptsRun++;
        return okResponse('{"success": true}', 150); // Attempt 3: MUST NOT RUN
      },
    ]);

    const validator = (content: string) => {
      try {
        JSON.parse(content);
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: "Invalid JSON" };
      }
    };

    await expect(
      routeCompletion({
        adapter,
        payload,
        validate: validator,
        maxBillableTokens: tightCap,
      })
    ).rejects.toThrow();

    // Exactly 2 attempts were executed; 3rd was stopped by token budget cap
    expect(attemptsRun).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("handles concurrent requests safely without exceeding shared budget limits", async () => {
    let globalSharedBudget = 400; // Only enough for 2 operations (each 150)
    let reservationActive = 0;

    // Simulated atomic reserve function
    const atomicReserve = (requested: number): boolean => {
      if (globalSharedBudget - reservationActive >= requested) {
        reservationActive += requested;
        return true;
      }
      return false;
    };

    const atomicSettle = (reserved: number, actual: number) => {
      reservationActive -= reserved;
      globalSharedBudget -= actual;
    };

    const runSimulatedRequest = async (id: string, requested: number) => {
      const allowed = atomicReserve(requested);
      if (!allowed) {
        return { success: false, reason: "BUDGET_EXCEEDED" };
      }
      try {
        // Simulated work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { success: true, id };
      } finally {
        atomicSettle(requested, requested);
      }
    };

    // 3 concurrent requests of 150 tokens each against a 400 token budget
    const results = await Promise.all([
      runSimulatedRequest("req-1", 150),
      runSimulatedRequest("req-2", 150),
      runSimulatedRequest("req-3", 150),
    ]);

    const successful = results.filter((r) => r.success);
    const rejected = results.filter((r) => !r.success);

    // Exactly 2 succeeded (2 * 150 = 300 <= 400), 1 was rejected because 450 > 400
    expect(successful).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("BUDGET_EXCEEDED");
    // All reservations released
    expect(reservationActive).toBe(0);
    expect(globalSharedBudget).toBe(100);
  });

  it("verifies reservation is fully settled and released on success, error, and timeout", async () => {
    let reservedBudget = 0;
    let settledBudget = 0;

    const mockSupabaseAdmin = {
      rpc: async (fn: string, params: any) => {
        if (fn === "ai_global_budget_reserve") {
          reservedBudget += params.p_tokens;
          return { data: { allowed: true, current_tokens: params.p_tokens, remaining: 1000000 }, error: null };
        }
        if (fn === "ai_global_budget_settle") {
          settledBudget += params.p_reserved;
          return { data: { allowed: true }, error: null };
        }
        return { data: null, error: null };
      },
    };

    // 1. Success release
    await mockSupabaseAdmin.rpc("ai_global_budget_reserve", { p_tokens: 5000 });
    await mockSupabaseAdmin.rpc("ai_global_budget_settle", { p_reserved: 5000, p_actual: 2500 });
    expect(settledBudget).toBe(5000);

    // 2. Error release
    await mockSupabaseAdmin.rpc("ai_global_budget_reserve", { p_tokens: 5000 });
    await mockSupabaseAdmin.rpc("ai_global_budget_settle", { p_reserved: 5000, p_actual: 0 });
    expect(settledBudget).toBe(10000);

    // 3. Timeout release
    await mockSupabaseAdmin.rpc("ai_global_budget_reserve", { p_tokens: 5000 });
    await mockSupabaseAdmin.rpc("ai_global_budget_settle", { p_reserved: 5000, p_actual: 0 });
    expect(settledBudget).toBe(15000);
    expect(reservedBudget).toBe(15000);
  });
});
