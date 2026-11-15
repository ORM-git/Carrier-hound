/**
 * Server-only model routing for non-streaming AI completions.
 *
 * primary model -> (optional) fallback model, under ONE shared deadline.
 * - Fallback only on: timeout, network, 5xx, 429, empty or truncated output.
 * - Validator rejection gets ONE repair retry (error text sent back), never a fallback.
 * - Quota / budget / kill-switch checks run before this and are never retried here.
 */
import {
  AiProviderUpstreamError,
  extractTextCompletionContent,
  type AiTextCompletionProviderAdapter,
  type AiTextCompletionResponse,
} from "./providerAdapter";
import type { BuiltAiPayload } from "./security";

export type AiAttemptOutcome =
  | "ok"
  | "timeout"
  | "http"
  | "network"
  | "empty"
  | "truncated"
  | "validation";

export type AiErrorCode =
  | "AI_TIMEOUT"
  | "AI_BUSY"
  | "AI_VALIDATION_FAILED"
  | "AI_NOT_CONFIGURED";

export interface AiAttemptInfo {
  model: string;
  attempt: number;
  repair: boolean;
  outcome: AiAttemptOutcome;
  latencyMs: number;
  httpStatus?: number;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  contentLength: number;
  /** Validator reason with echoed resume text removed. Never model output. */
  validationError?: string;
}

export class AiRoutingError extends Error {
  readonly code: AiErrorCode;
  readonly statusCode: number;
  readonly retryAfter?: number;
  constructor(code: AiErrorCode, message: string, statusCode: number, retryAfter?: number) {
    super(message);
    this.name = "AiRoutingError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

export type RoutingValidation = { ok: true } | { ok: false; error: string };

export interface RouteCompletionOptions {
  adapter: AiTextCompletionProviderAdapter;
  payload: BuiltAiPayload;
  apiKey?: string;
  validate: (content: string) => RoutingValidation;
  /** Shared deadline for every attempt together. */
  totalMs?: number;
  primaryMs?: number;
  fallbackMs?: number;
  onAttempt?: (info: AiAttemptInfo) => void;
  /** Aborting this (e.g. the request-level deadline) stops routing immediately. */
  signal?: AbortSignal;
}

export const DEFAULT_TOTAL_MS = 24_000;
export const DEFAULT_PRIMARY_MS = 20_000;
export const DEFAULT_FALLBACK_MS = 15_000;
const REPAIR_ECHO_MAX_CHARS = 6_000;

/** Drops the validator's echoed resume text ("Source: ... Generated: ..."). */
export function redactValidatorError(error: string): string {
  return String(error).split(" Source:")[0].split("Source:")[0].slice(0, 200).trim();
}

type Failure = {
  outcome: Exclude<AiAttemptOutcome, "ok" | "validation">;
  eligibleForFallback: boolean;
  status?: number;
  retryAfter?: number;
  message?: string;
};

function classifyThrown(err: unknown, aborted: boolean): Failure {
  if (aborted || (err as any)?.name === "AbortError") {
    return {
      outcome: "timeout",
      eligibleForFallback: true,
      message: "AI service request failed or timed out. Please try again.",
    };
  }
  if (err instanceof AiProviderUpstreamError) {
    if (err.kind === "http_status") {
      const s = err.status ?? 0;
      return {
        outcome: "http",
        status: s,
        retryAfter: err.retryAfter,
        eligibleForFallback: s === 429 || (s >= 500 && s <= 599),
        message:
          s === 503 || s === 502
            ? "AI service generation failed. Please try again."
            : err.message || "AI service generation failed. Please try again.",
      };
    }
    if (err.kind === "invalid_json") {
      return {
        outcome: "empty",
        eligibleForFallback: true,
        message: "AI service returned an invalid response. Please try again.",
      };
    }
    return {
      outcome: "http",
      eligibleForFallback: true,
      message: err.message || "AI service request failed or timed out. Please try again.",
    };
  }
  return {
    outcome: "http",
    eligibleForFallback: true,
    message: (err as any)?.message || "AI service request failed or timed out. Please try again.",
  };
}

export async function routeCompletion(
  opts: RouteCompletionOptions
): Promise<{ data: AiTextCompletionResponse | string; content: string; model: string; usedFallback: boolean }> {
  const { adapter, payload, apiKey, validate, onAttempt } = opts;
  const totalMs = opts.totalMs ?? DEFAULT_TOTAL_MS;
  const started = Date.now();
  const deadline = started + totalMs;

  const models = [payload.model];
  if (payload.fallbackModel && payload.fallbackModel !== payload.model) {
    models.push(payload.fallbackModel);
  }

  let repairUsed = false;
  let attemptNo = 0;
  let last: { kind: "timeout" | "busy" | "validation" | "config"; retryAfter?: number; message?: string } = {
    kind: "timeout",
  };

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const isFallback = mi > 0;
    const perAttemptCap = isFallback
      ? opts.fallbackMs ?? DEFAULT_FALLBACK_MS
      : opts.primaryMs ?? (models.length > 1 ? DEFAULT_PRIMARY_MS : totalMs);

    let messages: BuiltAiPayload["messages"] = payload.messages;
    let repairing = false;

    // At most two calls per model: the normal one and (once overall) a repair.
    for (let round = 0; round < 2; round++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || opts.signal?.aborted) {
        last = { kind: "timeout", message: "AI service request failed or timed out. Please try again." };
        break;
      }
      const attemptMs = Math.max(1, Math.min(perAttemptCap, remaining));
      const controller = new AbortController();
      const onParentAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), attemptMs);
      const t0 = Date.now();
      attemptNo++;

