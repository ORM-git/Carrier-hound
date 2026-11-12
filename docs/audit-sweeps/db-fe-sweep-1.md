# Audit Sweep #1: Database (19 Rows) & Frontend (3 Rows)

- **Repository:** `ORM-git/Carrier-hound`
- **Verified Commit (`main`):** `83ac3133d4432aefa977579732adbd74624aed76`
- **Scope:** Read-only code, migration, doc, workflow, and guard verification of 22 audit rows (19 Database + 3 Frontend) with **no application or database logic changes**.
- **Guard:** `scripts/test-audit-sweep-db-fe-1.ts` (registered offline in `scripts/suite-runner.ts` and `scripts/lib/test-guard.cjs`).

## Verdict Summary

| Metric | Count |
| --- | --- |
| Total rows audited | 22 |
| `CLOSE` | 3 |
| `GAP` | 19 |
| `GAP` — Owner step only | 7 |
| `GAP` — Code only | 3 |
| `GAP` — Code + Owner step | 9 |

### Sign-Off Overview Table

| # | Area | Audit Row | Verdict | Gap Classification | Summary |
| --- | --- | --- | --- | --- | --- |
| 1 | DB | RPO/RTO targets | `GAP` | Code + Owner step | Docs exist with `[OWNER TO CONFIRM]`; no merged automated backup/restore drill guard on `main` (`PR #554` open) |
| 2 | DB | Change-history triggers | `GAP` | Code + Owner step | Trigger map + Vitest guard + `20261106c` exist; migration `NOT APPLIED` and `purge_row_change_history()` not wired into retention cron |
| 3 | DB | Unused index audit | `GAP` | Owner step | Inventory, `db-health.sql`, `explain-checks.sql`, `20261106g`, and `20261108b` exist; migrations `NOT APPLIED` and probe workflow opt-in |
| 4 | DB | Index bloat monitoring | `GAP` | Code + Owner step | `docs/db-health-probe.md` explicitly leaves physical index bloat unmeasured; `20261106m` & `20261108b` `NOT APPLIED` |
| 5 | DB | Table size monitoring | `GAP` | Code + Owner step | `db_health_snapshot` samples current bytes, but `docs/db-health-probe.md` leaves growth trends/thresholds open; `20261108b` `NOT APPLIED` |
| 6 | DB | Index usage monitoring | `GAP` | Owner step | `db-health.sql`, `dbHealth.ts`, `probe-db-health.ts`, and `db-health-probe.yml` exist; `20261108b` `NOT APPLIED` and var-gated |
| 7 | DB | Dead tuple watch | `GAP` | Owner step | `dead_tuple_pressure` alert & tests complete; `20261108b` & `20261106q` `NOT APPLIED` and `DB_HEALTH_PROBE_ENABLED` disabled by default |
| 8 | DB | Purge jobs for log tables | `GAP` | Code + Owner step | `20261106a`/`20261106f`/`20261108a` `NOT APPLIED`; `purge_row_change_history()` (`20261106c`) omitted from `scripts/retention-cron.ts` |
| 9 | DB | Views / materialized views | `GAP` | Owner step | `jobs_public`, `worldwide_company_counts`, `jobs_duplicate_roles` + guards exist; `20261101`, `20261106d`, `20261107a`, `20261108a` `NOT APPLIED` (`PR #555` open) |
| 10 | DB | Connection pooling | `GAP` | Code + Owner step | App uses `@supabase/ssr` HTTP/PostgREST; no dedicated pooling doc/guard on `main`, and Supabase Supavisor/PgBouncer dashboard settings unverified |
| 11 | DB | PITR | `GAP` | Owner step | Documented as disabled on Supabase Free tier (`docs/rpo-rto-targets.md`, `docs/disaster-recovery.md`); requires Pro upgrade by owner |
| 12 | DB | Concurrent refresh | `GAP` | Owner step | `REFRESH MATERIALIZED VIEW CONCURRENTLY` + unique index + `matview_refresh_log` + tests exist; `20261101`, `20261106d`, `20261108a` `NOT APPLIED` |
| 13 | DB | CREATE INDEX CONCURRENTLY | `GAP` | Code + Owner step | `20261106n` standalone `CONCURRENTLY` (`NOT APPLIED`), but newer `20261106k` & `20261107a` create non-concurrent indexes on `jobs` without a blocking CI guard |
| 14 | DB | Alert on failed cron | `GAP` | Code + Owner step | `workflow-failure-alert` covers 13 names, omitting scheduled `.github/workflows/license-guard.yml`; Sentry/GitHub routing + probe vars require owner config |
| 15 | DB | Zero-downtime migration discipline | `CLOSE` | None | Policy doc, `test-migration-discipline.ts`, `test-not-valid-validate-policy.ts`, `test-custom-domain-types.ts`, schema drift & `record-migration.cjs` complete |
| 16 | DB | DB health check | `GAP` | Owner step | `/api/health/ready`, `dbHealth.ts`, `probe-db-health.ts`, `db-health.sql` complete; no UptimeRobot monitor on readiness probe, `20261108b` `NOT APPLIED`, probe var off |
| 17 | DB | Normalization | `GAP` | Code | Core normalized tables/FKs exist, but legacy `jobs.company` text duplication remains alongside nullable `jobs.company_id`, with no normalization audit/guard |
| 18 | DB | N+1 avoidance | `CLOSE` | None | `docs/db-n-plus-one.md` and Vitest guard `src/lib/__tests__/nPlusOneGuard.test.ts` cover all `src/app/api` and `src/lib` files |
| 19 | DB | DB-level RBAC | `GAP` | Code + Owner step | RLS/table revokes/`service_role` separation exist, but admin checks rely on app email allowlist + `service_role`; no DB-role RBAC or merged RLS coverage doc (`PR #542` open) |
| 20 | FE | SWR caching rows | `CLOSE` | None | `src/lib/cache/swr.ts` (`readSwr`/`swrFetch`/`updateSwr`/`invalidateSwr`/`isSwrStale`), dashboard/jobs wiring, HTTP SWR cache posture, and 8 Vitest/suite guards complete |
| 21 | FE | Concurrent features | `GAP` | Code | Partial `startTransition` in `src/app/jobs/page.tsx` and `<Suspense>` boundaries in 5 app files; no broader concurrent-feature coverage, doc, or guard |
| 22 | FE | PWA manifest | `GAP` | Code | `public/manifest.webmanifest`, metadata link in `src/app/layout.tsx`, icon/offline assets, and `sw.js` exist; no manifest/PWA test guard, pre-PWA posture noted, `PR #301` open |

