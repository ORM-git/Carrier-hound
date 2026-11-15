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

  it("calculates worst-case tokens correctly derived from shared constants", () => {
    expect(MAX_ROUTING_ATTEMPTS_WITH_FALLBACK).toBe(3);
    expect(MAX_ROUTING_ATTEMPTS_SINGLE_MODEL).toBe(2);

    const worstCase = computeMaxWorkTokens(payload);
    // per attempt tokens: 50 + 100 = 150
    // 3 attempts * 150 + 1500 buffer = 450 + 1500 = 1950
    expect(worstCase).toBe(1950);

    const singleModelPayload: BuiltAiPayload = { ...payload, fallbackModel: undefined };
    const singleWorstCase = computeMaxWorkTokens(singleModelPayload);
    // 2 attempts * 150 + 1500 buffer = 300 + 1500 = 1800
    expect(singleWorstCase).toBe(1800);
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
});
