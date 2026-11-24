# Backend Acceptance Reconciliation Report

**Date**: 24 November 2026  
**Baseline**: `main` (`09f3b50a4da9402f46e302da84a3ae9d8c238fdc`)  
**Scope**: Ingest watchdog catch-up safety, AI tailoring & fallback, auth invite gate, account deletion tombstone grants & recovery, and email one-click unsubscribe.

---

## 1. Acceptance Checklist Summary

| Domain | Scope / Feature | Status | Evidence | Exact Owner Action |
| :--- | :--- | :--- | :--- | :--- |
| **Ingestion Watchdog** | Ingest watchdog catch-up, concurrency serialized admission gate, dedupe cooldown | **PASS-LOCAL** | `python -m unittest scripts.scraper.test_watchdog_gate` (6/6 pass); `workers/ingest-watchdog/test/index.test.ts` (7/7 pass). Verified duplicate-dispatch queue serialization. | Review PR. Once merged to `main`, configure `GITHUB_TOKEN` (fine-grained PAT with `actions:write`) and deploy worker per `docs/ops/python-ingest-cohorts.md`. |
| **AI Cover Letter & Fallback** | Deterministic cover letter duty grounding, neutral fallback notice, GROQ key leak prevention | **PASS-LOCAL** | `npx tsx scripts/test-ai-fallback-and-cover-letter.ts` (6/6 pass, PASS-LOCAL). Negative control verified. | None required for offline logic. Ensure `GROQ_API_KEY` is provisioned in production. |
| **AI Resume Tailor (Live)** | Real live LLM resume tailor & job fit explanation | **BLOCKED** | Local test environment denies external network and lacks live `GROQ_API_KEY` / Supabase credentials. Offline static rules, taxonomy, and token caps pass. | Provision `GROQ_API_KEY` and verify live generation in staging/production UI. |
| **Stats & Invite Gate** | Authenticated-unapproved API denial, public stats restriction, invite claim protection | **PASS-LOCAL** | `npx tsx scripts/test-stats-and-invite-gate.ts` (8/8 pass, PASS-LOCAL). `/api/invite/claim` denied (403) for unapproved users. | Verify in production staging that early-access invite gate operates as expected. |
| **Account Deletion (Contracts)** | Deletion cleanup, cancel recovery, 42501 fallback, browser lookup fail-closed | **PASS-LOCAL** | `npx vitest run src/lib/account/__tests__/deleteThenFreshSignup.test.ts` (26/26 pass); `npx tsx scripts/test-account-delete.ts` (all pass). | None for application code. |
| **Account Deletion (Prod DB)** | Tombstone DELETE permissions for `service_role` | **BLOCKED** | Production Supabase returns `42501: permission denied for table deleted_account_tombstones` on DELETE. | Execute `supabase/migrations/20261123a_grant_tombstone_delete_to_service_role.sql` on production Supabase database. |
| **Email Unsubscribe** | RFC 8058 headers, GET confirm vs POST suppression, HMAC validation, digest skip | **PASS-LOCAL** | `npx tsx scripts/test-email-unsubscribe.ts` (8/8 test suites pass, PASS-LOCAL). Negative control verified. | Configure `UNSUBSCRIBE_SECRET` in production environment variables. |

---

## 2. Detailed Technical Evidence

### 2.1 Ingest Watchdog & Concurrency Admission Gate
- **Architecture**:
  - Primary scheduler remains GitHub Actions cron (`47 2-23/4 * * *`).
  - Cloudflare Worker (`workers/ingest-watchdog`) runs every 15 minutes (`*/15 * * * *`).
  - If last successful ingestion was $> 285$ minutes ago (4h cadence + 45m grace) and no run is active, it dispatches `python-ingest.yml` on `main` with inputs:
    `{ "cohort": "both", "mode": "write-production-expire", "confirm": "WRITE PRODUCTION AND EXPIRE", "watchdog": true }`.
  - Stale jobs ($\ge 120$ minutes in queued/running state) are alerted via webhook without triggering duplicate runs.
  - Per-cohort outcomes are inspected; partial failures trigger diagnostic alerts.
