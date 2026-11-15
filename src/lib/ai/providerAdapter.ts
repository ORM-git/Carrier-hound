/**
 * Server-only typed adapter interface for non-streaming AI text completions.
 *
 * Scope note (Backend sheet row "Provider Abstraction Layer"):
 * - Wraps the existing server-side non-streaming Groq chat-completions transport
 *   behind a small typed interface (`AiTextCompletionProviderAdapter`).
 * - Allows swapping in an offline fake adapter in tests (`AiServiceDeps.providerAdapter`)
 *   without changing model selection, prompt construction, output validation,
 *   token limits, timeouts, circuit-breaker recording, quota/budget accounting,
 *   or public error shapes.
 * - Does NOT add a second live provider or multi-provider runtime fallback;
 *   streaming (`upstreamStream: true`) remains on its dedicated SSE reader path.
 */

export interface AiTextCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiTextCompletionRequest {
  operation?: string;
  model: string;
  messages: AiTextCompletionMessage[];
  maxOutputTokens: number;
  temperature: number;
  jsonMode: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  estimatedInputTokens?: number;
  metadata?: {
    jobDescriptionShortened?: boolean;
  };
}

export interface AiTextCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface AiTextCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  content?: string;
  result?: string;
  usage?: AiTextCompletionUsage;
  [key: string]: unknown;
}

export interface AiTextCompletionOptions {
  signal?: AbortSignal;
  apiKey?: string;
  allowRetry?: boolean;
  deadline?: number;
}

const modelCooldownMap = new Map<string, number>();

export function setModelCooldown(model: string, cooldownMs: number): void {
  modelCooldownMap.set(model, Date.now() + cooldownMs);
}

export function isModelInCooldown(model: string): boolean {
  const until = modelCooldownMap.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    modelCooldownMap.delete(model);
    return false;
  }
  return true;
}

export function getModelCooldownRemaining(model: string): number {
  const until = modelCooldownMap.get(model);
  if (!until) return 0;
  const rem = until - Date.now();
  if (rem <= 0) {
    modelCooldownMap.delete(model);
    return 0;
  }
  return rem;
}

export function _resetModelCooldownsForTesting(): void {
  modelCooldownMap.clear();
}

export interface AiTextCompletionProviderAdapter {
  readonly provider: string;
  completeText(
    request: AiTextCompletionRequest,
    options?: AiTextCompletionOptions
  ): Promise<AiTextCompletionResponse | string>;
}

export type AiProviderErrorKind = "network" | "http_status" | "invalid_json";

export class AiProviderUpstreamError extends Error {
  readonly kind: AiProviderErrorKind;
  readonly status?: number;
  readonly cause?: unknown;
  readonly upstreamBody?: string;
  readonly upstreamCode?: string;
  readonly upstreamMessage?: string;
  readonly upstreamType?: string;
  readonly retryAfter?: number;

  constructor(
    kind: AiProviderErrorKind,
    message: string,
    options?: {
      status?: number;
      cause?: unknown;
      upstreamBody?: string;
      upstreamCode?: string;
      upstreamMessage?: string;
      upstreamType?: string;
      retryAfter?: number;
    }
  ) {
    super(message);
    this.name = "AiProviderUpstreamError";
    this.kind = kind;
    this.status = options?.status;
    this.cause = options?.cause;
    this.upstreamBody = options?.upstreamBody;
    this.upstreamCode = options?.upstreamCode;
    this.upstreamMessage = options?.upstreamMessage;
    this.upstreamType = options?.upstreamType;
    this.retryAfter = options?.retryAfter;
  }
}

export const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqAdapterDeps {
  fetchImpl?: typeof fetch;
  endpointUrl?: string;
}

export function buildGroqChatCompletionBody(
  request: AiTextCompletionRequest
): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    // gpt-oss reasoning models only; other models reject the parameter.
    ...(request.reasoningEffort && /gpt-oss/i.test(request.model)
      ? { reasoning_effort: request.reasoningEffort }
      : {}),
    ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };
}

export function extractTextCompletionContent(
  data: AiTextCompletionResponse | string | null | undefined
): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  const content = data?.choices?.[0]?.message?.content ?? data?.content ?? data?.result;
  return typeof content === "string" ? content : undefined;
}