---

## Database Rows (19)

### 1. RPO/RTO targets

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `docs/rpo-rto-targets.md` — Defines target RPO tiers (<= 24h Core User & Application State, <= 7d Job Corpus, <= 0 lost Paid Entitlements via idempotency/replay) and RTO targets (<= 4h Full DB Restore, <= 30m Application/Worker Tier, <= 1h Auth & Secrets), explicitly noting current values are `[OWNER TO CONFIRM]`.
  - `docs/disaster-recovery.md` — Documents Free-tier daily snapshots, manual dump procedure, and restore rehearsal plan.
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** Confirm SLA targets and current Supabase plan/backup retention in `docs/rpo-rto-targets.md`, and run/record a restore drill per `docs/disaster-recovery.md`.
  - **Code:** No automated off-site logical backup workflow or RPO/RTO verification guard is merged on `main` (`PR #554` for weekly `pg_dump` remains open and unmerged).

### 2. Change-history triggers

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `supabase/migrations/20261106c_change_history_triggers.sql` — Creates append-only `public.row_change_history`, privacy-filtered `public.log_row_change()`, triggers (`trg_change_history_subscriptions`, `trg_change_history_payment_orders`, `trg_change_history_user_addon_credits`, `trg_change_history_user_preferences`), and `public.purge_row_change_history(dry_run)`.
  - `docs/db-triggers.md` — Machine-checked inventory of all migration triggers.
  - `src/lib/__tests__/dbTriggersDoc.test.ts` — Vitest guard verifying every `CREATE TRIGGER` in `supabase/migrations/` matches `docs/db-triggers.md`.
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** `supabase/migrations/20261106c_change_history_triggers.sql` is marked `NOT APPLIED`; owner must execute it in Supabase SQL Editor and run `node scripts/record-migration.cjs 20261106c_change_history_triggers`.
  - **Code:** `public.purge_row_change_history(boolean)` is defined in `20261106c`, but `scripts/retention-cron.ts` and `public.purge_operational_logs()` (`supabase/migrations/20261106f_funnel_events_retention.sql`) do not invoke it automatically.

