# Query Plan Review Playbook

Repeatable, read-only `EXPLAIN` plan capture and monthly inspection cadence for CareerMonke's hottest PostgreSQL queries.

> Safety Rule: All automated and manual captures in this workflow use **`EXPLAIN` only (never `EXPLAIN ANALYZE`)** so query plans are inspected strictly from planner metadata and table statistics without executing expensive scans or risking production lock/statement pressure.

---

## Hot Query Catalog

All queries below are registered in [`scripts/explain-hot-queries.ts`](../scripts/explain-hot-queries.ts) (`HOT_QUERY_CATALOG`) as parameterized `EXPLAIN`-only definitions.

| Catalog ID | Category | Target Relation | Why This Query Is Hot | Code & SQL Origins |
| :--- | :--- | :--- | :--- | :--- |
| `job-match-feed` | Job Match / Feed | `public.jobs` | Powers authenticated Top-10 match prefiltering and filtered search with multi-term `title ILIKE` `OR` branches plus `posted_at DESC NULLS LAST, id DESC` sorting. Regressions immediately spike `/api/jobs/top10` and `/api/jobs/search` latency. | `src/app/api/jobs/top10/route.ts`, `src/app/api/jobs/search/route.ts`, `src/lib/jobs/service.ts` |
| `digest-candidate-selection` | Digest Candidate Selection | `public.candidate_profiles` | Executed per daily digest run to select candidate profiles with populated `skills` arrays sorted by `updated_at DESC`. As user count grows, unindexed scans or wide `experience_json` payloads degrade cron runtime. | `src/lib/cron/dailyDigestCron.ts` |
| `reconciliation-aggregates` | Reconciliation Aggregates | `public.jobs`, `public.jobs_public` | Runs parity checks comparing active `public.jobs` counts against `public.jobs_public`. Full-table aggregates can hit Postgres statement timeouts (`57014`) unless partial/active indexes serve index-only counts. | `scripts/run-db-reconciliation.ts`, `supabase/scripts/reconciliation.sql` |
| `public-jobs-listing` | Public Jobs Listing | `public.jobs_public` (`public.jobs`) | Serves high-traffic unauthenticated and free-tier job listings filtered by `is_active`, `status`, and `country_code`, ordered by `first_seen_at DESC, id DESC`. | `src/lib/api/jobs.ts`, `src/app/api/jobs/search/route.ts` |

---

## How to Run Capture

### 1. Offline SQL Dry Run (No DB Connection)

Prints every catalog query's parameterized `EXPLAIN` SQL, sample bindings, and destination path without contacting Supabase:

```bash
npx tsx scripts/explain-hot-queries.ts --dry-run
```

### 2. Live Service-Role Capture (`EXPLAIN` Only)

Requires `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY` in environment / `.env.local` with PostgREST plan inspection enabled (`db_plan_enabled = true`):

```bash
npx tsx scripts/explain-hot-queries.ts
```

Optional flags:
- `--date YYYY-MM-DD`: Override UTC date prefix for output files (default: today UTC).
- `--query <id>`: Capture a single catalog entry (for example `--query job-match-feed`).
- `--out-dir <path>`: Custom output directory (default: `docs/perf/query-plans`).

Each captured plan is written as a dated markdown file:

```text
docs/perf/query-plans/YYYY-MM-DD-<catalog-id>.md
```

> If PostgREST returns an error because `db_plan_enabled` is disabled on the project, copy the `--dry-run` `EXPLAIN (FORMAT TEXT, VERBOSE)` SQL into a read-only Supabase SQL Editor session with concrete sample parameters. Never substitute `EXPLAIN ANALYZE` on live production without explicit maintenance approval.

---

## How to Read a Plan

When reviewing saved plans in `docs/perf/query-plans/`, inspect top-to-bottom from leaf scan nodes up to the `Limit` / `Sort` nodes:

1. **Sequential Scans (`Seq Scan`) on large tables (`jobs`, `jobs_public`)**:
   - A `Seq Scan` on `public.jobs` combined with a `Filter:` predicate indicates a missing index, an `OR` condition mixing unindexed columns (such as `description ILIKE` or scalar `category`), or a search token too short (`< 3` chars) for `pg_trgm`.
   - Compare against expected index nodes: `Bitmap Index Scan` (`idx_jobs_title_trgm`), `Index Scan` (`jobs_country_code_idx`), or `Index Scan Backward` (`jobs_active_list_covering_idx`).
2. **Missing Index Use & Partial Predicate Mismatches**:
   - Partial indexes require query `WHERE` predicates to imply the index's `WHERE` clause (for example `status = 'active'` or `is_active = true AND status = 'active'`). Verify queries through `public.jobs_public` include matching predicates rather than forcing full scans.
   - Leading-wildcard `ILIKE '%term%'` never uses standard btree indexes; confirm `gin_trgm_ops` GIN usage or `text_pattern_ops` for prefix-only queries.
3. **Expensive Sorts (`Sort Method` / High Startup Cost)**:
   - Look for `Sort` nodes directly beneath `Limit`. If the query orders by `posted_at DESC NULLS LAST, id DESC` or `first_seen_at DESC, id DESC`, confirm whether an index scan satisfies ordering directly without sorting tens of thousands of candidate rows.
4. **High Estimated Row Width & Heap Fetches**:
   - Check `rows=` and `width=` estimates in `(cost=startup..total rows=N width=W)`. Sudden spikes in estimated `rows=` indicate stale table statistics (check post-ingest `analyze_after_ingest()` execution) or overly broad filters.

---

## Monthly Cadence

- **Schedule**: First Monday of every calendar month (aligned with database index & retention maintenance reviews).
- **Owner / Operator Steps**:
  1. Run `npx tsx scripts/explain-hot-queries.ts` against the target environment (or SQL Editor read-only fallback with `--dry-run` SQL) and commit the dated markdown snapshots under `docs/perf/query-plans/`.
  2. Diff against the previous month's snapshots in `docs/perf/query-plans/` for newly introduced `Seq Scan` nodes, dropped partial index usage, or `> 2x` startup/total cost regressions.
  3. Cross-check any unindexed predicates against [`docs/expression-index-audit.md`](expression-index-audit.md) and schedule targeted `CREATE INDEX CONCURRENTLY` migrations only as approved follow-up changes.
- **Guard Check**: CI continuously runs `npx tsx scripts/test-query-plan-review.ts` to verify the catalog, documentation, `--dry-run` offline behavior, and strict `EXPLAIN`-only enforcement.
