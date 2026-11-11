# Database Index & Constraint Inventory (Database sheet: Index & Constraint Inventory)

This document provides a machine-checked inventory and architectural reference of all custom indexes, primary keys, foreign keys, unique constraints, and check constraints declared across CareerMonke's Supabase migrations (`supabase/migrations/*.sql`).

---

## 1. Architectural Rules for Database Indexes

1. **Immutable Predicates on Partial Indexes**:
   - PostgreSQL requires functions in index predicates to be `IMMUTABLE` (`ERROR 42P17: functions in index predicate must be marked IMMUTABLE`).
   - Volatile functions like `NOW()` or `CURRENT_TIMESTAMP` must never appear in `WHERE` clauses of index definitions. Time-based windowing is handled via active state flags (e.g., `WHERE is_active = true AND status = 'active'`).

2. **Covering Indexes (`INCLUDE` Clause)**:
   - Covering indexes (e.g., `jobs_active_list_covering_idx` in `20261106n`) include payload columns in leaf pages without adding them to the btree search key, allowing index-only scans for high-throughput public endpoints (`/jobs`).

3. **Composite Index Ordering**:
   - Multi-column indexes follow equality-first, range/sort-second ordering. For keyset pagination, sort columns are indexed in descending order matching PostgREST queries: `(first_seen_at DESC, id DESC)`.

4. **Trigram & Text Search**:
   - Full-text search leverages GIN indexes over `search_vector` (`tsvector`) or `gin_trgm_ops` on `title`, `company`, and `location` using the `pg_trgm` extension.

---

## 2. Custom Index Inventory