- **Workflow Admission Gate (`scripts/scraper/watchdog_gate.py`)**:
  - Runs in `plan` job *after* acquiring the `concurrency: group: ingest-pipeline, cancel-in-progress: false` serialized lock.
  - Re-reads recent completed workflow runs from GitHub Actions API.
  - If a successful ingestion completed within the bounded 195-minute cooldown window, outputs `skip=true`.
  - Downstream `ingest` and `aggregate` jobs are skipped, completing the workflow green with zero database writes.
  - Tested locally with duplicate-dispatch queue serialization mocks in `scripts/scraper/test_watchdog_gate.py`.

### 2.2 AI Fallback & Grounding (`scripts/test-ai-fallback-and-cover-letter.ts`)
- **Test Command**: `npx tsx scripts/test-ai-fallback-and-cover-letter.ts`
- **Result**: ALL 6 CHECKS PASSED [PASS-LOCAL].
- **Coverage**:
  1. `getIndefiniteArticle` grammar resolution ("an Intern", "a Software Engineer").
  2. Cover letter duty grounding: role duties are strictly grounded in candidate profile; duty sentence omitted when profile role lacks duties.
  3. `CoverLetterModal`: neutral notice (`data-testid="cover-letter-ai-notice"`) displayed on failure; verified facts badge preserved.
  4. User-facing sanitization: `GROQ_API_KEY` leak neutralization replaces any error message containing secrets with `"AI is temporarily unavailable. Your verified rules-based version is ready."`
  5. Server-side logging integrity preserved in `serviceHandler.ts`.

### 2.3 Authenticated-Unapproved API Denial (`scripts/test-stats-and-invite-gate.ts`)
- **Test Command**: `npx tsx scripts/test-stats-and-invite-gate.ts`
- **Result**: ALL 8 CHECKS PASSED [PASS-LOCAL].
- **Coverage**:
  1. Anonymous callers receive only public summary stats (`jobsToday`, `updatedAt`).
  2. Authenticated unapproved users receive HTTP 403 on `/api/invite/claim`.
  3. Search and jobs browsing do not falsely block authenticated users.
  4. Subprocess negative control exits with code 1.

### 2.4 Account Deletion & Recovery (`deleteThenFreshSignup.test.ts`, `test-account-delete.ts`)
- **Test Commands**:
  - `npx vitest run src/lib/account/__tests__/deleteThenFreshSignup.test.ts` (26/26 passed)
  - `npx tsx scripts/test-account-delete.ts` (all passed)
- **Coverage**:
  1. Complete table coverage across all 14 user tables.
  2. `blocked_users` security tradeoff preserved (anonymized to prevent re-registration by banned users).
  3. A1: Interrupted deletion resets profile on cancel, enforcing fresh setup.
  4. A2: Partial delete then cancel allows fresh onboarding save with readable fresh preferences.
  5. A3: 42501 fallback updates `purged_at` when DELETE is denied.
  6. Browser status lookup fails closed to `/onboarding` on missing session or thrown error.
- **Production Prerequisite**:
  - Migration `supabase/migrations/20261123a_grant_tombstone_delete_to_service_role.sql` must be executed by owner on production database.

### 2.5 Email One-Click Unsubscribe (`scripts/test-email-unsubscribe.ts`)
- **Test Command**: `npx tsx scripts/test-email-unsubscribe.ts`
- **Result**: ALL 8 TEST SUITES PASSED [PASS-LOCAL].
- **Coverage**:
  1. Dedicated `UNSUBSCRIBE_SECRET` fail-closed enforcement.
  2. HMAC token generation, structure, and tamper rejection.
  3. RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
  4. GET returns confirmation page with button; POST executes suppression.
  5. Database constraint structure and idempotency verified.
  6. Digest sender cleanly skips suppressed addresses.
