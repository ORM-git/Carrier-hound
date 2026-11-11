# Database Index & Constraint Inventory (Database sheet: Index & Constraint Inventory)

This document provides a machine-checked inventory and architectural reference of all custom indexes, primary keys, foreign keys, unique constraints, and check constraints declared across CareerMonke's Supabase migrations (`supabase/migrations/*.sql`). Guarded offline by `scripts/test-index-constraint-inventory.ts`.

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

## 2. Custom Index Inventory (90 Unique Indexes)

| Table | Index Name | Type | Key Columns | Covering (`INCLUDE`) / Predicate | Owning Migration |
|---|---|---|---|---|---|
| `jobs` | `jobs_active_discovered_idx` | btree | `discovered_at DESC, id DESC` | WHERE is_active = true AND status = 'active' | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_search_vector_idx` | gin | `search_vector` | - | `20261001_filter_upgrades.sql` |
| `jobs` | `idx_jobs_title_trgm` | gin | `title gin_trgm_ops` | - | `20261001_filter_upgrades.sql` |
| `jobs` | `idx_jobs_company_trgm` | gin | `company gin_trgm_ops` | - | `20261001_filter_upgrades.sql` |
| `jobs` | `idx_jobs_location_trgm` | gin | `location gin_trgm_ops` | - | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_categories_gin_idx` | gin | `categories` | - | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_salary_min_idx` | btree | `salary_min` | WHERE status = 'active' | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_seniority_idx` | btree | `seniority` | WHERE status = 'active' | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_country_code_idx` | btree | `country_code` | WHERE status = 'active' | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_remote_scope_idx` | btree | `remote_scope` | WHERE status = 'active' | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_source_source_job_id_unique` | unique btree | `source, source_job_id` | WHERE source IS NOT NULL AND source_job_id IS NOT NULL | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_apply_url_unique` | unique btree | `apply_url` | WHERE apply_url IS NOT NULL | `20261001_ingestion_pipeline.sql` |
| `jobs` | `jobs_is_active_idx` | btree | `is_active` | - | `20261001_ingestion_pipeline.sql` |
| `jobs` | `jobs_last_seen_at_idx` | btree | `last_seen_at` | - | `20261001_ingestion_pipeline.sql` |
| `jobs` | `jobs_posted_at_idx` | btree | `posted_at` | - | `20261001_ingestion_pipeline.sql` |
| `jobs` | `jobs_active_verified_idx` | btree | `country_code, seniority, job_type` | WHERE is_active = true AND status = 'active' | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `jobs_company_id_idx` | btree | `company_id` | WHERE is_active = true | `20261001_phase1_storage_optimization.sql` |
| `jobs` | `jobs_verified_status_idx` | btree | `verified, is_active` | - | `20261001_phase1_storage_optimization.sql` |
| `company_boards` | `company_boards_lookup_idx` | btree | `ats_type, enabled` | WHERE enabled = true | `20261001_phase1_storage_optimization.sql` |
| `applications` | `applications_user_stage_idx` | btree | `user_id, stage` | - | `20261008_phase1_candidate_and_tracker.sql` |
| `applications` | `applications_user_created_idx` | btree | `user_id, created_at desc` | - | `20261008_phase1_candidate_and_tracker.sql` |
| `cron_run_logs` | `idx_cron_run_logs_started_at` | btree | `started_at DESC` | - | `20261008_phase2_daily_digest_cron.sql` |
| `cron_run_logs` | `idx_cron_run_logs_status` | btree | `status` | - | `20261008_phase2_daily_digest_cron.sql` |
| `daily_digests` | `idx_daily_digests_user_date` | btree | `user_id, digest_date DESC` | - | `20261008_phase2_daily_digest_cron.sql` |
| `daily_digests` | `idx_daily_digests_status` | btree | `status` | - | `20261008_phase2_daily_digest_cron.sql` |
| `subscriptions` | `idx_subscriptions_user_id` | btree | `user_id` | - | `20261008_phase3_subscriptions_and_billing.sql` |
| `subscriptions` | `idx_subscriptions_status` | btree | `status` | - | `20261008_phase3_subscriptions_and_billing.sql` |
| `subscriptions` | `idx_subscriptions_provider` | btree | `provider, subscription_id` | - | `20261008_phase3_subscriptions_and_billing.sql` |
| `dunning_logs` | `idx_dunning_logs_user_id` | btree | `user_id` | - | `20261008_phase3_subscriptions_and_billing.sql` |
| `tailored_resumes` | `tailored_resumes_user_job_idx` | btree | `user_id, job_id` | - | `20261010_tailored_resumes.sql` |
| `tailored_resumes` | `tailored_resumes_user_updated_idx` | btree | `user_id, updated_at DESC` | - | `20261010_tailored_resumes.sql` |
| `page_views` | `idx_page_views_path` | btree | `path` | - | `20261011_admin_page_views_and_blocked_users.sql` |
| `page_views` | `idx_page_views_created_at` | btree | `created_at DESC` | - | `20261011_admin_page_views_and_blocked_users.sql` |
| `page_views` | `idx_page_views_user_id` | btree | `user_id` | - | `20261011_admin_page_views_and_blocked_users.sql` |
| `page_views` | `idx_page_views_ip_hash` | btree | `ip_hash` | - | `20261011_admin_page_views_and_blocked_users.sql` |
| `blocked_users` | `idx_blocked_users_email` | btree | `email` | - | `20261011_admin_page_views_and_blocked_users.sql` |
| `blocked_users` | `idx_blocked_users_blocked_at` | btree | `blocked_at DESC` | - | `20261011_admin_page_views_and_blocked_users.sql` |
| `ai_usage_quotas` | `ai_usage_quotas_user_date_idx` | btree | `user_id, period_date` | - | `20261011_ai_usage_quotas.sql` |
| `ai_usage_quotas` | `ai_usage_quotas_user_idx` | btree | `user_id` | - | `20261011_ai_usage_quotas.sql` |
| `admin_audit_log` | `idx_admin_audit_log_created_at` | btree | `created_at DESC` | - | `20261020_admin_audit_log.sql` |
| `admin_audit_log` | `idx_admin_audit_log_admin_user_created_at` | btree | `admin_user_id, created_at DESC` | - | `20261020_admin_audit_log.sql` |
| `admin_audit_log` | `idx_admin_audit_log_action` | btree | `action` | - | `20261020_admin_audit_log.sql` |
| `rate_limits` | `idx_rate_limits_expires_at` | btree | `expires_at` | - | `20261020_rate_limits.sql` |
| `company_token_registry` | `company_token_registry_ats_active_idx` | btree | `ats, is_active` | WHERE is_active = true | `20261028_ats_board_ingestion.sql` |
| `early_access_emails` | `idx_early_access_emails_created_at` | btree | `created_at DESC` | - | `20261029_early_access_emails.sql` |
| `gmail_send_log` | `idx_gmail_send_log_sent_at` | btree | `sent_at DESC` | - | `20261029_early_access_emails.sql` |
| `gmail_send_log` | `idx_gmail_send_log_recipient_kind` | btree | `recipient_email, kind` | - | `20261029_early_access_emails.sql` |
| `gmail_send_log` | `idx_gmail_send_log_kind_sent_at` | btree | `kind, sent_at DESC` | - | `20261029_early_access_emails.sql` |
| `early_access_approved` | `idx_early_access_approved_lookup` | btree | `email` | WHERE approved = TRUE | `20261030_early_access_approved.sql` |
| `saved_jobs` | `idx_saved_jobs_user_id` | btree | `user_id` | - | `20261031_account_delete_and_private_resumes.sql` |
| `resumes` | `idx_resumes_user_id` | btree | `user_id` | - | `20261031_account_delete_and_private_resumes.sql` |
| `worldwide_company_counts` | `idx_worldwide_company_counts_slug` | btree | `slug` | - | `20261101_lock_scraper_metadata.sql` |
| `worldwide_company_counts` | `idx_worldwide_company_counts_active_job_count` | btree | `active_job_count DESC` | - | `20261101_lock_scraper_metadata.sql` |
| `user_addon_credits` | `addon_credits_user_expiry` | btree | `user_id, expires_at` | - | `20261103_plans_addons_usage.sql` |
| `plan_usage_events` | `plan_usage_user_time` | btree | `user_id, created_at` | - | `20261103_plans_addons_usage.sql` |
| `user_addon_credits` | `idx_user_addon_credits_order_id` | btree | `order_id` | WHERE order_id is not null | `20261103c_fulfil_payment_fn.sql` |
| `plan_usage_events` | `idx_plan_usage_credit_id` | btree | `credit_id` | WHERE credit_id is not null | `20261103d_consume_atomic_fn.sql` |
| `subscriptions` | `idx_subscriptions_user_id_unique` | unique btree | `user_id` | - | `20261103f_subscriptions_unique_user.sql` |
| `plan_usage_events` | `idx_plan_usage_user_kind_idempotency` | btree | `user_id, kind, idempotency_key` | - | `20261103h_ai_idempotency_scoped.sql` |
| `early_access_emails` | `idx_early_access_emails_status_created_at` | btree | `status, created_at DESC` | - | `20261104_early_access_approval_fields.sql` |
| `ai_concurrency_leases` | `idx_ai_concurrency_leases_expires` | btree | `expires_at` | - | `20261104a_global_ai_budget.sql` |
| `payment_orders` | `idx_payment_orders_mode` | btree | `mode` | - | `20261104b_payment_order_mode_isolation.sql` |
| `failed_events` | `idx_failed_events_source_event` | btree | `source, event_id` | - | `20261105a_failed_events.sql` |
| `failed_events` | `idx_failed_events_pending_retry` | btree | `status, next_retry_at` | WHERE status = 'pending' | `20261105a_failed_events.sql` |
| `email_suppressions` | `idx_email_suppressions_lower_email` | btree | `lower(email)` | - | `20261105b_email_suppressions.sql` |
| `email_suppressions` | `idx_email_suppressions_created_at` | btree | `created_at desc` | - | `20261105b_email_suppressions.sql` |
| `web_vitals` | `idx_web_vitals_name_route_created_at` | btree | `name, route, created_at desc` | - | `20261105b_web_vitals.sql` |
| `web_vitals` | `idx_web_vitals_created_at` | btree | `created_at desc` | - | `20261105b_web_vitals.sql` |
| `row_change_history` | `idx_row_change_history_table_row` | btree | `table_name, row_id, changed_at desc` | - | `20261106c_change_history_triggers.sql` |
| `row_change_history` | `idx_row_change_history_changed_at` | btree | `changed_at desc` | - | `20261106c_change_history_triggers.sql` |
| `matview_refresh_log` | `idx_matview_refresh_log_name_time` | btree | `matview_name, refreshed_at desc` | - | `20261106d_matview_refresh_log.sql` |
| `funnel_events` | `idx_funnel_events_event_created_at` | btree | `event, created_at desc` | - | `20261106e_funnel_events.sql` |
| `funnel_events` | `idx_funnel_events_created_at` | btree | `created_at desc` | - | `20261106e_funnel_events.sql` |
| `funnel_events` | `idx_funnel_events_user_id` | btree | `user_id, created_at desc` | - | `20261106e_funnel_events.sql` |
| `funnel_events` | `idx_funnel_events_anonymous_id` | btree | `anonymous_id, created_at desc` | - | `20261106e_funnel_events.sql` |
| `candidate_profiles` | `idx_candidate_profiles_deleted_at` | btree | `deleted_at` | WHERE deleted_at IS NOT NULL | `20261106h_soft_delete_tombstones.sql` |
| `resumes` | `idx_resumes_deleted_at` | btree | `deleted_at` | WHERE deleted_at IS NOT NULL | `20261106h_soft_delete_tombstones.sql` |
| `applications` | `idx_applications_deleted_at` | btree | `deleted_at` | WHERE deleted_at IS NOT NULL | `20261106h_soft_delete_tombstones.sql` |
| `job_applications` | `idx_job_applications_deleted_at` | btree | `deleted_at` | WHERE deleted_at IS NOT NULL | `20261106h_soft_delete_tombstones.sql` |
| `deleted_account_tombstones` | `idx_deleted_account_tombstones_user_id` | unique btree | `user_id` | - | `20261106h_soft_delete_tombstones.sql` |
| `deleted_account_tombstones` | `idx_deleted_account_tombstones_purge_due` | btree | `hard_delete_after` | WHERE purged_at IS NULL | `20261106h_soft_delete_tombstones.sql` |
| `push_subscriptions` | `idx_push_subscriptions_user` | btree | `user_id` | WHERE revoked_at is null | `20261106i_push_subscriptions.sql` |
| `inbound_replies` | `idx_inbound_replies_received` | btree | `received_at desc` | - | `20261106j_inbound_replies.sql` |
| `jobs` | `jobs_title_trgm_idx` | gin | `title gin_trgm_ops` | - | `20261106k_autocomplete_pg_trgm.sql` |
| `jobs_archive` | `idx_jobs_archive_archived_at` | btree | `archived_at` | - | `20261106l_job_archival.sql` |
| `jobs` | `jobs_active_list_covering_idx` | btree | `first_seen_at DESC, id DESC` | INCLUDE (is_active, title, company, location, remote, remote_scope, job_type, salary_text, last_seen_at, posted_at, category, country, country_code, apply_url) WHERE status = 'active' | `20261106n_covering_index_jobs_list.sql` |
| `jobs` | `jobs_role_key_active_idx` | btree | `public.jobs_role_key(company, title, location)` | WHERE is_active IS TRUE | `20261107a_jobs_role_dedupe.sql` |
| `search_alert_dispatches` | `search_alert_dispatches_created_at_idx` | btree | `created_at` | - | `20261107b_search_alert_dispatches.sql` |
| `outbox` | `outbox_dedupe_key_uidx` | unique btree | `dedupe_key` | WHERE dedupe_key IS NOT NULL | `20261107c_outbox_queue.sql` |
| `outbox` | `outbox_claim_idx` | btree | `topic, available_at` | WHERE status IN ('pending', 'processing') | `20261107c_outbox_queue.sql` |