### 3. Unused index audit

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Owner step
- **Artifacts Verified on `main`:**
  - `docs/db-index-constraint-inventory.md` & `scripts/test-index-constraint-inventory.ts` (registered offline in `scripts/suite-runner.ts`) — Inventories indexes/constraints and guards against volatile predicates.
  - `supabase/migrations/20261106g_drop_redundant_subscriptions_index.sql` & `scripts/test-redundant-index-cleanup.ts` (registered in `scripts/suite-runner.ts`).
  - `scripts/db-health.sql` (sections 2 & 14) and `supabase/scripts/explain-checks.sql` (section 11) — SQL queries over `pg_stat_user_indexes` (`idx_scan = 0`).
  - `supabase/migrations/20261108b_db_health_snapshot.sql`, `src/lib/health/dbHealth.ts`, `src/lib/__tests__/dbHealth.test.ts`, `docs/db-health-probe.md` — Computes `advisoryUnusedIndexes` for non-unique indexes >= 1MB after 7 days since `stats_reset`.
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** Apply and record `supabase/migrations/20261106g_drop_redundant_subscriptions_index.sql` and `supabase/migrations/20261108b_db_health_snapshot.sql`, set repository variable `DB_HEALTH_PROBE_ENABLED=true` for `.github/workflows/db-health-probe.yml`, and review live `pg_stat_user_indexes` (`advisoryUnusedIndexes` is advisory-only and does not fail health checks).

### 4. Index bloat monitoring

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `scripts/db-health.sql` (sections 4 & 14) — Dead-tuple pressure query and largest-index review query.
  - `supabase/migrations/20261106m_reindex_maintenance.sql` (`public.reindex_bloated_indexes(min_size_mb, dry_run)`), `scripts/retention-cron.ts`, `scripts/test-reindex-maintenance-policy.ts`, `src/lib/__tests__/reindexResults.test.ts`.
  - `docs/db-health-probe.md`, `supabase/migrations/20261108b_db_health_snapshot.sql`, `src/lib/health/dbHealth.ts`.
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** `docs/db-health-probe.md` explicitly states that dead-tuple estimates do not measure physical index bloat and leaves that gap open; `reindex_bloated_indexes()` selects targets by total `pg_relation_size >= min_size_mb` (50 MB default) rather than bloat percentage (`pgstattuple` or B-tree/GIN bloat ratio).
  - **Owner step:** Apply and record `20261106m` and `20261108b`, and enable `DB_HEALTH_PROBE_ENABLED=true`.

