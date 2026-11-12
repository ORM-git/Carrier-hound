# Statement Timeout Discipline & Caller Enforcement Architecture

## 1. Context & Technical Problem Statement

In the CareerMonke database architecture, PostgreSQL function execution previously relied on default connection settings:
- On Supabase direct connections and background worker pools, `statement_timeout` is unset by default (`0` = unbounded).
- While HTTP requests through the PostgREST API may be governed by API gateway limits, direct RPC executions, `pg_cron` jobs, CI workers, and service-role scripts run directly against the PostgreSQL engine.
- Several critical database functions execute with `SECURITY DEFINER` privileges, bypassing normal caller constraints and running with owner permissions.

### The Connection Pool Exhaustion Risk
When a heavy `SECURITY DEFINER` function encounters unexpected sequential scans, lock contention, autovacuum lock queues, or bloated indices, it holds an open transaction and an exclusive connection slot in the database pool (`pgbouncer` transaction pooler). Runaway queries holding connections for several minutes saturate the pool, leading to connection starvation and cascading `504 Gateway Timeout` errors across the platform.

### PostgreSQL Timeout Mechanics: Why Caller Enforcement is Required
In PostgreSQL:
1. `statement_timeout` measures the total elapsed time of the **client command**, starting the moment the query is received from the client.
2. Setting `ALTER FUNCTION ... SET statement_timeout = '...'` assigns a configuration parameter (`proconfig`) when the function executes. However, it does **not** arm a new, independent timer for statements executed inside the function.
3. If an existing client command or role-level timeout is already running, the timer began at the client command boundary.
4. Consequently, per-function timeouts cannot guarantee isolation if the caller boundary is unbounded.

### Solution: Dual-Tier Enforcement (Role Defaults + Caller-Side Deadlines)
To establish reliable, deterministic timeout boundaries:
- **Tier 1 (Role-Level Defaults)**: Sane fallback statement timeouts assigned to database roles (`authenticator` at 15s, `service_role` at 60s).
- **Tier 2 (Caller-Side Deadlines)**: Explicit statement timeouts armed before invoking heavy RPCs (via `SET LOCAL statement_timeout` in transactions, `pg_cron` job wrappers, or client-side `abortSignal` deadlines).
- **Tier 3 (Catalog Safeguards)**: Function-level configurations on catalog definitions as defense-in-depth bounds.

---

## 2. Heavy RPC Catalog & Proposed Budgets

> **Note on Budgets vs Measurements**: The values below represent **proposed operational safety budgets and bounding ceilings**, not measured production latency metrics. (Unverified "p99" figures have been removed per review discipline).

| Function Name & Argument Signature | Defining Migration | Workload Domain | Read / Maintenance | Proposed Timeout Budget | Rationale & Caller Enforcement Guidance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `refresh_worldwide_company_counts()` | `20261101_lock_scraper_metadata.sql`, `20261106d_matview_refresh_log.sql` | Aggregate Snapshot | Read / Refresh Matview | **30s** | Refreshes materialized view across active listings. Caller sets `SET LOCAL statement_timeout = '30s'` before refresh. |
| `db_health_snapshot()` | `20261108b_db_health_snapshot.sql` | Observability | Read-Only Snapshot | **5s** | Queries `pg_stat_user_tables` and `pg_stat_user_indexes`. Pre-existing 5s catalog setting preserved. Client caller enforces 10s abort deadline. |
| `analyze_after_ingest()` | `20261106q_analyze_after_ingest.sql` | Maintenance / Stats | Read / Stats Sampling | **15s** | Samples statistics on `jobs`, `job_descriptions`, and `companies`. Caller (`scripts/ingest.ts`) arms a 15s client abort deadline. |
| `dedupe_jobs_by_role(boolean)` | `20261107a_jobs_role_dedupe.sql` | Feed / Deduplication | Read Scan / Partition Ranking | **30s** | Scans and partitions active listings by role key. Caller sets 30s deadline. |
| `archive_expired_jobs(boolean, interval)` | `20261106l_job_archival.sql` | Retention & Archival | Read / Prune | **30s** | Scans inactive expired jobs past retention threshold. Caller (`scripts/retention-cron.ts`) arms a 30s abort deadline. |
| `reindex_bloated_indexes(integer, boolean)` | `20261106m_reindex_maintenance.sql` | Maintenance / Indexing | Reindex Loop | **30s / 300s** | Loops over ALL bloated indexes. **Maintenance budget**: 300s (5m) allocated for multi-index rebuilds (see Section 3). |
| `purge_operational_logs(boolean)` | `20261106a_data_retention.sql`, `20261106f_funnel_events_retention.sql` | Retention & Pruning | Read / Prune | **30s** | Scans 8 operational tables past retention windows. Caller (`scripts/retention-cron.ts`) arms a 30s abort deadline. |
| `purge_row_change_history(boolean)` | `20261106c_change_history_triggers.sql` | Retention & Pruning | Read / Prune | **30s** | Prunes historical row mutation audit records. Caller arms 30s timeout. |
| `purge_soft_deleted_account_data(interval)` | `20261106h_soft_delete_tombstones.sql` | Retention & Pruning | Read / Prune | **30s** | Prunes tombstoned user data past grace period. Caller arms 30s timeout. |
| `cleanup_expired_rate_limits()` | `20261020_rate_limits.sql` | Rate Limiting | Read / Prune | **10s** | Deletes expired rate-limit windows. Caller arms 10s timeout. |
| `check_rate_limit(text, integer, integer)` | `20261020_rate_limits.sql` | Rate Limiting | Hot OLTP Path | **2s** | Atomic rate limit check on request ingress. Must fail fast within 2s to protect API SLAs. |
| `outbox_claim_batch(text, integer, integer, text)` | `20261107c_outbox_queue.sql`, `20261107e_outbox_fencing.sql` | Digest & Queue | Read (Skip Locked) | **5s** | Background workers claim queued outbox batches. Caller arms 5s timeout. |
| `claim_search_alert_window(uuid, integer)` | `20261107f_search_alert_send_windows.sql` | Alert Dispatch | Read & Lock | **5s** | Atomic window reservation for search alert notifications. Caller arms 5s timeout. |
| `release_search_alert_window(uuid, timestamptz)` | `20261107f_search_alert_send_windows.sql` | Alert Dispatch | Read & Release | **5s** | Release reservation after alert delivery. Caller arms 5s timeout. |

