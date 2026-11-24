# Backend Acceptance Reconciliation Report

**Date**: 24 November 2026 (re-run on `main` `796c9422`)  
**Baseline**: `main` (`796c9422`: includes #709, #711, #714; #704 merged at `9475c01b`)  
**Scope**: Python ingest persistence and Workday isolation, ingest watchdog, company-profile enrichment, AI tailoring and fallback, auth invite gate, account-deletion tombstone grants and recovery, email one-click unsubscribe.

**Status legend.** **DONE** means verified live in production, with evidence. **BLOCKED (owner …)** means code or tests are ready and the next step needs an owner key, decision or merge. **NOT TESTED** means local or mocked tests pass but nothing has been verified live. A green build or a local pass never counts as DONE.

---

## 1. Acceptance Checklist Summary

| Domain | Scope / Feature | Status | Evidence | Exact Owner Action |
| :--- | :--- | :--- | :--- | :--- |
| **Python ingest persistence (Item B)** | `salary_period` never invented (fixes 23514 on the Amazon *Sr. Systems Engineer, Prime Air* row, run 45323980814); shared CHECK validator; per-row rejection; 23514 batch isolation; redacted diagnostics | **NOT TESTED** (live) | PR #716 (head `32ea4b71`). `python -m pytest -q scripts/scraper/` 144 passed locally (Node 22.23.4); CI Build/Lint/Test passed on the PR. No production dispatch was made. | Reviewer GO on #716, then merge (merge agent). |
| **Workday isolation (Item C)** | Per-board write isolation; persistent cooldown (Retry-After across runs) via actions/cache; fair rotation; cold start on missing/corrupt state; zero Workday expiry | **NOT TESTED** (live) | PR #717 (head `4bdd72c7`, stacked on #716). `python -m pytest -q scripts/scraper/` 154 passed locally. | Reviewer GO on #717 after #716 merges. |
| **Python ingest live run** | One production `python-ingest` dispatch on `main` after B and C merge | **BLOCKED (owner approval)** | Not run. The last known failure is still 45323980814 (23514). | After #716 and #717 merge, approve one `workflow_dispatch` of `python-ingest.yml` on `main` (cohort `both`, mode `write-production-expire`, confirm `WRITE PRODUCTION AND EXPIRE`). |
| **Ingestion Watchdog** | Catch-up dispatch, serialized admission gate, dedupe cooldown, attempt backoff | **BLOCKED (owner key + deploy)** | Code merged in #714. Re-run on `796c9422`: `python -m pytest -q scripts/scraper/test_watchdog_gate.py` 18 passed; `npx vitest run workers/ingest-watchdog/test/index.test.ts` 23 passed. The Worker is not deployed, so live catch-up is unverified. | Set the Worker secrets `GITHUB_TOKEN` (fine-grained, `actions:write`), `ALERT_WEBHOOK_URL` and `DISPATCH_SECRET`, then `wrangler deploy` (see `docs/ops/python-ingest-cohorts.md`). |
| **Company-profile enrichment (Item E)** | 3-company production canary, then a bounded scale runner | **BLOCKED (#700 merge)** | #704 is merged (`9475c01b`). #700 is still open, and the canary task requires both merged. No preflight, inventory, plan or writes have run. | Merge #700. The owner then runs the SELECT-only preflight `supabase/scripts/preflight-company-profile-20261122a.sql`, confirms `COMPANY_PROFILE_ENV=production` and the server-only Supabase env for project `szakevhxhwpeskidvtfs`, and approves 3 exact company IDs plus the plan digest. |
| **Company-tab data (Item D)** | Wikidata / DOL LCA / Google News RSS / rule-based tags | **BLOCKED (Item E canary)** | Not started; it depends on a verified Item E canary. | None until the Item E canary is verified. |
| **AI Cover Letter & Fallback** | Duty grounding, neutral fallback notice, GROQ key leak prevention | **BLOCKED (owner key)** | Re-run on `796c9422`: `npx tsx scripts/test-ai-fallback-and-cover-letter.ts`, ALL CHECKS PASSED (offline). | Provision `GROQ_API_KEY` for live AI calls. |
| **AI Resume Tailor (Live)** | Live LLM resume tailor and job-fit explanation | **BLOCKED (owner key)** | No live run: no `GROQ_API_KEY` available to this task. | Provision `GROQ_API_KEY` and verify one live generation. |
| **Stats & Invite Gate** | Authenticated-unapproved API denial, public stats restriction, invite claim protection | **NOT TESTED** (live) | Re-run on `796c9422`: `npx tsx scripts/test-stats-and-invite-gate.ts`, ALL CHECKS PASSED (local mock server). | Verify on production with real session tokens. |
| **Account Deletion (Contracts)** | Deletion cleanup, cancel recovery, 42501 fallback, browser lookup fail-closed | **NOT TESTED** (live) | Re-run on `796c9422`: `npx vitest run src/lib/account/__tests__/deleteThenFreshSignup.test.ts` 26 passed; `npx tsx scripts/test-account-delete.ts` all passed (mocked DB). | None for code; live deletion is unverified. |
| **Account Deletion (Prod DB)** | Tombstone DELETE permission for `service_role` | **BLOCKED (owner inspection)** | Current production grants not inspected. Do not run migration 20261123a on historical assumptions. | Owner inspects `service_role` grants on `deleted_account_tombstones`, then decides on migration 20261123a. |
| **Email Unsubscribe** | RFC 8058 headers, GET confirm vs POST suppression, HMAC, digest skip | **BLOCKED (owner key)** | Re-run on `796c9422`: `npx tsx scripts/test-email-unsubscribe.ts`, ALL 8 SUITES PASSED (live SQL branch skipped: no non-production DB configured). | Provision `UNSUBSCRIBE_SECRET` in production. |

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
- **Limitation**: Live email delivery and live suppression in production are **NOT TESTED** and require setting `UNSUBSCRIBE_SECRET` in production environment.

### 2.6 Python Ingest Persistence (Item B, PR #716) and Workday Isolation (Item C, PR #717)
- **Root cause of run 45323980814**: `build_normalized_job` defaulted `salary_period='year'`, but `public.jobs` accepts only `yearly/monthly/hourly`. Amazon states no salary, so every Amazon row failed `jobs_salary_period_check` (23514).
- **Item B**: `scripts/scraper/persistence.py` mirrors the live CHECK constraints. Only `year/month/hour` map to canonical values; other unknowns are rejected per row with source-key diagnostics, and valid rows continue. A definitive 400/23514 batch rejection is isolated row by row. Timeouts and 5xx are never retried. A board with any rejected row is withheld from expiry and the cohort exits nonzero.
- **Item C**: a Workday board writes only after its whole fetch succeeds. Failed boards contribute nothing and block nothing. Per-board cooldown and rotation state lives in a JSON file carried across runs by `actions/cache` (no DB). Missing or corrupt state means a 1-board cold start. Workday never expires.
- **Live status**: neither PR is merged and no production run has happened, so both stay **NOT TESTED** until one approved dispatch on `main`, checked with read-only SQL (`ingest_runs`, active job count) and the per-cohort report.
- **Note for the live check**: `public.ingest_runs` is written by the TypeScript ingester (`scripts/ingest.ts`), not by the Python runner. Python cohort results are in the run's step summary and `python-ingest-*` artifacts.

### 2.7 Company-Profile Enrichment (Items E and D)
- #704 (3-company canary planner/writer) merged at `9475c01b`. #700 is still open, and Item E starts only after both are merged.
- Nothing has been written to `company_profile_*` by this work. There is no preflight, inventory, plan, digest or journal yet.