      let data: AiTextCompletionResponse | string;
      try {
        data = await adapter.completeText(
          { ...payload, model, messages },
          { signal: controller.signal, apiKey }
        );
      } catch (err) {
        const f = classifyThrown(err, controller.signal.aborted || opts.signal?.aborted);
        onAttempt?.({
          model,
          attempt: attemptNo,
          repair: repairing,
          outcome: f.outcome,
          latencyMs: Date.now() - t0,
          httpStatus: f.status,
          contentLength: 0,
        });
        if (f.status === 401 || f.status === 403) {
          throw new AiRoutingError("AI_NOT_CONFIGURED", "AI service is not configured.", 500);
        }
        last = {
          kind: f.outcome === "timeout" ? "timeout" : "busy",
          retryAfter: f.retryAfter,
          message: f.message,
        };
        if (!f.eligibleForFallback) {
          throw new AiRoutingError("AI_BUSY", f.message || "AI service generation failed. Please try again.", 502, f.retryAfter);
        }
        break; // next model
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onParentAbort);
      }

      const latencyMs = Date.now() - t0;
      const content = extractTextCompletionContent(data) ?? "";
      const choice = typeof data === "object" && data ? (data as any).choices?.[0] : undefined;
      const finishReason: string | undefined = choice?.finish_reason ?? undefined;
      const usage = typeof data === "object" && data ? (data as any).usage : undefined;
      const base = { model, attempt: attemptNo, repair: repairing, latencyMs, finishReason, usage, contentLength: content.length };

      if (!content.trim()) {
        onAttempt?.({ ...base, outcome: "empty" });
        last = { kind: "busy", message: "AI service returned an empty generation." };
        break; // next model
      }
      if (finishReason === "length") {
        onAttempt?.({ ...base, outcome: "truncated" });
        last = { kind: "busy", message: "AI service response was truncated. Please try again." };
        break; // next model
      }

      const v = validate(content);
      if (v.ok) {
        onAttempt?.({ ...base, outcome: "ok" });
        return { data, content, model, usedFallback: isFallback };
      }

      const reason = redactValidatorError(v.error);
      onAttempt?.({ ...base, outcome: "validation", validationError: reason });
      last = { kind: "validation", message: v.error };
      if (repairUsed) break;
      repairUsed = true;
      repairing = true;
      messages = [
        ...payload.messages,
        { role: "assistant", content: content.slice(0, REPAIR_ECHO_MAX_CHARS) },
        {
          role: "user",
          content: `Your previous JSON was rejected: ${reason}. Return the corrected JSON object only, following every rule.`,
        },
      ] as BuiltAiPayload["messages"];
    }

    // A validation failure after the repair is final: another model will not fix it.
    if (last.kind === "validation") break;
  }

  if (last.kind === "validation") {
    throw new AiRoutingError("AI_VALIDATION_FAILED", last.message || "AI output rejected.", 502);
  }
  if (last.kind === "timeout") {
    throw new AiRoutingError("AI_TIMEOUT", last.message || "AI service request failed or timed out. Please try again.", 502);
  }
  throw new AiRoutingError("AI_BUSY", last.message || "AI service generation failed. Please try again.", 502, last.retryAfter);
}