---

## 3. Maintenance Budget Sizing: `reindex_bloated_indexes`

### Critical Loop & Transaction Behavior
The index maintenance RPC `public.reindex_bloated_indexes(min_size_mb, dry_run)` operates by querying bloated public-schema indexes and sequentially running `REINDEX INDEX` across all candidates matching the size threshold:
```sql
FOR r IN SELECT ... WHERE pg_relation_size(i.oid) >= min_size_mb * 1024 * 1024 LOOP
  EXECUTE format('REINDEX INDEX %I.%I', r.schema_name, r.index_name);
END LOOP;
```

**Key Operational Implications**:
1. **Cumulative Timeout Boundary**: A statement timeout caps the **entire function execution**, not each individual index rebuild. If a database has 8 candidate bloated indexes, the elapsed time is the sum of all 8 rebuilds.
2. **Transaction Rollback on 57014 Cancellation**: If `statement_timeout` triggers during index 5, PostgreSQL cancels the entire query with error code `57014 (query_canceled)`. The transaction aborts and rolls back, meaning cron observers detect a complete job failure rather than partial progress.
3. **Dedicated Maintenance Sizing**: Normal OLTP queries use budgets of 2s–30s. Maintenance jobs must be provisioned with a **dedicated maintenance budget** (e.g., `300s` / 5 minutes) to avoid false-positive aborts during scheduled weekly maintenance windows.

---

## 4. Caller-Side Timeout Implementation Patterns

Callers invoking heavy RPCs must arm timeouts using the appropriate pattern for their execution context:

### Pattern A: Direct SQL / Transaction Wrapper (`SET LOCAL`)
When invoking heavy RPCs via SQL scripts or migration tooling:
```sql
BEGIN;
-- Set transaction-scoped timeout; automatically reverts upon COMMIT or ROLLBACK
SET LOCAL statement_timeout = '30s';
SELECT public.purge_operational_logs(false);
COMMIT;
```

### Pattern B: `pg_cron` Command Wrapper
When scheduling periodic database tasks in `pg_cron`:
```sql
SELECT cron.schedule(
  'weekly-retention-purge',
  '30 19 * * 0',
  $$BEGIN; SET LOCAL statement_timeout = '30s'; SELECT public.purge_operational_logs(false); COMMIT;$$
);

-- Maintenance reindex with dedicated 300s budget:
SELECT cron.schedule(
  'weekly-reindex-maintenance',
  '0 20 * * 0',
  $$BEGIN; SET LOCAL statement_timeout = '300s'; SELECT public.reindex_bloated_indexes(50, false); COMMIT;$$
);
```

### Pattern C: TypeScript / Node.js Clients (PostgREST / Supabase)
In application code and maintenance runner scripts (`scripts/retention-cron.ts`, `scripts/ingest.ts`):
```typescript
// Enforce caller-side deadline using AbortSignal
const { data, error } = await supabase
  .rpc("purge_operational_logs", { dry_run: dry })
  .abortSignal(AbortSignal.timeout(30_000));
```

---

## 5. Migration & Application Procedure

The migration is defined in:
`supabase/migrations/20261112b_statement_timeouts.sql`

### Manual Execution Flow (Owner)
1. Open the Supabase Dashboard SQL Editor.
2. Review and execute `supabase/migrations/20261112b_statement_timeouts.sql`.
3. Record the migration in `schema_migrations`:
   ```bash
   node scripts/record-migration.cjs 20261112b_statement_timeouts
   ```

### Catalog-Only Verification Queries
Confirm role-level and function-level configurations without taking table locks:
```sql
-- 1. Verify role-level timeout configurations
SELECT r.rolname, s.setconfig
FROM pg_roles r
LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid
WHERE r.rolname IN ('authenticator', 'service_role')
ORDER BY r.rolname;

-- 2. Verify function-level statement_timeout configurations
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

### Rollback Strategy (Exact Restoration)
Rollback must restore the **exact pre-migration baseline**:
- `authenticator` role: restored to `statement_timeout = '15s'` (established in `20261105c`).
- `service_role` role: reset to unbounded (`RESET statement_timeout`).
- `public.db_health_snapshot()`: restored to `SET statement_timeout = '5s'` (preserves `20261108b`, does **not** reset blindly).
- All other 13 functions: `RESET statement_timeout`.

```sql
-- Restore role timeouts
ALTER ROLE authenticator SET statement_timeout = '15s';
ALTER ROLE service_role RESET statement_timeout;

-- Restore function configurations
ALTER FUNCTION public.refresh_worldwide_company_counts() RESET statement_timeout;
ALTER FUNCTION public.db_health_snapshot() SET statement_timeout = '5s'; -- preserves 20261108b
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
