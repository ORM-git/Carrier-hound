Run check: node scripts/check-release-smoke.cjs

# Production Release Smoke Checklist (15-Minute Launch Runbook)

> **Purpose**: This runbook enables the owner or release engineer to verify a production deploy end-to-end within 15 minutes. Every referenced route, script, workflow, and config matches actual repository code in `main`.
>
> **Execution Cadence**: Run immediately following any production deployment to Netlify or Cloudflare Pages.
>
> **Offline Validation**: Run `node scripts/check-release-smoke.cjs` to confirm that this checklist has not drifted from repository assets.

---

## 1. Deploy Identity Verification

Confirm that deployed running instances match the intended git commit SHA on `main`.

| Platform / Target | Verification Method | Pass Criteria | Log / Dashboard on Failure |
| :--- | :--- | :--- | :--- |
| **Netlify Frontend & Functions** | Open external Netlify dashboard (`https://app.netlify.com/projects/careermonke12/deploys`) | Active production deploy shows status `Published` and commit SHA equals target `origin/main` SHA. | External Netlify dashboard -> Deploys -> Deploy Log. |
| **Cloudflare Pages** | Open external Cloudflare Pages dashboard (`https://dash.cloudflare.com/?to=/5046ad59f83225dfa6727be1cb18965e/pages/view/carrier-hound`) | Active deployment shows status `Success` and commit SHA equals target `origin/main` SHA. | External Cloudflare Pages dashboard -> Deployments -> View Build Log. |
| **Health Liveness Probe** | Request `GET https://careermonke.com/api/health` | HTTP 200 with JSON payload `{"status":"ok"}` and response headers `Cache-Control: no-store, no-cache, must-revalidate` (`src/app/api/health/route.ts`). | External Cloudflare Pages dashboard (edge route logs) or external Sentry dashboard. |
| **Netlify Function Health** | Request `GET https://careermonke.com/.netlify/functions/health` | HTTP 200 with JSON payload `{"ok":true,"time":"..."}` (`netlify/functions/health.ts`). | External Netlify dashboard -> Functions -> `health` invocation logs. |
| **Automated Smoke Suite** | Run `npx tsx scripts/smoke-post-deploy.ts` (executes checks from `src/lib/monitoring/smokeChecks.ts`) | Script exits with status 0, reporting all smoke checks passed against the production domain. | Shell console stdout / stderr. |
| **GitHub Actions CI** | Open external GitHub Actions dashboard for `.github/workflows/ci.yml` | Workflow run for target `main` SHA completed with green checkmarks across all test, lint, and typecheck jobs. | External GitHub Actions dashboard -> CI run logs. |

---

## 2. Core Flows Verification (In Order)

Verify the end-to-end applicant journey in strict sequential order.

### Step 2.1: Landing Page
- **Exact Path**: `/`
- **Pass Criteria**: Homepage loads in < 1.5 seconds. Hero header, interactive demo previews, value propositions, and navigation links render with zero hydration warnings. "Sign In" and "Get Started" buttons are clickable.
- **Single Dashboard on Failure**: External Sentry dashboard (filter by `transaction:/` or `tag:handled:false` for client hydration and rendering exceptions).

### Step 2.2: Signup & Authentication (Real Auth in Code)
- **Exact Paths**: `/signup` and `/login`
- **Authentication Method (Code Verified)**: CareerMonke authentication is passwordless via Supabase Auth (`src/app/signup/page.tsx`, `src/app/login/page.tsx`, and `src/app/auth/callback/page.tsx`). It uses Magic Link / Email OTP (`supabase.auth.signInWithOtp`) and Google OAuth (`supabase.auth.signInWithOAuth`). Passwords do not exist in the codebase.
- **Pass Criteria**:
  1. Navigate to `/signup` or `/login`.
  2. Enter a valid test email address and submit.
  3. UI transitions smoothly to "Check your email" confirmation screen with a visible 60-second resend cooldown timer.
  4. Follow the magic link from email or complete callback exchange at `/auth/callback?returnTo=/onboarding`.
  5. User session initializes and client redirects to `/onboarding` for new users or `/jobs` for existing users.
- **Single Dashboard on Failure**: External Supabase dashboard -> Authentication -> Users & Logs (inspect Auth logs for rate limits, SMTP delivery errors, or redirect URL mismatches).

