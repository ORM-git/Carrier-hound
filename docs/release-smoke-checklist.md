Run check: node scripts/check-release-smoke.cjs

# Production Release Smoke Checklist (15-Minute Launch Runbook)

> **Purpose**: This runbook enables the owner or release engineer to verify a production deployment end-to-end within 15 minutes. Every referenced route, script, workflow, and config matches actual repository code in `main`.
>
> **Execution Cadence**: Run immediately following any production deployment to Cloudflare Pages (Primary) or Netlify (Backup).
>
> **Live Verification Status**: All live checks in this checklist are currently **UNVERIFIED (Not run)**. Each item must be executed and recorded by the release operator at launch time.
>
> **Offline Validation**: Run `node scripts/check-release-smoke.cjs` to confirm that this checklist has not drifted from repository assets, structure, or source-backed invariants.

---

## 1. Deploy Identity Verification

Confirm that deployed running instances match the intended git commit SHA on `main`.

### Host Roles & Routing
- **Cloudflare Pages (`carrier-hound.pages.dev`)**: **Primary** production host serving `https://careermonke.com`. Serves Next.js frontend pages and edge API routes (`src/app/api/health/route.ts`, `src/app/api/billing/razorpay/order/route.ts`, `src/app/api/billing/razorpay/verify/route.ts`).
- **Netlify (`careermonke12.netlify.app`)**: **Backup** production host serving static export assets (`out/`) and Node.js serverless functions (`netlify/functions/health.ts`, `netlify/functions/billing-razorpay-webhook.ts`).

> [!NOTE]
> Health probes are **liveness probes only**. They verify in-memory HTTP response availability, NOT end-to-end database connectivity, AI provider availability, or Supabase Auth service status.

| Platform / Target | Verification Method | Pass Criteria | Log / Dashboard on Failure | Live Status |
| :--- | :--- | :--- | :--- | :--- |
| **Cloudflare Pages (Primary Host)** | Open external Cloudflare Pages dashboard (`https://dash.cloudflare.com/?to=/5046ad59f83225dfa6727be1cb18965e/pages/view/carrier-hound`) | Active deployment shows status `Success` and commit SHA equals target `origin/main` SHA. | External Cloudflare Pages dashboard -> Deployments -> View Build Log. | `UNVERIFIED (Not run)` |
| **Netlify Frontend & Functions (Backup Host)** | Open external Netlify dashboard (`https://app.netlify.com/projects/careermonke12/deploys`) | Active production deploy shows status `Published` and commit SHA equals target `origin/main` SHA. | External Netlify dashboard -> Deploys -> Deploy Log. | `UNVERIFIED (Not run)` |
| **Edge Health Liveness Probe** | Request `GET https://careermonke.com/api/health` | HTTP 200 with JSON payload `{"status":"ok"}` and response headers `Cache-Control: no-store, no-cache, must-revalidate` (`src/app/api/health/route.ts`). (In-memory edge liveness check; does not verify DB/AI/auth). | External Cloudflare Pages dashboard (edge route logs) or external Sentry dashboard. | `UNVERIFIED (Not run)` |
| **Netlify Function Liveness Probe** | Request `GET https://careermonke12.netlify.app/.netlify/functions/health` (direct to Netlify backup domain, since primary `careermonke.com` routes to Cloudflare) | HTTP 200 with JSON payload `{"ok":true,"time":"..."}` (`netlify/functions/health.ts`). (In-memory function liveness check; does not verify DB/AI/auth). | External Netlify dashboard -> Functions -> `health` invocation logs. | `UNVERIFIED (Not run)` |
| **Automated Smoke Suite** | Run `npx tsx scripts/smoke-post-deploy.ts` (executes checks from `src/lib/monitoring/smokeChecks.ts`) | Script exits with status 0, reporting all smoke checks passed against the target production domain. | Shell console stdout / stderr. | `UNVERIFIED (Not run)` |
| **GitHub Actions CI** | Open external GitHub Actions dashboard for `.github/workflows/ci.yml` | Workflow run for target `main` SHA completed with green checkmarks across all test, lint, and typecheck jobs. | External GitHub Actions dashboard -> CI run logs. | `UNVERIFIED (Not run)` |

---

## 2. Core Flows Verification (In Order)