| Table | Index Name | Type | Key Columns | Covering (`INCLUDE`) / Predicate | Owning Migration |
|---|---|---|---|---|---|
| `jobs` | `jobs_active_discovered_idx` | btree | `discovered_at DESC, id DESC` | `WHERE is_active = true AND status = 'active'` | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_search_vector_idx` | GIN | `search_vector` | Full text search vector | `20261001_filter_upgrades.sql` |
| `jobs` | `idx_jobs_title_trgm` | GIN | `title gin_trgm_ops` | Substring trigram search | `20261001_filter_upgrades.sql` |
| `jobs` | `idx_jobs_company_trgm` | GIN | `company gin_trgm_ops` | Company trigram search | `20261001_filter_upgrades.sql` |
| `jobs` | `idx_jobs_location_trgm` | GIN | `location gin_trgm_ops` | Location trigram search | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_source_source_job_id_unique` | btree | `source, source_job_id` | Unique ingestion deduplication | `20261001_ingestion_pipeline.sql` |
| `jobs` | `idx_jobs_company_source_job_id` | btree | `company, source_job_id` | Company source lookup | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `idx_jobs_is_active_first_seen` | btree | `first_seen_at DESC` | `WHERE is_active = true` | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `idx_jobs_remote_scope_active` | btree | `remote_scope, first_seen_at DESC` | `WHERE is_active = true` | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `idx_jobs_location_active` | btree | `location, first_seen_at DESC` | `WHERE is_active = true` | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `idx_jobs_category_active` | btree | `category, first_seen_at DESC` | `WHERE is_active = true` | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `idx_jobs_status_active` | btree | `status, first_seen_at DESC` | `WHERE is_active = true` | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `idx_jobs_source_active` | btree | `source, first_seen_at DESC` | `WHERE is_active = true` | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `idx_jobs_categories` | GIN | `categories` | Multi-category array overlap | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_role_key_unique` | btree | `role_key` | `WHERE is_active = true AND status = 'active'` | `20261107a_jobs_role_dedupe.sql` |
| `jobs` | `jobs_active_list_covering_idx` | btree | `first_seen_at DESC, id DESC` | `INCLUDE (...) WHERE is_active = true AND status = 'active'` | `20261106n_covering_index_jobs_list.sql` |
| `job_descriptions` | `job_descriptions_pkey` | btree | `job_id` | Primary key | `20261001_phase1_storage_optimization.sql` |
| `companies` | `companies_slug_key` | btree | `slug` | Unique company slug | `20261001_phase1_storage_optimization.sql` |
| `company_boards` | `company_boards_board_token_key` | btree | `board_token` | Unique ATS board token | `20261001_phase1_storage_optimization.sql` |
| `candidate_profiles` | `candidate_profiles_user_id_key` | btree | `user_id` | Unique 1:1 user profile constraint | `20261008_phase1_candidate_and_tracker.sql` |
| `user_preferences` | `user_preferences_user_id_key` | btree | `user_id` | Unique 1:1 user preferences constraint | `20261008_phase1_candidate_and_tracker.sql` |
| `applications` | `applications_user_job_unique` | btree | `user_id, job_id` | Unique application tracking per user | `20261008_phase1_candidate_and_tracker.sql` |
| `resumes` | `idx_resumes_user_id` | btree | `user_id` | Resume ownership lookup | `20261031_account_delete_and_private_resumes.sql` |
| `saved_jobs` | `idx_saved_jobs_user_id` | btree | `user_id` | User saved job index | `20261031_account_delete_and_private_resumes.sql` |
| `tailored_resumes` | `idx_tailored_resumes_user_job` | btree | `user_id, job_id` | User tailoring lookup | `20261010_tailored_resumes.sql` |
| `subscriptions` | `idx_subscriptions_user_id_unique` | btree | `user_id` | Unique active subscription | `20261102_idx_subscriptions_user_id_unique.sql` |
| `outbox` | `idx_outbox_claim` | btree | `status, next_attempt_at` | `WHERE status IN ('pending', 'processing')` | `20261107c_outbox_queue.sql` |
| `outbox` | `uq_outbox_dedupe_key` | btree | `dedupe_key` | `WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'processing')` | `20261107c_outbox_queue.sql` |
| `rate_limits` | `idx_rate_limits_window` | btree | `key, window_start` | Sliding rate-limit token bucket | `20261020_rate_limits.sql` |

---

## 3. Constraint Rules & Inventory

1. **Foreign Key Integrity**:
   - Foreign key references to `auth.users(id)` or `public.jobs(id)` must specify explicit deletion actions (`ON DELETE CASCADE` or `ON DELETE SET NULL`), preventing orphaned records or deletion deadlocks.

2. **Enumeration & Range Check Constraints**:
   - String lifecycle columns use validated `CHECK (col IN ('...', '...'))` expressions.
   - Numeric ranges must enforce validity (e.g., `salary_min <= salary_max` in `jobs_salary_bounds_check`).

| Table | Constraint Name | Type | Definition / Enforced Expression | Owning Migration |
|---|---|---|---|---|
| `jobs` | `jobs_period_check` | CHECK | `period IS NULL OR period IN ('year', 'month', 'hour')` | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_seniority_check` | CHECK | `seniority IN ('entry', 'mid', 'senior', 'staff', 'lead', 'director', 'unknown')` | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_remote_eligibility_check` | CHECK | `remote_eligibility IN ('worldwide', 'country_restricted', 'unknown')` | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_job_type_check` | CHECK | `job_type IN ('job', 'internship', 'full-time', 'part-time', 'contract', 'other')` | `20261001_ingestion_pipeline.sql` |
| `jobs` | `jobs_salary_bounds_check` | CHECK | `salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max` | `20261106o_not_valid_validate_pattern.sql` |
| `inbound_replies` | `chk_inbound_kind` | CHECK | `kind IN ('reply', 'bounce_suspect', 'unsubscribe_suspect')` | `20261106j_inbound_replies.sql` |
| `admin_audit_log` | `chk_audit_action` | CHECK | `action IN ('user_block', 'user_unblock', 'subscription_modify', 'refund_issue', 'pii_read')` | `20261020_admin_audit_log.sql` |
| `outbox` | `chk_outbox_status` | CHECK | `status IN ('pending', 'processing', 'done', 'dead')` | `20261107c_outbox_queue.sql` |

---

## 4. Verification Guard

The integrity of this inventory against repository migration DDL is verified by `scripts/test-index-constraint-inventory.ts` as part of the offline test suite.
