# Request coalescing (cache stampede guard)

BE sheet rank 78. `src/lib/cache/singleFlight.ts` exports `singleFlight(key, loader)`:
concurrent callers for the same key share one in-flight loader promise.

- It is not a cache. The entry is removed when the promise settles, so a failure is
  never cached and no TTL is extended.
- A rejection reaches every coalesced caller; each handles it in its own try/catch.
- Scope is per isolate/process. It does not coordinate across Cloudflare isolates.

Applied to the two shared TTL-miss paths that run multi-query loads:

| Path | Key | What is coalesced |
| --- | --- | --- |
| `getAllActiveJobs` (`src/lib/jobs/service.ts`) | `jobs:getAllActiveJobs` | the count query plus up to 3 chunk reads |
| `GET /api/radar` (`src/app/api/radar/route.ts`) | `radar:aggregate` | the ingest_runs read, the chunked jobs reads and the aggregation |

Not applied: `/api/jobs/top10` (cache key is per user, so concurrent identical
requests are rare and the handler has an early 500 return inside the compute block),
and routes that rely only on `Cache-Control` s-maxage (`/api/ticker`, `/api/stats`).
Guard: `src/lib/__tests__/singleFlight.test.ts`.
