# Per-Function Statement Timeout Discipline

## 1. Context & Problem Statement

In the CareerMonke database architecture, PostgreSQL function execution currently inherits platform defaults:
- Default `statement_timeout` on Supabase / PostgreSQL direct connections and background worker pools is typically unset (`0` = unbounded).
- While HTTP requests through the PostgREST API may be governed by external gateway timeout windows (e.g., 8–15 seconds), internal RPC executions, `pg_cron` jobs, CI workers, and service-role scripts run directly against the database engine without a bounding timeout.
- Several critical database functions run with `SECURITY DEFINER` privileges, bypassing normal user constraints and operating with full owner authority.

### The Connection Pool Exhaustion Risk
When a heavy `SECURITY DEFINER` function encounters unexpected sequential scans, lock contention, lock waits against active autovacuum, or bloated indices, it holds an open transaction and an exclusive connection slot in the database pool (`pgbouncer` transaction pooler). A single runaway query running for several minutes can saturate the pool, leading to connection queueing and cascading `504 Gateway Timeout` errors for all live user traffic.

### Solution: Catalog-Level `statement_timeout`
PostgreSQL allows setting configuration parameters on individual functions using:
```sql
ALTER FUNCTION schema.function_name(arg_types) SET statement_timeout = '<duration>';
```
When invoked, the function executes within a localized timeout boundary. If execution exceeds this boundary, PostgreSQL aborts the statement with `ERROR: canceling statement due to statement timeout (57014)` and releases locks and connection resources immediately.

---

## 2. Catalog of Heaviest Database RPCs & Workloads

The following table catalogs the heaviest read, aggregate, and lifecycle RPCs in `supabase/migrations/`:

| Function Name & Signature | Defining Migration | Workload Domain | Read / Maintenance | Current Default | Proposed Timeout | Normal p99 | Rationale |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `refresh_worldwide_company_counts()` | `20261101_lock_scraper_metadata.sql`, `20261106d_matview_refresh_log.sql` | Aggregate Snapshot | Read / Refresh Matview | Unbounded (`0`) | **30s** | ~1.5s | Refreshes `worldwide_company_counts` across all active jobs. 30s allows 20x headroom for ~50k jobs while bounding lock contention. |
| `db_health_snapshot()` | `20261108b_db_health_snapshot.sql` | Observability | Read-Only Snapshot | Internal `5s` | **5s** | ~120ms | Scans `pg_stat_user_tables`, `pg_stat_user_indexes`, and `cron_run_logs`. Enforcing 5s at catalog level bounds system catalog locks. |
| `analyze_after_ingest()` | `20261106q_analyze_after_ingest.sql` | Maintenance / Stats | Read / Stats Sampling | Unbounded (`0`) | **15s** | ~1.2s | Samples `jobs`, `job_descriptions`, and `companies`. 15s provides ample headroom while preventing ingestion runs from hanging. |
| `dedupe_jobs_by_role(boolean)` | `20261107a_jobs_role_dedupe.sql` | Job Matching & Feed | Read Scan / Partition Ranking | Unbounded (`0`) | **30s** | ~1.8s | Performs window function partition ranking across active jobs. Default dry-run is pure read audit; 30s caps worst-case full scans. |
| `archive_expired_jobs(boolean, interval)` | `20261106l_job_archival.sql` | Retention & Archival | Read / Prune | Unbounded (`0`) | **30s** | ~400ms | Queries inactive expired jobs past threshold. Default dry-run is read count. 30s bounds archival moves without stalling workers. |
| `reindex_bloated_indexes(integer, boolean)` | `20261106m_reindex_maintenance.sql` | Maintenance / Indexing | Metadata Scan / Rebuild | Unbounded (`0`) | **60s** | ~2.5s | Queries index bloat metrics; dry-run is pure read. When active, individual index reindex is capped at 60s to prevent locking out tables. |
| `purge_operational_logs(boolean)` | `20261106a_data_retention.sql`, `20261106f_funnel_events_retention.sql` | Retention & Pruning | Read / Prune | Unbounded (`0`) | **30s** | ~800ms | Scans 8 operational tables. Default dry-run counts rows past retention. 30s safely bounds multi-table scans. |
| `purge_row_change_history(boolean)` | `20261106c_change_history_triggers.sql` | Retention & Pruning | Read / Prune | Unbounded (`0`) | **30s** | ~600ms | Scans `change_history` partition. 30s bounds large transaction logs without blocking inserts. |
| `purge_soft_deleted_account_data(interval)` | `20261106h_soft_delete_tombstones.sql` | Retention & Pruning | Read / Prune | Unbounded (`0`) | **30s** | ~350ms | Scans user tombstone markers across tables. 30s bounds cascade checks. |
| `cleanup_expired_rate_limits()` | `20261020_rate_limits.sql` | Rate Limiting | Read / Prune | Unbounded (`0`) | **10s** | ~80ms | Deletes expired rate limit windows from `rate_limits`. 10s prevents table lock accumulation. |
| `check_rate_limit(text, integer, integer)` | `20261020_rate_limits.sql` | Rate Limiting | Read & Upsert (Hot OLTP) | Unbounded (`0`) | **2s** | ~15ms | Hot request path rate limiting. Must fail fast (within 2s) to protect API gateway SLAs. |
| `outbox_claim_batch(text, integer, integer, text)` | `20261107c_outbox_queue.sql`, `20261107e_outbox_fencing.sql` | Digest & Queue Processing | Read (Skip Locked) | Unbounded (`0`) | **5s** | ~25ms | Scans unassigned queue items using `FOR UPDATE SKIP LOCKED`. 5s bounds worker polling. |
| `claim_search_alert_window(uuid, integer)` | `20261107f_search_alert_send_windows.sql` | Digest & Alert Processing | Read & Lock | Unbounded (`0`) | **5s** | ~20ms | Atomic window claim for search alert dispatch. 5s protects notification workers. |
| `release_search_alert_window(uuid, timestamptz)` | `20261107f_search_alert_send_windows.sql` | Digest & Alert Processing | Read & Release | Unbounded (`0`) | **5s** | ~15ms | Window release. 5s protects notification workers. |

