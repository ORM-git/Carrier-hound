import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { routeCompletion } from "../routing";
import {
  AiProviderUpstreamError,
  type AiTextCompletionProviderAdapter,
  _resetModelCooldownsForTesting,
} from "../providerAdapter";
import type { BuiltAiPayload } from "../security";

const SENTINEL_RESUME = "SENTINEL_RESUME_9f3a";
const SENTINEL_JD = "SENTINEL_JD_b7c2";

const testPayloadWithSentinels: BuiltAiPayload = {
  messages: [
    { role: "system", content: `System prompt context for ${SENTINEL_JD}` },
    { role: "user", content: `Candidate resume: ${SENTINEL_RESUME}` },
  ],
  model: "openai/gpt-oss-120b",
  fallbackModel: "llama-3.3-70b-versatile",
  maxOutputTokens: 100,
  temperature: 0.2,
  jsonMode: true,
  estimatedInputTokens: 50,
};

function createMockAdapter(steps: Array<(req: any) => any>) {
  const calls: any[] = [];
  const adapter: AiTextCompletionProviderAdapter = {
    provider: "test-sanitization-adapter",
    async completeText(req) {
      calls.push(req);
      const step = steps[calls.length - 1];
      if (!step) throw new Error("Unexpected call");
      return step(req);
    },
  };
  return { adapter, calls };
}

describe("Issue 2: Log Sanitization & PII Leak Prevention", () => {
  const capturedLogs: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;

  beforeEach(() => {
    _resetModelCooldownsForTesting();
    capturedLogs.length = 0;

    // Capture all stdout and stderr writes during test
    process.stdout.write = ((chunk: any, ...args: any[]) => {
      capturedLogs.push(String(chunk));
      return (origStdoutWrite as any).apply(process.stdout, [chunk, ...args]);
    }) as any;

    process.stderr.write = ((chunk: any, ...args: any[]) => {
      capturedLogs.push(String(chunk));
      return (origStderrWrite as any).apply(process.stderr, [chunk, ...args]);
    }) as any;
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  });

  function assertNoSentinelsLogged(label: string) {
    const combinedLog = capturedLogs.join("\n");
    expect(combinedLog).not.toContain(SENTINEL_RESUME);
    expect(combinedLog).not.toContain(SENTINEL_JD);
  }

  it("1. Success path: never logs resume or JD sentinels", async () => {
    const { adapter } = createMockAdapter([
      () => ({
        choices: [{ message: { content: '{"success": true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      }),
    ]);

    const result = await routeCompletion({
      adapter,
      payload: testPayloadWithSentinels,
      validate: () => ({ ok: true as const }),
    });

    expect(result.content).toBe('{"success": true}');
    assertNoSentinelsLogged("success path");
  });

  it("2. Fallback path: never logs resume or JD sentinels on provider failure", async () => {
    const { adapter } = createMockAdapter([
      () => {
        throw new AiProviderUpstreamError("http_status", `Upstream failed with ${SENTINEL_JD}`, { status: 500 });
      },
      () => ({
        choices: [{ message: { content: '{"from_fallback": true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      }),
    ]);

    const result = await routeCompletion({
      adapter,
      payload: testPayloadWithSentinels,
      validate: () => ({ ok: true as const }),
    });

    expect(result.usedFallback).toBe(true);
    assertNoSentinelsLogged("fallback path");
  });

  it("3. Repair path: never logs raw invalid generation containing sentinels", async () => {
    const { adapter } = createMockAdapter([
      () => ({
        choices: [{ message: { content: `{"bad_output": "${SENTINEL_RESUME}"}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      }),
      () => ({
        choices: [{ message: { content: '{"repaired": true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
      }),
    ]);

    let attemptCount = 0;
    const validator = (content: string) => {
      attemptCount++;
      if (attemptCount === 1) {
        return { ok: false as const, error: `Invalid content with ${SENTINEL_RESUME} Source: Candidate text` };
      }
      return { ok: true as const };
    };

    const result = await routeCompletion({
      adapter,
      payload: testPayloadWithSentinels,
      validate: validator,
    });

    expect(result.content).toBe('{"repaired": true}');
    assertNoSentinelsLogged("repair path");
  });

  it("4. Validation failure path: logs only reason code without echoing resume text", async () => {
    const { adapter } = createMockAdapter([
      () => ({
        choices: [{ message: { content: `{"invalid": "${SENTINEL_RESUME}"}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      }),
      () => ({
        choices: [{ message: { content: `{"still_invalid": "${SENTINEL_RESUME}"}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
      }),
    ]);

    const validator = () => ({
      ok: false as const,
      error: `skill unevidenced: claiming ${SENTINEL_RESUME} Source: raw candidate resume`,
    });

    await expect(
      routeCompletion({
        adapter,
        payload: testPayloadWithSentinels,
        validate: validator,
      })
    ).rejects.toThrow();

    assertNoSentinelsLogged("validation failure path");
  });

  it("5. Provider error path: never echoes raw upstream error body containing sentinels", async () => {
    const { adapter } = createMockAdapter([
      () => {
        throw new AiProviderUpstreamError("http_status", `Echo of bad request containing ${SENTINEL_RESUME}`, { status: 429, retryAfter: 10 });
      },
    ]);

    await expect(
      routeCompletion({
        adapter,
        payload: testPayloadWithSentinels,
        validate: () => ({ ok: true as const }),
      })
    ).rejects.toThrow();

    assertNoSentinelsLogged("provider error path");
  });
});
