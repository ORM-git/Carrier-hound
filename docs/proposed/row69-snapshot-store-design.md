# Row 69: feed snapshot store, design (PROPOSED, NOT APPLIED)

Status: author-and-test only. The SQL in `docs/proposed/row69-snapshot-store/` has **never been run on any real database**. It is exercised only on an in-memory PGlite fixture (`src/lib/pagination/__tests__/snapshotStore.pglite.test.ts`). All proof is fixture or source-compiled, never canonical. No route, host or page is wired. There is no env or secret change, and no signing key.

The owner applies it later, by hand, following `docs/proposed/row69-snapshot-store-HANDOFF.md`.

## What it is

- **A private table** `public.feed_snapshots`. Each row holds one frozen ordered membership:
  - `ids uuid[]`, in rank order;
  - `kind`: `search`, `multiword` or `recommended`;
  - `owner_id`, `tier`, `query_hash`, `scoring_rev`;
  - `created_at`, `expires_at` (TTL at most 1 hour);
  - `member_count`, with a size bound per kind.
- **A bearer handle.** Each row is keyed by an unguessable 64-hex id: two `gen_random_uuid()` values, 244 random bits, generated in the database and never sequential.
- **Paging** reads id windows by a **position** (the offset just after the last id consumed). That's the cursor of PR #898's `nextPage`, which then applies current eligibility and refills holes.

**The id is a handle, not a binding.** Every read re-checks expiry, owner, tier and query hash *inside* `feed_read_snapshot_window`. Unknown ids, expired ids and any mismatch all raise the same `snapshot_unavailable` (SQLSTATE `P0002`), so a probe can't tell "exists for someone else" from "does not exist". There is never an offset fallback.

## Where owner, tier and query hash come from: server-side only

| Part | Source | Never |
|---|---|---|
| `owner_id` | The user id from the verified Supabase auth token: `supabaseAdmin.auth.getUser(token)` (`src/app/api/jobs/recommended/route.ts:148`, `src/app/api/jobs/search/route.ts:160`). | A client-sent id or header. |
| `tier` | The server entitlement lookup the routes already use for Pro masking (`isPro = Boolean(entitlement.isPro)`, `src/app/api/jobs/recommended/route.ts:152`). | A client claim. |
| `query_hash` | SHA-256 (64 hex) of the server-normalized request: surface, every effective filter, sort, page size and the candidate/preferences revision. | Hashed by the client. |
| `scoring_rev` | The server's scoring revision. Stored so a later page can be checked against it. | |

**Guests.** A shared literal owner such as `guest` would let every guest read every other guest's snapshot. The repo has **no verified server-side guest-session identity**:
- `src/middleware.ts:15`, `:28` and `:608` treat a guest only as "not signed in";
- nothing in `src/`, `netlify/` or `supabase/` issues or verifies a guest id (searched: guest/anonymous session, visitor id, `signInAnonymously`, `is_anonymous`).

So guests get **no snapshot**. They keep today's behaviour through `liveFallback(rows, "host_not_wired")` from PR #898, which explicitly says "not stable". `owner_id` is a `uuid` column and `tier` allows only `free` or `pro`, so a guest or shared owner can't be stored at all. This design invents no guest cookie or key.

## Table, constraints, indexes, access

