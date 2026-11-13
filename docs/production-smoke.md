# Production Smoke Probe: Automated Post-Deploy Verification

> **Probe Script**: `scripts/smoke-production.cjs`  
> **Execution Command**: `node scripts/smoke-production.cjs [baseUrl] [--json]`  
> **Design Philosophy**: Standalone, read-only, zero dependencies, polite sequential requests.

---

## 1. Purpose & Overview

The release checklist (`docs/release-smoke-checklist.md`) provides a comprehensive 15-minute human walkthrough for first releases. The automated post-deploy smoke probe (`scripts/smoke-production.cjs`) complements it as a rapid, one-command health verifier that the site owner or engineer can run in seconds right after each production deploy, on launch morning, or following an incident rollback.

It executes five targeted checks against the target deployment, measuring latency, asserting correct HTTP status codes and response bodies, and verifying that payments remain safely disabled per launch-day policy.

---

## 2. When to Run the Smoke Probe

1. **Immediately After Every Production Deployment**:
   - Run against `https://careermonke.com` (or the primary Cloudflare Pages domain `https://carrier-hound.pages.dev`) as soon as the build finishes.
   - Catches edge routing regressions, environment variable misconfigurations, or broken SSR builds before user traffic encounters them.

2. **Launch Morning (Monday 16 Nov)**:
   - Run at launch hour with the `--json` flag to establish an immutable audit record in `reports/smoke/`.
   - Confirms that early-access gating has been cleanly lifted for public applicants while payments remain strictly OFF.

3. **Immediately After Any Incident Rollback or Host Failover**:
   - Run following a rollback in Cloudflare Pages or a DNS failover to the Netlify backup host (`docs/ops-runbook.md#web-deployment-rollback`).
   - Proves the rolled-back target is immediately alive, connected to Supabase, and serving valid HTML.

---

## 3. Usage & Command Reference

### Standard Production Run
```bash
node scripts/smoke-production.cjs https://careermonke.com
```

### Launch-Morning Audit Run (Writes Dated Record)
```bash
node scripts/smoke-production.cjs https://careermonke.com --json
```
Appends a dated result line to `reports/smoke/smoke-YYYY-MM-DD.jsonl` with full per-check latencies and statuses.

### Checking Preview Deployments or Staging
```bash
node scripts/smoke-production.cjs https://carrier-hound.pages.dev
# or Netlify backup deploy
node scripts/smoke-production.cjs https://careermonke12.netlify.app
```

---

## 4. What Each Check Proves

| # | Check Name | Target Route | Method | Expected Result | What It Proves |
| :-: | :--- | :--- | :-: | :--- | :--- |
| **1** | **Homepage** | `/` | `GET` | HTTP 200, contains `CareerMonke` app marker | Proves edge routing, Next.js server-rendered HTML engine, and core layout bundle are serving without 5xx errors or client-side crash pages. |
| **2** | **Readiness Probe** | `/api/health/ready` | `GET` | HTTP 200, JSON `{ status: "ready", checks: { env: "ok", database: "ok" } }` | Proves full-stack database and environment health. Verifies that edge functions have valid Supabase API credentials and can execute live SQL reads against `jobs_public`. |
| **3** | **Public Jobs Feed** | `/jobs` | `GET` | HTTP 200, contains job listing or skeleton feed markup | Proves the core applicant directory is accessible to public visitors. Catches regressions where pages return empty bodies, crash, or remain erroneously gated behind early-access redirects (`HTTP 307`). |
| **4** | **Auth Entry Page** | `/login` | `GET` | HTTP 200, contains authentication markers | Proves candidate authentication entry point is accessible and ready to receive magic-link and OAuth sign-in flows. |
| **5** | **Payments-OFF Gate** | `/api/billing/razorpay/order` | `GET` | Blocked status (HTTP 403, 404, 405, or 503; **NOT 200/201**) | **Negative Check**: Enforces the launch-day mandate that payments remain OFF. Proves that live checkout creation is blocked and cannot charge users or initiate live Razorpay transactions. |

---

## 5. First Response Per Failure (Ops Runbook Pointers)

If any check reports `[FAIL]`, the script exits with non-zero status (`1`). Follow these immediate first-response procedures:

