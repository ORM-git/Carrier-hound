# Row 69: integration follow-up

Status: **LOCAL PREP ONLY.** Nothing here is wired into any host, route or page, and nothing has been executed against a real database. All proof is fixture-level (in-memory PGlite, fake builders) or source-compiled. None of it is canonical. The whole row 69 contract is **not** implemented.

**Owner-gated, with no authority yet:**
- any store for snapshots;
- any signing key;
- any transport for snapshots or cursors.

The PROPOSED-NOT-EXECUTED SQL fixture is only a candidate for the owner to review. It is not a plan to run, and this note proposes no RPC or store for any host.

## Contract to preserve

- **Stable membership and order:** original membership and order stay stable across data changes; jobs that became gone or ineligible drop out, with no repeat and no skip.
- **Ordering and pools:**
  - the route's NULLS FIRST ordering;
  - the multiword 200-row relevance;
  - the recommended 1000-row pool;
  - indefinite search, with no 1000 cap on search.
- **Transport and logging:** header-only transport, `no-store` responses, no tokens in logs.
- **All platform features stay**, on both hosts.
- **Rejected designs:** chained windows, a search cap, unsigned tokens, and a legacy-only Netlify fallback.

## What this prep contains

| File | Role |
|---|---|
| `src/lib/jobs/searchFilters.ts` | The search route's WHERE-clause block. **A verbatim copy, not used by the route**; it still matches the route after #897 (whitespace-normalized). |
| `src/lib/jobs/captureFilters.ts` | Recorder, PostgREST or-clause parser and serializer. Unknown methods or grammar throw (fail closed). |
| `src/lib/jobs/__tests__/fixtures/row69-capture.PROPOSED-NOT-EXECUTED.sql` | Owner-gated candidate SQL. Exercised only on PGlite. |
| `src/lib/jobs/__tests__/captureRpc.local.test.ts` | 9 fixture tests of that candidate. |
| `src/lib/pagination/readScan.ts` | `teeQuery`: forwards every builder call unchanged while recording it. `await q` / `run()` returns the live builder's own result; `then` and symbols are never treated as builder calls. |
| `src/lib/pagination/snapshotReplay.ts` | `captureOrder` (with optional owner/tier/queryHash binding) and `verifySnapshot`. `nextPage(snapshot, cursor, pageSize, fetchEligible)` is the only read path. |
| `src/lib/pagination/multiwordRelevance.ts` | `rankMultiword` (a verbatim copy of the route's inline relevance sort, source-compared in tests) and `captureMultiword`. |
| `src/lib/pagination/stabilityFallback.ts` | `liveFallback`: current behaviour, explicitly `stable: false`. `isStable` is true only for snapshot-served pages. |
| `src/lib/pagination/__tests__/row69LocalPrep.test.ts` | 18 tests, plus the real source mutants listed in the PR. |

### `nextPage` rules

- **The cursor is a position** in the frozen snapshot (the offset just after the last id consumed), never a page number. A negative, fractional or past-the-end cursor is rejected.
- **Reading and refilling:** each call reads id windows from the cursor and calls `fetchEligible(ids)`. That callback is where a host applies current visibility and eligibility. Ids that are gone or ineligible are dropped, and the page refills from further windows until it is full or the snapshot ends, up to `MAX_REFILL_WINDOWS` = 8 windows per call.
- **Short pages** happen only at `snapshot_end` or `refill_bound`, and the result says which.
- **Untrusted callback output:** rows for ids that weren't requested, duplicates, and rows from outside the window are ignored. There is no rows-only replay.
- **Page size** is 1 to `MAX_PAGE_SIZE` (100); anything else throws.
- **`hasMore` and `total`** come from the snapshot position, not from survivors.

## Route extract (still not applied)

#897 has merged (`a0f75cb9`). The supplied hunk that makes `src/app/api/jobs/search/route.ts` call `applyBaseVisibility` / `applySearchFilters` is still **not applied**, because this round allows no route changes. It belongs to the wiring step below. When that step happens:
- re-check `searchFilters.ts` and `rankMultiword` against the route of that day;
- have the route import both instead of keeping inline copies.

## Hosts and the files to wire (later, after review)

**1. Cloudflare Pages (edge server build; Next.js API routes)**
- `src/app/api/jobs/search/route.ts`:
  - apply the extract hunk;
  - page 1 builds the query through `teeQuery`;
  - the multi-word path freezes its 200 rows with `captureMultiword`;
  - later pages go through `nextPage` with a `fetchEligible` that re-applies the route's current visibility and eligibility to `id IN (...)`;
  - search stays indefinite, with `verified` NULLS FIRST as today.
  - How page 1's membership is held between requests is the owner-gated store/transport decision.
- `src/app/api/jobs/recommended/route.ts`: freeze the existing ranked, capped pool (at most 1000) with `captureOrder`, then serve with `nextPage`.
- `src/lib/jobs/service.ts` (`getLiveJobs`): carry the continuation in a header and read the stability flag; the existing degraded and 403/503 handling is kept.
- `src/app/jobs/page.tsx`: hold the continuation for the current query, and reset on rejection.
- **Every handler:** `verifySnapshot` against the request's owner, tier and query hash before serving, and `liveFallback(..., reason)` whenever no snapshot is available, so it never claims stability.

**2. Netlify search (static export + functions)**
- `netlify/functions/jobs-search.ts`: its own copy of the visibility and filter block and its own `(posted_at, id)` cursor today. It needs the same `searchFilters` import, `teeQuery` and `nextPage` as the Pages route, with behaviour kept equivalent.
- `netlify/functions/_cors.ts`: the continuation header has to be allowed (`:81` sets `Access-Control-Allow-Headers`).
- `netlify.toml`: `/api/jobs/search` already goes to the function (`:57-61`).

**3. Netlify recommended: the existing client-side feature**
- `src/lib/jobs/service.ts` `getLiveJobs` direct path (`:487-488`, ranking and slicing at `:880-898`): the feature **stays** in the contract.
- A Netlify adapter that serves it from a frozen snapshot is a later integration step, not dropped.
- Until then it reports `liveFallback(rows, "host_not_wired")`, explicitly not stable.

## Still unproven

- **Real PostgreSQL concurrency** (PGlite is a single connection).
- **The real `public.jobs_without_excluded_skills` view/function.** Its definition isn't in the repo; the tests use a stub.
- **A real PostgREST oracle.** Parity is shown against JS mirrors, an AST interpreter, the recorder's parser and fake builders.
- **Persistence and transport** of snapshots and cursors. Store, signing key and transport are owner-gated, with no authority.
- **Every host wiring** listed above, and live verification after review and release.
