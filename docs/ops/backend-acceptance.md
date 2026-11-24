# Backend Acceptance Reconciliation Report

**Date**: 24 November 2026  
**Baseline**: `main` `796c9422` (includes #709, #711, #714). Local suites re-run on this SHA.  
**Scope**: Python ingest persistence and Workday isolation, ingest watchdog, company-profile enrichment, AI tailoring and fallback, auth invite gate, account-deletion tombstone grants and recovery, email one-click unsubscribe.

**Status legend.** **DONE** means verified live in production, with evidence. **BLOCKED (…)** means the next step needs a review, merge, owner decision or owner action. **NOT TESTED** means local or mocked tests pass but nothing has been verified live. A green build or local pass is never DONE. Where this task could not see a production secret or deployment, its state is **not verified**. That is not the same as missing.

---

## 1. Acceptance Checklist Summary

| Domain | Scope / Feature | Status | Evidence | Exact Owner Action |
| :--- | :--- | :--- | :--- | :--- |
| **Python ingest persistence (Item B)** | Stop sending `salary_period='year'` (23514 on the Amazon *Sr. Systems Engineer, Prime Air* row, run 45323980814); shared CHECK validator; per-row rejection; 400/23514 batch isolation | **BLOCKED (re-review of #716)** | First head `32ea4b71` got reviewer **NOT GO** with two blockers: (1) the UPDATE path treated any 23514 body, even on HTTP 503, as a row rejection and kept writing; (2) list/dict values in enum fields raised `TypeError` instead of rejecting the row. Also, Adzuna was labelled yearly without the data stating a period. All three fixes are at head **`39080108`**, with tests (update 503+23514 / 500 / timeout gives exactly 1 PATCH and stops writes; list/dict rejected per row while the valid sibling persists, board expiry is withheld and the exit is nonzero; Adzuna period null). `pytest scripts/scraper/` 149 passed locally. These are pending re-review, not accepted guarantees. | Reviewer re-review of #716 at `39080108`; merge only after GO. |
| **Workday isolation (Item C)** | Per-board write isolation, persistent cooldown, rotation, zero Workday expiry | **BLOCKED (new review after B)** | First head `4bdd72c7` got reviewer **NOT GO** with two blockers: (1) a run with every board deferred exited 0 and would turn the production job green, refreshing watchdog freshness with nothing written; (2) dry runs wrote the production cooldown state (boards moved +3h with `last_success_at` null), so the next production run could defer untouched boards. Fixes are at head **`97eb1688`**, rebased on `39080108`: an all-deferred write run reports `noop_deferred` and exits 3 (job not green); dry runs never write state and the cache is saved only for `write-production-expire`; fetched-only is never completion. `pytest scripts/scraper/` 162 passed locally. Cooldown and production completeness are **unproven live**. | New review of #717 after #716 is re-reviewed. |
| **Python ingest live run** | One production `python-ingest` dispatch on `main` after B and C merge | **BLOCKED (owner approval)** | Not run. The last known production failure is still run 45323980814 (23514). | After #716 and #717 merge, approve one `workflow_dispatch` of `python-ingest.yml` on `main` (cohort `both`, mode `write-production-expire`, confirm `WRITE PRODUCTION AND EXPIRE`). Evidence to record: merged SHA, run ID, both cohort summaries/artifacts (fetched/validated/rejected/inserted/updated/failed/expired, Workday deferred boards with next eligible time, zero Workday expiry), and read-only `public.jobs` checks (e.g. active count and rows by `source_id` for the run window). |
| **Ingestion Watchdog** | Catch-up dispatch, serialized admission gate, dedupe cooldown, attempt backoff | **NOT TESTED** (live); deploy **not verified** | Code merged in #714. Re-run on `796c9422`: `pytest scripts/scraper/test_watchdog_gate.py` 18 passed; `npx vitest run workers/ingest-watchdog/test/index.test.ts` 23 passed. This task did not check whether the Worker is deployed or which secrets it has. | **Required for scheduled watchdog**: Worker secrets `GITHUB_TOKEN` (fine-grained, `actions:write`) and `ALERT_WEBHOOK_URL`, then `wrangler deploy`. **Optional**: `DISPATCH_SECRET`, needed only for the manual authenticated `POST /dispatch` endpoint. |
| **Company-profile enrichment (Item E)** | 3-company production canary, then a bounded scale runner | **BLOCKED (#700 merge into main)** | **#704 merged into `codex/company-tab-profile` (merge commit `9475c01b`), NOT into `main`.** `9475c01b` is not an ancestor of `origin/main`. #700 (that branch) is still open. No preflight, inventory, plan, digest or write has run. | Merge #700 into `main`. Item E then starts from verified merged code on `main`: SELECT-only preflight `supabase/scripts/preflight-company-profile-20261122a.sql`, read-only inventory, then owner approval of 3 exact company IDs plus the plan digest. Whether the production env (`COMPANY_PROFILE_ENV`, server-only Supabase URL/key for `szakevhxhwpeskidvtfs`) is configured is **not verified**. |
| **Company-tab data (Item D)** | Wikidata / DOL LCA / Google News RSS / rule-based tags | **BLOCKED (Item E canary)** | Not started. | None until the Item E canary is verified. |
| **AI Cover Letter & Fallback** | Duty grounding, neutral fallback notice, GROQ key leak prevention | **NOT TESTED** (live) | Re-run on `796c9422`: `npx tsx scripts/test-ai-fallback-and-cover-letter.ts`, ALL CHECKS PASSED (offline). Whether `GROQ_API_KEY` is configured in production is **not verified**. | Confirm `GROQ_API_KEY` is configured, then verify one live call. |
| **AI Resume Tailor (Live)** | Live LLM resume tailor and job-fit explanation | **NOT TESTED** (live) | No live run in this task. `GROQ_API_KEY` presence **not verified**. | Confirm `GROQ_API_KEY`, then verify one live generation. |
| **Stats & Invite Gate** | Authenticated-unapproved API denial, public stats restriction, invite claim protection | **NOT TESTED** (live) | Re-run on `796c9422`: `npx tsx scripts/test-stats-and-invite-gate.ts`, ALL CHECKS PASSED (local mock server). | Verify on production with real session tokens. |
| **Account Deletion (Contracts)** | Deletion cleanup, cancel recovery, 42501 fallback, browser lookup fail-closed | **NOT TESTED** (live) | Re-run on `796c9422`: `npx vitest run src/lib/account/__tests__/deleteThenFreshSignup.test.ts` 26 passed; `npx tsx scripts/test-account-delete.ts` all passed (mocked DB). | None for code; live deletion is unverified. |
| **Account Deletion (Prod DB)** | Tombstone DELETE permission for `service_role` | **BLOCKED (owner inspection)** | Current production grants **not verified**. Do not run migration 20261123a on historical assumptions. | Owner inspects `service_role` grants on `deleted_account_tombstones`, then decides on migration 20261123a. |
| **Email Unsubscribe** | RFC 8058 headers, GET confirm vs POST suppression, HMAC, digest skip | **NOT TESTED** (live) | Re-run on `796c9422`: `npx tsx scripts/test-email-unsubscribe.ts`, ALL 8 SUITES PASSED (live SQL branch skipped: no non-production DB configured). `UNSUBSCRIBE_SECRET` presence **not verified**. | Confirm `UNSUBSCRIBE_SECRET` is configured in production, then verify one live unsubscribe. |

---

## 2. Detailed Technical Evidence & Limitations

### 2.1 Ingest Watchdog & Concurrency Admission Gate
- **Architecture**:
  - Primary scheduler remains native GitHub Actions cron (`47 2-23/4 * * *`).
  - Cloudflare Worker (`workers/ingest-watchdog`) executes every 15 minutes (`*/15 * * * *`).
  - Freshness is derived from completed production-write cohort jobs on `main` (`Python ingestion [<cohort>] (write-production-expire)` with `conclusion == 'success'`).
  - Shared cadence (240m) + grace (45m) = 285m threshold across Worker and admission gate. A cohort that succeeded 200 minutes ago is fresh (< 285m) and is **never rewritten**.
  - Dry-runs (`(dry-run)`), other-branch runs, and skip-only runs are strictly excluded from production freshness.
  - Cohorts are tracked independently: if one cohort fails or is stale, only that degraded cohort is dispatched, preventing repeated writes to the healthy cohort.
  - Both worker and workflow gate enforce a 45-minute attempt cooldown to suppress rapid retries after failure.
  - Stale jobs ($\ge 120$ minutes in queued/running state) trigger alerts without duplicate dispatch.
  - Mandatory webhook destination validation, timeouts, bounded retries honoring `Retry-After` (seconds and HTTP-date), and 30-minute alert deduplication.
  - In-memory alert deduplication is best-effort across worker isolates.
  - Accepted PR limitation: `job-name + conclusion` is the freshness signal (no artifact/write-count validation). Full artifact parsing is an intentional follow-up.
- **Workflow Admission Gate (`scripts/scraper/watchdog_gate.py`)**:
  - Runs in `plan` job *after* acquiring the `concurrency: group: ingest-pipeline, cancel-in-progress: false` serialized lock.
  - Re-evaluates requested cohorts after acquiring the lock; excludes fresh cohorts and admits only overdue cohorts outside attempt cooldown.
  - Fails closed (`skip=true`, exit 1) if credentials, history, or cohort jobs cannot be verified (e.g. missing token/repo, HTTP 401/403/429/timeout, malformed data, empty jobs for completed run).
  - Distinguishes verified first-run bootstrap (API 200 with zero runs) from API failures.
  - Tested locally with 18 unit and negative regression tests (re-run on `796c9422`) in `scripts/scraper/test_watchdog_gate.py`.

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
- **Limitation**: Live LLM generation is **NOT TESTED**: this task had no `GROQ_API_KEY`, and whether one is configured in production is **not verified**.

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
- **Evidence Type**: Reproduced Local Test (Mocked DB).
- **Test Commands**:
  - `npx vitest run src/lib/account/__tests__/deleteThenFreshSignup.test.ts` (26/26 passed)
  - `npx tsx scripts/test-account-delete.ts` (all passed)
- **Coverage**:
  1. Complete table coverage across all 14 user tables.
  2. `blocked_users` security tradeoff preserved (anonymized to prevent re-registration by banned users).
  3. Interrupted deletion resets profile on cancel, enforcing fresh setup.
  4. 42501 fallback updates `purged_at` when DELETE is denied.
  5. Browser status lookup fails closed to `/onboarding` on missing session or thrown error.
- **Current Production Status**: `NOT VERIFIED`. Do not execute migration 20261123a without verifying current live table permissions. Owner should inspect `deleted_account_tombstones` permissions to confirm whether DELETE grant is already present.

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
- **Limitation**: Live email delivery and live suppression in production are **NOT TESTED**. Whether `UNSUBSCRIBE_SECRET` is configured in production is **not verified**.

### 2.6 Python Ingest Persistence (Item B, PR #716) and Workday Isolation (Item C, PR #717)
- **Root cause of run 45323980814**: `build_normalized_job` defaulted `salary_period='year'`, but `public.jobs` accepts only `yearly/monthly/hourly`. Amazon states no salary, so every Amazon row failed `jobs_salary_period_check` (23514).
- **#716 review history**: head `32ea4b71` got NOT GO. Blockers: the UPDATE path isolated a row on any 23514 body, including HTTP 503, instead of stopping; list/dict enum values raised `TypeError`; the Adzuna period was invented. Fixed at `39080108` and pending re-review. Until merged and run live, none of this is an accepted production guarantee.
- **#717 review history**: head `4bdd72c7` got NOT GO. Blockers: an all-deferred run exited 0 (a green job that refreshes watchdog freshness with nothing written); dry runs mutated the production cooldown state. Fixed at `97eb1688` (rebased on `39080108`) and needs a new review after #716. Cooldown behaviour and production completeness are unproven until a live run.
- **Live evidence (Step 3, not yet run)**: merged SHA, the `python-ingest` run ID, both cohort summaries and `python-ingest-*` artifacts, and read-only `public.jobs` checks. `public.ingest_runs` is written only by the TypeScript ingester (`scripts/ingest.ts`) and is TS context only, never evidence of a Python run.

### 2.7 Company-Profile Enrichment (Items E and D)
- #704 (3-company canary planner/writer) merged into `codex/company-tab-profile` at `9475c01b`, **not into `main`**. Item E waits for #700 to merge into `main` and for verification of the merged code.
- Nothing has been written to `company_profile_*` by this work. There is no preflight, inventory, plan, digest or journal yet.

### 2.8 CI Note for This Document's PR (#718)
- `Quality Advisory (a11y & Lighthouse, non-blocking)` → job `Axe + Lighthouse (advisory)` failed on attempts 1 and 2 at head `5fb78801` in step *Build Static Export*: `An error occurred in next/font … TypeError: Cannot read properties of null (reading '1')` from the Google font loader. The PR changes only this markdown file. Attempt 3 at the same head passed, and #716's run between the failures passed too. **Classification: transient failure fetching Google Fonts during the static export; unrelated to the diff.** This is a diagnosed transient, not a blanket waiver for red checks.
