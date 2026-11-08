# Cache Invalidation Strategy

Every cache in the system names its invalidation strategy up front. The
rule for adding a cache: pick one of the four strategies below, record
it in this table, and keep `src/lib/__tests__/cacheInvalidationDoc.test.ts`
green.

| Cache | Location | Strategy |
| --- | --- | --- |
| Client SWR store | `src/lib/cache/swr.ts` | Explicit invalidation: `invalidateSwr` by exact key or prefix after mutations, plus write-through `updateSwr` so mutation handlers update the cached bundle in place (no stale paint, no extra loading state); freshness windows via `isSwrStale`; memory-only, cleared on full reload |
| Cover-letter result cache | `src/lib/resume/tailor.ts` | Version key: `COVER_LETTER_CACHE_VERSION` bump invalidates all prior generations logically |
| AI idempotency result cache | `src/lib/ai/serviceHandler.ts` | Time-to-live: 24h TTL with expired-entry removal on read, plus a 10,000-entry cap |
| Rate-limit windows | `src/lib/api/sharedRateLimit.ts` | Time window: per-key `resetAt` expiry; windows self-expire |
| Static assets | bundler output | Content hash: hashed filenames make far-future caching safe; a new deploy is a new URL |

Why no central invalidation bus: data caches are few and mostly
isolates-local; the strategies above keep staleness bounded without
cross-instance coordination. If a shared data cache (e.g. the managed
Redis seam in `docs/managed-redis.md`) is adopted, its entries must use
one of these strategies - prefix invalidation or version keys for
write-through data, TTL for read-through data.

## Pending SWR reads

`invalidateSwr` detaches matching pending reads as well as completed values.
The next fetch starts a new loader. A detached old response cannot republish a
value or remove the newer dedupe slot, on success or failure. Exact keys take
precedence when a completed value or pending flight has that exact key;
otherwise matching prefixes are invalidated. Empty prefix clears all entries
unless an actual empty key exists (the same exact-key precedence applies).

This does not abort network requests or change the result returned to callers
already awaiting an old promise. UI callers still own their cancellation or
request-order guards. A successful `updateSwr` on a cached entry also detaches
an older in-flight read so it cannot overwrite the mutation result. It keeps
the original freshness timestamp. A missing-key update remains a no-op;
a throwing updater leaves both the entry and its pending read intact. Deferred-promise tests cover stale success/failure ordering.
