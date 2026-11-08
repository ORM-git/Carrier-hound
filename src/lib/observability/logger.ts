/**
 * Structured JSON logging (one JSON object per line, stdout).
 *
 * Design:
 * - zero-dependency, safe in edge and Node runtimes (uses only console.*)
 * - every line carries: ts (ISO-8601), level, msg, plus flat context fields
 * - child() binds persistent context (route, requestId, job, ...)
 * - secrets are redacted: any context key whose name matches the
 *   REDACTED_KEY_PATTERN (password, token, secret, authorization, cookie,
 *   api key, session, cvv, ...) is replaced with "[REDACTED]" before output
 * - LOG_LEVEL env filters output ("debug" | "info" | "warn" | "error" |
 *   "silent"); default "info". Unknown values fall back to "info".
 * - output is newline-safe: values are JSON.stringify'd, so a single log
 *   call always produces exactly one line
 *
 * Adoption is opt-in per route/module; existing console.* calls keep
 * working. See docs/structured-logging.md.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = Record<string, unknown>;

/** Keys whose values must never be logged (case-insensitive). */
const REDACTED_KEY_PATTERN =
  /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|session|cvv|cvc|otp|private/i;

const REDACTED = "[REDACTED]";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

/** Injectable sink: one call per fully-formed JSON line. Defaults to console. */
export type LogSink = (line: string, level: LogLevel) => void;

const defaultSink: LogSink = (line, level) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

function resolveMinLevel(envValue: string | undefined): number {
  if (envValue === "silent") return Number.POSITIVE_INFINITY;
  if (envValue && envValue in LEVEL_ORDER) return LEVEL_ORDER[envValue as LogLevel];
  return LEVEL_ORDER.info;
}

/** Deep-redact a context object. Never throws (circular-safe). */
export function redactContext(input: unknown, seen?: WeakSet<object>): unknown {
  const refs = seen ?? new WeakSet<object>();
  if (typeof input === "bigint") return input.toString();
  if (typeof input === "function" || typeof input === "symbol" || typeof input === "undefined") return String(input);
  if (typeof input === "number" && !Number.isFinite(input)) return String(input);
  if (input === null || typeof input !== "object") return input;
  if (refs.has(input as object)) return "[CIRCULAR]";
  refs.add(input as object);
  if (Array.isArray(input)) return input.map((v) => redactContext(v, refs));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (REDACTED_KEY_PATTERN.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactContext(v, refs);
    }
  }
  return out;
}

export interface Logger {
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  /** Bind persistent context; never mutates the parent. */
  child(context: LogContext): Logger;
  /** Current minimum level (numeric). */
  minLevel(): number;
}

export interface LoggerOptions {
  /** Bound context copied into every record. */
  context?: LogContext;
  /** Output sink (tests inject a capture array). */
  sink?: LogSink;
  /** Explicit minimum level; defaults to LOG_LEVEL env then "info". */
  level?: LogLevel | "silent";
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const baseContext = options.context ? { ...options.context } : {};
  const now = options.now ?? (() => new Date());
  const envLevel = options.level ?? process.env.LOG_LEVEL;
  const min = typeof envLevel === "string" && envLevel in LEVEL_ORDER
    ? LEVEL_ORDER[envLevel as LogLevel]
    : envLevel === "silent"
      ? Number.POSITIVE_INFINITY
      : resolveMinLevel(process.env.LOG_LEVEL);

  function emit(level: LogLevel, msg: string, context?: LogContext): void {
    if (LEVEL_ORDER[level] < min) return;
    const merged: Record<string, unknown> = { ...baseContext, ...(context ?? {}) };
    const record: LogRecord = {
      ts: now().toISOString(),
      level,
      msg: String(msg),
      ...(redactContext(merged) as Record<string, unknown>),
    };
    // JSON.stringify never throws here: circular refs already replaced.
    sink(JSON.stringify(record), level);
  }

  return {
    debug: (msg, context) => emit("debug", msg, context),
    info: (msg, context) => emit("info", msg, context),
    warn: (msg, context) => emit("warn", msg, context),
    error: (msg, context) => emit("error", msg, context),
    child: (context) =>
      createLogger({
        ...options,
        context: { ...baseContext, ...context },
        sink,
        now,
        level: options.level,
      }),
    minLevel: () => min,
  };
}

/** Shared app-wide logger (reads LOG_LEVEL once per call site import). */
export const logger = createLogger();