Verify the end-to-end applicant journey in strict sequential order. Because payments are OFF (`NEXT_PUBLIC_BILLING_ENABLED=false`), free accounts are gated at Pro screens (`src/components/billing/ProUpgradeScreen.tsx`). The verification is therefore divided into:
1. **Free Account Verification** (verifying standard onboarding, jobs feed, and expected Pro paywall gating).
2. **Pro Account Verification** (verifying resume parsing and tracker features using an existing owner-authorized entitled test account).

> [!IMPORTANT]
> Never instruct testers to make payments or modify database entitlement tables to pass smoke testing. Pro features must be verified exclusively using an existing owner-authorized entitled test account.

### Step 2.1: Landing Page
- **Exact Path**: `/`
- **Pass Criteria**: Homepage loads in < 1.5 seconds. Hero header, interactive demo previews, value propositions, and navigation links render with zero hydration warnings. "Sign In" and "Get Started" buttons are clickable.
- **Single Dashboard on Failure**: External Sentry dashboard (filter by `transaction:/` or unhandled hydration exceptions).
- **Live Status**: `UNVERIFIED (Not run)`

### Step 2.2: Signup & Authentication (Passwordless Auth)
- **Exact Paths**: `/signup` and `/login`
- **Authentication Method (Code Verified)**: CareerMonke authentication is passwordless via Supabase Auth (`src/app/signup/page.tsx`, `src/app/login/page.tsx`, and `src/app/auth/callback/page.tsx`). It uses Magic Link / Email OTP (`supabase.auth.signInWithOtp`) and Google OAuth (`supabase.auth.signInWithOAuth`). Passwords do not exist in the codebase.
- **Resend Cooldown Timer**: Exactly 30 seconds (`setResendTimer(30)` in `src/app/signup/page.tsx` and `src/app/login/page.tsx`).
- **Post-Auth Dynamic Destination**: In `src/app/auth/callback/page.tsx`, the destination resolves dynamically via query parameters (`returnTo`, `return_to`, or `next`), defaulting to `/onboarding` if none is provided. There is no universal onboarding/jobs split based on user profile.
- **Pass Criteria**:
  1. Navigate to `/signup` or `/login`.
  2. Enter a valid test email address and submit.
  3. UI transitions smoothly to "Check your email" confirmation screen with the 30-second resend cooldown timer.
  4. Follow magic link from email or complete callback exchange at `/auth/callback?returnTo=/onboarding`.
  5. User session initializes and client navigates to the resolved callback destination.
- **Single Dashboard on Failure**: External Supabase dashboard -> Authentication -> Users & Logs (inspect Auth logs for delivery or token exchange errors).
- **Live Status**: `UNVERIFIED (Not run)`

### Step 2.3: Onboarding Flow (Known Gap / Launch Blocker Documented)
- **Exact Path**: `/onboarding` (`src/app/onboarding/page.tsx`)
- **Flow Details**: Complete the multi-step questionnaire: Role selection, Experience level, Work model, Preferred countries, and Job types.
- **Known Gap / Launch Blocker**: `src/app/onboarding/page.tsx` pre-populates existing preferences if present, but does **not** check `onboardingCompleted` on mount to redirect completed users away. Manually navigating back to `/onboarding` re-renders the questionnaire with prefilled answers. This is a known gap / launch blocker pending a client-side redirect fix, NOT "Code Verified" once-only.
- **Pass Criteria (Pending Fix)**:
  1. Complete questions and submit preferences.
  2. Submitting final preferences writes `onboardingCompleted: true` to the `user_preferences` table (`src/lib/auth/session.ts`).
  3. Client redirects to the target destination (`/jobs` or `/dashboard`).
- **Single Dashboard on Failure**: External Supabase dashboard -> Table Editor -> `user_preferences`.
- **Live Status**: `UNVERIFIED (Not run)`

### Step 2.4: Free Account Gating Verification (`/resume` & `/tracker`)
- **Exact Paths**: `/resume` (`src/app/resume/page.tsx`) and `/tracker` (`src/app/tracker/page.tsx`)
- **Gating Component**: `src/components/billing/ProUpgradeScreen.tsx`
- **Context**: For a newly signed-up free account, navigating to `/resume` or `/tracker` must display `ProUpgradeScreen`. Because billing is OFF (`NEXT_PUBLIC_BILLING_ENABLED=false`), free users cannot upgrade.
- **Pass Criteria**:
  1. Navigate to `/resume` with a free account: `ProUpgradeScreen` renders cleanly without client runtime crashes.
  2. Navigate to `/tracker` with a free account: `ProUpgradeScreen` renders cleanly with upgrade CTA.
  3. Clicking upgrade CTAs does not trigger any payment modal or unhandled network errors (see Section 3).
