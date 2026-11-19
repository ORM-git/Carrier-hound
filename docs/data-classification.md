# Data Classification

Internal reference for what the database stores and how sensitive it is
(Backend row: "Data Classification"). Three classes:

- **PII** - personal data under DPDP: identifies or can identify a user.
  Export, deletion, retention, and read-audit rules apply.
- **Internal** - operational data with no direct personal content
  (system logs, quotas, scraper state). Not exported, not user-visible.
- **Public** - product data served to any visitor.

Cross-references: `docs/retention-policy.md` (per-table retention classes),
`scripts/db-health.sql` (review queries), `public.admin_audit_log`
(admin mutations and `pii_read` access records).

## PII tables

| Table | Personal data held | Notes |
| --- | --- | --- |
| `candidate_profiles` | name, email, phone, headline, summary, skills, experience/education JSON, raw resume text | The core profile; exported and deleted with the account. |
| `profiles` | `full_name`, `target_roles` (PII); internal fields: `user_id`, `created_at`, `onboarding_completed_at` (lifecycle state) | Account onboarding and profile metadata; retained until account deletion (`docs/retention-policy.md`); not yet in the account export (known gap); deletion works through the `auth.users` cascade FK. |
| `resumes` | resume file metadata (`file_name`, `storage_path`, `mime_type`, `size_bytes`) per user | Bytes live in the `resumes` storage bucket (private). |
| `onboarding_resume_uploads` | pointer to the user's onboarding resume (`storage_path`, `file_name`, `mime_type`, `size_bytes`, `uploaded_at`) | Bytes live under `<uid>/onboarding/` in the private `resumes` bucket; writes are service-role only, owner can read their own row; deleted with the account via the `auth.users` cascade FK (20261118, NOT APPLIED). |
| `onboarding_resume_profiles` | structured profile parsed from the onboarding resume or LinkedIn "Save to PDF" export: job titles, skills, years of experience, education, location, preferred roles; parse status and reason | No raw text, name, email, phone or URLs. Writes are service-role only (`/api/onboarding/resume`), owner can read their own row; used server-side by `/api/jobs/recommended` for ranking; deleted with the upload pointer and with the account via cascade FKs (20261119, NOT APPLIED). |
| `tailored_resumes` | tailored resume and cover-letter content per user/job | AI-generated from the profile. |
| `user_preferences` | roles, locations, salary expectations, work authorization, digest opt-in | `work_auth` is sensitive; treat with care in logs. |
| `applications` | jobs applied to, stage, free-text `notes` | Notes can contain anything the user types. |
| `saved_jobs` | jobs a user saved | Behavioral. |
| `daily_digests` | per-user matched job lists | Behavioral. |
| `subscriptions` | provider customer/subscription ids, plan, amounts, period | Links identity to billing. |
| `payment_orders` | provider order id, amount, currency, status per user | Links identity to billing. |
| `user_addon_credits` | add-on credit balance per user | Billing-adjacent. |
| `dunning_logs` | failed-payment retry state per subscription | Billing-adjacent. |
| `early_access_emails` / `early_access_approved` | email addresses of pre-signup leads | PII before an account exists; covered by account-deletion email matching. |
| `email_suppressions` | email + suppression reason | Kept to honor opt-outs; do not purge blindly. |
| `gmail_send_log` | recipient email per send | Doubles as suppression evidence (180-day retention). |
| `page_views` | user id (nullable), salted IP hash, user agent, paths | Behavioral; 90-day retention. |
| `blocked_users` | email, user id, block reason | Moderation record. |
| `funnel_events` | nullable user id, pseudonymous `anonymous_id`, salted IP hash, funnel metadata | Signup->onboard->apply funnel; 90-day retention (20261106f). |
| `row_change_history` | before/after row images of user and billing tables | Per-row change audit; service-role only, append-only (20261106c). |
| `push_subscriptions` | Web Push endpoint URL and `p256dh`/`auth` keys per browser subscription | Endpoint and keys identify a device; deleted with the account or on unsubscribe (20261106i, NOT APPLIED). |
| `inbound_replies` | sender address, subject, truncated body excerpt of replies to product mail | Personal correspondence; service-role only, no user-facing policies (20261106j, NOT APPLIED). |
| `ai_generations` | user id, feature type, prompt/completion tokens, model, latency, metadata | AI feature usage accounting and audit log; owner-only RLS and service-role access (20261116b, NOT APPLIED). |
| `consent_logs` | user id (nullable), session id, consent type, granted boolean, IP address, user agent | Statutory DPDP and GDPR consent audit trail; owner-only read, service-role all (20261116b, NOT APPLIED). |
| `user_age_attestations` | user id, age confirmation boolean, IP address, user agent, timestamp | Statutory minor data protection compliance under DPDP; owner-only read, service-role all (20261116b, NOT APPLIED). |