- **CHECK constraints:**
  - id format `^[0-9a-f]{64}$`;
  - kind in the three values; tier in `free`/`pro`; `query_hash` 64-hex; `scoring_rev` 1–128 chars;
  - `ids` one-dimensional, 1-based, with no NULL;
  - `member_count = cardinality(ids) >= 1`;
  - TTL: `expires_at > created_at` and at most `+1 hour`;
  - size: multiword ≤ 200 (the route's relevance pool), recommended ≤ 1000 (its pool), search ≤ 20000.
- **Indexes:** `expires_at` (purge, capacity count) and `(owner_id, created_at)` (per-owner rate).
- **RLS enabled with no policy at all.** `REVOKE ALL` from `PUBLIC`, `anon` and `authenticated`. `service_role` gets `SELECT, INSERT, DELETE` only, with no `UPDATE`: a snapshot is never modified.
- **Defaults.** Supabase's default privileges grant new `public` objects to `anon`/`authenticated`, so the explicit revokes matter. The tests apply such defaults and prove the revokes hold.

## Functions and their privilege level

Every function is **`SECURITY INVOKER`**, with `SET search_path = ''` and schema-qualified names. The only caller is the server, connecting as `service_role`, which already holds the table grants and bypasses RLS. Advisory locks need no special privilege. So **no function needs `SECURITY DEFINER`**, and none uses it.

`EXECUTE` is revoked from `PUBLIC`, `anon` and `authenticated` on every function and granted only to `service_role`.

| Function | Why INVOKER is enough |
|---|---|
| `feed_capture_snapshot(kind, owner, tier, query_hash, scoring_rev, ids uuid[], ttl_min)` | Stores an already-ranked list: the recommended pool and multiword relevance, ranked by the server's existing code, unchanged. Validates every argument, rejects duplicates, NULLs and over-bound lists. Needs only INSERT and SELECT, which `service_role` has. |
| `feed_capture_search_snapshot(filters jsonb, verified_first, owner, tier, query_hash, scoring_rev, max, ttl_min, excluded text[])` | The single-CTE capture from PR #898 (ordered, then aggregate in rank order, then insert, in **one statement**), with the route's order (`verified DESC`, Postgres default NULLS FIRST; `posted_at DESC NULLS LAST`; `id DESC`). The base relation is `public.jobs`, or `public.jobs_without_excluded_skills(text[])`. Needs SELECT on jobs and the excluded-skills function, which `service_role` has. |
| `feed_snapshot_filter_sql(jsonb)` | Pure: compiles the allowlisted filter AST into a predicate, with values quoted by `%L`. No table access. |
| `feed_read_snapshot_window(id, owner, tier, query_hash, position, count)` | Re-checks expiry and the full binding inside the function on every call. `count` is 1–100, `position` is 0..total. Needs SELECT only. |
| `feed_purge_expired_snapshots(limit)` | Deletes expired rows, at most `least(greatest(limit,1),5000)` per call. Needs DELETE only. |
| `feed_snapshot_admit(owner)` | Rate and capacity gate (below). Needs SELECT and an advisory lock. |
| `feed_snapshot_check_args`, `feed_snapshot_limits` | Pure validation and constants. |

## Rate limit and capacity: atomic under concurrent captures

Both capture functions call `feed_snapshot_admit(owner)` **inside the same transaction as their insert**. It takes one transaction-scoped advisory lock (`pg_advisory_xact_lock(hashtextextended('public.feed_snapshots:capture', 0))`), then counts:
- per owner: at most 10 captures per minute and at most 20 active;
- global: at most 50000 active rows.

Because every capture holds the same lock until it commits, no other capture can insert between this one's count and its insert. There is no read-then-insert race. The limits live in `feed_snapshot_limits()`, so changing them is reviewed DDL, never a request parameter.

**Cost:** captures are serialized. That's one short transaction on the first page of a session only; later pages only read. Measuring the real throughput is part of the staging plan below.

## Excluded skills

The real `public.jobs_without_excluded_skills` definition is **not in the repo**. The repo has only the *proposed* `docs/proposed/executable/20261126c_advanced_skill_filter_rpc.sql`, not known to be applied.

- The search capture relies only on the name and the `(text[])` signature.
- The tests run it against both a stub and that proposed definition.
- `01_precheck.READONLY.sql` section D prints the real definition and grants, using **the same query text** as `docs/proposed/advanced_skill_rpc.READONLY.sql`. The owner is asked once, and the advanced-filter work (Agent B and its open PRs) can share that output. Nothing about the body is guessed.

## Transport (for the later integration; nothing wired now)

- **What the client holds:** only the opaque id and a position, sent in a request header (proposed name `X-CM-Feed-Snapshot: <64hex>.<position>`).
- **Never in a URL**, never in analytics, never logged. A log line may carry a short hash of the id at most.
- **Responses** carrying a handle: `Cache-Control: no-store`.
- **Any rejection** (`snapshot_unavailable`, `bad_position`, `capture_too_large`, `snapshot_rate`, `snapshot_capacity`): the route serves the explicit non-stable live fallback, or restarts from page 1 with a fresh capture. It never falls back to page-number offsets.

## Concurrency: what PGlite shows and what needs a real Postgres

PGlite is a single connection. Locally the tests show:
- interleaved captures by two owners keep independent counts and windows;
- purge between reads removes only expired rows, stays bounded, and leaves a live snapshot serving;
- rate and capacity limits hold when calls are sequential.

**Needs a real Postgres with two or more connections.** The staging-only script `05_concurrency-check.STAGING-ONLY.sh` is written, not run, and refuses production-looking URLs:
1. 30 parallel captures for one owner on 30 connections: exactly 10 succeed and 20 raise `snapshot_rate` (rate-limit atomicity).
2. 20 parallel captures for 20 owners: all succeed (the lock serializes, it doesn't drop).
3. Reads during parallel purges: a live snapshot keeps serving.
4. Global capacity under concurrency: same lock as check 1. To test it directly, lower `global_active` on the scratch database only.

Also needed on a real database:
- capture latency and throughput under the global lock;
- `EXPLAIN` of the search capture with realistic filters;
- the excluded-skills function's real cost and behaviour.

## Tests (local, fixture-level)

`src/lib/pagination/__tests__/snapshotStore.pglite.test.ts`, 33 tests:
- capture and exact windows, plus position and count bounds;
- id format, uniqueness and non-sequential ids;
- cross-user, cross-tier, cross-query, client-claimed owner or tier, guessed, forged and expired ids all rejected with one error; a shared guest owner can't be stored or used;
- `anon` and `authenticated` denied on the table and every function, `service_role` allowed;
- metadata: RLS on, 0 policies, all INVOKER, `search_path=""`;
- size, duplicate, NULL, empty, TTL, kind, tier and hash bounds;
- per-owner rate and active limits; the global 50000 cap, freed by expiry;
- search order equal to the route's (NULLS FIRST); over-bound and empty captures store nothing; bad columns refused;
- excluded skills against the stub and the proposed definition;
- interleaved captures; purge during reads; rollback removes everything;
- staging guards: nothing in `supabase/migrations`, NOT APPLIED headers, the read-only scripts contain no write or DDL, and pre-check and verify run on the fixture with the expected results.

**13 SQL mutants.** Each edits the proposed SQL; the named check fails on the weakened copy. The 13 weakenings:
- the owner check removed from reads;
- the tier check removed;
- the query-hash check removed;
- the expiry check removed;
- a distinct error for a mismatch;
- the table revoke dropped;
- the function revoke dropped;
- RLS not enabled;
- a function made `SECURITY DEFINER`;
- the rate limit removed;
- sequential ids;
- the size bound removed;
- the search aggregate order reversed.

A further mutant (a `DELETE` added to the pre-check) is caught by the read-only guard. **Not detectable on one connection:** removing the advisory lock. That needs staging check 1.

## Still unproven

- real PostgreSQL concurrency (the script above);
- the real `jobs_without_excluded_skills` view or function;
- a real PostgREST oracle;
- persistence and transport end to end;
- purge scheduling: the owner decides between pg_cron and an opportunistic server call;
- whether 20000 is the right search bound. Above it, capture raises and that query gets the non-stable fallback, so stable paging for search isn't indefinite beyond the bound. That's an open owner decision;
- every host wiring.