### Check 1 Fails: Homepage Down / Error State
- **Ops Runbook Reference**: [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) and [`docs/ops-runbook.md#1-cloudflare-pages-rollback-primary-production-host`](docs/ops-runbook.md#1-cloudflare-pages-rollback-primary-production-host).
- **First Response**:
  1. Open Cloudflare Pages Dashboard -> `carrier-hound` -> View Deploy Log for the failing commit.
  2. If the build or edge bundle is broken, trigger an immediate **1-click rollback** to the last known good deployment in the Cloudflare dashboard.
  3. If Cloudflare edge is degraded, assess initiating temporary DNS failover to the Netlify backup host (`docs/ops-runbook.md#3-host-failover--dns-cutover`).

### Check 2 Fails: Readiness Probe Unhealthy (`/api/health/ready`)
- **Ops Runbook Reference**: [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) and [`docs/ops-runbook.md#5-environment-variables--secrets-reference`](docs/ops-runbook.md#5-environment-variables--secrets-reference).
- **First Response**:
  1. Inspect the response payload:
     - If `checks.env: "fail"`: Verify `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Cloudflare Pages -> Settings -> Environment Variables.
     - If `checks.database: "fail"`: Check Supabase project status at `https://status.supabase.com` and open the Supabase Dashboard -> Database -> Connection Pooler to inspect active connections and pool exhaustion.
  2. Run the read-only DB diagnostic query from `docs/ops-runbook.md#database-migrations-procedure` in Supabase SQL editor to verify table health.

### Check 3 Fails: Public Jobs Feed Inaccessible (`/jobs`)
- **Ops Runbook Reference**: [`docs/ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs`](docs/ops-runbook.md#scenario-b-ingest-pipeline-stalled-zero-new-jobs) and [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages).
- **First Response**:
  1. If status is `307` redirecting to `/early-access`: Confirm whether the launch flag removing early access has been enabled and deployed.
  2. If status is `5xx` or body is empty: Verify in Supabase SQL editor that `jobs_public` view exists and is populated (`SELECT count(*) FROM jobs_public;`).
  3. Check ingest pipeline status in GitHub Actions (`.github/workflows/ingest.yml`).

### Check 4 Fails: Auth Entry Page Down (`/login`)
- **Ops Runbook Reference**: [`docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages`](docs/ops-runbook.md#scenario-a-site-down--5xx-spike-on-cloudflare-pages) and [`docs/ops-runbook.md#5-environment-variables--secrets-reference`](docs/ops-runbook.md#5-environment-variables--secrets-reference).
- **First Response**:
  1. Check Supabase Auth service status at `https://status.supabase.com`.
  2. Verify that Supabase Redirect URLs allow `https://careermonke.com/auth/callback` in Supabase Dashboard -> Authentication -> URL Configuration.
  3. Inspect edge logs in Cloudflare Pages dashboard for unhandled client bundle errors during auth module hydration.

### Check 5 Fails: Live Checkout Route Unexpectedly Reachable
- **Ops Runbook Reference**: [`docs/ops-runbook.md#scenario-c-payment-webhooks-failing-subscriptions-not-activating`](docs/ops-runbook.md#scenario-c-payment-webhooks-failing-subscriptions-not-activating) and [`docs/ops-runbook.md#5-environment-variables--secrets-reference`](docs/ops-runbook.md#5-environment-variables--secrets-reference).
- **First Response**:
  1. **CRITICAL POLICY BREACH**: Launch policy mandates that payments remain strictly OFF (`NEXT_PUBLIC_BILLING_ENABLED=false`).
  2. Immediately verify Cloudflare Pages dashboard -> Settings -> Environment Variables: ensure `NEXT_PUBLIC_BILLING_ENABLED` is set to `false`.
  3. Trigger an immediate redeployment or rollback to keep payments disabled.
  4. Open external Razorpay dashboard (`https://dashboard.razorpay.com`) to confirm zero live test charges or transactions have occurred.

---

## 6. Safety & Politeness Architecture

The smoke probe is built with strict operational safeguards:
- **Polite Execution**: Requests are executed sequentially with a single request per endpoint; it never parallelizes or hammers production servers.
- **Strict Short Timeout**: Requests time out after 8,000ms to avoid blocking CI runners or hang conditions.
- **Zero Retries**: It does not retry failing requests, ensuring that intermittent or degraded infrastructure is not subjected to retry storms.
- **Zero Secrets**: Requires no admin tokens, passwords, or credentials; uses only standard public GET endpoints.
- **Completely Read-Only**: Performs zero database mutations, state updates, or live-DB writes.
