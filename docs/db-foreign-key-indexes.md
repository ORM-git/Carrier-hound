# Foreign Key Indexing & Cascade Impact Analysis (Database Sheet: DB #26)

This document provides the authoritative inventory and risk assessment of all foreign key relationships defined across CareerMonke PostgreSQL migrations (`supabase/migrations/`). Guarded offline by `scripts/test-foreign-key-indexes.ts`.

## 1. Background & PostgreSQL Mechanics

In PostgreSQL, creating a `FOREIGN KEY ... REFERENCES parent_table(col)` constraint:
1. Automatically creates an index on the **parent** table's referenced unique/primary key column.
2. **Does NOT automatically create an index on the child table's referencing column.**

Without an index on the child table's referencing column:
- **Parent Row Deletions/Updates**: When a row in the parent table is deleted or its key updated, PostgreSQL must execute a sequential scan on the child table to enforce `ON DELETE CASCADE`, `ON DELETE SET NULL`, or `RESTRICT`. If the child table is large, this locks the child table and degrades throughput.
- **Join Performance**: Queries joining `parent JOIN child ON child.parent_id = parent.id` cannot use index scans on the foreign key column.

---

## 2. Foreign Key Inventory & Coverage Status

Across the 70 repository migration files, 33 foreign key declarations are analyzed and classified into four categories:

### Category A: Primary Key Covered (Self-Indexed via PK B-Tree)
These foreign keys serve simultaneously as the child table's Primary Key. PostgreSQL creates a unique btree index (`<table>_pkey`) automatically covering the foreign key column.
- `candidate_profiles(user_id)` -> `auth.users(id)` (Index: `candidate_profiles_pkey`)
- `user_preferences(user_id)` -> `auth.users(id)` (Index: `user_preferences_pkey`)
- `job_descriptions(job_id)` -> `public.jobs(id)` (Index: `job_descriptions_pkey`)
- `blocked_users(user_id)` -> `auth.users(id)` (Index: `blocked_users_pkey`)

### Category B: Covered by Explicit Single or Composite Leading Index
These foreign keys have dedicated indexes or lead a composite index, enabling efficient parent lookup, join traversal, and instant cascade enforcement:
- `jobs(company_id)` -> `companies(id)` (Covered by `idx_jobs_company_id`)
- `applications(user_id)` -> `auth.users(id)` (Covered by `idx_applications_user_stage` leading column `user_id`)
- `daily_digests(user_id)` -> `auth.users(id)` (Covered by `idx_daily_digests_user_date` leading column `user_id`)
- `subscriptions(user_id)` -> `auth.users(id)` (Covered by `idx_subscriptions_user_id`)
- `dunning_logs(user_id)` -> `auth.users(id)` (Covered by `idx_dunning_logs_user_id`)
- `tailored_resumes(user_id)` -> `auth.users(id)` (Covered by `idx_tailored_resumes_user_job` leading column `user_id`)
- `page_views(user_id)` -> `auth.users(id)` (Covered by `idx_page_views_user_id`)
- `ai_usage_quotas(user_id)` -> `auth.users(id)` (Covered by `idx_ai_usage_quotas_user_period` leading column `user_id`)
- `saved_jobs(user_id)` -> `auth.users(id)` (Covered by `idx_saved_jobs_user_id`)
- `resumes(user_id)` -> `auth.users(id)` (Covered by `idx_resumes_user_id`)
- `user_addon_credits(order_id)` -> `payment_orders(id)` (Covered by `idx_user_addon_credits_order_id`)
- `plan_usage_events(credit_id)` -> `user_addon_credits(id)` (Covered by `idx_plan_usage_events_credit_id`)
- `user_addon_credits(user_id)` -> `auth.users(id)` (Covered by `idx_user_addon_credits_user_expires` leading column `user_id`)
- `plan_usage_events(user_id)` -> `auth.users(id)` (Covered by `idx_plan_usage_events_user_kind_idem` leading column `user_id`)
- `funnel_events(user_id)` -> `auth.users(id)` (Covered by `idx_funnel_events_user_created` leading column `user_id`)
- `push_subscriptions(user_id)` -> `auth.users(id)` (Covered by `idx_push_subscriptions_user_id`)

### Category C: Static Dimension Exemption
These foreign keys reference static lookup/dimension tables containing fewer than 10 immutable rows. Deletions or updates to parent codes are disallowed by business rule. Sequential scan cost during any hypothetical update is O(1) table scan of < 10 rows:
- `user_addon_credits(pack_code)` -> `addon_packs(code)`
- `payment_orders(plan_code)` -> `plans(code)`
- `payment_orders(addon_code)` -> `addon_packs(code)`

### Category D: Unindexed Foreign Keys (Identified for Owner Action)
The following foreign keys currently lack covering indexes on the referencing column:
1. `applications(job_id)` -> `public.jobs(id)` (`ON DELETE SET NULL`)
   - *Impact*: When a job is purged or deleted, PostgreSQL table-scans `applications` to set `job_id = NULL`.
2. `saved_jobs(job_id)` -> `public.jobs(id)` (`ON DELETE CASCADE`)
   - *Impact*: When a job is deleted, PostgreSQL table-scans `saved_jobs` to cascade delete.
3. `payment_orders(user_id)` -> `auth.users(id)` (`ON DELETE CASCADE`)
   - *Impact*: During user account deletion (`account-delete`), PostgreSQL table-scans `payment_orders`.
4. `company_boards(company_id)` -> `public.companies(id)` (`ON DELETE CASCADE`)
   - *Impact*: When a company is deleted, scans `company_boards`.

---

## 3. Production Read-Only Inspection Query

Run this query in Supabase SQL Editor to audit unindexed foreign keys in live production:

```sql
SELECT
    c.conname AS constraint_name,
    c.conrelid::regclass AS child_table,
    a.attname AS child_column,
    c.confrelid::regclass AS parent_table,
    CASE c.confdeltype
        WHEN 'c' THEN 'CASCADE'
        WHEN 'n' THEN 'SET NULL'
        WHEN 'd' THEN 'SET DEFAULT'
        WHEN 'r' THEN 'RESTRICT'
        WHEN 'a' THEN 'NO ACTION'
        ELSE c.confdeltype::text
    END AS on_delete
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND c.connamespace = 'public'::regnamespace
  AND NOT EXISTS (
      SELECT 1
      FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND a.attnum = i.indkey[0] -- Leading column of index
  )
ORDER BY child_table, child_column;
```

---

## 4. Remediation DDL (For Future Owner Migration)

When scheduled by the maintainer, the missing indexes may be added concurrently via:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_applications_job_id ON public.applications(job_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_saved_jobs_job_id ON public.saved_jobs(job_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_orders_user_id ON public.payment_orders(user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_company_boards_company_id ON public.company_boards(company_id);
```
