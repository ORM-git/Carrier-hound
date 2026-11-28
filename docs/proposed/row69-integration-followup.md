# Row 69: integration follow-up (after #897 merges)

Status: **LOCAL PREP ONLY.** Nothing here is wired into any host, route or page, and nothing has been executed against a real database. All proof is fixture-level (in-memory PGlite, fake builders) or source-compiled. None of it is canonical.

The whole contract is **not** implemented yet. What exists locally:
- the atomic single-CTE capture for the normal search path. It's a fixture SQL file marked PROPOSED-NOT-EXECUTED, and it proposes a new private TTL table;
- four pure modules with tests.

**No signing key and no infrastructure change is approved**, and none is assumed. The proposed TTL table stays a proposal.

## What this prep contains

| File | Role |
|---|---|
| `src/lib/jobs/searchFilters.ts` | The search route's WHERE-clause block. **Today a verbatim copy, not used by the route** (see "Route extract" below). |
| `src/lib/jobs/captureFilters.ts` | Recorder, PostgREST or-clause parser and serializer. Unknown methods or grammar throw (fail closed). |
| `src/lib/jobs/__tests__/fixtures/row69-capture.PROPOSED-NOT-EXECUTED.sql` | Proposed capture RPC and private TTL table. Exercised only on PGlite. |
| `src/lib/jobs/__tests__/captureRpc.local.test.ts` | 9 fixture tests of the capture RPC. |
| `src/lib/pagination/readScan.ts` | `teeQuery`: forwards every builder call unchanged while recording it, so capture can't change which rows a filter returns. |
| `src/lib/pagination/snapshotReplay.ts` | `captureOrder` / `pageIds` / `replayPage`: freeze an ordered id list once, then serve page N by id, survivors only. |
| `src/lib/pagination/multiwordRelevance.ts` | `rankMultiword` (a verbatim copy of the route's inline relevance sort, source-compared in tests) and `captureMultiword` (exactly the ordered ids of the at most 200 fetched rows). |
| `src/lib/pagination/stabilityFallback.ts` | `liveFallback`: current behaviour, explicitly `stable: false` with a notice. `isStable` is true only for snapshot-served pages. |
| `src/lib/pagination/__tests__/row69LocalPrep.test.ts` | 12 tests for the four modules. |

## Route extract (blocked by #897)

The supplied diff also edited `src/app/api/jobs/search/route.ts`, so that the route itself calls `applyBaseVisibility` / `applySearchFilters`. That file is changed by open PR #897, so **the hunk was not applied**.

Until it is, `searchFilters.ts` is a copy. It matched the route's block exactly (whitespace-normalized) on main `5212d17e`, but nothing keeps them in step. After #897 merges:
- re-check the copy against the merged route;
- apply the route hunk;
- re-run `captureRpc.local.test.ts`.

The same applies to `multiwordRelevance.rankMultiword`: the route should import it instead of keeping its own inline copy.

## Hosts and the exact files to wire (after #897)

**1. Cloudflare Pages (edge server build; Next.js API routes)**
- `src/app/api/jobs/search/route.ts`:
  - apply the extract hunk;
  - capture page 1 through `teeQuery` and the capture RPC (normal path) or `captureMultiword` (multi-word path, 200 rows, current relevance);
  - serve later pages by id with `replayPage` under the current eligibility;
  - continuation in a request header only, responses `Cache-Control: no-store`, no tokens in logs;
  - search stays indefinite, with no 1000 cap;
  - `verified` keeps today's NULLS FIRST order.
- `src/app/api/jobs/recommended/route.ts`: capture the ranked, capped pool (at most 1000) from the existing `rankJobsByRecommendation` + `capJobsPerCompany` output with `captureOrder`, and serve pages with `replayPage`.
- `src/lib/jobs/service.ts` (`getLiveJobs`): send the continuation header, read the stability flag, and keep the existing degraded and 403/503 handling.
- `src/app/jobs/page.tsx`: hold the continuation for the current query, and reset on rejection.
- Every handler: return `liveFallback(..., reason)` whenever capture is unavailable or rejected, so it never claims stability.

**2. Netlify search (static export + functions)**
- `netlify/functions/jobs-search.ts`: today it has its own copy of the visibility and filter block (`:295`, `:455`) and its own `(posted_at, id)` cursor. It needs the same `searchFilters` import, capture and replay as the Pages route, with behaviour kept equivalent.
- `netlify/functions/_cors.ts`: the continuation header has to be added to `allowedHeaders` (`:81` sets `Access-Control-Allow-Headers`) for the function that serves it.
- `netlify.toml`: no change unless a new endpoint is added. `/api/jobs/search` already goes to the function (`:57-61`).

**3. Netlify recommended client path**
- `src/lib/jobs/service.ts` `getLiveJobs` direct path (`:487-488`, ranking and slicing at `:880-898`): the existing client-side recommended feature **stays**.
- A Netlify adapter that serves it from a captured snapshot is a later integration step, not dropped.
- Until then the path must report `liveFallback(rows, "host_not_wired")`, which is explicitly not stable, rather than claim stability.

## Still unproven (needed before anything is called done)

- **Real PostgreSQL concurrency.** PGlite is a single connection. Advisory locks, rate limits and capture atomicity under concurrent requests are untested.
- **The real `public.jobs_without_excluded_skills` view/function.** Its definition isn't in the repo; the tests use a stub.
- **A real PostgREST oracle.** Parity is shown against the repo's JS mirrors, an AST interpreter and the recorder's parser. PostgREST's own parsing and evaluation of the same requests has not been run.
- **Snapshot persistence and transport.** The private TTL table is a proposal only, and no signing key is approved. How a continuation is carried and verified is open.
- **Every host wiring** listed above, and live verification after review and release.
