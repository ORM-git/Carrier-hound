# Managed Redis

**Status: INTERNAL - infrastructure doc, not user-facing.**

## What this is

`src/lib/cache/redis.ts` is an env-gated adapter over a managed Redis
(via the Upstash REST API, which needs no npm dependency and works in both
the Node and edge runtimes). Today there is no Redis anywhere in the repo
(repo evidence: `src/lib/cache/` contains only the in-process `lru.ts` and
`swr.ts`); this adapter adds the seam without changing any behavior.

- When `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are both
  set, `getRedis()` returns a live REST adapter.
- Otherwise it returns a noop: reads miss, writes no-op. Callers must
  treat the cache as an optimization, never a source of truth.
- The adapter is **fail-open**: network errors, non-200 responses, and
  Redis error bodies become a miss/no-op and are reported through the
  optional `onError` hook (wire it to `logger` from
  `src/lib/observability/logger.ts` or Sentry). A cache outage must never
  take a request path down.

## Usage

```ts
import { getRedis } from "@/lib/cache/redis";

const redis = getRedis();
const cached = await redis.get("jobs:suggest:ac");
if (cached === null) {
  // compute, then best-effort populate
  await redis.set("jobs:suggest:ac", JSON.stringify(value), { exSeconds: 300 });
}
```

## Data rules

- Keys: lowercase, colon-namespaced by domain (`rate:`, `jobs:`,
  `session:`), always with a TTL unless the entry is explicitly permanent.
- Values: **no PII, ever** - no emails, names, phone numbers, profile
  payloads, or raw resume text (see `docs/data-classification.md`).
  Pseudonymous ids and derived aggregates are fine.
- The token is a secret: vault only, never committed, never in client
  bundles (no `NEXT_PUBLIC_` prefix).

## Owner activation (dashboard steps, not done here)

1. Create an Upstash (or equivalent REST-capable) Redis database in the
   region nearest production traffic (Cloudflare Pages - owner to confirm
   current deploy region).
2. Store `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the
   vault, then set them as production env vars (Cloudflare Pages project
   settings; Netlify only if preview/legacy functions need it).
3. Adopt the adapter per use case, incrementally - candidate first users:
   rate limiting counters (currently in-process in
   `src/lib/api/sharedRateLimit.ts`) and hot read-through caches. Each
   adoption is its own PR with its row test.
4. Set an eviction policy (`allkeys-lru` is the chosen default for a
   pure-cache workload - owner to confirm) and an alert on memory usage in
   the provider dashboard.

## Why Upstash REST and not a TCP client

Edge runtimes cannot hold TCP connections; the REST API works over plain
fetch with no dependency. If a Node-only workload later needs pipelines or
pub/sub, that is a separate decision (and a separate adapter behind the
same `RedisAdapter` interface).
