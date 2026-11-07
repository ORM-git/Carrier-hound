# Edge KV / Config Store

**Status: INTERNAL - infrastructure doc, not user-facing.**

## What this is

`src/lib/cache/edgeKv.ts` is an env-gated adapter for a Cloudflare KV
namespace, matching the production host (Cloudflare Pages - repo evidence:
Pages deploy config; owner to confirm the current project binding). It
gives the app a config/key-value seam without changing any behavior today.

Two backends behind one `EdgeKvAdapter` interface:

1. **Binding first** (the normal production path): a KV namespace bound to
   the Pages project is passed straight in from the request context
   (`getEdgeKv({ binding: env.CONFIG_KV })`). No tokens, no extra egress.
2. **REST fallback** (scripts, crons, local integration checks): enabled
   only when `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_KV_NAMESPACE_ID` and
   `CLOUDFLARE_KV_API_TOKEN` are all set; speaks the Cloudflare KV REST
   API over plain fetch.

Neither configured -> noop: reads miss, writes no-op. The adapter is
**fail-open**: backend errors become a miss/no-op and are reported through
the optional `onError` hook (wire it to `src/lib/observability/logger.ts`
or Sentry). The store is an optimization, never a source of truth.

## Usage

```ts
import { getEdgeKv } from "@/lib/cache/edgeKv";

// inside a Pages function with a CONFIG_KV binding:
const kv = getEdgeKv({ binding: context.env.CONFIG_KV });
const flags = await kv.getJson<FeatureFlags>("flags:current");
```

## Data rules

- Keys: lowercase, colon-namespaced (`flags:`, `config:`, `geo:`), always
  with a TTL (`ttlSeconds`) unless explicitly permanent.
- Values: **no PII, ever** (see `docs/data-classification.md`). Config,
  feature flags, and derived aggregates are fine.
- The REST API token is a secret: vault only, never committed, no
  `NEXT_PUBLIC_` prefix. Production traffic should use the binding path
  and not need the token at all.

## Owner activation (dashboard steps, not done here)

1. Create a KV namespace in the Cloudflare dashboard.
2. Bind it to the Pages project (suggested binding name `CONFIG_KV` -
   chosen default, owner to confirm) for production and preview.
3. For the REST fallback only: create an API token scoped to that
   namespace, store it in the vault, then set the three env vars where
   needed (local/cron environments; production should prefer the binding).
4. Adopt per use case in separate PRs - candidate first users: feature
   flags / runtime config, geo or taxonomy lookup snapshots. Each adoption
   ships with its own row test.

## When to use KV vs the Redis adapter

KV is read-optimized, globally replicated, and eventually consistent
(chosen fit: config/flags/snapshots). Redis (`src/lib/cache/redis.ts`) is
the pick for counters, rate limits, and short-lived coordination writes.
Both are fail-open seams; neither is a system of record.
