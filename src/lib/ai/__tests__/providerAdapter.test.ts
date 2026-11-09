import { describe, it, expect, beforeEach } from "vitest";
import {
  executeAiCore,
  _resetAiRateLimitStore,
  GroqCircuitBreaker,
  AiServiceDeps,
} from "../serviceHandler";
import {
  AiTextCompletionProviderAdapter,
  AiTextCompletionRequest,
  AiTextCompletionResponse,
  AiTextCompletionOptions,
  AiProviderUpstreamError,
  GROQ_CHAT_COMPLETIONS_URL,
  buildGroqChatCompletionBody,
  createGroqTextCompletionAdapter,
} from "../providerAdapter";

class FakeTextCompletionAdapter implements AiTextCompletionProviderAdapter {
  readonly provider = "fake-test-provider";
  readonly calls: Array<{
    request: AiTextCompletionRequest;
    options?: AiTextCompletionOptions;
  }> = [];

  private handler: (
    request: AiTextCompletionRequest,
    options?: AiTextCompletionOptions
  ) => Promise<AiTextCompletionResponse | string>;

  constructor(
    handler: (
      request: AiTextCompletionRequest,
      options?: AiTextCompletionOptions
    ) => Promise<AiTextCompletionResponse | string>
  ) {
    this.handler = handler;
  }

  async completeText(
    request: AiTextCompletionRequest,
    options?: AiTextCompletionOptions
  ): Promise<AiTextCompletionResponse | string> {
    this.calls.push({ request, options });
    return this.handler(request, options);
  }
}

function createHarness(overrides: Partial<AiServiceDeps> = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let refundedQuotas = 0;
  let refundedSets = 0;

  const makeTableBuilder = (table: string): any => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => {
        if (table === "ai_usage_quotas") {
          return { data: { count: 1, total_tokens: 250 }, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
      update: (values: Record<string, unknown>) => {
        if (table === "ai_usage_quotas" && values && values.count === 0) {
          refundedQuotas++;
        }
        return builder;
      },
      order: () => builder,
      limit: () => builder,
    };
    return builder;
  };

  const supabaseAdmin = {
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: "user-adapter-test-1",
            email: "pro@careermonke.example",
            app_metadata: { approved: true },
          },
        },
        error: null,
      }),
    },
    from: (table: string) => makeTableBuilder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "check_and_increment_ai_quota") {
        return {
          data: { allowed: true, current_count: 1, limit: 30 },
          error: null,
        };
      }
      if (fn === "ai_global_budget_reserve") {
        return {
          data: [{ allowed: true, current_tokens: 500, remaining: 1500000 }],
          error: null,
        };
      }
      if (fn === "ai_global_budget_settle") {
        return { data: { settled: true }, error: null };
      }
      if (fn === "ai_concurrency_acquire") {
        return { data: true, error: null };
      }
      if (fn === "ai_concurrency_release") {
        return { data: { released: true }, error: null };
      }
      return { data: null, error: null };
    },
  };

  const breaker = new GroqCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 5000,
  });

  const deps: AiServiceDeps = {
    supabaseAdmin,
    getSupabaseAdmin: () => supabaseAdmin,
    getServerEntitlement: async () =>
      ({
        tier: "pro",
        isPro: true,
        status: "active",
      }) as any,
    isUserApproved: async () => true,
    checkSharedRateLimit: async () => ({
      allowed: true,
      retryAfter: 0,
      currentCount: 1,
      source: "shared" as const,
    }),
    consumeSet: async () => ({
      success: true,
      alreadyConsumed: false,
      remaining: 9,
    }),
    refundSet: async () => {
      refundedSets++;
      return { success: true, refunded: true };
    },
    circuitBreaker: breaker,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
      GROQ_API_KEY: "gsk_test_adapter_key",
    },
    ...overrides,
  };

  return {
    deps,
    breaker,
    rpcCalls,
    getRefundedQuotas: () => refundedQuotas,
    getRefundedSets: () => refundedSets,
    getSettledTokens: () =>
      rpcCalls
        .filter((call) => call.fn === "ai_global_budget_settle")
        .map((call) => call.args.p_actual as number),
  };
}

const VALID_JOB_FIT_PARAMS = {
  candidate: {
    name: "Jane Doe",
    headline: "Senior Backend Engineer",
    skills: ["TypeScript", "PostgreSQL", "Node.js"],
  },
  job: {
    title: "Staff Backend Engineer",
    company: "Acme Cloud",
    description: "Build resilient backend services in TypeScript and PostgreSQL.",
  },
};

