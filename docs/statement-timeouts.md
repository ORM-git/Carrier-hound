# Database Statement Timeout Discipline & Invocation Architecture

## 1. Context & Problem Statement

In the CareerMonke database architecture, PostgreSQL function execution previously relied on default connection settings:
- Direct connections and background worker pools in Supabase have an unbounded default (`statement_timeout = 0`) unless explicitly configured.
- Several critical database functions execute with `SECURITY DEFINER` privileges, operating with full owner authority.

### The Connection Pool Exhaustion Risk
When a heavy `SECURITY DEFINER` function encounters unexpected sequential scans, lock contention, autovacuum lock queues, or bloated indices, it holds an open transaction and an exclusive connection slot in the database pool (`pgbouncer` transaction pooler). Runaway queries holding connections for several minutes saturate the pool, leading to connection queueing and cascading `504 Gateway Timeout` errors across the platform.

Bounding statement timeouts provides a hard ceiling: if a query stalls, PostgreSQL terminates execution with error `57014 (query_canceled)` and immediately releases table locks and connection pool slots.

---

## 2. Invocation Route Classification & Mechanics

To apply timeouts correctly, execution must be distinguished by how callers connect to PostgreSQL:

### Route 1: Supabase REST API (`supabase.rpc`)
- **Callers**: `scripts/retention-cron.ts`, `scripts/ingest.ts`, Next.js API routes (`src/lib/...`).
- **Protocol**: HTTP POST to `/rest/v1/rpc/<func>`.
- **Mechanics**: PostgREST executes a single standalone `SELECT public.<func>(...)` command.
- **Function Timeout Support**: **Function-level `ALTER FUNCTION ... SET statement_timeout` IS fully supported and effective for REST RPC calls** per [Supabase documentation](https://supabase.com/docs/guides/database/postgres/timeouts). When PostgREST calls the function, PostgreSQL applies the function-level configuration parameter (`pg_proc.proconfig`) for that execution.
- **Gateway Ceiling**: The Supabase REST API gateway enforces a **maximum configurable timeout of 60 seconds**. Any RPC invoked via `supabase.rpc` cannot exceed 60 seconds regardless of database-level settings.
- **Client-Side Abort Caveat**: An `AbortController` or `AbortSignal` on the JavaScript client only terminates the client-side HTTP waiting state. **Client abort does NOT cancel ongoing PostgreSQL backend execution or release database locks.** Real backend cancellation and lock release occur only when PostgreSQL's `statement_timeout` triggers on the server.

### Route 2: Direct PostgreSQL Connection (Session / Transaction Pooler)
- **Callers**: Direct database CLI scripts, DBA tooling, migration runners connecting via port 5432 (direct) or port 6543 (pgbouncer).
- **Mechanics**: When running multi-statement transactions (`BEGIN; ... COMMIT;`), function-level settings apply during the function's execution, but callers should explicitly arm transaction-level protection:
  ```sql
  BEGIN;
  SET LOCAL statement_timeout = '30s';
  SELECT public.purge_operational_logs(false);
  COMMIT;
  ```

### Route 3: `pg_cron` Scheduled Background Worker
- **Callers**: Background tasks scheduled inside the PostgreSQL engine.
- **Mechanics**: Runs directly in the engine as the postgres/cron superuser. Jobs should be wrapped in transaction commands with explicit local timeouts:
  ```sql
  SELECT cron.schedule(
    'hourly-worldwide-refresh',
    '0 * * * *',
    $$BEGIN; SET LOCAL statement_timeout = '30s'; SELECT public.refresh_worldwide_company_counts(); COMMIT;$$
  );
  ```

---

## 3. Role-Level Timeout Rationale

- **`authenticator` Role**: PostgREST connection pooler role. Already configured with `statement_timeout = '15s'`, `lock_timeout = '5s'`, and `idle_in_transaction_session_timeout = '60s'` in migration `20261105c_database_safety.sql`. It does not need re-assertion.
- **`service_role` Role**: **Omitted from broad role-level timeout.** No inventory proves that every legitimate service-role task (large batch ingest, future data backfills, migrations) fits within an arbitrary ceiling like 60s. Imposing a global role-level timeout on `service_role` risks unexpectedly breaking uninventoried background tasks. Timeouts on service-role operations are applied per-function on the catalog or per-caller in scripts.

---

## 4. Heavy RPC Catalog & Proposed Budgets

> **Note on Budgets vs Measurements**: The values below represent **proposed operational safety budgets and bounding ceilings**, not measured production latency metrics. (Unverified "p99" figures have been removed per review discipline).

| Function Name & Argument Signature | Defining Migration | Workload Domain | Read / Maintenance | Proposed Timeout Budget | Rationale & Route Constraints |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `refresh_worldwide_company_counts()` | `20261101_lock_scraper_metadata.sql`, `20261106d_matview_refresh_log.sql` | Aggregate Snapshot | Read / Refresh Matview | **30s** | Refreshes materialized view across active listings. 30s bounds lock retention during peak load. |
| `db_health_snapshot()` | `20261108b_db_health_snapshot.sql` | Observability | Read-Only Snapshot | **5s** | Queries system statistics. Pre-existing 5s setting preserved from `20261108b`. |
| `analyze_after_ingest()` | `20261106q_analyze_after_ingest.sql` | Maintenance / Stats | Read / Stats Sampling | **15s** | Samples statistics on `jobs`, `job_descriptions`, and `companies`. Invoked by `scripts/ingest.ts` over REST. |
| `dedupe_jobs_by_role(boolean)` | `20261107a_jobs_role_dedupe.sql` | Feed / Deduplication | Read Scan / Partition Ranking | **30s** | Scans and partitions active listings by role key. 30s bounds full scans. |
| `archive_expired_jobs(boolean, interval)` | `20261106l_job_archival.sql` | Retention & Archival | Read / Prune | **30s** | Moves inactive expired jobs past retention threshold. Invoked by `scripts/retention-cron.ts` over REST. |
| `reindex_bloated_indexes(integer, boolean)` | `20261106m_reindex_maintenance.sql` | Maintenance / Indexing | Reindex Loop | **60s** | Loops over bloated indexes. Constrained to Supabase REST 60s bound (see Section 5). |
| `purge_operational_logs(boolean)` | `20261106a_data_retention.sql`, `20261106f_funnel_events_retention.sql` | Retention & Pruning | Read / Prune | **30s** | Scans 8 operational tables past retention windows. Invoked by `scripts/retention-cron.ts` over REST. |
| `purge_row_change_history(boolean)` | `20261106c_change_history_triggers.sql` | Retention & Pruning | Read / Prune | **30s** | Prunes historical row mutation audit records. |
| `purge_soft_deleted_account_data(interval)` | `20261106h_soft_delete_tombstones.sql` | Retention & Pruning | Read / Prune | **30s** | Prunes tombstoned user data past grace period. |
| `cleanup_expired_rate_limits()` | `20261020_rate_limits.sql` | Rate Limiting | Read / Prune | **10s** | Deletes expired rate-limit windows. |
| `check_rate_limit(text, integer, integer)` | `20261020_rate_limits.sql` | Rate Limiting | Hot OLTP Path | **2s** | Atomic rate limit check on request ingress. Must fail fast within 2s to protect API SLAs. |
| `outbox_claim_batch(text, integer, integer, text)` | `20261107c_outbox_queue.sql`, `20261107e_outbox_fencing.sql` | Digest & Queue | Read (Skip Locked) | **5s** | Background workers claim queued outbox batches using `FOR UPDATE SKIP LOCKED`. |
| `claim_search_alert_window(uuid, integer)` | `20261107f_search_alert_send_windows.sql` | Alert Dispatch | Read & Lock | **5s** | Atomic window reservation for search alert notifications. |
| `release_search_alert_window(uuid, timestamptz)` | `20261107f_search_alert_send_windows.sql` | Alert Dispatch | Read & Release | **5s** | Release reservation after alert delivery. |

---

## 5. Maintenance Loop Behavior: `reindex_bloated_indexes`

### Loop & Transaction Abort Mechanics
`public.reindex_bloated_indexes(min_size_mb, dry_run)` iterates sequentially over all indexes exceeding `min_size_mb`:
1. **Cumulative Timeout Boundary**: The statement timeout applies to the **entire function execution**, not to each individual index rebuild.
2. **Transaction Abort on Error 57014**: If `statement_timeout` triggers during rebuild, PostgreSQL raises error code `57014 (query_canceled)`. The entire transaction rolls back, meaning cron observers detect a complete failure rather than partial completion.
3. **REST Invocation Ceiling**: When called via `supabase.rpc` in `scripts/retention-cron.ts`, the Supabase REST gateway hard-caps requests at 60 seconds. Therefore, catalog timeout is set to `60s` to fit the REST bound.
4. **Direct Connection for Unconstrained Reindex**: For heavy maintenance passes where total index rebuild time exceeds 60s, reindex maintenance must be executed via **direct connection** (session pooler) with a transaction-local timeout (`SET LOCAL statement_timeout = '300s'`) or batched using a higher `min_size_mb` threshold.

---

## 6. Migration Application & Verification Runbook

The migration is defined in:
`supabase/migrations/20261112b_statement_timeouts.sql`

### Pre-Apply Capture Step (Run Before Applying)
Before applying the migration, query and record existing `proconfig` values in your maintenance deployment log:
```sql
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  p.proconfig AS current_configuration
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'refresh_worldwide_company_counts', 'db_health_snapshot', 'analyze_after_ingest',
    'dedupe_jobs_by_role', 'archive_expired_jobs', 'reindex_bloated_indexes',
    'purge_operational_logs', 'purge_row_change_history', 'purge_soft_deleted_account_data',
    'outbox_claim_batch', 'cleanup_expired_rate_limits', 'check_rate_limit',
    'claim_search_alert_window', 'release_search_alert_window'
  )
ORDER BY p.proname;
```
*Repository baseline expectation*: `db_health_snapshot()` has `statement_timeout = '5s'`; all other 13 functions have `proconfig IS NULL`.

### Manual Execution Flow (Owner)
1. Open the Supabase Dashboard SQL Editor.
2. Execute `supabase/migrations/20261112b_statement_timeouts.sql`.
3. Record the migration in `schema_migrations`:
   ```bash
   node scripts/record-migration.cjs 20261112b_statement_timeouts
   ```

### Post-Apply Verification Query
```sql
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  p.proconfig AS configuration
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proconfig::text LIKE '%statement_timeout%'
ORDER BY p.proname;
```

### Operational Note: PostgREST Config Reload
Per official [Supabase documentation](https://supabase.com/docs/guides/database/postgres/timeouts), whenever role-level settings or schema parameters affecting the API are updated, PostgREST must be notified to reload its configuration:
```sql
NOTIFY pgrst, 'reload config';
```
*(This command is for the deployment runbook; it is not included in the migration script).*

---

## 7. Exact Rollback Strategy

> **Important**: In PostgreSQL, `ALTER FUNCTION ... RESET statement_timeout` removes the function-level configuration from `pg_proc.proconfig`, causing the function to revert to inheriting the caller role or database configuration. It does **not** guarantee an unbounded baseline if the role or database has a default.

### Exact Restoration Commands:
```sql
-- Restore function configurations to repository pre-migration baselines:
ALTER FUNCTION public.refresh_worldwide_company_counts() RESET statement_timeout;

-- PRESERVE existing 5s setting from 20261108b (DO NOT RESET BLINDLY):
ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s';

ALTER FUNCTION public.analyze_after_ingest() RESET statement_timeout;
ALTER FUNCTION public.dedupe_jobs_by_role(boolean) RESET statement_timeout;
ALTER FUNCTION public.archive_expired_jobs(boolean, interval) RESET statement_timeout;
ALTER FUNCTION public.reindex_bloated_indexes(integer, boolean) RESET statement_timeout;
ALTER FUNCTION public.purge_operational_logs(boolean) RESET statement_timeout;
ALTER FUNCTION public.purge_row_change_history(boolean) RESET statement_timeout;
ALTER FUNCTION public.purge_soft_deleted_account_data(interval) RESET statement_timeout;
ALTER FUNCTION public.outbox_claim_batch(text, integer, integer, text) RESET statement_timeout;
ALTER FUNCTION public.cleanup_expired_rate_limits() RESET statement_timeout;
ALTER FUNCTION public.check_rate_limit(text, integer, integer) RESET statement_timeout;
ALTER FUNCTION public.claim_search_alert_window(uuid, integer) RESET statement_timeout;
ALTER FUNCTION public.release_search_alert_window(uuid, timestamptz) RESET statement_timeout;
```
If your pre-apply capture identified custom proconfig settings in your environment, restore those specific captured values.
