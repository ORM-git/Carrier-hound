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
  isModelInCooldown,
  setModelCooldown,
  getModelCooldownRemaining,
  type AiTextCompletionProviderAdapter,
  type AiTextCompletionResponse,
} from "./providerAdapter";
import type { BuiltAiPayload } from "./security";
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "ai/routing" } });

export type AiAttemptOutcome =
  | "ok"
  | "timeout"
  | "http"
  | "empty"
  | "truncated"
  | "validation";

export type AiErrorCode =
  | "AI_TIMEOUT"
  | "AI_BUSY"
  | "AI_VALIDATION_FAILED"
  | "AI_NOT_CONFIGURED";

export interface AiAttemptInfo {
  requestId?: string;
  model: string;
  attempt: number;
  repair: boolean;
  outcome: AiAttemptOutcome;
  latencyMs: number;
  httpStatus?: number;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  contentLength: number;
  /** Validator reason code with no employer names or IDs. Never raw model output. */
  validationError?: string;
}

export class AiRoutingError extends Error {
  readonly code: AiErrorCode;
  readonly statusCode: number;
  readonly retryAfter?: number;
  billableTokens?: number;
  constructor(code: AiErrorCode, message: string, statusCode: number, retryAfter?: number, billableTokens?: number) {
    super(message);
    this.name = "AiRoutingError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.billableTokens = billableTokens;
  }
}

export type RoutingValidation = { ok: true } | { ok: false; error: string };