describe("Provider Abstraction Layer (AiTextCompletionProviderAdapter)", () => {
  beforeEach(() => {
    _resetAiRateLimitStore();
  });

  it("swaps in an offline FakeTextCompletionAdapter for successful JSON completion and preserves call/response contracts", async () => {
    const fakeAdapter = new FakeTextCompletionAdapter(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              score: 88,
              matchedSkills: ["TypeScript", "PostgreSQL"],
              missingSkills: ["Kubernetes"],
              summary: "Strong backend systems alignment with TypeScript and PostgreSQL.",
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 310,
        completion_tokens: 95,
        total_tokens: 405,
      },
    }));

    const harness = createHarness({ providerAdapter: fakeAdapter });

    const response = await executeAiCore(
      "127.0.0.1",
      "Bearer valid-jwt",
      {
        operation: "job_fit",
        params: VALID_JOB_FIT_PARAMS,
      },
      harness.deps
    );

    expect(response.statusCode).toBe(200);
    expect(fakeAdapter.calls).toHaveLength(1);

    const { request, options } = fakeAdapter.calls[0];
    expect(request.model).toBe("openai/gpt-oss-20b");
    expect(request.maxOutputTokens).toBe(1000);
    expect(request.temperature).toBe(0.1);
    expect(request.jsonMode).toBe(true);
    expect(typeof request.estimatedInputTokens).toBe("number");
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[1].role).toBe("user");
    expect(options?.apiKey).toBe("gsk_test_adapter_key");
    expect(options?.signal).toBeInstanceOf(AbortSignal);

    expect(response.body.success).toBe(true);
    expect(response.body.operation).toBe("job_fit");
    expect(response.body.model).toBe("openai/gpt-oss-20b");
    expect(response.body.result).toEqual({
      score: 88,
      matchedSkills: ["TypeScript", "PostgreSQL"],
      missingSkills: ["Kubernetes"],
      summary: "Strong backend systems alignment with TypeScript and PostgreSQL.",
    });
    expect(harness.getSettledTokens()).toEqual([405]);
    expect(harness.getRefundedQuotas()).toBe(0);
    expect(harness.breaker.getState()).toBe("CLOSED");
  });

  it("enforces timeout on a hanging providerAdapter, trips failure accounting, settles 0 tokens, and refunds quota", async () => {
    let signalAborted = false;
    const hangingAdapter = new FakeTextCompletionAdapter(
      (_req, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              signalAborted = true;
              const err = new Error("Aborted by signal");
              err.name = "AbortError";
              reject(err);
            },
            { once: true }
          );
        })
    );

    const harness = createHarness({
      providerAdapter: hangingAdapter,
      groqTimeoutMs: 40,
    });

    const response = await executeAiCore(
      "127.0.0.1",
      "Bearer valid-jwt",
      {
        operation: "job_fit",
        params: VALID_JOB_FIT_PARAMS,
      },
      harness.deps
    );

    expect(signalAborted).toBe(true);
    expect(response.statusCode).toBe(502);
    expect(response.body).toEqual({
      error: "AI service request failed or timed out. Please try again.",
    });
    expect(harness.getSettledTokens()).toEqual([0]);
    expect(harness.getRefundedQuotas()).toBe(1);
    expect(
      harness.rpcCalls.some((call) => call.fn === "ai_concurrency_release")
    ).toBe(true);
  });

  it("preserves exact 502 error mappings, budget settlement (0), and quota rollback across network, HTTP status, invalid JSON, and empty output failures", async () => {
    const cases: Array<{
      label: string;
      impl: () => Promise<AiTextCompletionResponse>;
      expectedError: string;
    }> = [
      {
        label: "network failure",
        impl: async () => {
          throw new AiProviderUpstreamError(
            "network",
            "AI service request failed or timed out. Please try again.",
            { cause: new Error("ECONNRESET") }
          );
        },
        expectedError: "AI service request failed or timed out. Please try again.",
      },
      {
        label: "upstream HTTP 503 status",
        impl: async () => {
          throw new AiProviderUpstreamError(
            "http_status",
            "AI service generation failed. Please try again.",
            { status: 503 }
          );
        },
        expectedError: "AI service generation failed. Please try again.",
      },
      {
        label: "invalid upstream JSON",
        impl: async () => {
          throw new AiProviderUpstreamError(
            "invalid_json",
            "AI service returned an invalid response. Please try again.",
            { cause: new SyntaxError("Unexpected token <") }
          );
        },
        expectedError: "AI service returned an invalid response. Please try again.",
      },
      {
        label: "empty completion content",
        impl: async () => ({
          choices: [{ message: { content: "" } }],
        }),
        expectedError: "AI service returned an empty generation.",
      },
    ];

    for (const testCase of cases) {
      _resetAiRateLimitStore();
      const adapter = new FakeTextCompletionAdapter(testCase.impl);
      const harness = createHarness({ providerAdapter: adapter });

      const res = await executeAiCore(
        "127.0.0.1",
        "Bearer valid-jwt",
        {
          operation: "job_fit",
          params: VALID_JOB_FIT_PARAMS,
        },
        harness.deps
      );

      expect(res.statusCode, testCase.label).toBe(502);
      expect(res.body, testCase.label).toEqual({ error: testCase.expectedError });
      expect(harness.getSettledTokens(), testCase.label).toEqual([0]);
      expect(harness.getRefundedQuotas(), testCase.label).toBe(1);
    }
  });

  it("opens the circuit breaker after threshold providerAdapter failures and short-circuits with 503 before calling the adapter", async () => {
    const failingAdapter = new FakeTextCompletionAdapter(async () => {
      throw new AiProviderUpstreamError(
        "http_status",
        "AI service generation failed. Please try again.",
        { status: 502 }
      );
    });

    const harness = createHarness({ providerAdapter: failingAdapter });
    const reqBody = {
      operation: "job_fit",
      params: VALID_JOB_FIT_PARAMS,
    };

    const first = await executeAiCore("127.0.0.1", "Bearer valid-jwt", reqBody, harness.deps);
    const second = await executeAiCore("127.0.0.1", "Bearer valid-jwt", reqBody, harness.deps);
    expect(first.statusCode).toBe(502);
    expect(second.statusCode).toBe(502);
    expect(harness.breaker.getState()).toBe("OPEN");
    expect(failingAdapter.calls).toHaveLength(2);

    const third = await executeAiCore("127.0.0.1", "Bearer valid-jwt", reqBody, harness.deps);
    expect(third.statusCode).toBe(503);
    expect(third.body.error).toBe("AI temporarily busy");
    // Adapter must NOT be invoked while circuit is open
    expect(failingAdapter.calls).toHaveLength(2);
  });

  it("negative control: rejects malformed JSON output from a swapped adapter with 502 and rolls back quota", async () => {
    const badJsonAdapter = new FakeTextCompletionAdapter(async () => ({
      choices: [
        {
          message: {
            content: "not-valid-json-at-all",
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }));

    const harness = createHarness({ providerAdapter: badJsonAdapter });

    const res = await executeAiCore(
      "127.0.0.1",
      "Bearer valid-jwt",
      {
        operation: "job_fit",
        params: VALID_JOB_FIT_PARAMS,
      },
      harness.deps
    );

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toContain("invalid JSON returned for 'job_fit'");
    expect(harness.getSettledTokens()).toEqual([0]);
    expect(harness.getRefundedQuotas()).toBe(1);
  });

  it("preserves the Groq HTTP request contract in createGroqTextCompletionAdapter (URL, headers, body, response_format, and error mapping)", async () => {
    const capturedCalls: Array<{ url: string; init?: RequestInit }> = [];

    const mockFetch: typeof fetch = async (input: any, init?: RequestInit) => {
      capturedCalls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"score\":91}" } }],
          usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const groqAdapter = createGroqTextCompletionAdapter({ fetchImpl: mockFetch });
    expect(groqAdapter.provider).toBe("groq");

    const jsonReq: AiTextCompletionRequest = {
      operation: "job_fit",
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "System instruction" },
        { role: "user", content: "User payload" },
      ],
      maxOutputTokens: 800,
      temperature: 0.2,
      jsonMode: true,
    };

    const controller = new AbortController();
    const result = await groqAdapter.completeText(jsonReq, {
      apiKey: "gsk_unit_test_secret",
      signal: controller.signal,
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].url).toBe(GROQ_CHAT_COMPLETIONS_URL);
    expect(capturedCalls[0].init?.method).toBe("POST");
    expect(capturedCalls[0].init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer gsk_unit_test_secret",
    });
    expect(capturedCalls[0].init?.signal).toBe(controller.signal);

    const sentBody = JSON.parse(String(capturedCalls[0].init?.body));
    expect(sentBody).toEqual({
      model: "llama-3.1-8b-instant",
      messages: jsonReq.messages,
      max_tokens: 800,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    expect(result).toEqual({
      choices: [{ message: { content: "{\"score\":91}" } }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    });

    // Plain-text operation (jsonMode: false) omits response_format
    const plainBody = buildGroqChatCompletionBody({
      ...jsonReq,
      operation: "cover_letter",
      jsonMode: false,
    });
    expect(plainBody).not.toHaveProperty("response_format");
  });
});