- **Single Dashboard on Failure**: External Sentry dashboard.
- **Live Status**: `UNVERIFIED (Not run)`

### Step 2.5: Jobs Feed (Real Jobs with Visible Posted Dates)
- **Exact Path**: `/jobs` (`src/app/jobs/page.tsx`)
- **Pass Criteria**:
  1. Jobs feed renders real scraped jobs from the Supabase `jobs` table (no mock fallback cards).
  2. Each job card clearly displays company name, title, location, work model badge, and visible posted date (`posted_at`, e.g. "Posted 3h ago").
  3. Match score badge calculates and displays based on candidate profile.
  4. Applying filters (e.g. Remote filter or Role search) updates visible job list responsively without errors.
- **Single Dashboard on Failure**: External Supabase dashboard -> SQL Editor (`SELECT count(*), max(posted_at) FROM jobs;`).
- **Live Status**: `UNVERIFIED (Not run)`

### Step 2.6: Job Detail View
- **Exact Paths**: `/jobs/detail` or selecting a job card on `/jobs` (`src/app/jobs/detail/page.tsx`, `src/components/jobs/JobDetailView.tsx`)
- **Pass Criteria**:
  1. Full job description, requirements, company summary, and metadata render properly formatted.
  2. Outbound "Apply on Company Site" button contains a valid applicant tracking URL.
  3. Experimental flags (`NEXT_PUBLIC_ENABLE_INTERVIEW_PACK` and `NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF` in `src/lib/flags/flags.ts`) remain disabled by default.
- **Single Dashboard on Failure**: External Sentry dashboard.
- **Live Status**: `UNVERIFIED (Not run)`

### Step 2.7: Entitled Pro Features Verification (Using Owner-Authorized Entitled Test Account)
- **Account Requirement**: Must use an existing owner-authorized entitled test account with pre-configured Pro access in Supabase. Do NOT attempt to pay or alter DB tables during smoke testing.
- **Resume Upload & Parsing**:
  - Path: `/resume` (`src/app/resume/page.tsx`, `src/components/resume/ResumeUploadAndConfirm.tsx`).
  - Upload a sample PDF or DOCX resume. Extracted fields populate confirmation card. Click "Confirm & Save Profile". Profile persists to storage (`src/lib/resume/storage.ts`).
- **Application Tracker**:
  - Path: `/tracker` (`src/app/tracker/page.tsx`).
  - From a job card, click "Save" or "Track Job". Verify job appears in "Saved" column on `/tracker`. Move stage to "Applied". Stage persists across page reloads (`src/lib/tracker/storage.ts`).
- **Single Dashboard on Failure**: External Sentry dashboard or external Supabase dashboard.
- **Live Status**: `UNVERIFIED (Not run)`

### Step 2.8: User Settings
- **Exact Path**: `/settings` (`src/app/settings/page.tsx`)
- **Pass Criteria**:
  1. Settings page displays account email, preferences, and daily digest opt-in.
  2. Toggle Daily Digest preference and click "Save Preferences".
  3. Confirmation toast appears and preference persists upon page refresh in `user_preferences`.
- **Single Dashboard on Failure**: External Supabase dashboard -> Table Editor -> `user_preferences`.
- **Live Status**: `UNVERIFIED (Not run)`

---

## 3. Payments OFF State Verification

CareerMonke launches with payments strictly **OFF** (`NEXT_PUBLIC_BILLING_ENABLED=false` in `src/lib/flags/flags.ts`). Note that code flag defaults alone are not proof of production state; deployment environment variables and server routing must be verified.

### Verification Procedure & Before/After Evidence
1. **Deployment Environment Inspection**:
   - Inspect external Cloudflare Pages dashboard -> Settings -> Environment Variables. Confirm `NEXT_PUBLIC_BILLING_ENABLED` is unset or explicitly `"false"`.
   - Inspect external Netlify dashboard -> Site configuration -> Environment variables. Confirm `NEXT_PUBLIC_BILLING_ENABLED` is unset or explicitly `"false"`.
2. **Before/After Evidence in External Razorpay Dashboard**:
   - Prior to smoke verification, open external Razorpay dashboard (`https://dashboard.razorpay.com`) and record initial counts:
     - Initial Payments Count: `[ ______ ]`
     - Initial Orders Count: `[ ______ ]`
     - Initial Subscriptions Count: `[ ______ ]`
   - Following all smoke test steps, verify before/after delta is exactly ZERO (0 new charges, 0 new orders, 0 new subscriptions).

