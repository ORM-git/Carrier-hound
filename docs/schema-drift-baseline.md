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

Measured 7 Nov 2026: 42 tables created by migrations, 0 duplicated in schema.sql, 42 covered only by migrations.

| Table | Owning migration |
| --- | --- |
| `addon_packs` | `20261103_plans_addons_usage.sql` |
| `admin_audit_log` | `20261020_admin_audit_log.sql` |
| `ai_concurrency_leases` | `20261104a_global_ai_budget.sql` |
| `ai_global_budget_daily` | `20261104a_global_ai_budget.sql` |
| `ai_usage_quotas` | `20261011_ai_usage_quotas.sql` |
| `applications` | `20261008_phase1_candidate_and_tracker.sql` |
| `blocked_users` | `20261011_admin_page_views_and_blocked_users.sql` |
| `candidate_profiles` | `20261008_phase1_candidate_and_tracker.sql` |
| `companies` | `20261001_phase1_storage_optimization.sql` |
| `company_boards` | `20261001_phase1_storage_optimization.sql` |
| `company_token_registry` | `20261028_ats_board_ingestion.sql` |
| `cron_run_logs` | `20261008_phase2_daily_digest_cron.sql` |
| `daily_digests` | `20261008_phase2_daily_digest_cron.sql` |
| `deleted_account_tombstones` | `20261106h_soft_delete_tombstones.sql` |
| `dunning_logs` | `20261008_phase3_subscriptions_and_billing.sql` |
| `early_access_approved` | `20261030_early_access_approved.sql` |
| `early_access_emails` | `20261029_early_access_emails.sql` |
| `email_suppressions` | `20261105b_email_suppressions.sql` |
| `failed_events` | `20261105a_failed_events.sql` |
| `funnel_events` | `20261106e_funnel_events.sql` |
| `gmail_send_log` | `20261029_early_access_emails.sql` |
| `inbound_replies` | `20261106j_inbound_replies.sql` |
| `ingest_runs` | `20261001_phase1_storage_optimization.sql` |
| `job_descriptions` | `20261001_phase1_storage_optimization.sql` |
| `jobs_archive` | `20261106l_job_archival.sql` |
| `matview_refresh_log` | `20261106d_matview_refresh_log.sql` |
| `page_views` | `20261011_admin_page_views_and_blocked_users.sql` |
| `payment_orders` | `20261103_plans_addons_usage.sql` |
| `plan_usage_events` | `20261103_plans_addons_usage.sql` |
| `plans` | `20261103_plans_addons_usage.sql` |
| `push_subscriptions` | `20261106i_push_subscriptions.sql` |
| `rate_limits` | `20261020_rate_limits.sql` |
| `resumes` | `20261031_account_delete_and_private_resumes.sql` |
| `row_change_history` | `20261106c_change_history_triggers.sql` |
| `saved_jobs` | `20261031_account_delete_and_private_resumes.sql` |
| `schema_migrations` | `20261105c_database_safety.sql` |
| `subscriptions` | `20261008_phase3_subscriptions_and_billing.sql` |
| `tailored_resumes` | `20261010_tailored_resumes.sql` |
| `user_addon_credits` | `20261103_plans_addons_usage.sql` |
| `user_preferences` | `20261008_phase4_user_preferences_and_onboarding.sql` |
| `web_vitals` | `20261105b_web_vitals.sql` |
| `webhook_events` | `20261019_webhook_events.sql` |

<!-- guard-entries: one per line, parsed by schemaDriftBaseline.test.ts -->
```guard
baseline-count: 42
table: addon_packs | 20261103_plans_addons_usage.sql
table: admin_audit_log | 20261020_admin_audit_log.sql
table: ai_concurrency_leases | 20261104a_global_ai_budget.sql
table: ai_global_budget_daily | 20261104a_global_ai_budget.sql
table: ai_usage_quotas | 20261011_ai_usage_quotas.sql
table: applications | 20261008_phase1_candidate_and_tracker.sql
table: blocked_users | 20261011_admin_page_views_and_blocked_users.sql
table: candidate_profiles | 20261008_phase1_candidate_and_tracker.sql
table: companies | 20261001_phase1_storage_optimization.sql
table: company_boards | 20261001_phase1_storage_optimization.sql
table: company_token_registry | 20261028_ats_board_ingestion.sql
table: cron_run_logs | 20261008_phase2_daily_digest_cron.sql
table: daily_digests | 20261008_phase2_daily_digest_cron.sql
table: deleted_account_tombstones | 20261106h_soft_delete_tombstones.sql
table: dunning_logs | 20261008_phase3_subscriptions_and_billing.sql
table: early_access_approved | 20261030_early_access_approved.sql
table: early_access_emails | 20261029_early_access_emails.sql
table: email_suppressions | 20261105b_email_suppressions.sql
table: failed_events | 20261105a_failed_events.sql
table: funnel_events | 20261106e_funnel_events.sql
table: gmail_send_log | 20261029_early_access_emails.sql
table: inbound_replies | 20261106j_inbound_replies.sql
table: ingest_runs | 20261001_phase1_storage_optimization.sql
table: job_descriptions | 20261001_phase1_storage_optimization.sql
table: jobs_archive | 20261106l_job_archival.sql
table: matview_refresh_log | 20261106d_matview_refresh_log.sql
table: page_views | 20261011_admin_page_views_and_blocked_users.sql
table: payment_orders | 20261103_plans_addons_usage.sql
table: plan_usage_events | 20261103_plans_addons_usage.sql
table: plans | 20261103_plans_addons_usage.sql
table: push_subscriptions | 20261106i_push_subscriptions.sql
table: rate_limits | 20261020_rate_limits.sql
table: resumes | 20261031_account_delete_and_private_resumes.sql
table: row_change_history | 20261106c_change_history_triggers.sql
table: saved_jobs | 20261031_account_delete_and_private_resumes.sql
table: schema_migrations | 20261105c_database_safety.sql
table: subscriptions | 20261008_phase3_subscriptions_and_billing.sql
table: tailored_resumes | 20261010_tailored_resumes.sql
table: user_addon_credits | 20261103_plans_addons_usage.sql
table: user_preferences | 20261008_phase4_user_preferences_and_onboarding.sql
table: web_vitals | 20261105b_web_vitals.sql
table: webhook_events | 20261019_webhook_events.sql
```
