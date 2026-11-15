import { describe, it, expect, vi } from "vitest";
import {
  createGroqTextCompletionAdapter,
  AiProviderUpstreamError,
  AiTextCompletionRequest,
} from "../providerAdapter";
import {
  sanitizeUserFacingAiError,
  GENERIC_AI_UNAVAILABLE_MESSAGE,
} from "../groq";

describe("Groq Adapter Automatic Retry & Logging", () => {
  const mockRequest: AiTextCompletionRequest = {
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: "Test prompt" }],
    maxOutputTokens: 500,
    temperature: 0.2,
    jsonMode: false,
  };

  it("retries once on HTTP 429 and succeeds if the retry succeeds", async () => {
    let callCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Rate limit reached for model on tokens per minute (TPM)",
              type: "tokens",
              code: "rate_limit_exceeded",
            },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json", "retry-after": "0" },
          }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Retry succeeded content" } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const adapter = createGroqTextCompletionAdapter({ fetchImpl });
    const result = (await adapter.completeText(mockRequest)) as any;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.choices[0].message.content).toBe("Retry succeeded content");
  });

  it("retries once on HTTP 503 and captures upstream error details if retry also fails", async () => {
    let callCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          error: {
            message: "Model overloaded. Service unavailable.",
            code: "service_unavailable",
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    const adapter = createGroqTextCompletionAdapter({ fetchImpl });

    await expect(adapter.completeText(mockRequest)).rejects.toThrow(
      AiProviderUpstreamError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    try {
      await adapter.completeText(mockRequest);
    } catch (err: any) {
      expect(err).toBeInstanceOf(AiProviderUpstreamError);
      expect(err.kind).toBe("http_status");
      expect(err.status).toBe(503);
      expect(err.upstreamMessage).toContain("Model overloaded");
      expect(err.upstreamCode).toBe("service_unavailable");
    }
  });

  it("does not retry on 400 Bad Request or 401 Unauthorized", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "The model does not exist",
            code: "model_not_found",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    const adapter = createGroqTextCompletionAdapter({ fetchImpl });
    await expect(adapter.completeText(mockRequest)).rejects.toThrow(
      AiProviderUpstreamError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeUserFacingAiError Friendly Error Formatting", () => {
  it("converts raw AI generation failed messages to friendly copy", () => {
    const raw = "AI service generation failed. Please try again.";
    expect(sanitizeUserFacingAiError(raw)).toBe(
      "AI service is temporarily busy. Your verified rules-based version is ready."
    );
  });

  it("converts rate limit messages to friendly high-demand message", () => {
    const raw = "Rate limit reached for model";
    expect(sanitizeUserFacingAiError(raw)).toBe(
      "AI service is experiencing high demand. Please try again in a few moments."
    );
  });

  it("converts timeout errors to friendly retry message", () => {
    const raw = "AI service request timed out after 25s";
    expect(sanitizeUserFacingAiError(raw)).toBe(
      "AI service request timed out. Please try again in a moment."
    );
  });

  it("neutralizes sensitive keys with generic message", () => {
    expect(
      sanitizeUserFacingAiError("Missing required env: GROQ_API_KEY")
    ).toBe(GENERIC_AI_UNAVAILABLE_MESSAGE);
  });

  it("preserves legitimate business messages", () => {
    const quotaMsg = "Daily AI match explanation quota exceeded.";
    expect(sanitizeUserFacingAiError(quotaMsg)).toBe(quotaMsg);
  });
});