| Verification Item | Test Procedure | Expected Response / State | Dashboard / Tool to Verify | Live Status |
| :--- | :--- | :--- | :--- | :--- |
| **No Paid Checkout Reachable** | Click any Pro upgrade CTA across `/jobs`, `/resume`, or `/settings`. | Modal displays launch/free access message or `src/components/billing/ProUpgradeScreen.tsx`. No Razorpay payment iframe opens. | Browser dev tools Network tab (0 requests to `api.razorpay.com`). | `UNVERIFIED (Not run)` |
| **Razorpay Webhook Returns 503** | Send `POST https://careermonke.com/.netlify/functions/billing-razorpay-webhook` | HTTP 503 with body `{"error":"Billing is currently unavailable","code":"BILLING_DISABLED"}` (`netlify/functions/billing-razorpay-webhook.ts`). | External Netlify dashboard -> Functions -> `billing-razorpay-webhook`. | `UNVERIFIED (Not run)` |
| **Billing Order API Returns 503** | Send `POST https://careermonke.com/api/billing/razorpay/order` with header `Authorization: Bearer <token>` | HTTP 503 with body `{"error":"Billing is currently unavailable","code":"BILLING_DISABLED"}` (`src/app/api/billing/razorpay/order/route.ts`). | External Cloudflare Pages dashboard -> Functions logs. | `UNVERIFIED (Not run)` |
| **Billing Verify API Returns 503** | Send `POST https://careermonke.com/api/billing/razorpay/verify` with header `Authorization: Bearer <token>` | HTTP 503 with body `{"error":"Billing is currently unavailable","code":"BILLING_DISABLED"}` (`src/app/api/billing/razorpay/verify/route.ts`). | External Cloudflare Pages dashboard -> Functions logs. | `UNVERIFIED (Not run)` |
| **Zero New Charges (Before/After)** | Compare external Razorpay dashboard before and after smoke testing | Zero delta: 0 new payments, 0 new orders, 0 new subscriptions generated. | External Razorpay dashboard -> Payments & Orders. | `UNVERIFIED (Not run)` |

---

## 4. Ingest Health Verification

Verify that job ingestion is healthy and fresh jobs have landed today.

### Ingest Freshness Verification Criteria
> [!IMPORTANT]
> Querying `SELECT max(created_at) FROM jobs;` alone is **NOT** proof of recent ingest execution! Because `scripts/ingest.ts` upserts existing postings, `created_at` remains unchanged on updated jobs. Freshness verification MUST pair DB records with scheduled non-dry shard run reports (`reports/ingest-report-*.json` or GitHub Actions workflow logs) and per-source fetch/upsert results.
>
> - **Cadence Target**: Ingest runs every 4 hours (`0 */4 * * *`). Target freshness is within 4 hours.
> - **Tolerance Limit**: 24 hours maximum acceptable operational tolerance.

### Where to Check
1. **External GitHub Actions Dashboard**: Check `.github/workflows/ingest.yml`. Verify the scheduled workflow executed successfully within the last 4 hours (cron: `0 */4 * * *`). Inspect shard job logs for non-dry upsert counts and per-source status.
2. **External Supabase Dashboard**: In the SQL Editor, execute:
   ```sql
   SELECT
     count(*) AS total_jobs,
     max(created_at) AS latest_created_at,
     max(posted_at) AS latest_posted_at
   FROM jobs;
   ```
   **Pass Condition**: Non-zero total jobs, `latest_posted_at` or recent shard report is within the 4-hour target (or within 24-hour tolerance).

### Remediation If Ingest Has Not Run Today
1. **Manual Workflow Dispatch**: In external GitHub Actions dashboard, navigate to `.github/workflows/ingest.yml`, click "Run workflow", select branch `main`, and run with default parameters (scheduled mode, 438 validated boards).
2. **Check Repository Secrets**: In GitHub repository Settings -> Secrets and variables -> Actions, verify that the following secrets are configured:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. **Inspect Failure Logs**: Review failed step logs in external GitHub Actions dashboard for HTTP 429 rate limits, network timeouts, or schema mismatches.

- **Live Status**: `UNVERIFIED (Not run)`

---

## 5. Scheduled Workflows (Cron Green Check)

Confirm that all scheduled background workflows have a recent green run in the external GitHub Actions dashboard prior to launch sign-off.