### 5. Table size monitoring

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `scripts/db-health.sql` (section 5) — Live per-table relation & total sizes.
  - `scripts/db-stats.ts` — On-demand row count sampler (`jobs`, `companies`, `job_descriptions`, `ingest_runs`).
  - `supabase/migrations/20261108b_db_health_snapshot.sql`, `src/lib/health/dbHealth.ts`, `scripts/probe-db-health.ts`, `.github/workflows/db-health-probe.yml`, `src/lib/__tests__/dbHealth.test.ts`, `docs/db-health-probe.md` — Samples `total_bytes` across top 100 public tables (`tableBytes`).
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** `docs/db-health-probe.md` explicitly notes that `tableBytes` is a point-in-time sample without persisted historical growth-trend tracking or byte/quota threshold alerts.
  - **Owner step:** Apply and record `20261108b_db_health_snapshot.sql` and set `DB_HEALTH_PROBE_ENABLED=true`.

### 6. Index usage monitoring

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Owner step
- **Artifacts Verified on `main`:**
  - `scripts/db-health.sql` (sections 3, 14, 15) and `supabase/scripts/explain-checks.sql` (section 11) — `pg_stat_user_indexes` scan counts, index sizes, and `pg_statio_user_tables` heap-fetch ratio.
  - `supabase/migrations/20261108b_db_health_snapshot.sql`, `src/lib/health/dbHealth.ts`, `scripts/probe-db-health.ts`, `.github/workflows/db-health-probe.yml`, `src/lib/__tests__/dbHealth.test.ts`, `docs/db-health-probe.md`.
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** `20261108b_db_health_snapshot.sql` is `NOT APPLIED` and `.github/workflows/db-health-probe.yml` is gated behind `vars.DB_HEALTH_PROBE_ENABLED == 'true'`, so scheduled automated index-usage probing is inactive until the owner applies the migration and sets the variable.

### 7. Dead tuple watch

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Owner step
- **Artifacts Verified on `main`:**
  - `scripts/db-health.sql` (section 4) — `pg_stat_user_tables` dead tuple inspection query.
  - `supabase/migrations/20261108b_db_health_snapshot.sql`, `src/lib/health/dbHealth.ts`, `scripts/probe-db-health.ts`, `.github/workflows/db-health-probe.yml`, `docs/db-health-probe.md`, `src/lib/__tests__/dbHealth.test.ts` — Alerts with `dead_tuple_pressure` (and marks `healthy: false`) when `dead / (live + dead) >= 0.20` and `dead_tuples >= 1000`.
  - `supabase/migrations/20261106q_analyze_after_ingest.sql` & `scripts/test-analyze-after-ingest-policy.ts` — Post-ingest `ANALYZE` support.
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** Apply and record `20261108b_db_health_snapshot.sql` and `20261106q_analyze_after_ingest.sql` in Supabase, and set `DB_HEALTH_PROBE_ENABLED=true` so `.github/workflows/db-health-probe.yml` runs live weekly checks.

### 8. Purge jobs for log tables

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `docs/retention-policy.md`, `docs/log-retention.md`, `docs/pg-cron-schedules.md`.
  - `supabase/migrations/20261106a_data_retention.sql` & `supabase/migrations/20261106f_funnel_events_retention.sql` — `public.purge_operational_logs(dry_run)` covering `page_views`, `gmail_send_log`, `cron_run_logs`, `admin_audit_log`, `webhook_events`, `failed_events`, and `funnel_events`.
  - `scripts/retention-cron.ts`, `.github/workflows/retention-cron.yml`, `supabase/migrations/20261108a_pg_cron_scheduled_jobs.sql` (`purge-operational-logs-weekly`).
  - `scripts/test-retention-policy-consistency.ts` & `scripts/test-pg-cron-scheduled-jobs.ts` (registered offline in `scripts/suite-runner.ts`).
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** Apply and record `20261106a_data_retention.sql`, `20261106f_funnel_events_retention.sql`, and `20261108a_pg_cron_scheduled_jobs.sql` (`scripts/retention-cron.ts` fails closed until `20261106a` is applied).
  - **Code:** `public.row_change_history` (`supabase/migrations/20261106c_change_history_triggers.sql`) defines `purge_row_change_history(dry_run)`, which is not invoked by `scripts/retention-cron.ts` or `purge_operational_logs()`.

