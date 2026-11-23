# Schema drift baseline (Database sheet: Repo-vs-live drift)

`supabase/schema.sql` is the hand-run baseline applied in the Supabase
SQL Editor; today it carries only the original `jobs` / `profiles`
tables and their policies. Every other live table is created by the
migration files under `supabase/migrations/` (owner-applied). This file
is the machine-checked inventory of that gap so drift is explicit and
can only shrink, never silently grow.

Guard: `src/lib/__tests__/schemaDriftBaseline.test.ts` fails CI when a
migration creates a table that is neither added to `schema.sql` nor
listed here, when an entry here no longer matches a migration, or when
the uncovered-table count rises above the baseline. New migrations
that create tables must extend `schema.sql` (preferred) or this file
in the same PR.

Measured 7 Nov 2026: 42 tables created by migrations, 0 duplicated in schema.sql, 42 covered only by migrations. Updated 7 Nov 2026 for `20261107b_search_alert_dispatches.sql` (not applied): 43 tables, 43 covered only by migrations. Updated again for `20261107c_outbox_queue.sql` (not applied): 44 tables, 44 covered only by migrations. Updated for `20261107f_search_alert_send_windows.sql` (not applied): 45 tables, 45 covered only by migrations. Updated 18 Nov 2026 for `20261118_onboarding_resume_uploads.sql` (migration-only: pointer table with preflight, marker comments, and transactional rollback guards): 46 tables, 46 covered only by migrations. Updated 19 Nov 2026 for `20261119_onboarding_resume_profiles.sql` (migration-only: parsed resume profile for ranking, owner-read only, preflight + marker + guarded rollback): 47 tables, 47 covered only by migrations. Updated 19 Nov 2026 (rehearsal merge of #643) for `20261116b_ten_million_system_design_schema.sql` (not applied): 57 tables, 57 covered only by migrations. Updated 20 Nov 2026 for the #643 rollback-provenance table `internal_ingestion.schema_migration_provenance` (`20261116b`, not applied): 58 tables, 58 covered only by migrations. Updated 21 Nov 2026 for `20261121a_error_events.sql` (not applied): 59 tables, 59 covered only by migrations. Updated 23 Nov 2026 for `20261123_company_logo_review_state.sql` (not applied): owner review state `company_logo_reviews` + `company_logo_rejected_hashes`, 62 tables covered only by migrations.

| Table | Owning migration |
| --- | --- |
| `addon_packs` | `20261103_plans_addons_usage.sql` |
| `admin_audit_log` | `20261020_admin_audit_log.sql` |
| `ai_concurrency_leases` | `20261104a_global_ai_budget.sql` |
| `ai_generations` | `20261116b_ten_million_system_design_schema.sql` |
| `ai_global_budget_daily` | `20261104a_global_ai_budget.sql` |
| `ai_usage_quotas` | `20261011_ai_usage_quotas.sql` |
| `applications` | `20261008_phase1_candidate_and_tracker.sql` |
| `blocked_users` | `20261011_admin_page_views_and_blocked_users.sql` |
| `candidate_profiles` | `20261008_phase1_candidate_and_tracker.sql` |
| `canonical_dedupe_hash_backfill_progress` | `20261121a_canonical_job_dedupe_hash.sql` |
| `category_overrides` | `20261116b_ten_million_system_design_schema.sql` |
| `companies` | `20261001_phase1_storage_optimization.sql` |
| `company_aliases` | `20261116b_ten_million_system_design_schema.sql` |
| `company_logo_runs` | `20261122_company_logo_contract.sql` |
| `company_logo_reviews` | `20261123_company_logo_review_state.sql` |
| `company_logo_rejected_hashes` | `20261123_company_logo_review_state.sql` |
| `company_boards` | `20261001_phase1_storage_optimization.sql` |
| `company_token_registry` | `20261028_ats_board_ingestion.sql` |
| `consent_logs` | `20261116b_ten_million_system_design_schema.sql` |
| `cron_run_logs` | `20261008_phase2_daily_digest_cron.sql` |
| `daily_digests` | `20261008_phase2_daily_digest_cron.sql` |
| `deleted_account_tombstones` | `20261106h_soft_delete_tombstones.sql` |
| `dunning_logs` | `20261008_phase3_subscriptions_and_billing.sql` |
| `early_access_approved` | `20261030_early_access_approved.sql` |
| `early_access_emails` | `20261029_early_access_emails.sql` |
| `email_suppressions` | `20261105b_email_suppressions.sql` |
| `error_events` | `20261121a_error_events.sql` |
| `failed_events` | `20261105a_failed_events.sql` |
| `funnel_events` | `20261106e_funnel_events.sql` |
| `gmail_send_log` | `20261029_early_access_emails.sql` |
| `inbound_replies` | `20261106j_inbound_replies.sql` |
| `ingest_runs` | `20261001_phase1_storage_optimization.sql` |
| `ingestion_sources` | `20261116b_ten_million_system_design_schema.sql` |
| `job_descriptions` | `20261001_phase1_storage_optimization.sql` |
| `job_postings` | `20261116b_ten_million_system_design_schema.sql` |
| `job_source_records` | `20261116b_ten_million_system_design_schema.sql` |
| `jobs_archive` | `20261106l_job_archival.sql` |
| `matview_refresh_log` | `20261106d_matview_refresh_log.sql` |
| `onboarding_resume_profiles` | `20261119_onboarding_resume_profiles.sql` |
| `onboarding_resume_uploads` | `20261118_onboarding_resume_uploads.sql` |
| `outbox` | `20261107c_outbox_queue.sql` |
| `page_views` | `20261011_admin_page_views_and_blocked_users.sql` |
| `payment_orders` | `20261103_plans_addons_usage.sql` |
| `plan_usage_events` | `20261103_plans_addons_usage.sql` |
| `plans` | `20261103_plans_addons_usage.sql` |
| `push_subscriptions` | `20261106i_push_subscriptions.sql` |
| `rate_limits` | `20261020_rate_limits.sql` |
| `repair_645_backfill_progress` | `20261116f_repair_642_batch_backfill.sql` |
| `resumes` | `20261031_account_delete_and_private_resumes.sql` |
| `row_change_history` | `20261106c_change_history_triggers.sql` |
| `saved_jobs` | `20261031_account_delete_and_private_resumes.sql` |
| `schema_migrations` | `20261105c_database_safety.sql` |
| `search_alert_dispatches` | `20261107b_search_alert_dispatches.sql` |
| `search_alert_windows` | `20261107f_search_alert_send_windows.sql` |
| `schema_migration_provenance` | `20261116b_ten_million_system_design_schema.sql` |
| `search_outbox` | `20261116b_ten_million_system_design_schema.sql` |
| `subscriptions` | `20261008_phase3_subscriptions_and_billing.sql` |
| `tailored_resumes` | `20261010_tailored_resumes.sql` |
| `user_addon_credits` | `20261103_plans_addons_usage.sql` |
| `user_age_attestations` | `20261116b_ten_million_system_design_schema.sql` |
| `user_preferences` | `20261008_phase4_user_preferences_and_onboarding.sql` |
| `web_vitals` | `20261105b_web_vitals.sql` |
| `webhook_events` | `20261019_webhook_events.sql` |

<!-- guard-entries: one per line, parsed by schemaDriftBaseline.test.ts -->
```guard
baseline-count: 62
table: addon_packs | 20261103_plans_addons_usage.sql
table: admin_audit_log | 20261020_admin_audit_log.sql
table: ai_concurrency_leases | 20261104a_global_ai_budget.sql
table: ai_generations | 20261116b_ten_million_system_design_schema.sql
table: ai_global_budget_daily | 20261104a_global_ai_budget.sql
table: ai_usage_quotas | 20261011_ai_usage_quotas.sql
table: applications | 20261008_phase1_candidate_and_tracker.sql
table: blocked_users | 20261011_admin_page_views_and_blocked_users.sql
table: candidate_profiles | 20261008_phase1_candidate_and_tracker.sql
table: canonical_dedupe_hash_backfill_progress | 20261121a_canonical_job_dedupe_hash.sql
table: category_overrides | 20261116b_ten_million_system_design_schema.sql
table: companies | 20261001_phase1_storage_optimization.sql
table: company_aliases | 20261116b_ten_million_system_design_schema.sql
table: company_logo_runs | 20261122_company_logo_contract.sql
table: company_logo_reviews | 20261123_company_logo_review_state.sql
table: company_logo_rejected_hashes | 20261123_company_logo_review_state.sql
table: company_boards | 20261001_phase1_storage_optimization.sql
table: company_token_registry | 20261028_ats_board_ingestion.sql
table: consent_logs | 20261116b_ten_million_system_design_schema.sql
table: cron_run_logs | 20261008_phase2_daily_digest_cron.sql
table: daily_digests | 20261008_phase2_daily_digest_cron.sql
table: deleted_account_tombstones | 20261106h_soft_delete_tombstones.sql
table: dunning_logs | 20261008_phase3_subscriptions_and_billing.sql
table: early_access_approved | 20261030_early_access_approved.sql
table: early_access_emails | 20261029_early_access_emails.sql
table: email_suppressions | 20261105b_email_suppressions.sql
table: error_events | 20261121a_error_events.sql
table: failed_events | 20261105a_failed_events.sql
table: funnel_events | 20261106e_funnel_events.sql
table: gmail_send_log | 20261029_early_access_emails.sql
table: inbound_replies | 20261106j_inbound_replies.sql
table: ingest_runs | 20261001_phase1_storage_optimization.sql
table: ingestion_sources | 20261116b_ten_million_system_design_schema.sql
table: job_descriptions | 20261001_phase1_storage_optimization.sql
table: job_postings | 20261116b_ten_million_system_design_schema.sql
table: job_source_records | 20261116b_ten_million_system_design_schema.sql
table: jobs_archive | 20261106l_job_archival.sql
table: matview_refresh_log | 20261106d_matview_refresh_log.sql
table: onboarding_resume_profiles | 20261119_onboarding_resume_profiles.sql
table: onboarding_resume_uploads | 20261118_onboarding_resume_uploads.sql
table: outbox | 20261107c_outbox_queue.sql
table: page_views | 20261011_admin_page_views_and_blocked_users.sql
table: payment_orders | 20261103_plans_addons_usage.sql
table: plan_usage_events | 20261103_plans_addons_usage.sql
table: plans | 20261103_plans_addons_usage.sql
table: push_subscriptions | 20261106i_push_subscriptions.sql
table: rate_limits | 20261020_rate_limits.sql
table: repair_645_backfill_progress | 20261116f_repair_642_batch_backfill.sql
table: resumes | 20261031_account_delete_and_private_resumes.sql
table: row_change_history | 20261106c_change_history_triggers.sql
table: saved_jobs | 20261031_account_delete_and_private_resumes.sql
table: schema_migrations | 20261105c_database_safety.sql
table: search_alert_dispatches | 20261107b_search_alert_dispatches.sql
table: search_alert_windows | 20261107f_search_alert_send_windows.sql
table: schema_migration_provenance | 20261116b_ten_million_system_design_schema.sql
table: search_outbox | 20261116b_ten_million_system_design_schema.sql
table: subscriptions | 20261008_phase3_subscriptions_and_billing.sql
table: tailored_resumes | 20261010_tailored_resumes.sql
table: user_addon_credits | 20261103_plans_addons_usage.sql
table: user_age_attestations | 20261116b_ten_million_system_design_schema.sql
table: user_preferences | 20261008_phase4_user_preferences_and_onboarding.sql
table: web_vitals | 20261105b_web_vitals.sql
table: webhook_events | 20261019_webhook_events.sql
```
