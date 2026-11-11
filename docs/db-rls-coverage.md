# Row-Level Security (RLS) Coverage & Tier Architecture (Database Sheet: DB #2 / DB #20)

This document provides the authoritative audit and policy architecture for Row-Level Security (RLS) across all tables in CareerMonke PostgreSQL database (`supabase/migrations/`). Guarded offline by `scripts/test-rls-coverage.ts`.

---

## 1. Zero-Trust Database Policy

Supabase exposes PostgREST endpoints directly to public clients using anonymous (`anon`) and authenticated user JWTs (`authenticated`). Without Row-Level Security explicitly enabled, any table in the `public` schema would be directly readable and writable by anyone holding an anon key.

**CareerMonke Invariant**: Every single table created in the `public` schema **MUST** execute:
```sql
ALTER TABLE public.<table_name> ENABLE ROW LEVEL SECURITY;
```
When RLS is enabled with no policies attached, PostgreSQL defaults to **fail-closed deny-all** for non-superuser roles (`anon`, `authenticated`), while permitting `service_role` (which bypasses RLS) to execute background tasks and serverless functions.

---

## 2. Table Classification & Policy Tiers

All 45 tables across the 70 migration files are classified into four security tiers:

### Tier 1: User-Isolated Tenant Tables (Owner Read/Write via `auth.uid() = user_id`)
Users may access only rows matching their own authenticated UUID:
- `candidate_profiles`
- `applications`
- `user_preferences`
- `resumes`
- `tailored_resumes`
- `subscriptions`
- `dunning_logs`
- `user_addon_credits`
- `payment_orders`
- `saved_jobs`
- `push_subscriptions`
- `user_roles`
- `user_consents`
- `search_alerts`

### Tier 2: Public Read / Restricted Columns (Controlled Public Access)
Tables offering catalog or discovery data:
- `jobs` (Raw table locked down; public queries route through `jobs_public` view or serverless functions with compensation masking)
- `companies` (Public read of active companies, service_role write)
- `plans` (Public read of subscription catalog, service_role write)
- `addon_packs` (Public read of credit add-on catalog, service_role write)

### Tier 3: Service-Role Only / Deny-All by Default (Zero Public Policies)
Operational, audit, and queue tables where client access is strictly prohibited. RLS is enabled with zero policies, meaning `anon` and `authenticated` roles receive 0 rows / permission denied on all operations:
- `failed_events`
- `email_suppressions`
- `web_vitals`
- `schema_migrations`
- `row_change_history`
- `matview_refresh_log`
- `outbox`
- `search_alert_windows`
- `search_alert_dispatches`
- `jobs_archive`
- `ai_global_budget_daily`
- `ai_concurrency_leases`

### Tier 4: Append-Only Telemetry & Ingestion
Tables allowing insert with restricted read or service-only aggregation:
- `page_views` (Insert allowed, select restricted to admin/service)
- `funnel_events` (Insert allowed, select restricted to admin/service)
- `inbound_replies` (Service-role webhook ingest only)
- `deleted_account_tombstones` (Service-role soft-delete audit only)
- `admin_audit_log` (Append-only trigger locked, admin select only)

---

## 3. Production Read-Only Inspection Query

Run this query in Supabase SQL Editor to audit live production and assert that **0** public tables have RLS disabled:

```sql
-- Audit query: Detect any public table where Row-Level Security is NOT enabled
-- Expected result: 0 rows returned.
SELECT
    schemaname AS schema_name,
    tablename AS table_name,
    rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity = false
ORDER BY tablename;
```

---

## 4. Continuous Offline Guard

`scripts/test-rls-coverage.ts` verifies statically that every `CREATE TABLE` in `supabase/migrations/*.sql` is paired with an `ENABLE ROW LEVEL SECURITY` statement.
