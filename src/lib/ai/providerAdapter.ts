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

  constructor(
    kind: AiProviderErrorKind,
    message: string,
    options?: { status?: number; cause?: unknown }
  ) {
    super(message);
    this.name = "AiProviderUpstreamError";
    this.kind = kind;
    this.status = options?.status;
    this.cause = options?.cause;
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
        throw new AiProviderUpstreamError(
          "network",
          "AI service request failed or timed out. Please try again.",
          { cause: fetchErr }
        );
      }

      if (!groqResponse.ok) {
        throw new AiProviderUpstreamError(
          "http_status",
          "AI service generation failed. Please try again.",
          { status: groqResponse.status }
        );
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
