# Structured JSON Logging

**Status: INTERNAL - infrastructure doc, not user-facing.**

## What this is

`src/lib/observability/logger.ts` provides a zero-dependency structured
logger. Each log call emits exactly one line of JSON to stdout/stderr:

```json
{"ts":"2026-11-06T10:00:00.000Z","level":"info","msg":"request completed","route":"/api/ticker","requestId":"req-1"}
```

Guarantees (all covered by `scripts/test-structured-logger.ts`):

- one JSON object per line, always parseable (multi-line messages and
  context values are JSON-escaped, never line-breaking)
- fields: `ts` (ISO-8601), `level` (`debug` | `info` | `warn` | `error`),
  `msg`, plus flat context
- level filtering via the `LOG_LEVEL` env var (`debug` | `info` | `warn` |
  `error` | `silent`); default `info`; unknown values fall back to `info`
- secret redaction: context keys matching
  `password|secret|token|authorization|cookie|api[-_]?key|session|cvv|cvc|otp|private`
  (case-insensitive, nested included) are replaced with `[REDACTED]`
  before serialization, so secret values never reach the log line
- circular references, bigints, functions, symbols, NaN/Infinity never
  throw; they are replaced with stable string markers
- `child(context)` binds persistent context (requestId, route, job name)
  without mutating the parent logger

## Why JSON lines

Cloudflare Pages (production - repo evidence: `wrangler.toml` / Pages
deploy config; owner to confirm the current dashboard binding) and Netlify
(preview/legacy functions) both capture stdout per invocation. One JSON
object per line means logs can be grepped, parsed by `jq`, and ingested by
any log drain (Sentry already captures errors via
`src/lib/monitoring/sentryErrorReporter.ts`; JSON lines complement it for
non-error events). No log-shipping dependency is introduced - that keeps
the edge runtime free of Node-only SDKs.

## Usage

```ts
import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { service: "api" } });

export async function GET(req: Request) {
  const reqLog = log.child({ requestId: crypto.randomUUID(), route: "/api/ticker" });
  reqLog.info("request start");
  try {
    // ...
    reqLog.info("request completed", { status: 200 });
  } catch (err) {
    reqLog.error("request failed", { err: String(err) });
  }
}
```

## Adoption

Adoption is opt-in per route/module. This change intentionally does **not**
rewrite existing `console.*` call sites: the logger is additive, and routes
migrate incrementally (suggested order: API routes with the most
`console.*` calls first). Existing behavior is unchanged until a call site
opts in.

Status (Backend sheet rank 102): every server-side module under `src/lib`,
`src/app/api` and `src/middleware.ts` logs through the logger, so `LOG_LEVEL`
filtering covers the listed adopting modules. The logger seam itself owns
console output. `src/lib/api/routeBudget.ts` now uses the seam too: budget breaches
retain their event/route/budgetMs/durationMs fields and add the common
level/msg/ts/module envelope. `LOG_LEVEL=error` or `silent` suppresses this warn
just like other adopting modules. Level is read when the module initializes,
not changed dynamically during an invocation. Remaining `console.*` calls under `src` are client/UI
files (pages and components), which run in the browser and are out of scope for
`LOG_LEVEL`. Guards: `structuredLoggingLibAdoption.test.ts` (lib modules and
middleware) and `structuredLoggingAdoption.test.ts` (routes).

For tests, inject a sink:

```ts
const lines: string[] = [];
const log = createLogger({ sink: (line) => lines.push(line), now: () => new Date(0) });
```

## Ops notes

- Set `LOG_LEVEL=debug` only for short investigations; production default
  `info` is the intended steady state (chosen default - owner to confirm).
- Redaction is a last line of defense, not a license to log request
  bodies: keep PII out of context fields per `docs/data-classification.md`.
