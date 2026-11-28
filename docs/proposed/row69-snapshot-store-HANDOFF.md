# Row 69 snapshot store: owner hand-off (run in this order)

Nothing here has been run on any real database. Run each step yourself, on a **staging or scratch** database first, then on production only after review. Each step says what it proves. Paste every output back into the PR thread.

Files: `docs/proposed/row69-snapshot-store/`. Design and reasoning: `docs/proposed/row69-snapshot-store-design.md`.

## Step 1: pre-check (read only, safe anywhere)

```
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/proposed/row69-snapshot-store/01_precheck.READONLY.sql
```

You can also paste the file into the Supabase SQL editor. It only runs `SELECT`s.

What it proves:
- **A:** no existing table or function would be overwritten. Expect 0 rows.
- **B:** the roles exist, `service_role` bypasses RLS, and `gen_random_uuid` and `hashtextextended` are available.
- **C:** `public.jobs` has every column the search capture reads.
- **D:** prints the real `jobs_without_excluded_skills` definition, signature and grants. This is the **same query text** as `docs/proposed/advanced_skill_rpc.READONLY.sql`, so one run answers both this work and the advanced-filter work.
- **E:** shows the default privileges the apply step revokes explicitly.

**Stop if:**
- A returns any row;
- B lacks a role, or `service_role` doesn't bypass RLS;
- D shows a signature other than `jobs_without_excluded_skills(text[])`, a view, or nothing. In that case don't use the excluded-skills search path; report it instead.

## Step 2: apply (staging first)

```
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/proposed/row69-snapshot-store/02_apply.PROPOSED-NOT-APPLIED.sql
```

It runs as one transaction: either everything is created, or nothing is. It creates the private table, its constraints and indexes, RLS with no policy, the grants and revokes, and the eight `SECURITY INVOKER` functions. It touches no existing table, row or function.

## Step 3: verify (read only)

```
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/proposed/row69-snapshot-store/03_verify.READONLY.sql
```

| Section | Expect |
|---|---|
| 1 | 1 table and 8 functions |
| 2 | `rls = true`, `policies = 0` |
| 3 | `anon`/`authenticated` false on every privilege; `service_role` true for SELECT/INSERT/DELETE, false for UPDATE |
| 4 | every function `prosecdef = false`, `proconfig = {search_path=""}`; `anon_exec` and `auth_exec` false; `service_exec` true |
| 5 | every constraint and the 2 indexes plus the primary key |
| 6 | limits `10, 20, 50000, 60, 100` |
| 7 | 0 active and 0 expired right after apply |

**Staging only, after verify:** run the multi-connection check. It writes test rows under a reserved owner range and deletes them at the end, and it refuses production-looking URLs.

```
SNAPSHOT_TEST_DATABASE_URL="$STAGING_DATABASE_URL" bash docs/proposed/row69-snapshot-store/05_concurrency-check.STAGING-ONLY.sh
```

It proves three things the local single-connection tests cannot:
- the per-owner rate limit is atomic under 30 parallel connections (exactly 10 succeed);
- parallel captures for different owners all succeed;
- reads stay correct during parallel purges.

## Step 4: rollback (only if needed)

First switch any server code that calls these functions back to the live fallback. Then:

```
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/proposed/row69-snapshot-store/04_rollback.PROPOSED-NOT-APPLIED.sql
```

It drops the eight functions and the table. Only snapshot rows (TTL at most 1 hour) are lost. Re-run `03_verify` section 1: expect 0 rows.

## Open decisions for you

1. Where purge runs: pg_cron, or an opportunistic server call to `feed_purge_expired_snapshots`.
2. Whether 20000 is the right search snapshot bound. Above it, that query gets the non-stable fallback.
3. The limits (10 per minute and 20 active per owner, 50000 global, 60-minute maximum TTL).
4. Guests keep the non-stable fallback until a verified server-side guest-session identity exists. None exists today.

## Adapter design after the SQL is applied (text only; nothing is wired in this PR)

All handlers derive owner, tier and query hash **server-side**: the verified auth token, the existing entitlement lookup, and the normalized request. The handle and position travel only in a request header. Responses carrying them are `no-store`, and nothing logs them. Pages are served by `nextPage` from PR #898 over `feed_read_snapshot_window`, with a `fetchEligible` that re-applies current visibility and entitlement. Any rejection gets the explicit non-stable live fallback, or a fresh capture from page 1; never page-number offsets.

**Cloudflare Pages (Next.js API routes):**
- `src/app/api/jobs/search/route.ts`:
  - normal path: page 1 calls `feed_capture_search_snapshot` with the AST recorded from the route's own filters (PR #898 `searchFilters` + `teeQuery`), NULLS FIRST order;
  - multiword path: rank the 200 fetched rows with the route's relevance (PR #898 `rankMultiword`), then `feed_capture_snapshot(kind 'multiword')`;
  - later pages: `feed_read_snapshot_window` + `nextPage`.
- `src/app/api/jobs/recommended/route.ts`: rank and cap the 1000-row pool exactly as today, then `feed_capture_snapshot(kind 'recommended')`; later pages go through the window read + `nextPage`.
- `src/lib/jobs/service.ts` (`getLiveJobs`): send and receive the header, keep the existing degraded and 403/503 handling, and read the stability flag.
- `src/app/jobs/page.tsx`: hold the handle and position for the current query; reset on rejection, new query or sign-out; keep Back/Forward and scroll.

**Netlify search (static export + functions):**
- `netlify/functions/jobs-search.ts`: the same capture and read as the Pages search route, behaviour kept equivalent. It has its own copy of the filter block and cursor today.
- `netlify/functions/_cors.ts`: allow the snapshot header (`:81` sets `Access-Control-Allow-Headers`).
- `netlify.toml`: no change. `/api/jobs/search` already maps to the function.

**Netlify recommended: the existing client path** (`src/lib/jobs/service.ts` `getLiveJobs` direct path, `:487-488` and `:880-898`):
- The feature stays.
- A browser can't call `service_role` functions, so stable paging there needs a later server adapter (a Netlify function serving the recommended capture and reads).
- Until then, the client path reports `liveFallback(rows, "host_not_wired")`: explicitly not stable.
