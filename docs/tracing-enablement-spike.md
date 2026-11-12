# Technical Spike: Server & Edge Distributed Tracing Enablement

**Status**: Technical Spike & Compatibility Assessment  
**Author**: Agent A / CareerMonke Engineering  
**Scope**: Production distributed tracing on Cloudflare Pages (`@cloudflare/next-on-pages` Edge Runtime)  
**Target Routes**: `/api/track`, `/api/jobs/search`, `/api/jobs/top10`, `/api/jobs/pro`, `/api/stats`  

---

## 1. Executive Summary & Problem Statement

Distributed tracing is currently **PARTIAL** across CareerMonke:

- **Client-Side**: Sentry tracing is enabled in `sentry.client.config.ts`, sampling 5% of production sessions (`tracesSampleRate: process.env.NODE_ENV === "production" ? 0.05 : 1.0`). The browser SDK creates spans for page loads and client navigations and injects `sentry-trace` and `baggage` HTTP headers into outbound `fetch` calls.
- **Server/Edge Side**: Server/edge auto-instrumentation is **disabled** in `next.config.mjs` to maintain compatibility with `@cloudflare/next-on-pages`.
- **The Observability Gap**: Because incoming HTTP requests to edge API route handlers (`export const runtime = "edge"`) lack server-side transaction and span creation, the distributed trace stops abruptly at the browser boundary. Server processing time, database query latency, Upstash Redis rate-limit round-trips, and candidate scoring waterfalls are invisible end-to-end. At launch, production tail latency (P95/P99) on core search and tracking routes cannot be diagnosed with waterfall traces.

This spike explains the exact technical root cause of this limitation, evaluates three architectural options for enabling server-side tracing, presents a compatibility risk assessment, and recommends a provably compatible path for launch.

---

## 2. Why Server/Edge Auto-Instrumentation is Disabled Today

### 2.1 The Pinned Configuration

In `next.config.mjs` (lines 41–43 and 46–58):

```javascript
  experimental: {
    instrumentationHook: false,
  },
};

export default withSentryConfig(nextConfig, {
  org: "olive-ridley-media",
  project: "careermonke",
  silent: true,
  widenClientFileUpload: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  disableLogger: true,
  // Disable automatic server/edge handler instrumentation to prevent
  // duplicate webpack module identifier collisions under @cloudflare/next-on-pages
  autoInstrumentServerFunctions: false,
  autoInstrumentMiddleware: false,
  autoInstrumentAppDirectory: false,
});
```

### 2.2 The `@cloudflare/next-on-pages` Build & Packaging Constraint

1. **Secondary Webpack Bundling into a Single Worker**:
   Next.js compiles each edge route handler into its own isolated function artifact under `.vercel/output/functions/` (e.g. `api/jobs/search.func`). Next-on-pages (`@cloudflare/next-on-pages`) then performs an automated second-stage compilation pass, bundling all function artifacts and static assets into a single combined Cloudflare Worker entrypoint (`_worker.js`).
2. **Duplicate Webpack Module Identifier Collisions**:
   When Sentry's automated AST wrapping is enabled (`autoInstrumentServerFunctions: true`, `autoInstrumentAppDirectory: true`), the Sentry webpack bundler plugin injects internal shims and wrapper modules into every individual route output. When `next-on-pages` merges these outputs into `_worker.js`, webpack detects duplicate module identifiers and conflicting global symbol definitions. This results in hard build failures (`Duplicate identifier` / `Conflicting module IDs`) or corrupted bundle initialization at runtime.
3. **Absence of Standard Node.js `instrumentation.ts` Hooks in `workerd`**:
   Next.js's standard `experimental.instrumentationHook: true` executes an `instrumentation.ts` file via Node.js runtime initialization (`register()` hook). On Cloudflare Pages, edge route handlers run inside Cloudflare's V8 worker runtime (`workerd`), which does not execute standard Node.js server lifecycle hooks without complex Node compatibility shims that increase bundle size and cold-start latency.

Consequently, automatic build-time AST instrumentation must remain strictly disabled.

---

## 3. High-Priority Route Latency Profile (The 5 Hottest Routes)

Production latency on the following five endpoints directly impacts user experience and platform reliability at launch:

| Route | HTTP Method | Runtime | Primary Workload & Latency Factors | Launch Observability Need |
| :--- | :--- | :--- | :--- | :--- |
| **`/api/track`** | `POST` | `edge` | High-frequency client telemetry: page views, Core Web Vitals (LCP, INP, CLS, TTFB, FCP), and funnel conversions. Encodes payload, writes to Supabase `page_views` / `funnel_events`. | High volume. Any server-side latency causes beacon queueing or dropped beacons on page unload. |
| **`/api/jobs/search`** | `GET` | `edge` | Primary user job search: Redis rate limiting, SQL query generation, candidate-country eligibility filtering, company capping (`capJobsPerCompany`), and keyset cursor encoding. Target budget: 2000ms. | Core product path. Essential to separate DB fetch time from edge memory filtering and pagination. |
| **`/api/jobs/top10`** | `POST` | `edge` | Personalized matching: extracts Bearer token, fetches candidate profile, scores candidate skills against live job pool, and generates fit diagnostics. | High compute relative to standard search; needs span breakdown of auth check vs query vs ranking. |
| **`/api/jobs/pro`** | `GET`, `POST` | `edge` | Subscriber Pro feed: server entitlement verification (`getServerEntitlement`), unmasked salary data retrieval, and filter evaluation. | Paid subscriber experience. Latency spikes directly erode subscription trust. |
| **`/api/stats`** | `GET` | `edge` | Public statistics counter: live job counts, company aggregates, and country tallies with SWR in-memory caching and conditional ETag handling. Target budget: 1000ms. | High concurrency from landing page. Needs visibility into cache hit vs origin database fetch duration. |