---

## 3. Workload Categories & Rationale

### A. Aggregate Snapshots & Materialized Views
- **`refresh_worldwide_company_counts()` (30s)**: Materialized view aggregations group all active listings by company name and country. While index-backed scans execute in ~1.5s, large batch ingestion runs can cause table bloat. A 30s timeout provides generous headroom during peak load while preventing indefinite lock retention.
- **`db_health_snapshot()` (5s)**: This function reads directly from `pg_stat_user_tables` and `pg_stat_user_indexes`. Since stats queries run in memory, they complete in <150ms. 5s is sufficient for system catalog queries and prevents blocking on lock queues.
- **`analyze_after_ingest()` (15s)**: Called by ingestion pipelines after bulk inserts. PostgreSQL `ANALYZE` takes a `SHARE UPDATE EXCLUSIVE` lock. A 15s timeout guarantees that statistics sampling completes cleanly without holding locks during concurrent query spikes.

### B. Job Deduplication & Archival Scans
- **`dedupe_jobs_by_role()` (30s)**: Performs partition-based role comparison across active listings. In dry-run mode, it acts as a read-only audit query. 30s allows complete scanning of tens of thousands of active listings while preventing runaway query degradation.
- **`archive_expired_jobs()` (30s)**: Evaluates expired job records against a 90-day retention cutoff. Dry-run execution counts candidate jobs. 30s ensures predictable retention execution.

### C. Maintenance & Retention Pruning
- **`purge_operational_logs()` (30s)**, **`purge_row_change_history()` (30s)**, **`purge_soft_deleted_account_data()` (30s)**: These functions scan historical records using index range scans on timestamps (`created_at`, `started_at`). A 30s timeout accommodates large batches during weekly cron sweeps while guarding against lock contention.
- **`reindex_bloated_indexes()` (60s)**: Rebuilding bloated indexes locks individual index structures. 60s bounds index reindexing to prevent table access blocking.

### D. High-Frequency Outbox & Rate-Limiting
- **`check_rate_limit()` (2s)**: Executes on every inbound rate-limited request. Setting a 2s statement timeout ensures that if the `rate_limits` table is locked, the request fails fast rather than holding client connections.
- **`outbox_claim_batch()` (5s)**: Background workers poll outbox items with `FOR UPDATE SKIP LOCKED`. 5s bounds batch claiming to keep worker loops responsive.

---

## 4. Migration & Application Procedure

The migration is defined in:
`supabase/migrations/20261112b_statement_timeouts.sql`

### Manual Execution Flow (Owner)
1. Navigate to the Supabase Dashboard SQL Editor.
2. Paste and run the contents of `supabase/migrations/20261112b_statement_timeouts.sql`.
3. Record the migration in `schema_migrations`:
   ```bash
   node scripts/record-migration.cjs 20261112b_statement_timeouts
   ```

### Verification Query
After applying, verify that the statement timeouts are attached to function configurations:
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

### Rollback Strategy
To revert to platform defaults without modifying function code:
```sql
ALTER FUNCTION public.refresh_worldwide_company_counts() RESET statement_timeout;
ALTER FUNCTION public.db_health_snapshot() RESET statement_timeout;
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