### 9. Views / materialized views

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Owner step
- **Artifacts Verified on `main`:**
  - `supabase/migrations/20261010_lock_paid_jobs_data.sql` (`public.jobs_public` view masking paid columns).
  - `supabase/migrations/20261016_worldwide_company_counts.sql`, `supabase/migrations/20261101_lock_scraper_metadata.sql`, `supabase/migrations/20261106d_matview_refresh_log.sql` (`public.worldwide_company_counts` materialized view + `matview_refresh_log` + `refresh_worldwide_company_counts()`).
  - `supabase/migrations/20261107a_jobs_role_dedupe.sql` (`public.jobs_duplicate_roles` view `WITH (security_invoker = true)`, `service_role` only).
  - `scripts/test-worldwide-view.ts`, `scripts/test-matview-staleness.ts`, `scripts/test-cross-source-dedupe.ts` (registered in `scripts/suite-runner.ts`), `scripts/db-health.sql`.
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** `20261016`, `20261101`, `20261106d`, `20261107a`, and `20261108a` carry `PENDING APPLICATION` / `NOT APPLIED` headers and must be applied and recorded in Supabase. *(Note: `PR #555` remains open to decouple the synchronous `ingest_runs` trigger refresh from `20261101`.)*

### 10. Connection pooling

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `src/lib/supabase/client.ts` & `src/lib/supabase/server.ts` — Application runtime uses `@supabase/ssr` / `@supabase/supabase-js` HTTP/PostgREST rather than direct `pg` TCP pools.
  - `supabase/migrations/20261105c_database_safety.sql` & `docs/statement-timeouts.md` — Configures `authenticator` PostgREST pooler role timeouts (`15s` statement / `5s` lock / `60s` idle-in-tx) and documents PgBouncer transaction-pooler port `6543` saturation risks.
  - `scripts/loadtest/README.md` — Notes checking Supabase Connection Pooling dashboard during load tests.
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** No dedicated connection-pooling architecture/audit doc or offline guard test exists on `main`.
  - **Owner step:** Verify and record live Supabase Supavisor/PgBouncer pool mode and pool-size limits in the Supabase dashboard (not visible from repo).

### 11. PITR

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Owner step
- **Artifacts Verified on `main`:**
  - `docs/rpo-rto-targets.md` & `docs/disaster-recovery.md` — Explicitly document that Supabase Free tier provides daily backups only and lacks Point-in-Time Recovery (PITR), requiring upgrade to Supabase Pro (`[OWNER TO CONFIRM]`).
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** Upgrade the Supabase project to Pro, enable the PITR add-on in the Supabase dashboard, and confirm RPO/restore testing.

### 12. Concurrent refresh

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Owner step
- **Artifacts Verified on `main`:**
  - `supabase/migrations/20261101_lock_scraper_metadata.sql` — Creates `UNIQUE INDEX idx_worldwide_company_counts_slug` and `refresh_worldwide_company_counts()` using `REFRESH MATERIALIZED VIEW CONCURRENTLY public.worldwide_company_counts` with non-concurrent fallback.
  - `supabase/migrations/20261106d_matview_refresh_log.sql` — Preserves `CONCURRENTLY` refresh with `'concurrent'` vs `'blocking_fallback'` logging in `public.matview_refresh_log`.
  - `supabase/migrations/20261108a_pg_cron_scheduled_jobs.sql`, `docs/pg-cron-schedules.md`, `scripts/test-matview-staleness.ts`, `scripts/test-pg-cron-scheduled-jobs.ts`.
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** Apply and record `20261101_lock_scraper_metadata.sql`, `20261106d_matview_refresh_log.sql`, and `20261108a_pg_cron_scheduled_jobs.sql` in Supabase. *(Note: open `PR #555` decouples synchronous post-ingest trigger execution onto a deferred path.)*