---

## 4. Evaluation of Architectural Options

### Option 1: Manual Span Instrumentation via Existing `@sentry/nextjs` SDK (Recommended)

- **Architecture**:
  - Keep `next.config.mjs` automated AST instrumentation disabled (`autoInstrumentServerFunctions: false`, `instrumentationHook: false`).
  - Introduce a lightweight wrapper `src/lib/monitoring/tracing.ts` (`withRouteSpan`) that invokes `Sentry.continueTrace` and `Sentry.startSpan`.
  - Gate execution behind an environment variable flag `ENABLE_SERVER_TRACING=true` (default: **`false` / OFF**).
  - Wrap the route handlers of the 5 hottest routes.
- **Compatibility Risk Assessment**:
  - *Build Compatibility*: **Zero risk**. Does not modify webpack bundler options, `next.config.mjs`, or build pipelines. `@sentry/nextjs` is already installed and imported by `reportRequestErrorToSentry` across these routes.
  - *Runtime Compatibility*: **Low risk / Provably Compatible**. `@sentry/nextjs` edge exports (`@sentry/core`) safely execute `startSpan` in edge environments. When `ENABLE_SERVER_TRACING` is disabled, the wrapper directly awaits the handler with zero overhead. Even if Sentry SDK fails or is misconfigured, the wrapper catches and fails open.
  - *Subrequest Quota*: Cloudflare Workers allow 50 subrequests per execution. Sentry envelope delivery uses standard `fetch` transport. In production, tracing should use Sentry's existing 5% sample rate to stay well within quotas.

### Option 2: OpenTelemetry-Lite Manual Spans

- **Architecture**:
  - Implement a bespoke lightweight tracer that manually parses incoming W3C `traceparent` headers (`00-<trace_id>-<span_id>-<flags>`), generates child span IDs, records `performance.now()`, and exports JSON spans to a custom collector or Cloudflare Logpush.
- **Compatibility Risk Assessment**:
  - *Build & Runtime*: High compatibility with `workerd`, but completely disconnected from Sentry Performance UI.
  - *Maintenance Burden*: **High**. Requires writing and maintaining custom span serialization, context propagation, and sampling logic, creating an unmaintained proprietary observability silo.

### Option 3: Waiting for Upstream Platform Auto-Instrumentation

- **Architecture**:
  - Defer all server tracing until `@cloudflare/next-on-pages` and `@sentry/nextjs` provide seamless zero-config edge auto-instrumentation.
- **Compatibility Risk Assessment**:
  - *Build & Runtime*: Zero risk today.
  - *Operational Risk at Launch*: **High**. Launches with zero end-to-end trace visibility on `/api/track` and job routes. If P99 spikes on search, engineers cannot determine whether the bottleneck is Supabase database queries, network latency, or edge CPU execution.

---

## 5. Comparison Matrix

| Criterion | Option 1: Manual Sentry Spans (Gated) | Option 2: OpenTelemetry-Lite | Option 3: Wait for Platform |
| :--- | :--- | :--- | :--- |
| **next-on-pages Build Safety** | **Provably Safe** (No webpack AST injection) | **Safe** | **Safe** |
| **End-to-End Distributed Trace** | **Yes** (Connects client `sentry-trace`) | No (Requires custom bridge) | No |
| **Sentry Performance UI** | **Yes** (Native spans & waterfalls) | No | No |
| **Default OFF Safety Net** | **Yes** (`ENABLE_SERVER_TRACING=true`) | Yes | Yes (No-op) |
| **Implementation Footprint** | Small (~75 lines helper + route wrapping) | Large (Full OTel serialization) | Zero |
| **Launch Readiness** | **Ready immediately** | Weeks of plumbing | Unknown (Upstream dependency) |

---

## 6. Recommended Implementation Path

1. **Land Pure Tracing Helper (`src/lib/monitoring/tracing.ts`)**:
   Implement `withRouteSpan(route, req, fn, options)` and `isServerTracingEnabled()`:
   - Default state: `process.env.ENABLE_SERVER_TRACING === "true"` (default: `false`).
   - Disabled state: Directly executes and returns `await fn()` with zero overhead and zero Sentry calls.
   - Enabled state: Extracts `sentry-trace`, `baggage`, and `x-request-id`, invokes `Sentry.continueTrace()`, starts an `http.server` span, and attaches `http.status_code`.
   - Fail-open: Transparently catches any Sentry internal exception and proceeds with the handler.
2. **Wire the 5 Hottest Routes**:
   Wrap `/api/track`, `/api/jobs/search`, `/api/jobs/top10`, `/api/jobs/pro`, and `/api/stats` with `withRouteSpan`.
3. **Register Offline Guard Test (`scripts/test-tracing-enablement.ts`)**:
   Enforce default OFF bypass, enabled span creation, distributed trace header extraction, fail-open resilience, route wiring completeness, and negative control verification. Register append-only in `scripts/suite-runner.ts`.
4. **Owner Operational Rollout**:
   Leave `ENABLE_SERVER_TRACING` unset in production initially. When diagnosing launch performance or verifying tail latency, set `ENABLE_SERVER_TRACING=true` in Cloudflare Pages environment variables to enable 5% sampled end-to-end traces.
