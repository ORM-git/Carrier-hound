# Data Retention Policy (DPDP schedule)

Retention classes per table. Enforcement: `public.purge_operational_logs`
(migration 20261106a) run weekly by `.github/workflows/retention-cron.yml`,
logged to `cron_run_logs` as job_type `retention_purge`.

| Table | Class | Window | Rationale |
| --- | --- | --- | --- |
| `page_views` | Analytics log | 90 days | Trend analytics need a quarter; raw views older than that have no operational use. |
| `funnel_events` | Analytics log | 90 days | Signup-to-apply funnel trends are quarterly, same as page_views; raw events older than that have no operational use. |
| `gmail_send_log` | Mail log | 180 days | Doubles as evidence for suppression/bounce handling; 6 months covers dispute windows. |
| `cron_run_logs` | Ops log | 90 days | Debugging window for recurring cron failures. |
| `admin_audit_log` | Audit trail | 365 days | Admin actions stay reviewable for a year. |
| `webhook_events` | Idempotency log | 90 days | Provider retries never arrive after 90 days. |
| `failed_events` (replayed/dead) | Dead-letter archive | 90 days after last attempt | Resolved incidents stay inspectable for a quarter. Pending rows are never purged. |
| User profile / resume data | User data | Until account deletion | Deleted with the account (`/api/account/delete`); no separate retention. |
| `jobs` / `job_descriptions` | Public reference data | Lifecycle-managed by ingestion (`is_active`) | Not user data; expired listings inactive for 90+ days move to `jobs_archive` via `archive_expired_jobs()` (20261106l, weekly retention cron). |

Notes:
- This schedule is the DPDP "storage limitation" baseline. User-facing
  privacy policy text updates are an owner decision.
- Backups (Supabase platform backups) may retain deleted rows inside
  their own windows; that is platform-managed.