### 13. CREATE INDEX CONCURRENTLY

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `supabase/migrations/20261106n_covering_index_jobs_list.sql` — Standalone single-statement `CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_active_list_covering_idx` with autocommit instructions and INVALID-index recovery guidance.
  - `docs/concurrent-covering-index.md` & `docs/zero-downtime-migrations.md`.
  - `scripts/test-covering-index-policy.ts` & `scripts/test-migration-discipline.ts` (registered offline in `scripts/suite-runner.ts`).
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** Newer migrations `supabase/migrations/20261106k_autocomplete_pg_trgm.sql` (`jobs_title_trgm_idx`) and `supabase/migrations/20261107a_jobs_role_dedupe.sql` (`jobs_role_key_active_idx`) still execute non-concurrent `CREATE INDEX` on `public.jobs`, and `scripts/test-migration-discipline.ts` only checks that the doc mentions `CONCURRENTLY` rather than blocking non-concurrent index builds on existing hot tables.
  - **Owner step:** Apply standalone `20261106n_covering_index_jobs_list.sql` in autocommit mode outside a transaction block and record it.

### 14. Alert on failed cron

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `.github/workflows/workflow-failure-alert.yml`, `scripts/workflow-failure-alert.ts`, `scripts/lib/workflow-failure-alert.ts`, `scripts/lib/cron-sentry.ts`, `scripts/lib/cron-heartbeat.ts`.
  - `scripts/test-workflow-failure-alert.ts`, `scripts/test-cron-failure-visibility.ts`, `scripts/test-cron-heartbeat-monitoring.ts` (registered in `scripts/suite-runner.ts`).
  - `supabase/migrations/20261108b_db_health_snapshot.sql` & `src/lib/health/dbHealth.ts` (`failed_cron_last_7d`).
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** `.github/workflows/license-guard.yml` (`OSS License Guard`, scheduled weekly via `cron: '0 4 * * 1'`) is missing from both `.github/workflows/workflow-failure-alert.yml` `workflows:` trigger list and `SCHEDULED_CRON_WORKFLOWS` in `scripts/lib/workflow-failure-alert.ts` (which still carries legacy `"Daily Job Ingestion & Cleanup Pipeline"` alongside `ingest.yml`).
  - **Owner step:** Ensure `SENTRY_DSN` secret, GitHub issue notification routing, and `DB_HEALTH_PROBE_ENABLED=true` are configured in repo settings (`docs/environments-and-manual-settings.md`).

### 15. Zero-downtime migration discipline

- **Domain:** Database
- **Verdict:** `CLOSE`
- **Gap Classification:** None
- **Artifacts Verified on `main`:**
  - `docs/zero-downtime-migrations.md` — Defines Expand/Contract rules, `NOT VALID` + `VALIDATE CONSTRAINT`, `CONCURRENTLY`, and manual apply-and-record workflow.
  - `scripts/test-migration-discipline.ts` — Statically scans every `.sql` file in `supabase/migrations/` and fails on executable `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `RENAME COLUMN`, `RENAME TO`, or `SET DATA TYPE`.
  - `supabase/migrations/20261106o_not_valid_validate_pattern.sql` & `scripts/test-not-valid-validate-policy.ts`.
  - `supabase/migrations/20261112a_custom_domain_types.sql`, `docs/custom-domain-types.md`, & `scripts/test-custom-domain-types.ts`.
  - `docs/schema-drift-baseline.md`, `src/lib/__tests__/schemaDriftBaseline.test.ts`, `scripts/record-migration.cjs`, & `scripts/test-database-safety.ts`.
- **What Is Missing / Owner Sign-Off Action:**
  - **None (row closed by repo policy + CI guards).** *(Informational: open PRs `#541` idempotent DDL and `#544` rollback runbook propose additive docs/guards; individual pending migrations still follow the documented owner apply-and-record flow.)*