export interface RouteCompletionOptions {
  adapter: AiTextCompletionProviderAdapter;
  payload: BuiltAiPayload;
  apiKey?: string;
  requestId?: string;
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

export function getValidationReasonCode(error: string): string {
  if (!error) return "VALIDATION_FAILED";
  const e = String(error).toLowerCase();
  if (e.includes("json")) return "JSON_INVALID";
  if (e.includes("html") || e.includes("markup") || e.includes("script")) return "MARKUP_DISALLOWED";
  if (e.includes("paragraph")) return "PARAGRAPH_COUNT_MISMATCH";
  if (e.includes("word count") || e.includes("words")) return "WORD_COUNT_OUT_OF_BOUNDS";
  if (e.includes("numeric") || e.includes("number")) return "NUMERIC_FACT_MISMATCH";
  if (e.includes("bullet count")) return "BULLET_COUNT_MISMATCH";
  if (e.includes("experience id") || e.includes("experienceid")) return "EXPERIENCE_ID_MISMATCH";
  if (e.includes("cross-employer")) return "CROSS_EMPLOYER_FACT_TRANSFER";
  if (e.includes("forbidden field") || e.includes("schema")) return "SCHEMA_INVALID";
  if (e.includes("degree")) return "DEGREE_UNGROUNDED";
  if (e.includes("employer") || e.includes("company")) return "EMPLOYER_UNGROUNDED";
  if (e.includes("skill") || e.includes("tool")) return "SKILL_UNGROUNDED";
  if (e.includes("keyword")) return "KEYWORD_UNGROUNDED";
  if (e.includes("summary")) return "SUMMARY_UNGROUNDED";
  return "VALIDATION_FAILED";
}

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
        // On 429, we do NOT immediately try fallback; we place the model in cooldown and report busy
        eligibleForFallback: (s >= 500 && s <= 599),
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
): Promise<{
  data: AiTextCompletionResponse | string;
  content: string;
  model: string;
  usedFallback: boolean;
  totalBillableTokens: number;
}> {
  const { adapter, payload, apiKey, validate, onAttempt } = opts;
  const totalMs = opts.totalMs ?? DEFAULT_TOTAL_MS;
  const started = Date.now();
  const deadline = started + totalMs;

  const reqId = opts.requestId || "unknown";
  const emitAttempt = (info: AiAttemptInfo) => {
    const tokens =
      info.usage?.total_tokens ??
      (((info.usage?.prompt_tokens ?? 0) + (info.usage?.completion_tokens ?? 0)) || 0);
    const finishReason = info.finishReason ?? null;
    const structuredLog: Record<string, any> = {
      requestId: reqId,
      model: info.model,
      latency: info.latencyMs,
      finish_reason: finishReason,
      tokens,
      outcome: info.outcome,
    };
    if (info.validationError) {
      structuredLog.validation_code = getValidationReasonCode(info.validationError);
    }
    log.info("[AI Attempt]", structuredLog);
    onAttempt?.({ ...info, requestId: reqId });
  };

  const models = [payload.model];
  if (payload.fallbackModel && payload.fallbackModel !== payload.model) {
    models.push(payload.fallbackModel);
  }

  let repairUsed = false;
  let attemptNo = 0;
  let totalBillableTokens = 0;
  const conservativePerAttemptTokens = (payload.estimatedInputTokens || 0) + (payload.maxOutputTokens || 0);
  let last: { kind: "timeout" | "busy" | "validation" | "config"; retryAfter?: number; message?: string } = {
    kind: "timeout",
  };

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const isFallback = mi > 0;

    // Check if model is currently in cooldown
    if (isModelInCooldown(model)) {
      if (!isFallback && models.length > 1) {
        // Skip primary model if cooled down, jump directly to fallback
        continue;
      }
      const remSec = Math.ceil(getModelCooldownRemaining(model) / 1000);
      throw new AiRoutingError("AI_BUSY", "AI service is busy right now.", 502, remSec || 30, totalBillableTokens);
    }

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

      let timeoutTimer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          controller.abort();
          const err = new DOMException("The operation timed out", "AbortError");
          reject(err);
        }, attemptMs);
      });

      let parentAbortListener: (() => void) | undefined;
      const parentAbortPromise = new Promise<never>((_, reject) => {
        if (opts.signal?.aborted) {
          controller.abort();
          const err = new DOMException("The operation was aborted", "AbortError");
          reject(err);
          return;
        }
        parentAbortListener = () => {
          controller.abort();
          const err = new DOMException("The operation was aborted", "AbortError");
          reject(err);
        };
        opts.signal?.addEventListener("abort", parentAbortListener, { once: true });
      });

      const t0 = Date.now();
      attemptNo++;

      let data: AiTextCompletionResponse | string;
      try {
        const callPromise = adapter.completeText(
          { ...payload, model, messages },
          { signal: controller.signal, apiKey, allowRetry: false, deadline }
        );
        data = await Promise.race([callPromise, timeoutPromise, parentAbortPromise]);
        // Double-check wall-clock deadline to reject late results
        if (Date.now() > deadline || opts.signal?.aborted) {
          throw new DOMException("The operation timed out", "AbortError");
        }
      } catch (err) {
        // Unknown network or failed outcome: count conservatively towards budget
        totalBillableTokens += conservativePerAttemptTokens;
        const f = classifyThrown(err, Boolean(controller.signal.aborted || opts.signal?.aborted));
        emitAttempt({
          model,
          attempt: attemptNo,
          repair: repairing,
          outcome: f.outcome,
          latencyMs: Date.now() - t0,
          httpStatus: f.status,
          contentLength: 0,
        });
        if (f.status === 401 || f.status === 403) {
          throw new AiRoutingError("AI_NOT_CONFIGURED", "AI service is not configured.", 500, undefined, totalBillableTokens);
        }
        if (f.status === 429) {
          // Put model in cooldown instead of immediately trying fallback
          const cdSec = typeof f.retryAfter === "number" && f.retryAfter > 0 ? f.retryAfter : 30;
          setModelCooldown(model, cdSec * 1000);
          throw new AiRoutingError("AI_BUSY", "AI service is experiencing high demand. Please try again.", 502, f.retryAfter, totalBillableTokens);
        }
        last = {
          kind: f.outcome === "timeout" ? "timeout" : "busy",
          retryAfter: f.retryAfter,
          message: f.message,
        };
        if (!f.eligibleForFallback) {
          throw new AiRoutingError("AI_BUSY", f.message || "AI service generation failed. Please try again.", 502, f.retryAfter, totalBillableTokens);
        }
        break; // next model
      } finally {
        clearTimeout(timeoutTimer);
        if (parentAbortListener) {
          opts.signal?.removeEventListener("abort", parentAbortListener);
        }
        controller.abort();
      }

      const latencyMs = Date.now() - t0;
      const content = extractTextCompletionContent(data) ?? "";
      const choice = typeof data === "object" && data ? (data as any).choices?.[0] : undefined;
      const finishReason: string | undefined = choice?.finish_reason ?? undefined;
      const usage = typeof data === "object" && data ? (data as any).usage : undefined;

      const pTokens = Number(usage?.prompt_tokens) || 0;
      const cTokens = Number(usage?.completion_tokens) || 0;
      const attemptTokens = Number(usage?.total_tokens) || (pTokens + cTokens);
      totalBillableTokens += attemptTokens > 0 ? attemptTokens : conservativePerAttemptTokens;

      const base = { model, attempt: attemptNo, repair: repairing, latencyMs, finishReason, usage, contentLength: content.length };

      if (!content.trim()) {
        emitAttempt({ ...base, outcome: "empty" });
        last = { kind: "busy", message: "AI service returned an empty generation." };
        break; // next model
      }
      if (finishReason === "length") {
        emitAttempt({ ...base, outcome: "truncated" });
        last = { kind: "busy", message: "AI service response was truncated. Please try again." };
        break; // next model
      }

      const v = validate(content);
      if (v.ok) {
        emitAttempt({ ...base, outcome: "ok" });
        return { data, content, model, usedFallback: isFallback, totalBillableTokens };
      }

      const reason = redactValidatorError(v.error);
      emitAttempt({ ...base, outcome: "validation", validationError: reason });
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
    throw new AiRoutingError("AI_VALIDATION_FAILED", last.message || "AI output rejected.", 502, undefined, totalBillableTokens);
  }
  if (last.kind === "timeout") {
    throw new AiRoutingError("AI_TIMEOUT", last.message || "AI service request failed or timed out. Please try again.", 502, undefined, totalBillableTokens);
  }
  throw new AiRoutingError("AI_BUSY", last.message || "AI service generation failed. Please try again.", 502, last.retryAfter, totalBillableTokens);
}
