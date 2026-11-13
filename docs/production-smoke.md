# Production Smoke Probe: Automated Post-Deploy Verification

> **Probe Script**: `scripts/smoke-production.cjs`  
> **Offline Test Suite**: `scripts/test-smoke-production.cjs`  
> **Execution Command**: `node scripts/smoke-production.cjs [baseUrl] [--json] [--sha <commit>]`  
> **Design Philosophy**: Standalone, read-only, zero dependencies, polite sequential requests.

---

## 1. Purpose & Scope

The manual release checklist (`docs/release-smoke-checklist.md` - *Pending in-flight PR #595*) provides a comprehensive 15-minute human walkthrough for production launches. The automated post-deploy smoke probe (`scripts/smoke-production.cjs`) complements it as a rapid, one-command health verifier that engineers can run immediately after each production deploy, during deployment canary monitoring, or following an incident rollback.

### Scope & Verification Limits
The smoke probe performs basic HTTP and structural assertions against edge routing and shell delivery:
- **Shell-Only Checks**: Checks for `/`, `/jobs`, and `/login` assert the presence of server-rendered HTML shells, route-specific markup, and distinct content bodies. They **do not** prove client-side React hydration, live data fetching in mounted components, or client-side interactivity.
- **Readiness Scope**: `/api/health/ready` verifies that environment variables are populated and executes a **single anonymous read query** on `jobs_public`. It does not prove authenticated access, write permissions, or background worker health.
- **Billing Scope**: The probe dispatches a non-wallet-bearing probe (unauthenticated empty POST `{}`) to `/api/billing/razorpay/order`. It passes **only** if the endpoint returns HTTP 503 with `BILLING_DISABLED`. Any other response (such as 401 auth challenge, 403 early-access intercept, 404, or 405) is marked `NOT VERIFIED / inconclusive` (FAIL), because those statuses cannot prove that order creation is disabled.
- **Not a Launch Sign-Off**: The probe provides partial automated verification; it does not replace end-to-end human verification or constitute launch sign-off.

---

## 2. When to Run the Smoke Probe

1. **Immediately After Every Production Deployment**:
   - Run against `https://careermonke.com` (or preview domain `https://carrier-hound.pages.dev`) as soon as the edge build finishes.
   - Catches edge routing regressions, misconfigured environment variables, or broken SSR bundles before user traffic encounters them.

2. **Pre-Launch Canary Verification**:
   - Run with `--json` and `--sha <commit>` to record dated local evidence in `reports/smoke/` tied to the deployed commit SHA.

3. **Following Rollback or Host Failover**:
   - Run after a Cloudflare Pages rollback or DNS failover to the Netlify backup host (`docs/ops-runbook.md#web-deployment-rollback` - *Pending in-flight PR #593*).
   - Confirms that the target host is reachable, serving valid shells, and communicating with Supabase.

---

## 3. Usage & Command Reference

### Standard Production Verification
```bash
node scripts/smoke-production.cjs https://careermonke.com
```

### Recording Dated Local Evidence (with Deployment SHA)
```bash
node scripts/smoke-production.cjs https://careermonke.com --json --sha $(git rev-parse HEAD)
```
Appends a dated result line to `reports/smoke/smoke-YYYY-MM-DD.jsonl` recording:
- Timestamp (ISO 8601)
- Target URL
- Deployment SHA (for commit identity)
- Pass/Fail summary and per-check latencies, status codes, and diagnostic details.

### Testing Preview Deployments or Staging
```bash
# Cloudflare Pages staging deploy
node scripts/smoke-production.cjs https://carrier-hound.pages.dev

# Netlify backup host
node scripts/smoke-production.cjs https://careermonke12.netlify.app
```

### Running the Offline Test Suite
The probe includes an offline fixture test suite using a local HTTP mock server to verify error handling, timeouts, redirects, soft-404 detection, and negative controls:
```bash
node scripts/test-smoke-production.cjs
```

---

## 4. What Each Check Proves & Evaluates

| # | Check Name | Target Route | Method | Expected Result | What It Proves (Honest Scope) |
| :-: | :--- | :--- | :-: | :--- | :--- |
| **1** | **Homepage** | `/` | `GET` | HTTP 200, valid `<html>` root, `<main>` container, CareerMonke branding, length > 500 B | **Shell-only check**: Proves edge routing and root layout server-rendered HTML delivery without 5xx errors or crash screens. Does not evaluate client hydration. |
| **2** | **Readiness Probe** | `/api/health/ready` | `GET` | HTTP 200, JSON `{ status: "ready", checks: { env: "ok", database: "ok" } }` | **Shallow read probe**: Verifies edge functions have database credentials and successfully executes a single anonymous `SELECT` on `jobs_public`. Proves nothing beyond this single query. |
| **3** | **Public Jobs Feed** | `/jobs` | `GET` | HTTP 200, distinct body, jobs directory structural markup (`jobs-skeleton-list`, `JobFilterBar`, or `jobs-main-content`) | **Shell-only check**: Proves the applicant directory shell renders and is not gated behind early-access redirects (`HTTP 307`). Fails if identical generic fallback HTML is served. Does not prove hydration or populated feed data. |
| **4** | **Auth Entry Page** | `/login` | `GET` | HTTP 200, distinct body, email input and auth action elements (`Sign in`, `Log in`, `Magic link`, or `Google`) | **Shell-only check**: Proves login shell renders without crashing and serves distinct markup. Does not prove auth service readiness or email delivery. |
| **5** | **Payments-OFF Gate** | `/api/billing/razorpay/order` | `POST` (`{}`) | HTTP 503 with code `BILLING_DISABLED` | **Non-wallet-bearing probe**: Verifies that the order creation endpoint explicitly rejects requests with HTTP 503 and `BILLING_DISABLED`. Any other code (401, 403, 404, 405, 3xx) is flagged `NOT VERIFIED / inconclusive` (FAIL). |

---

## 5. Safeguards & Resilience Architecture

The smoke probe is built with strict operational safeguards to protect production services and prevent false passes:

1. **Overall Wall-Clock Abort Deadline**:
   - Caps total execution time at 25 seconds (`WALL_CLOCK_TIMEOUT_MS = 25000`, configurable via `--wall-timeout <ms>`).
   - If cumulative latency exceeds the deadline, subsequent requests are aborted immediately, preventing stuck runs.

2. **Per-Request Timeout Guard**:
   - Each request has a strict 6-second timeout (`PER_REQUEST_TIMEOUT_MS = 6000`, configurable via `--timeout <ms>`).

3. **Response Body Size Cap**:
   - Limits response streams to 512 KB (`MAX_BODY_BYTES = 524288`).
   - If an endpoint streams excessive data, the connection is aborted with an error, protecting client memory.

4. **Cross-Route Generic Fallback Fingerprinting**:
   - Generates a SHA-256 fingerprint of normalized response bodies.
   - If `/jobs` or `/login` returns the same generic fallback body as `/`, the probe fails immediately, catching broken Single Page Application fallback routing.

5. **Soft-404 and Error Body Detection**:
   - Scans 200 OK responses for known soft-404 markers, client-side exception notices, and server error headers.

6. **Sequential & Polite Execution**:
   - Probes one endpoint at a time with polite User-Agent headers. Zero concurrency, zero hammering, and zero retries.

---

## 6. First Response Per Failure (Ops Runbook Pointers)

If any check reports `[FAIL]`, the script exits with non-zero status (`1`). Consult `docs/ops-runbook.md` (*Pending in-flight PR #593*) for remediation procedures:

### Check 1 Fails: Homepage Down / Error State
- **Runbook Ref**: `docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages` (*Pending PR #593*).
- **First Response**:
  1. Check Cloudflare Pages Dashboard -> `carrier-hound` -> View Deploy Log for the failing commit.
  2. If edge bundle is broken, trigger 1-click rollback in Cloudflare Pages dashboard.
  3. If Cloudflare edge network is degraded, evaluate initiating DNS failover to the Netlify backup host.

### Check 2 Fails: Readiness Probe Unhealthy (`/api/health/ready`)
- **Runbook Ref**: `docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages` and `#5-environment-variables--secrets-reference` (*Pending PR #593*).
- **First Response**:
  1. Inspect response JSON payload:
     - `checks.env: "fail"`: Verify `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in deployment environment settings.
     - `checks.database: "fail"`: Check Supabase status at `https://status.supabase.com` and review connection pool metrics in Supabase Dashboard.
  2. Execute read-only diagnostic query in Supabase SQL editor: `SELECT count(*) FROM jobs_public;`.

### Check 3 Fails: Public Jobs Feed Inaccessible (`/jobs`)
- **Runbook Ref**: `docs/ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs` (*Pending PR #593*).
- **First Response**:
  1. If status is `307` redirecting to `/early-access`: Confirm whether the launch flag lifting early-access gating has been merged and deployed.
  2. If status is `5xx` or body missing structure: Check build output and verify `jobs_public` view accessibility.

### Check 4 Fails: Auth Entry Page Down (`/login`)
- **Runbook Ref**: `docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages` (*Pending PR #593*).
- **First Response**:
  1. Check Supabase Auth service health.
  2. Verify URL Configuration in Supabase Dashboard: ensure redirect URLs include `https://careermonke.com/auth/callback`.

### Check 5 Fails: Payments-OFF Gate Not Verified / Live Checkout Active
- **Runbook Ref**: `docs/ops-runbook.md#scenario-c-payment-webhooks-failing-subscriptions-not-activating` (*Pending PR #593*).
- **First Response**:
  1. If status is `200` or `201`: **P0 Alert** - live checkout creation is responding when payments must remain OFF. Immediately ensure `NEXT_PUBLIC_BILLING_ENABLED=false` and redeploy.
  2. If status is `401`, `403`, `404`, or `405`: Check why the request was intercepted before reaching the billing gate (e.g. middleware or routing). The probe requires an explicit `503 BILLING_DISABLED` response to prove payments are safely gated.

---

## 7. Current Production Baseline (Partial Probe Output)

When executed against current live production (`https://careermonke.com`), the probe outputs:
```text
[PASS] 1. Homepage (/)                                       687ms  HTTP 200 OK (shell rendered, 68783 bytes)
       (Shell-only check: verifies root layout and branding HTML shell)
[PASS] 2. Readiness Probe (/api/health/ready)                701ms  HTTP 200 OK (ready: env=ok, database=ok; single jobs_public select verified)
       (Shallow read probe: verifies single anonymous select on jobs_public)
[FAIL] 3. Public Jobs Feed (/jobs)                           179ms  Redirected to https://careermonke.com/early-access (early-access or auth redirect active; launch requires public 200)
       (Shell-only check: verifies jobs directory HTML shell (no claim of hydration or live feed))
[PASS] 4. Auth Entry Page (/login)                           193ms  HTTP 200 OK (login shell rendered, distinct body, 36212 bytes)
       (Shell-only check: verifies login gateway HTML shell (no claim of auth service readiness))
[FAIL] 5. Payments-OFF Gate (/api/billing/razorpay/order)    178ms  NOT VERIFIED / inconclusive: returned HTTP 403 ({"error":"Early access only"}); cannot prove payments disabled (requires exact 503 + BILLING_DISABLED)
       (Non-wallet-bearing probe: verifies exact 503 + BILLING_DISABLED)

SUMMARY: 3/5 checks passed against https://careermonke.com
VERDICT: FAIL (One or more smoke checks failed or inconclusive; see details above)
```

### Analysis of Current Live Results
- **Checks 1, 2, 4 Pass**: Homepage shell, anonymous database readiness, and login shell are healthy and responsive.
- **Check 3 Fails (Expected Pre-Launch)**: `/jobs` redirects to `/early-access` because the early-access middleware gate has not yet been lifted in production.
- **Check 5 Inconclusive (Expected Pre-Launch)**: The billing endpoint is intercepted by the early-access middleware returning HTTP 403 `{"error":"Early access only"}` before reaching the billing handler. As mandated by the probe's verification rules, HTTP 403 cannot prove POST billing is disabled; only an explicit `503 BILLING_DISABLED` response satisfies the probe.
- **Launch Day Transition**: Once early access is removed at launch, both `/jobs` and the payments gate will transition to public evaluation, allowing all 5 checks to verify successfully.
