# Backend Acceptance Reconciliation Report

**Date**: 24 November 2026  
**Baseline**: `main` (`09f3b50a4da9402f46e302da84a3ae9d8c238fdc`)  
**Scope**: Ingest watchdog catch-up safety, AI tailoring & fallback, auth invite gate, account deletion tombstone grants & recovery, and email one-click unsubscribe.

---

## 1. Acceptance Checklist Summary

| Domain | Scope / Feature | Status | Evidence Type & Description | Exact Owner Action |
| :--- | :--- | :--- | :--- | :--- |
| **Ingestion Watchdog** | Ingest watchdog catch-up, concurrency serialized admission gate, dedupe cooldown, attempt backoff | **PASS-LOCAL** | **Reproduced Local Tests**: `python -m unittest scripts.scraper.test_watchdog_gate` (12/12 pass); `workers/ingest-watchdog/test/index.test.ts` (21/21 pass). Verified duplicate serialization, attempt cooldown, fail-closed negative controls. | Review PR #714. Once merged to `main`, configure `GITHUB_TOKEN` (fine-grained PAT with `actions:write`) and `ALERT_WEBHOOK_URL` in Cloudflare Workers per `docs/ops/python-ingest-cohorts.md`. |
| **AI Cover Letter & Fallback** | Deterministic cover letter duty grounding, neutral fallback notice, GROQ key leak prevention | **PASS-LOCAL** | **Reproduced Local Tests**: `npx tsx scripts/test-ai-fallback-and-cover-letter.ts` (6/6 pass). Offline mock harness verifies duty grounding and error sanitization. | None for offline logic. Ensure `GROQ_API_KEY` is provisioned for live production AI calls. |
| **AI Resume Tailor (Live)** | Real live LLM resume tailor & job fit explanation | **BLOCKED** | **Live Evidence Blocked**: Sandbox environment denies external network access and lacks live `GROQ_API_KEY` / live Supabase credentials. Offline static rules and token limits pass, but live LLM generation cannot be verified offline. | Provision `GROQ_API_KEY` and verify live generation in staging/production environment. |
| **Stats & Invite Gate** | Authenticated-unapproved API denial, public stats restriction, invite claim protection | **PASS-LOCAL** | **Reproduced Local Tests**: `npx tsx scripts/test-stats-and-invite-gate.ts` (8/8 pass) on local Express mock server. Authenticated unapproved users receive HTTP 403 on `/api/invite/claim`. Live production invite gate is **NOT TESTED**. | Verify on production/staging deployment with real session tokens. |
| **Account Deletion (Contracts)** | Deletion cleanup, cancel recovery, 42501 fallback, browser lookup fail-closed | **PASS-LOCAL** | **Reproduced Local Tests**: `npx vitest run src/lib/account/__tests__/deleteThenFreshSignup.test.ts` (26/26 pass); `npx tsx scripts/test-account-delete.ts` (all pass) on mocked database. | None for application code. |
| **Account Deletion (Prod DB)** | Tombstone DELETE permissions for `service_role` | **BLOCKED** | **Historical Live Evidence**: Production Supabase returned `42501: permission denied for table deleted_account_tombstones` during previous live testing. Live physical delete unblocking remains blocked until owner runs migration. | Execute `supabase/migrations/20261123a_grant_tombstone_delete_to_service_role.sql` on production Supabase database. |
| **Email Unsubscribe** | RFC 8058 headers, GET confirm vs POST suppression, HMAC validation, digest skip | **PASS-LOCAL** | **Reproduced Local Tests**: `npx tsx scripts/test-email-unsubscribe.ts` (8/8 pass) on local test harness. Verifies HMAC generation and suppression logic. Live production sending is **NOT TESTED**. | Provision `UNSUBSCRIBE_SECRET` in production environment variables. |

---

## 2. Detailed Technical Evidence & Limitations

### 2.1 Ingest Watchdog & Concurrency Admission Gate
- **Architecture**:
  - Primary scheduler remains native GitHub Actions cron (`47 2-23/4 * * *`).
  - Cloudflare Worker (`workers/ingest-watchdog`) executes every 15 minutes (`*/15 * * * *`).
  - Derives freshness from verified production-write cohort jobs on `main` (`Python ingestion [<cohort>] (write-production-expire)`).
  - Dry-runs (`(dry-run)`), other-branch runs, and skip-only runs are strictly excluded from production freshness.
  - Cohorts are tracked independently: if one cohort fails or is stale, only that degraded cohort is dispatched, preventing repeated writes to the healthy cohort.
  - Both worker and workflow gate enforce a 45-minute attempt cooldown to suppress rapid retries after failure.
  - Stale jobs ($\ge 120$ minutes in queued/running state) trigger alerts without duplicate dispatch.
  - Mandatory webhook destination validation, timeouts, bounded retries honoring `Retry-After`, and 30-minute alert deduplication.
  - Note: GitHub Actions job status inspection (e.g. checking job conclusions) confirms execution status, but is NOT full artifact report validation, which requires inspecting confirmed database write counts in the uploaded JSON artifact report.