### 16. DB health check

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Owner step
- **Artifacts Verified on `main`:**
  - `src/app/api/health/route.ts`, `src/app/api/health/ready/route.ts`, `src/lib/health/readiness.ts`, `docs/readiness-probe.md`, `scripts/test-readiness.ts`.
  - `supabase/migrations/20261108b_db_health_snapshot.sql`, `src/lib/health/dbHealth.ts`, `scripts/probe-db-health.ts`, `.github/workflows/db-health-probe.yml`, `docs/db-health-probe.md`, `src/lib/__tests__/dbHealth.test.ts`, `scripts/db-health.sql`.
- **What Is Missing / Owner Sign-Off Action:**
  - **Owner step:** `docs/readiness-probe.md` notes `/api/health/ready` has no external monitor pointed at it yet and has not been verified against live Cloudflare/Netlify deploys; `20261108b_db_health_snapshot.sql` is `NOT APPLIED`; and `.github/workflows/db-health-probe.yml` is disabled until `DB_HEALTH_PROBE_ENABLED=true` is set (`PR #551` also open for slow-query extension).

### 17. Normalization

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code
- **Artifacts Verified on `main`:**
  - `supabase/migrations/20261001_phase1_storage_optimization.sql` — Normalizes `public.companies`, `public.company_boards`, and splits large text into `public.job_descriptions`, adding `jobs.company_id` FK.
  - `supabase/migrations/20261009_production_fixes.sql` & `supabase/migrations/20261031_account_delete_and_private_resumes.sql` — Foreign keys across `candidate_profiles`, `user_preferences`, `applications`, `daily_digests`, `subscriptions`, `saved_jobs`, `resumes`, and `tailored_resumes`.
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** `public.jobs` retains duplicated company-name text (`company`) alongside a nullable `company_id` FK (`20261001_phase1_storage_optimization.sql`), forcing string-normalization fallback joins in `supabase/migrations/20261101_lock_scraper_metadata.sql` (`j.company_id = c.id OR LOWER(TRIM(j.company)) = LOWER(TRIM(c.name))`). No schema normalization audit doc or offline guard test exists on `main`.

### 18. N+1 avoidance

- **Domain:** Database
- **Verdict:** `CLOSE`
- **Gap Classification:** None
- **Artifacts Verified on `main`:**
  - `docs/db-n-plus-one.md` — Documents bounded-fanout rules and classifies intentional loop queries vs banned N+1 storms.
  - `src/lib/__tests__/nPlusOneGuard.test.ts` — Registered Vitest guard statically scanning every `src/app/api/**/route.ts` and `src/lib/**/*.ts` file for Supabase `await` inside loops, failing CI on any unclassified hit or stale baseline entry.