---

## 3. Named Constraints Inventory (16 Constraints)

| Table | Constraint Name | Type | Definition / Enforced Expression | Owning Migration |
|---|---|---|---|---|
| `jobs` | `jobs_period_check` | CHECK | `period IS NULL OR period IN ('year', 'month', 'hour')` | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_seniority_check` | CHECK | `seniority IN ('entry', 'mid', 'senior', 'staff', 'lead', 'director', 'unknown')` | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_remote_eligibility_check` | CHECK | `remote_eligibility IN ('worldwide', 'country_restricted', 'unknown')` | `20261001_filter_upgrades.sql` |
| `jobs` | `jobs_job_type_check` | CHECK | `job_type IN ('job', 'internship', 'full-time', 'part-time', 'contract', 'other')` | `20261001_ingestion_pipeline.sql` |
| `jobs` | `jobs_source_source_job_id_key` | UNIQUE | `source, source_job_id` | `20261001_ingestion_pipeline.sql` |
| `company_boards` | `company_boards_ats_slug_unique` | UNIQUE | `ats_type, slug` | `20261001_phase1_storage_optimization.sql` |
| `daily_digests` | `daily_digests_user_date_unique` | UNIQUE | `user_id, digest_date` | `20261008_phase2_daily_digest_cron.sql` |
| `subscriptions` | `subscriptions_user_unique` | UNIQUE | `user_id` | `20261008_phase3_subscriptions_and_billing.sql` |
| `tailored_resumes` | `tailored_resumes_user_job_unique` | UNIQUE | `user_id, job_id` | `20261010_tailored_resumes.sql` |
| `ai_usage_quotas` | `ai_usage_quotas_user_date_op_key` | UNIQUE | `user_id, period_date, operation` | `20261011_ai_usage_quotas.sql` |
| `company_token_registry` | `company_token_registry_ats_token_key` | UNIQUE | `ats, token` | `20261028_ats_board_ingestion.sql` |
| `subscriptions` | `subscriptions_user_id_fkey` | FOREIGN KEY | `user_id REFERENCES auth.users(id) ON DELETE SET NULL` | `20261031_account_delete_and_private_resumes.sql` |
| `plan_usage_events` | `plan_usage_events_user_kind_idempotency_unique` | UNIQUE | `user_id, kind, idempotency_key` | `20261103h_ai_idempotency_scoped.sql` |
| `email_suppressions` | `email_suppressions_email_key` | UNIQUE | `email` | `20261105d_email_suppressions_unique_constraint.sql` |
| `jobs_archive` | `jobs_archive_pkey` | PRIMARY KEY | `id` | `20261106l_job_archival.sql` |
| `jobs` | `jobs_salary_bounds_check` | CHECK | `salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max` | `20261106o_not_valid_validate_pattern.sql` |

---

## 4. Inline Unnamed Check Constraints

The following tables define inline CHECK constraints directly on columns without explicit constraint names:

| Table | Column | Type | Expression | Owning Migration |
|---|---|---|---|---|
| `inbound_replies` | `kind` | CHECK (inline) | `kind IN ('reply', 'bounce_suspect', 'unsubscribe_suspect')` | `20261106j_inbound_replies.sql` |
| `outbox` | `status` | CHECK (inline) | `status IN ('pending', 'processing', 'done', 'dead')` | `20261107c_outbox_queue.sql` |
| `outbox` | `max_attempts` | CHECK (inline) | `max_attempts > 0` | `20261107c_outbox_queue.sql` |
| `payment_orders` | `mode` | CHECK (inline) | `mode IN ('test', 'live')` | `20261104b_payment_order_mode_isolation.sql` |

---

## 5. Verification Guard

The integrity of this inventory against repository migration DDL is verified by `scripts/test-index-constraint-inventory.ts` as part of the offline test suite.