export function createGroqTextCompletionAdapter(
  deps: GroqAdapterDeps = {}
): AiTextCompletionProviderAdapter {
  const endpointUrl = deps.endpointUrl ?? GROQ_CHAT_COMPLETIONS_URL;

  return {
    provider: "groq",
    async completeText(
      request: AiTextCompletionRequest,
      options?: AiTextCompletionOptions
    ): Promise<AiTextCompletionResponse> {
      const fetchFn = deps.fetchImpl ?? globalThis.fetch;
      let lastErr: unknown;
      const maxAttempts = options?.allowRetry === false ? 1 : 2;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          if (options?.signal?.aborted) {
            break;
          }
          const retryAfterSec = (lastErr as any)?.retryAfter;
          let backoffMs = process.env.NODE_ENV === "test" ? 10 : 1000;
          if (typeof retryAfterSec === "number" && retryAfterSec > 0) {
            const requestedMs = retryAfterSec * 1000;
            const remainingDeadline = options?.deadline ? options.deadline - Date.now() : undefined;
            if (remainingDeadline !== undefined) {
              if (requestedMs > remainingDeadline) {
                // Retry-After exceeds remaining deadline: fail immediately, never shrink 120s to 3s
                throw lastErr;
              }
              backoffMs = requestedMs;
            } else {
              backoffMs = requestedMs;
            }
          }
          await new Promise((r) => setTimeout(r, backoffMs));
          if (options?.signal?.aborted) {
            break;
          }
        }

        let groqResponse: Response;
        try {
          groqResponse = await fetchFn(endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${options?.apiKey ?? ""}`,
            },
            body: JSON.stringify(buildGroqChatCompletionBody(request)),
            signal: options?.signal,
          });
        } catch (fetchErr: unknown) {
          lastErr = new AiProviderUpstreamError(
            "network",
            "AI service request failed or timed out. Please try again.",
            { cause: fetchErr }
          );
          if (attempt === 0 && maxAttempts > 1 && !options?.signal?.aborted) {
            continue;
          }
          throw lastErr;
        }

        if (!groqResponse.ok) {
          let errorBodyText = "";
          let errorJson: any = null;
          try {
            errorBodyText = await groqResponse.text();
            errorJson = JSON.parse(errorBodyText);
          } catch {}

          const upstreamMessage =
            errorJson?.error?.message || errorBodyText || groqResponse.statusText;
          const upstreamCode = errorJson?.error?.code;
          const upstreamType = errorJson?.error?.type;
          const retryAfterHeader = groqResponse.headers?.get?.("retry-after");
          const retryAfter = retryAfterHeader ? Number(retryAfterHeader) || undefined : undefined;

          if (groqResponse.status === 429) {
            const cdSec = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 30;
            setModelCooldown(request.model, cdSec * 1000);
          }

          lastErr = new AiProviderUpstreamError(
            "http_status",
            "AI service generation failed. Please try again.",
            {
              status: groqResponse.status,
              cause: {
                message: upstreamMessage,
                code: upstreamCode,
                type: upstreamType,
                rawBody: errorBodyText,
              },
              upstreamBody: errorBodyText,
              upstreamCode,
              upstreamMessage,
              upstreamType,
              retryAfter,
            }
          );

          const isRetryable =
            (groqResponse.status === 429 ||
              (groqResponse.status >= 500 && groqResponse.status <= 504)) &&
            attempt === 0 &&
            maxAttempts > 1 &&
            !options?.signal?.aborted;

          if (isRetryable) {
            continue;
          }

          throw lastErr;
        }

        try {
          return (await groqResponse.json()) as AiTextCompletionResponse;
        } catch (parseErr: unknown) {
          throw new AiProviderUpstreamError(
            "invalid_json",
            "AI service returned an invalid response. Please try again.",
            { cause: parseErr }
          );
        }
      }

      throw lastErr;
    },
  };
}

export const groqTextCompletionAdapter: AiTextCompletionProviderAdapter =
  createGroqTextCompletionAdapter();

/**
 * Creates an in-memory mock completion adapter for tests and offline harnesses.
 */
export function createMockTextCompletionAdapter(
  provider = "mock-provider",
  responseContent: string | Record<string, unknown> = "mock completion text"
): AiTextCompletionProviderAdapter {
  return {
    provider,
    async completeText(): Promise<AiTextCompletionResponse> {
      return {
        choices: [
          {
            message: {
              content:
                typeof responseContent === "string"
                  ? responseContent
                  : JSON.stringify(responseContent),
            },
          },
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40,
        },
      };
    },
  };
}