- **Workflow Admission Gate (`scripts/scraper/watchdog_gate.py`)**:
  - Runs in `plan` job *after* acquiring the `concurrency: group: ingest-pipeline, cancel-in-progress: false` serialized lock.
  - Fails closed (`skip=true`, exit 1) if credentials, history, or cohort jobs cannot be verified (e.g. missing token/repo, HTTP 401/403/429/timeout, malformed data).
  - Distinguishes verified first-run bootstrap (API 200 with zero runs) from API failures.
  - Tested locally with 12 unit and negative regression tests in `scripts/scraper/test_watchdog_gate.py`.

### 2.2 AI Fallback & Grounding (`scripts/test-ai-fallback-and-cover-letter.ts`)
- **Evidence Type**: Reproduced Local Test (Mock Harness).
- **Test Command**: `npx tsx scripts/test-ai-fallback-and-cover-letter.ts`
- **Result**: ALL 6 CHECKS PASSED [PASS-LOCAL].
- **Coverage**:
  1. `getIndefiniteArticle` grammar resolution ("an Intern", "a Software Engineer").
  2. Cover letter duty grounding: role duties are strictly grounded in candidate profile; duty sentence omitted when profile role lacks duties.
  3. `CoverLetterModal`: neutral notice (`data-testid="cover-letter-ai-notice"`) displayed on failure; verified facts badge preserved.
  4. User-facing sanitization: `GROQ_API_KEY` leak neutralization replaces any error message containing secrets with `"AI is temporarily unavailable. Your verified rules-based version is ready."`
  5. Server-side logging integrity preserved in `serviceHandler.ts`.
- **Limitation**: Live LLM generation with real external API calls is **BLOCKED** offline due to sandbox network restrictions and absence of production `GROQ_API_KEY`.

### 2.3 Authenticated-Unapproved API Denial (`scripts/test-stats-and-invite-gate.ts`)
- **Evidence Type**: Reproduced Local Test (Local Mock Server).
- **Test Command**: `npx tsx scripts/test-stats-and-invite-gate.ts`
- **Result**: ALL 8 CHECKS PASSED [PASS-LOCAL].
- **Coverage**:
  1. Anonymous callers receive only public summary stats (`jobsToday`, `updatedAt`).
  2. Authenticated unapproved users receive HTTP 403 on `/api/invite/claim`.
  3. Search and jobs browsing do not falsely block authenticated users.
  4. Subprocess negative control exits with code 1.
- **Limitation**: Live production invite gate enforcement against live Supabase Auth and database tables is **NOT TESTED** and requires owner verification in staging.

### 2.4 Account Deletion & Recovery (`deleteThenFreshSignup.test.ts`, `test-account-delete.ts`)
- **Evidence Type**: Reproduced Local Test (Mocked DB) & Historical Live Evidence.
- **Test Commands**:
  - `npx vitest run src/lib/account/__tests__/deleteThenFreshSignup.test.ts` (26/26 passed)
  - `npx tsx scripts/test-account-delete.ts` (all passed)
- **Coverage**:
  1. Complete table coverage across all 14 user tables.
  2. `blocked_users` security tradeoff preserved (anonymized to prevent re-registration by banned users).
  3. Interrupted deletion resets profile on cancel, enforcing fresh setup.
  4. 42501 fallback updates `purged_at` when DELETE is denied.
  5. Browser status lookup fails closed to `/onboarding` on missing session or thrown error.
- **Limitation**: Production physical deletion of tombstones remains **BLOCKED** on owner execution of `supabase/migrations/20261123a_grant_tombstone_delete_to_service_role.sql` on the live database.

### 2.5 Email One-Click Unsubscribe (`scripts/test-email-unsubscribe.ts`)
- **Evidence Type**: Reproduced Local Test (Local Mock Harness).
- **Test Command**: `npx tsx scripts/test-email-unsubscribe.ts`
- **Result**: ALL 8 TEST SUITES PASSED [PASS-LOCAL].
- **Coverage**:
  1. Dedicated `UNSUBSCRIBE_SECRET` fail-closed enforcement.
  2. HMAC token generation, structure, and tamper rejection.
  3. RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
  4. GET returns confirmation page with button; POST executes suppression.
  5. Database constraint structure and idempotency verified.
  6. Digest sender cleanly skips suppressed addresses.
- **Limitation**: Live email delivery and live suppression in production are **NOT TESTED** and require setting `UNSUBSCRIBE_SECRET` in production environment.
