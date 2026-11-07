# Database trigger map (Database sheet: DB Triggers)

Every PostgreSQL trigger declared in `supabase/migrations/`, what it fires
on, and why it exists. Guard: `src/lib/__tests__/dbTriggersDoc.test.ts`
fails CI if a migration adds/removes a trigger without this file changing
in the same PR. Atomic quota mutations intentionally use RPC functions
(e.g. `consume_set` / `refund_set`) instead of triggers so quota math runs
as one atomic statement per call; triggers below are for audit, derived
data, and normalization only.

Measured 7 Nov 2026: 7 triggers across 4 migration files. Updated 7 Nov 2026 for `20261107d_row_version_optimistic_lock.sql` (not applied): 11 triggers across 5 migration files.

| Trigger | Table | Timing / event | Function | Purpose |
| --- | --- | --- | --- | --- |
| `tr_prevent_admin_audit_log_mutation` | `admin_audit_log` | BEFORE UPDATE OR DELETE | `prevent_admin_audit_log_mutation()` | Audit log is append-only: blocks edits and deletes of audit rows. |
| `trigger_refresh_worldwide_company_counts` | `ingest_runs` | AFTER INSERT OR UPDATE OF finished_at, status, WHEN finished_at set | `on_ingest_run_completed_refresh_worldwide()` | Refreshes worldwide company-count derived data once an ingest run finishes. |
| `trg_email_suppressions_lowercase` | `email_suppressions` | BEFORE INSERT OR UPDATE | `trg_email_suppressions_lowercase()` | Normalizes suppression addresses to lowercase so lookups cannot miss by case. |
| `trg_change_history_subscriptions` | `subscriptions` | AFTER INSERT OR UPDATE OR DELETE | `log_row_change()` | Appends old/new row images to `row_change_history` (change-history audit). |
| `trg_change_history_payment_orders` | `payment_orders` | AFTER INSERT OR UPDATE OR DELETE | `log_row_change()` | Same change-history capture for payment orders. |
| `trg_change_history_user_addon_credits` | `user_addon_credits` | AFTER INSERT OR UPDATE OR DELETE | `log_row_change()` | Same change-history capture for add-on credit balances. |
| `trg_change_history_user_preferences` | `user_preferences` | AFTER INSERT OR UPDATE OR DELETE | `log_row_change()` | Same change-history capture for user preferences. |
| `trg_row_version_user_preferences` | `user_preferences` | BEFORE UPDATE | `bump_row_version()` | Optimistic-lock counter: row_version + 1 on every update (20261107d, not applied). Never rejects a write. |
| `trg_row_version_resumes` | `resumes` | BEFORE UPDATE | `bump_row_version()` | Optimistic-lock counter: row_version + 1 on every update (20261107d, not applied). Never rejects a write. |
| `trg_row_version_applications` | `applications` | BEFORE UPDATE | `bump_row_version()` | Optimistic-lock counter: row_version + 1 on every update (20261107d, not applied). Never rejects a write. |
| `trg_row_version_candidate_profiles` | `candidate_profiles` | BEFORE UPDATE | `bump_row_version()` | Optimistic-lock counter: row_version + 1 on every update (20261107d, not applied). Never rejects a write. |

<!-- guard-entries: one per line, parsed by dbTriggersDoc.test.ts -->
```guard
trigger: tr_prevent_admin_audit_log_mutation | 20261020_admin_audit_log.sql | admin_audit_log
trigger: trigger_refresh_worldwide_company_counts | 20261101_lock_scraper_metadata.sql | ingest_runs
trigger: trg_email_suppressions_lowercase | 20261105b_email_suppressions.sql | email_suppressions
trigger: trg_change_history_subscriptions | 20261106c_change_history_triggers.sql | subscriptions
trigger: trg_change_history_payment_orders | 20261106c_change_history_triggers.sql | payment_orders
trigger: trg_change_history_user_addon_credits | 20261106c_change_history_triggers.sql | user_addon_credits
trigger: trg_change_history_user_preferences | 20261106c_change_history_triggers.sql | user_preferences
trigger: trg_row_version_user_preferences | 20261107d_row_version_optimistic_lock.sql | user_preferences
trigger: trg_row_version_resumes | 20261107d_row_version_optimistic_lock.sql | resumes
trigger: trg_row_version_applications | 20261107d_row_version_optimistic_lock.sql | applications
trigger: trg_row_version_candidate_profiles | 20261107d_row_version_optimistic_lock.sql | candidate_profiles
```