## Internal tables

| Table | Contents |
| --- | --- |
| `admin_audit_log` | Admin mutations and `pii_read` access records (pseudonymous: salted IP hash, redacted metadata). Append-only, service-role only, 365-day retention. |
| `cron_run_logs` | Scheduled job outcomes. 90-day retention. |
| `ingest_runs` | Job-ingestion run state. |
| `failed_events` | Webhook/event replay queue. Replayed/dead rows purged after 90 days. |
| `webhook_events` | Provider webhook receipts (event ids, no payload PII). 90-day retention. |
| `rate_limits` | Rate-limit buckets keyed by route/ip hash. |
| `ai_usage_quotas` / `plan_usage_events` / `ai_concurrency_leases` / `ai_global_budget_daily` | Per-user and global AI usage accounting. User-linked but not identifying beyond the id. |
| `web_vitals` | Anonymous performance telemetry (no identifiers by design). |
| `company_token_registry` | Scraper tokens for company boards. Secret-adjacent; service-role only. |
| `matview_refresh_log` | Materialized-view refresh telemetry (when, duration). Service-role only (20261106d). |
| `deleted_account_tombstones` | PII-free account-deletion audit anchor (user id, SHA-256 email hash, purge deadline). 30-day undo window, then hard-purged (20261106h). |
| `supabase_migrations.schema_migrations` | Applied-migration ledger (Supabase-internal schema). |
| `internal_ingestion.ingestion_sources` / `internal_ingestion.job_source_records` / `internal_ingestion.company_aliases` / `internal_ingestion.search_outbox` / `internal_ingestion.category_overrides` | High-volume ingestion engine configuration, raw staging records, company aliases, CDC search outbox, and category overrides. Strictly isolated internal schema, zero PostgREST exposure, service-role only (20261116b, NOT APPLIED). |

## Public data

| Object | Contents |
| --- | --- |
| `jobs` / `jobs_public` view | Job listings. The view masks paid fields (company, salary, description, apply URL) for free users. |
| `job_postings` / `job_postings_public` view | Dedicated high-volume job postings table for 10M scale (Document 1, Section 3.3). Raw table restricted to service_role; public view masks paid fields (company_name, salary, apply URL) for free users (20261116b, NOT APPLIED). |
| `job_descriptions` | Full job description text. |
| `search_alert_dispatches` | Sent-log of (alert id, job id) pairs for search alerts (20261107b, not applied). Ids only, no email or personal text. Service-role only; no client access. |
| `search_alert_windows` | One row per alert with send-window timestamps (20261107f, not applied). Alert id and timestamps only, no email or personal text. Service-role only; no client access. |
| `outbox` | Generic work queue rows (20261107c, not applied). Payload is caller-defined and may contain personal data depending on the topic; keep payloads to ids. Service-role only; no client access. |
| `jobs_archive` | Archived expired job listings (cold storage, 20261106l). Service-role only; no client access. |
| `companies` / `company_boards` | Company directory and ATS board config. |
| `plans` / `addon_packs` | Product catalog (names, prices, quotas). |
| `company-logos` storage bucket | Public logo assets. |

## Rules of thumb

1. New columns on a PII table are PII until reviewed; check export
   (`src/lib/account/exportHandler.ts`) and deletion
   (`src/lib/account/deleteHandler.ts`) coverage when adding one.
2. Never log raw PII: audit metadata goes through the redacting sanitizer in
   `src/lib/admin/auditLog.ts`, and IPs are stored only as salted hashes.
3. Reads of PII by admins or exports are recorded as `action = 'pii_read'` in
   `admin_audit_log`; review with `scripts/db-health.sql` section 9.