- **What Is Missing / Owner Sign-Off Action:**
  - **None for app request paths (row closed).** *(Informational: offline scripts in `scripts/` sit outside `nPlusOneGuard.test.ts`'s `src/` globs.)*

### 19. DB-level RBAC

- **Domain:** Database
- **Verdict:** `GAP`
- **Gap Classification:** Code + Owner step
- **Artifacts Verified on `main`:**
  - `supabase/migrations/20261010_lock_paid_jobs_data.sql` (`jobs_public` view, `REVOKE SELECT ON public.jobs FROM anon, authenticated`, `jobs_service_role_access` policy).
  - `supabase/migrations/20261020_admin_audit_log.sql`, `supabase/migrations/20261101_lock_scraper_metadata.sql`, `supabase/migrations/20261105c_database_safety.sql`, `supabase/migrations/20261106c_change_history_triggers.sql`, `supabase/migrations/20261106l_job_archival.sql`, `supabase/migrations/20261107a_jobs_role_dedupe.sql` — Table/function revocations from `anon`/`authenticated` and `service_role`-only grants.
  - `src/lib/admin/auth.ts` & `src/lib/admin/constants.ts` (`isVerifiedAdminUser`, `verifyAdminSession`).
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** PostgreSQL custom RBAC roles or JWT database role claims do not exist; admin privilege is checked at the Next.js application layer (`ADMIN_EMAIL` / `ADMIN_EMAILS` + Google identity) before querying via `service_role`. No DB-level RBAC/RLS coverage matrix doc or CI guard is merged on `main` (`PR #542 db/rls-coverage` remains open).
  - **Owner step:** Apply and record pending RLS/lockdown migrations (`20261101`, `20261106c`, `20261106l`, `20261107a`) in Supabase.

---

## Frontend Rows (3)

### 20. SWR caching rows

- **Domain:** Frontend
- **Verdict:** `CLOSE`
- **Gap Classification:** None
- **Artifacts Verified on `main`:**
  - `src/lib/cache/swr.ts` — Implements bounded in-memory SWR cache (`readSwr`, `swrFetch` with 60s `SWR_DEFAULT_TTL_MS` and in-flight deduplication, `updateSwr`, `invalidateSwr`, `isSwrStale`, `SWR_MAX_ENTRIES = 200`).
  - `src/app/dashboard/page.tsx` & `src/app/jobs/page.tsx` — Instant paint via `readSwr`, background revalidation on mount/visibility via `swrFetch`, and write-through updates via `updateSwr`.
  - `docs/cache-invalidation.md`, `docs/memory-bounds.md`, `docs/race-condition-audit.md`, `docs/cache-posture.md`.
  - Guards: `src/lib/__tests__/swrBounds.test.ts`, `src/lib/__tests__/swrInvalidation.test.ts`, `src/lib/__tests__/swrUpdate.test.ts`, `src/lib/__tests__/swrWriteThroughRace.test.ts`, `src/lib/__tests__/cacheInvalidationDoc.test.ts`, `src/lib/__tests__/raceConditionAuditDoc.test.ts`, `scripts/test-memory-bounds.ts`, `scripts/test-cache-posture.ts`.
- **What Is Missing / Owner Sign-Off Action:**
  - **None (row closed).**

### 21. Concurrent features

- **Domain:** Frontend
- **Verdict:** `GAP`
- **Gap Classification:** Code
- **Artifacts Verified on `main`:**
  - `src/app/jobs/page.tsx` — Wraps debounced search state update (`setDebouncedSearch`) in `startTransition`.
  - `src/app/layout.tsx`, `src/app/jobs/page.tsx`, `src/app/job-detail/page.tsx`, `src/app/onboarding/page.tsx`, `src/app/settings/page.tsx` — `<Suspense>` boundaries around layout trackers (`<WebVitalsTracker />`, guarded by `scripts/test-web-vitals-analytics.ts`) and search-param page shells.
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** `useTransition` pending UI states and `useDeferredValue` are not adopted on heavy filter/render paths, and there is no Concurrent Features inventory/guideline doc or offline test guard on `main`.

### 22. PWA manifest

- **Domain:** Frontend
- **Verdict:** `GAP`
- **Gap Classification:** Code
- **Artifacts Verified on `main`:**
  - `public/manifest.webmanifest` — Valid JSON manifest defining `name`, `short_name`, `start_url: "/jobs"`, `display: "standalone"`, `192x192` and `512x512` PNG icons.
  - `public/icon-192.png`, `public/icon.png`, `public/apple-touch-icon.png`, `public/offline.html`, `public/sw.js` — All referenced icon/offline/service-worker assets present on disk.
  - `src/app/layout.tsx` & `src/components/pwa/ServiceWorkerRegistrar.tsx` — Exports `manifest: "/manifest.webmanifest"` in Next.js metadata and registers `/sw.js` in production.
- **What Is Missing / Owner Sign-Off Action:**
  - **Code:** No offline test or CI guard validates `public/manifest.webmanifest` schema, icon path resolution, or `sw.js` precache/fallback contract; `docs/push-notifications.md` explicitly characterizes the app as pre-PWA; and A2HS install prompt support remains unmerged (`PR #301`).