### Step 2.3: Onboarding (Asked Once Only)
- **Exact Path**: `/onboarding` (`src/app/onboarding/page.tsx`)
- **Pass Criteria**:
  1. Complete the multi-step questionnaire: Role selection, Experience level, Work model (Remote/Hybrid/Onsite), Preferred countries, and Job types.
  2. Submitting final preferences writes `onboardingCompleted: true` to the `user_preferences` table.
  3. Page redirects automatically to `/jobs`.
  4. **Once-Only Enforcement**: Manually navigate back to `/onboarding` in the browser URL bar. The page detects `onboardingCompleted: true` and immediately redirects to `/jobs` (or `/dashboard`), proving the questionnaire is never re-prompted.
- **Single Dashboard on Failure**: External Supabase dashboard -> Table Editor -> `user_preferences` (verify the user's row exists with `onboarding_completed: true`).

### Step 2.4: Resume Upload & Parsing
- **Exact Path**: `/resume` (`src/app/resume/page.tsx`)
- **Component**: `src/components/resume/ResumeUploadAndConfirm.tsx`
- **Pass Criteria**:
  1. Upload a sample PDF or DOCX resume via file picker or drag-and-drop.
  2. Parsing indicator runs without client-side timeout or unhandled exceptions.
  3. Extracted fields (candidate name, email, target title, detected skills, work history) populate the confirmation card.
  4. Click "Confirm & Save Profile". Profile persists to local/remote profile storage (`src/lib/resume/storage.ts`) and success toast appears.
- **Single Dashboard on Failure**: External Sentry dashboard (filter by `logger:resume.parser` or unhandled exceptions in `src/lib/resume/parser.ts`).

### Step 2.5: Jobs Feed (Real Jobs with Visible Posted Dates)
- **Exact Path**: `/jobs` (`src/app/jobs/page.tsx`)
- **Pass Criteria**:
  1. Jobs feed renders real scraped jobs from the Supabase `jobs` table (no mock fallback cards).
  2. Each job card clearly displays company name, title, location, work model badge, and the visible posted date (`posted_at`, e.g. "Posted 3h ago" or "Nov 13, 2026").
  3. Match score badge calculates and displays based on the confirmed candidate profile.
  4. Applying filters (e.g. Remote filter or Role search) updates the visible job list responsively without errors.
- **Single Dashboard on Failure**: External Supabase dashboard -> SQL Editor (run `SELECT count(*), max(posted_at) FROM jobs;` to verify live rows exist and query latency is normal).

### Step 2.6: Job Detail View
- **Exact Paths**: `/jobs/detail` or selecting a job card on `/jobs` (`src/app/jobs/detail/page.tsx`, `src/components/jobs/JobDetailView.tsx`)
- **Pass Criteria**:
  1. Full job description, requirements, company summary, and metadata render properly formatted.
  2. External "Apply on Company Site" button contains a valid outbound applicant tracking URL.
  3. Experimental feature surfaces (`NEXT_PUBLIC_ENABLE_INTERVIEW_PACK` and `NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF` in `src/lib/flags/flags.ts`) remain disabled or hidden according to launch flag defaults.
- **Single Dashboard on Failure**: External Sentry dashboard (check for edge errors or sanitization issues in job description rendering).

### Step 2.7: Save & Track Application
- **Exact Path**: `/tracker` (`src/app/tracker/page.tsx`)
- **Pass Criteria**:
  1. From a job card or detail view, click "Save" or "Track Job".
  2. Navigate to `/tracker`. The saved job appears in the "Saved" column of the application pipeline.
  3. Drag or update stage to "Applied". The application stage updates immediately and persists across page reloads via `src/lib/tracker/storage.ts`.
- **Single Dashboard on Failure**: External Supabase dashboard -> Table Editor -> `applications` or `job_tracker` table.

### Step 2.8: User Settings
- **Exact Path**: `/settings` (`src/app/settings/page.tsx`)
- **Pass Criteria**:
  1. Settings page displays account email, saved preferences, notification options, and daily digest opt-in.
  2. Toggle a preference (e.g., Daily Digest toggle) and click "Save Preferences".
  3. Confirmation toast appears and preference persists upon page refresh.
- **Single Dashboard on Failure**: External Supabase dashboard -> Table Editor -> `user_preferences`.

---

## 3. Payments OFF State Verification

CareerMonke launches with payments strictly **OFF** (`NEXT_PUBLIC_BILLING_ENABLED=false` configured in `src/lib/flags/flags.ts`).

| Verification Item | Test Procedure | Expected Response / State | Dashboard / Tool to Verify |
| :--- | :--- | :--- | :--- |
| **No Paid Checkout Reachable** | Click any Pro upgrade CTA across `/jobs`, `/resume`, or `/settings`. | Modal displays launch/free access message or remains hidden. No Razorpay payment iframe opens. | Browser dev tools Network tab (0 requests to `api.razorpay.com`). |
| **Razorpay Webhook Returns 503** | Send `POST https://careermonke.com/.netlify/functions/billing-razorpay-webhook` | HTTP 503 with body `{"error":"Billing is currently unavailable","code":"BILLING_DISABLED"}` (`netlify/functions/billing-razorpay-webhook.ts`). | External Netlify dashboard -> Functions -> `billing-razorpay-webhook`. |
| **Billing Order API Returns 503** | Send `POST https://careermonke.com/api/billing/razorpay/order` with header `Authorization: Bearer <token>` | HTTP 503 with body `{"error":"Billing is currently unavailable","code":"BILLING_DISABLED"}` (`src/app/api/billing/razorpay/order/route.ts`). | External Cloudflare Pages dashboard -> Functions logs. |
| **Billing Verify API Returns 503** | Send `POST https://careermonke.com/api/billing/razorpay/verify` with header `Authorization: Bearer <token>` | HTTP 503 with body `{"error":"Billing is currently unavailable","code":"BILLING_DISABLED"}` (`src/app/api/billing/razorpay/verify/route.ts`). | External Cloudflare Pages dashboard -> Functions logs. |
| **Zero Live or Test Charges** | Check external Razorpay dashboard (`https://dashboard.razorpay.com`) | 0 payments processed, 0 orders created, 0 active subscriptions on launch day. | External Razorpay dashboard -> Payments & Orders. |

---

## 4. Ingest Health Verification

Verify that job ingestion is healthy and fresh jobs have landed today.

### Where to Check
1. **External GitHub Actions Dashboard**: Check `.github/workflows/ingest.yml`. Verify the workflow executed successfully within the last 4 hours (scheduled cron: `0 */4 * * *`).
2. **External Supabase Dashboard**: In the SQL Editor, execute:
   ```sql
   SELECT
     count(*) AS total_jobs,
     max(created_at) AS latest_created_at,
     max(posted_at) AS latest_posted_at
   FROM jobs;
   ```
   **Pass Condition**: `latest_created_at` timestamp is within the last 4 hours (or at least within the last 24 hours), and `total_jobs` is non-zero.

### Remediation If Ingest Has Not Run Today
1. **Manual Workflow Dispatch**: In external GitHub Actions dashboard, navigate to `.github/workflows/ingest.yml`, click "Run workflow", select branch `main`, and run with default parameters (scheduled mode, 438 validated boards).
2. **Check Repository Secrets**: In GitHub repository Settings -> Secrets and variables -> Actions, verify that the following secrets are configured:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GREENHOUSE_API_KEY` (if required for partner boards)
3. **Inspect Failure Logs**: Review failed job step logs in external GitHub Actions dashboard for HTTP 429 rate limits, network timeouts, or schema mismatches.

---

## 5. Scheduled Workflows (Cron Green Check)

Confirm that all scheduled background workflows have a recent green run in the external GitHub Actions dashboard prior to launch sign-off.

| Workflow File | Schedule | Purpose | Where to Check |
| :--- | :--- | :--- | :--- |
| `.github/workflows/ingest.yml` | Every 4 hours (`0 */4 * * *`) | Scrapes 438 validated boards across shards and upserts fresh jobs into Supabase `jobs` table. | External GitHub Actions dashboard -> Workflows -> `ingest.yml`. |
| `.github/workflows/daily-digest-cron.yml` | Daily at 21:30 UTC / 03:00 AM IST (`30 21 * * *`) | Matches candidate preferences against fresh jobs and generates daily email digests. | External GitHub Actions dashboard -> Workflows -> `daily-digest-cron.yml`. |
| `.github/workflows/retention-cron.yml` | Weekly Sunday at 19:30 UTC (`30 19 * * 0`) | Prunes expired sessions, audit logs, and stale job postings per data retention policies. | External GitHub Actions dashboard -> Workflows -> `retention-cron.yml`. |
| `.github/workflows/db-reconciliation.yml` | Weekly Monday at 03:27 UTC (`27 3 * * 1`) | Audits database referential integrity, orphan records, and foreign key relations. | External GitHub Actions dashboard -> Workflows -> `db-reconciliation.yml`. |
| `.github/workflows/db-health-probe.yml` | Weekly Monday at 02:13 UTC (`13 2 * * 1`) | Checks Postgres pool health, query latency, and database connection capacity. | External GitHub Actions dashboard -> Workflows -> `db-health-probe.yml`. |
| `.github/workflows/workflow-failure-alert.yml` | Automated on `workflow_run` failure | Listens for failed scheduled workflows and dispatches incident alert notifications. | External GitHub Actions dashboard -> Workflows -> `workflow-failure-alert.yml`. |

---

## 6. Rollback Procedures & Decision Rules

If any blocking defect is discovered during the 15-minute smoke verification, execute platform rollbacks immediately.

### Rollback Steps by Platform

1. **Netlify Frontend & Functions**:
   - Open external Netlify dashboard (`https://app.netlify.com/projects/careermonke12/deploys`).
   - Locate the previous successful production deployment (matching the prior green `main` commit).
   - Click into the deploy details and select **"Publish deploy"**.
   - Rollback is effective globally within ~15 seconds.

2. **Cloudflare Pages**:
   - Open external Cloudflare Pages dashboard (`https://dash.cloudflare.com/?to=/5046ad59f83225dfa6727be1cb18965e/pages/view/carrier-hound`).
   - Navigate to the **Deployments** tab.
   - Find the previous known-good deployment, click the menu options (`...`), and select **"Rollback to this deployment"**.
   - Edge routing switches instantly to the previous build.

3. **Supabase Database & Migrations**:
   - If a breaking schema change was deployed, inspect the down-migration scripts under `supabase/migrations/` and apply the compensating SQL in the external Supabase dashboard SQL Editor.
   - If severe relational corruption or accidental data loss occurred, navigate to external Supabase dashboard -> Settings -> Database -> Backups and trigger Point-In-Time Recovery (PITR) to a timestamp immediately prior to deployment.
   - For disaster recovery details, reference `docs/disaster-recovery.md` and see `docs/ops-runbook.md` once #591 merges.

### Decision Rule: Rollback vs Fix-Forward

- **TRIGGER IMMEDIATE ROLLBACK IF**:
  - Authentication failure: Users cannot log in, request OTP/magic links, or access authenticated routes.
  - Data corruption: Ingest or profile operations overwrite, corrupt, or drop database records.
  - Security / Privacy incident: User data is cross-contaminated or exposed across sessions.
  - Widespread outage: HTTP 5xx error rate exceeds 1% on `/api/health`, `/jobs`, or core pages.
- **FIX-FORWARD (DO NOT ROLLBACK) IF**:
  - Non-critical visual layout or CSS styling alignment defect.
  - Minor copy or typo in marketing/landing content.
  - Isolated third-party API rate-limiting on a single job board source that does not affect overall job serving.

---

## 7. Sign-off Block

Fill out the verification table and sign off prior to announcing release availability.

- **Verification Date**: `YYYY-MM-DD`
- **Deployed Commit SHA**: `________________________________________` (Full 40-character SHA)
- **Verified By**: `____________________` (Operator Name / Handle)
- **Target Environment**: Production (`https://careermonke.com`)

| Smoke Item | Route / Component | Result (PASS / FAIL) | Tester Notes |
| :--- | :--- | :--- | :--- |
| **1. Deploy Identity** | Netlify / Cloudflare / `src/app/api/health/route.ts` | `[  ]` | SHA matches `origin/main` |
| **2. Landing Page** | `/` | `[  ]` | Rendered without hydration error |
| **3. Auth & Callback** | `/signup`, `/login`, `/auth/callback` | `[  ]` | OTP/Magic link received & logged in |
| **4. Onboarding Flow** | `/onboarding` | `[  ]` | Completed once, redirects on revisit |
| **5. Resume Parse** | `/resume`, `src/components/resume/ResumeUploadAndConfirm.tsx` | `[  ]` | Sample resume parsed and saved |
| **6. Jobs Feed** | `/jobs` | `[  ]` | Live jobs display with visible posted dates |
| **7. Job Detail** | `/jobs/detail` | `[  ]` | Job description and apply link work |
| **8. Tracker** | `/tracker` | `[  ]` | Job saved and moved to applied stage |
| **9. Settings** | `/settings` | `[  ]` | Preferences updated and persisted |
| **10. Payments OFF** | `netlify/functions/billing-razorpay-webhook.ts` | `[  ]` | Returns HTTP 503 `BILLING_DISABLED` |
| **11. Ingest Health** | `.github/workflows/ingest.yml` | `[  ]` | Supabase `jobs` has fresh records |
| **12. Cron Workflows** | Scheduled workflows in `.github/workflows/` | `[  ]` | Recent green runs verified |

### Overall Release Verdict
- [ ] **GO (Release Approved)**
- [ ] **NO-GO (Rolled Back to Previous Commit)**

**Operator Signature**: `_____________________________________`