> [!WARNING]
> In GitHub Actions, **skipped workflow runs appear with grey/green indicators but are NOT passes**! Ensure that workflow jobs actually executed and steps succeeded.

| Workflow File | Schedule | Purpose & Verified Scope | Required Prerequisites / Inactive Guard | Where to Check | Live Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `.github/workflows/ingest.yml` | Every 4 hours (`0 */4 * * *`) | Scrapes 438 validated boards across shards and upserts fresh jobs into Supabase `jobs` table via `scripts/ingest.ts`. | Active by default with repo secrets. Target freshness: 4 hours (24h tolerance). | External GitHub Actions dashboard -> Workflows -> `ingest.yml`. | `UNVERIFIED (Not run)` |
| `.github/workflows/daily-digest-cron.yml` | Daily at 21:30 UTC / 03:00 AM IST (`30 21 * * *`) | Matches candidate preferences against fresh jobs and dispatches daily email digests. | Active by default with repo secrets. | External GitHub Actions dashboard -> Workflows -> `daily-digest-cron.yml`. | `UNVERIFIED (Not run)` |
| `.github/workflows/retention-cron.yml` | Weekly Sunday at 19:30 UTC (`30 19 * * 0`) | Purges old operational logs (`purge_operational_logs`), optional job archival (`archive_expired_jobs`), and optional index maintenance (`reindex_bloated_indexes`) via `scripts/retention-cron.ts`. **Does NOT prune user sessions.** | Requires migration 20261106a. Default manual dispatch runs with `--dry`. | External GitHub Actions dashboard -> Workflows -> `retention-cron.yml`. | `UNVERIFIED (Not run)` |
| `.github/workflows/db-reconciliation.yml` | Weekly Monday at 03:27 UTC (`27 3 * * 1`) | Audits database referential integrity, orphan records, and foreign key relations. | **Inert unless `vars.DB_RECONCILIATION_ENABLED == 'true'`** or manually dispatched via `workflow_dispatch`. Skipped run is not a pass. | External GitHub Actions dashboard -> Workflows -> `db-reconciliation.yml`. | `UNVERIFIED (Not run)` |
| `.github/workflows/db-health-probe.yml` | Weekly Monday at 02:13 UTC (`13 2 * * 1`) | Checks Postgres pool health, query latency, and database connection capacity. | **Inert unless `vars.DB_HEALTH_PROBE_ENABLED == 'true'`** (even on manual dispatch!) plus migration and secrets. Skipped run is not a pass. | External GitHub Actions dashboard -> Workflows -> `db-health-probe.yml`. | `UNVERIFIED (Not run)` |
| `.github/workflows/workflow-failure-alert.yml` | Automated on `workflow_run` failure | Listens for failed scheduled workflows and dispatches incident alert notifications. | Active on `workflow_run` failure. | External GitHub Actions dashboard -> Workflows -> `workflow-failure-alert.yml`. | `UNVERIFIED (Not run)` |

---

## 6. Rollback Procedures & Decision Rules

If a blocking defect is discovered during release smoke verification, execute platform rollbacks immediately.

> [!CAUTION]
> **Code/UI Rollback != Database Rollback**:
> - Rolling back a deployment in Cloudflare Pages or Netlify reverts frontend static assets and serverless function code, but **does not revert the database schema or data**.
> - Automated down-migrations do **NOT** exist in the repository (`supabase/migrations/` contains forward-only DDL).
> - Any database schema compensation, backup restoration, or Point-In-Time Recovery (PITR) is strictly gated on:
>   1. **Explicit owner approval**.
>   2. **A verified recovery route** (referencing `docs/disaster-recovery.md` and pending `docs/ops-runbook.md`).
>   3. **A verified restore point / backup snapshot**.
> - Do not claim instant or 15-second propagation; rollback availability depends on CDN cache purges and edge network distribution.

### Platform-Specific Rollback Steps

1. **Cloudflare Pages (Primary Production Host)**:
   - Rolling back Netlify does **NOT** fix a failing Cloudflare Pages deployment!
   - Open external Cloudflare Pages dashboard (`https://dash.cloudflare.com/?to=/5046ad59f83225dfa6727be1cb18965e/pages/view/carrier-hound`).
   - Navigate to the **Deployments** tab.
   - Locate the previous known-good deployment matching the prior green `main` commit.
   - Click the options menu (`...`) and select **"Rollback to this deployment"**.
   - Edge routes and pages switch to the previous build once edge propagation completes.

