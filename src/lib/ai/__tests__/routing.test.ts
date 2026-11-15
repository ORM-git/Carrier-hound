import { describe, it, expect } from "vitest";
import { routeCompletion, AiRoutingError, redactValidatorError } from "../routing";
import { AiProviderUpstreamError, type AiTextCompletionProviderAdapter } from "../providerAdapter";
import type { BuiltAiPayload } from "../security";

const payload: BuiltAiPayload = {
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "usr" },
  ],
  model: "primary",
  fallbackModel: "fallback",
  maxOutputTokens: 100,
  temperature: 0.2,
  jsonMode: true,
  estimatedInputTokens: 10,
};

const ok = (content: string, finish = "stop") => ({
  choices: [{ message: { content }, finish_reason: finish }],
});
const http = (status: number) =>
  new AiProviderUpstreamError("http_status", "x", { status });

function adapterFrom(steps: Array<(req: any, signal?: AbortSignal) => any>) {
  const calls: any[] = [];
  const adapter: AiTextCompletionProviderAdapter = {
    provider: "test",
    async completeText(req, opts) {
      calls.push(req);
      const step = steps[calls.length - 1];
      if (!step) throw new Error("unexpected call");
      return step(req, opts?.signal);
    },
  };
  return { adapter, calls };
}
const pass = () => ({ ok: true as const });

describe("routeCompletion", () => {
  it("returns the primary result without touching the fallback", async () => {
    const { adapter, calls } = adapterFrom([() => ok("{}")]);
    const r = await routeCompletion({ adapter, payload, validate: pass });
    expect(r.model).toBe("primary");
    expect(r.usedFallback).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([429, 500, 503])("falls back on HTTP %i", async (status) => {
    const { adapter } = adapterFrom([() => { throw http(status); }, () => ok("{}")]);
    const r = await routeCompletion({ adapter, payload, validate: pass });
    expect(r.model).toBe("fallback");
    expect(r.usedFallback).toBe(true);
  });

  it("falls back on empty and on truncated output", async () => {
    const empty = adapterFrom([() => ok("  "), () => ok("{}")]);
    expect((await routeCompletion({ adapter: empty.adapter, payload, validate: pass })).model).toBe("fallback");
    const cut = adapterFrom([() => ok("{", "length"), () => ok("{}")]);
    expect((await routeCompletion({ adapter: cut.adapter, payload, validate: pass })).model).toBe("fallback");
  });

  it("falls back on a primary timeout using the per-attempt cap", async () => {
    const hang = (_r: any, signal?: AbortSignal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
      );
    const { adapter } = adapterFrom([hang, () => ok("{}")]);
    const r = await routeCompletion({ adapter, payload, validate: pass, primaryMs: 1200, totalMs: 5000 });
    expect(r.model).toBe("fallback");
  });

  it("does not fall back on a non-retryable 4xx and reports busy", async () => {
    const { adapter, calls } = adapterFrom([() => { throw http(400); }]);
    await expect(routeCompletion({ adapter, payload, validate: pass })).rejects.toMatchObject({ code: "AI_BUSY" });
    expect(calls).toHaveLength(1);
  });

  it("maps 401 to AI_NOT_CONFIGURED", async () => {
    const { adapter } = adapterFrom([() => { throw http(401); }]);
    await expect(routeCompletion({ adapter, payload, validate: pass })).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });
  });

  it("repairs once with the validator text, then succeeds on the same model", async () => {
    const { adapter, calls } = adapterFrom([() => ok('{"a":1}'), () => ok('{"a":2}')]);
    let n = 0;
    const r = await routeCompletion({
      adapter,
      payload,
      validate: () => (++n === 1 ? { ok: false, error: "bullet count mismatch for exp-1. Source: SECRET RESUME" } : { ok: true }),
    });
    expect(r.model).toBe("primary");
    expect(calls).toHaveLength(2);
    const repairMsg = calls[1].messages.at(-1).content as string;
    expect(repairMsg).toContain("bullet count mismatch");
    expect(repairMsg).not.toContain("SECRET RESUME");
  });

  it("fails with AI_VALIDATION_FAILED after one repair and never uses the fallback", async () => {
    const { adapter, calls } = adapterFrom([() => ok("{}"), () => ok("{}")]);
    const err = await routeCompletion({
      adapter,
      payload,
      validate: () => ({ ok: false, error: "nope" }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AiRoutingError);
    expect(err.code).toBe("AI_VALIDATION_FAILED");
    expect(calls).toHaveLength(2);
  });

  it("returns AI_TIMEOUT when every attempt times out", async () => {
    const hang = (_r: any, signal?: AbortSignal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" })))
      );
    const { adapter } = adapterFrom([hang, hang]);
    await expect(
      routeCompletion({ adapter, payload, validate: pass, primaryMs: 1000, fallbackMs: 1000, totalMs: 3000 })
    ).rejects.toMatchObject({ code: "AI_TIMEOUT" });
  });

  it("carries Retry-After through to the busy error", async () => {
    const e429 = new AiProviderUpstreamError("http_status", "x", { status: 429, retryAfter: 7 });
    const { adapter } = adapterFrom([() => { throw e429; }, () => { throw e429; }]);
    await expect(routeCompletion({ adapter, payload, validate: pass })).rejects.toMatchObject({
      code: "AI_BUSY",
      retryAfter: 7,
    });
  });

  it("redacts echoed resume text from validator errors", () => {
    expect(redactValidatorError("numbers changed. Source: a b Generated: c")).toBe("numbers changed.");
  });

  it("emits structured per-attempt logs with required fields and privacy redaction", async () => {
    const attempts: any[] = [];
    const { adapter } = adapterFrom([
      () => ({ choices: [{ message: { content: '{"bad":1}' }, finish_reason: "stop" }], usage: { total_tokens: 42 } }),
      () => ({ choices: [{ message: { content: '{"good":1}' }, finish_reason: "stop" }], usage: { total_tokens: 55 } }),
    ]);

    let count = 0;
    await routeCompletion({
      adapter,
      payload,
      requestId: "req-123",
      onAttempt: (info) => attempts.push(info),
      validate: () => {
        count++;
        if (count === 1) {
          return { ok: false, error: "Count mismatch. Source: Jane Doe resume experience facts" };
        }
        return { ok: true };
      },
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      requestId: "req-123",
      model: "primary",
      outcome: "validation",
      repair: false,
    });
    expect(attempts[0].validationError).toBe("Count mismatch.");
    expect(attempts[0].validationError).not.toContain("Jane Doe");
    expect((attempts[0] as any).content).toBeUndefined();
    expect((attempts[0] as any).messages).toBeUndefined();

    expect(attempts[1]).toMatchObject({
      requestId: "req-123",
      model: "primary",
      outcome: "ok",
      repair: true,
    });
  });
});