2. **Netlify (Backup Host / Secondary)**:
   - If traffic has been failed over to Netlify via DNS cutover (see `docs/dns-cutover-runbook.md`), roll back in Netlify:
   - Open external Netlify dashboard (`https://app.netlify.com/projects/careermonke12/deploys`).
   - Locate the previous successful production deployment.
   - Click into deploy details and select **"Publish deploy"**.

3. **Supabase Database Incident Protocol**:
   - **Gated on Owner Approval**: Never execute destructive SQL or restore commands without explicit owner authorization.
   - If an unrecoverable database corruption occurred:
     - Open external Supabase dashboard -> Settings -> Database -> Backups.
     - Review available daily backups and PITR recovery points with the project owner.
     - Formulate a tested forward-fix migration or execute an owner-authorized recovery procedure.

### Decision Rule: Rollback vs Fix-Forward

- **TRIGGER IMMEDIATE DEPLOYMENT ROLLBACK IF**:
  - Authentication failure: Users cannot log in or authenticate across `/signup`, `/login`, or `/auth/callback`.
  - Edge routing failure: Primary host returns HTTP 5xx on `/api/health`, `/jobs`, or core pages.
  - Data corruption: Application writes corrupted records to Supabase tables.
  - Security / Privacy leak: Session cross-contamination or unauthorized access.
- **FIX-FORWARD (DO NOT ROLLBACK) IF**:
  - Non-critical CSS alignment or minor visual presentation issue.
  - Minor copy or typo in static landing content.
  - Isolated third-party board fetch timeout in a single ingest shard that does not impact global job serving.

---

## 7. Sign-off Block

Fill out the verification table and sign off prior to announcing release availability. All items are currently unverified.

- **Verification Date**: `YYYY-MM-DD`
- **Deployed Commit SHA**: `________________________________________` (Full 40-character SHA)
- **Verified By**: `____________________` (Operator Name / Handle)
- **Target Environment**: Production (`https://careermonke.com`)

| Smoke Item | Route / Component | Result | Notes |
| :--- | :--- | :--- | :--- |
| **1. Deploy Identity** | Netlify / Cloudflare / `src/app/api/health/route.ts` | `[ ] UNVERIFIED (Not run)` | Verify SHA matches `origin/main` |
| **2. Landing Page** | `/` | `[ ] UNVERIFIED (Not run)` | Verify rendered without hydration error |
| **3. Auth & Callback** | `/signup`, `/login`, `/auth/callback` | `[ ] UNVERIFIED (Not run)` | Verify OTP/magic link & 30s resend cooldown |
| **4. Onboarding Flow** | `/onboarding` | `[ ] UNVERIFIED (Not run)` | Known gap documented; verify completion writes prefs |
| **5. Free User Gating** | `/resume`, `/tracker`, `src/components/billing/ProUpgradeScreen.tsx` | `[ ] UNVERIFIED (Not run)` | Verify ProUpgradeScreen gating on free account |
| **6. Pro Features** | `/resume`, `/tracker`, `src/components/resume/ResumeUploadAndConfirm.tsx` | `[ ] UNVERIFIED (Not run)` | Verify resume parse & tracker on entitled test account |
| **7. Jobs Feed** | `/jobs` | `[ ] UNVERIFIED (Not run)` | Verify live jobs display with visible posted dates |
| **8. Job Detail** | `/jobs/detail` | `[ ] UNVERIFIED (Not run)` | Verify job description and apply link work |
| **9. Settings** | `/settings` | `[ ] UNVERIFIED (Not run)` | Verify preferences updated and persisted |
| **10. Payments OFF** | `netlify/functions/billing-razorpay-webhook.ts` | `[ ] UNVERIFIED (Not run)` | Verify HTTP 503 & before/after zero Razorpay delta |
| **11. Ingest Health** | `.github/workflows/ingest.yml` | `[ ] UNVERIFIED (Not run)` | Verify run reports & DB records within 4h (24h tol) |
| **12. Cron Workflows** | Scheduled workflows in .github/workflows/ (ingest, digest, retention, db-reconciliation, db-health-probe) | `[ ] UNVERIFIED (Not run)` | Verify actual green runs (not skipped) & prerequisites |

### Overall Release Verdict
- [ ] **GO (Release Approved)**
- [ ] **NO-GO (Rolled Back to Previous Commit)**

**Operator Signature**: `_____________________________________`
