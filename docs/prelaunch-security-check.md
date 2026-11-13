# Pre-Launch Security Sign-Off Gate

```bash
node scripts/check-prelaunch-security.cjs
```

**Launch Date:** Monday 16 Nov 2026  
**Launch Configuration:** Payments OFF (`NEXT_PUBLIC_BILLING_ENABLED=false`), early access waitlist removed (open signups).  
**Enforcement Tool:** Standalone offline verification script [`scripts/check-prelaunch-security.cjs`](file:///d:/Carrer-hound/scripts/check-prelaunch-security.cjs).

---

## 1. Sign-Off Summary Table

| Gate | Status | What It Protects | Primary Evidence |
| :--- | :---: | :--- | :--- |
| **1. Secrets & Credentials** | **PASS** | Prevents exposure of service-role keys, JWTs, Razorpay secrets, or API tokens in deployed code. | Scanned 1,340 tracked files outside docs, examples, and test fixtures: **0 secrets detected**. |
| **2. Security Headers & CSP** | **PASS** | Prevents clickjacking, MIME sniffing, SSL downgrade, and arbitrary third-party script execution. | Full agreement between [`public/_headers:1-8`](file:///d:/Carrer-hound/public/_headers#L1-L8) and [`netlify.toml:141-150`](file:///d:/Carrer-hound/netlify.toml#L141-L150). Razorpay checkout is the sole script-src exception. |
| **3. API & Serverless Auth Gating** | **PASS** | Ensures all routes reading/writing user data require authenticated sessions; strictly bounds public surfaces. | 26 user-data routes verified with established auth helpers; only 17 public reads, health probes, and HMAC-signed webhooks allowlisted. |
| **4. Debug Surfaces & Logs** | **PASS** | Prevents debug fixtures from shipping in routes/pages and prevents credential/body leakage in server logs. | 100 app routes/pages scanned: 0 fixture exports. 161 server files scanned: 0 `console.log` leaks of bodies or tokens. |
| **5. Payments-OFF Launch State** | **PASS** | Enforces disabled checkout at launch; prevents accidental live charges until the owner enables billing. | Order endpoints fail closed with 503 `BILLING_DISABLED` ([`order/route.ts:19-24`](file:///d:/Carrer-hound/src/app/api/billing/razorpay/order/route.ts#L19-L24), [`billing-razorpay-order.ts:58-67`](file:///d:/Carrer-hound/netlify/functions/billing-razorpay-order.ts#L58-L67)). Active state: `false`. |

---

## 2. Gate Verification Details

### Gate 1: Secrets & Token Protection
- **Policy:** Production source code must never contain live or mock service-role keys, JWT tokens, payment secrets, or third-party API keys.
- **Rules Enforced:**
  - JWT Tokens (`eyJ...` with 3 segments)
  - Supabase Service/Access Tokens (`sbp_...`)
  - Stripe Secret/Public Keys (`sk_live_...`, `pk_live_...`, `sk_test_...`)
  - Razorpay Secret/Key IDs (`rzp_live_...`, `rzp_test_...`)
  - Groq Keys (`gsk_...`)
  - Hardcoded Secret Assignments (`SUPABASE_SERVICE_ROLE_KEY = "..."`, `RAZORPAY_KEY_SECRET = "..."`, `ADMIN_SECRET = "..."`)
- **Allowlist Scope:** Strictly limited to documentation (`docs/`), example environment templates ([`.env.example:1-25`](file:///d:/Carrer-hound/.env.example#L1-L25)), GitLeaks configurations ([`.gitleaks.toml:1-13`](file:///d:/Carrer-hound/.gitleaks.toml#L1-L13)), and offline test suites ([`scripts/test-*.ts`](file:///d:/Carrer-hound/scripts/), [`scripts/load-handlers-local.ts`](file:///d:/Carrer-hound/scripts/load-handlers-local.ts), `src/**/__tests__/**`).
- **Result:** **PASS** (1,340 files audited; 0 secret leaks).

---

### Gate 2: Security Headers Parity & CSP Hardening
- **Policy:** Both deployment hosts—Cloudflare Pages ([`public/_headers`](file:///d:/Carrer-hound/public/_headers)) and Netlify ([`netlify.toml`](file:///d:/Carrer-hound/netlify.toml))—must enforce an identical, hardened security header suite.
- **Evidence Lines:**
  - `X-Content-Type-Options: nosniff`: [`public/_headers:2`](file:///d:/Carrer-hound/public/_headers#L2) <-> [`netlify.toml:144`](file:///d:/Carrer-hound/netlify.toml#L144).
  - `X-Frame-Options: DENY`: [`public/_headers:3`](file:///d:/Carrer-hound/public/_headers#L3) <-> [`netlify.toml:145`](file:///d:/Carrer-hound/netlify.toml#L145).
  - `Referrer-Policy: strict-origin-when-cross-origin`: [`public/_headers:4`](file:///d:/Carrer-hound/public/_headers#L4) <-> [`netlify.toml:146`](file:///d:/Carrer-hound/netlify.toml#L146).
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`: [`public/_headers:6`](file:///d:/Carrer-hound/public/_headers#L6) <-> [`netlify.toml:148`](file:///d:/Carrer-hound/netlify.toml#L148).
  - `frame-ancestors 'none'`: [`public/_headers:7`](file:///d:/Carrer-hound/public/_headers#L7) <-> [`netlify.toml:149`](file:///d:/Carrer-hound/netlify.toml#L149).
  - `Content-Security-Policy`: Byte-for-byte identical string match (883 characters).
  - `script-src` Allowlist: Restricted strictly to `'self'`, `'unsafe-inline'` (required for Next.js App Router RSC hydration scripts as documented in [`docs/security/csp.md:37-56`](file:///d:/Carrer-hound/docs/security/csp.md#L37-L56)), SRI-verified PDF.js ([`docs/third-party-scripts.md:17-18`](file:///d:/Carrer-hound/docs/third-party-scripts.md#L17-L18)), Google Identity Services, and `https://checkout.razorpay.com`.
  - Sole Script Exception: `https://checkout.razorpay.com` is verified as the only third-party checkout script exception per [`docs/third-party-scripts.md:19-20`](file:///d:/Carrer-hound/docs/third-party-scripts.md#L19-L20) and [`docs/audit-sweeps/be-sweep-1.md:68`](file:///d:/Carrer-hound/docs/audit-sweeps/be-sweep-1.md#L68). No external ad trackers, marketing pixels, or other payment gateways are present.
- **Result:** **PASS**.

---

### Gate 3: API & Serverless Auth Gating
- **Policy:** Every API route and serverless function that accesses, updates, or deletes user-owned data must verify authentication before performing database or business logic.
- **Verified Routes (26 Endpoints):**
  - **Account Lifecycle:** [`src/app/api/account/delete/route.ts`](file:///d:/Carrer-hound/src/app/api/account/delete/route.ts), [`src/app/api/account/export/route.ts`](file:///d:/Carrer-hound/src/app/api/account/export/route.ts), [`src/app/api/account/signout-all/route.ts`](file:///d:/Carrer-hound/src/app/api/account/signout-all/route.ts), [`netlify/functions/account-delete.ts`](file:///d:/Carrer-hound/netlify/functions/account-delete.ts). Enforce Bearer token verification via `handleAccountDelete`, `handleAccountExport`, `handleSignoutAll`, and `supabaseAdmin.auth.getUser(token)`.
  - **Admin Operations:** All 8 admin routes under `src/app/api/admin/` ([`early-access`](file:///d:/Carrer-hound/src/app/api/admin/early-access/route.ts), [`approve`](file:///d:/Carrer-hound/src/app/api/admin/early-access/approve/route.ts), [`reject`](file:///d:/Carrer-hound/src/app/api/admin/early-access/reject/route.ts), [`replay`](file:///d:/Carrer-hound/src/app/api/admin/replay/route.ts), [`stats`](file:///d:/Carrer-hound/src/app/api/admin/stats/route.ts), [`users`](file:///d:/Carrer-hound/src/app/api/admin/users/route.ts), [`activity`](file:///d:/Carrer-hound/src/app/api/admin/users/activity/route.ts), [`block`](file:///d:/Carrer-hound/src/app/api/admin/users/block/route.ts)) enforce `verifyAdminSession(req)`.
  - **AI Generation & Streaming:** [`src/app/api/ai/route.ts`](file:///d:/Carrer-hound/src/app/api/ai/route.ts), [`src/app/api/ai/stream/route.ts`](file:///d:/Carrer-hound/src/app/api/ai/stream/route.ts), [`netlify/functions/ai.ts`](file:///d:/Carrer-hound/netlify/functions/ai.ts) enforce session token verification, rate limits, and quota debits via `handleAiRequest`, `handleNetlifyAiRequest`, and `executeAiCore`.
  - **Pro & Personalization:** [`src/app/api/jobs/pro/route.ts`](file:///d:/Carrer-hound/src/app/api/jobs/pro/route.ts), [`src/app/api/jobs/top10/route.ts`](file:///d:/Carrer-hound/src/app/api/jobs/top10/route.ts), [`src/app/api/jobs/interview-pack/route.ts`](file:///d:/Carrer-hound/src/app/api/jobs/interview-pack/route.ts), [`src/app/api/jobs/skill-what-if/route.ts`](file:///d:/Carrer-hound/src/app/api/jobs/skill-what-if/route.ts), [`netlify/functions/jobs-pro.ts`](file:///d:/Carrer-hound/netlify/functions/jobs-pro.ts), [`netlify/functions/jobs-top10.ts`](file:///d:/Carrer-hound/netlify/functions/jobs-top10.ts) enforce `verifyProUser`, `verifyUserNotBanned`, and `supabaseAdmin.auth.getUser(token)`.
  - **Billing & Quota:** [`src/app/api/billing/razorpay/order/route.ts`](file:///d:/Carrer-hound/src/app/api/billing/razorpay/order/route.ts), [`src/app/api/billing/razorpay/verify/route.ts`](file:///d:/Carrer-hound/src/app/api/billing/razorpay/verify/route.ts), [`src/app/api/me/quota/route.ts`](file:///d:/Carrer-hound/src/app/api/me/quota/route.ts), [`netlify/functions/billing-razorpay-order.ts`](file:///d:/Carrer-hound/netlify/functions/billing-razorpay-order.ts), [`netlify/functions/billing-razorpay-verify.ts`](file:///d:/Carrer-hound/netlify/functions/billing-razorpay-verify.ts) enforce user authentication.
- **Allowlisted Public & Webhook Endpoints (17 Endpoints):**
  - Public job and platform reads (`jobs_public` view only): [`src/app/api/jobs/search/route.ts`](file:///d:/Carrer-hound/src/app/api/jobs/search/route.ts), [`src/app/api/jobs/suggest/route.ts`](file:///d:/Carrer-hound/src/app/api/jobs/suggest/route.ts), [`src/app/api/radar/route.ts`](file:///d:/Carrer-hound/src/app/api/radar/route.ts), [`src/app/api/stats/route.ts`](file:///d:/Carrer-hound/src/app/api/stats/route.ts), [`src/app/api/ticker/route.ts`](file:///d:/Carrer-hound/src/app/api/ticker/route.ts), [`netlify/functions/jobs-search.ts`](file:///d:/Carrer-hound/netlify/functions/jobs-search.ts), [`netlify/functions/stats.ts`](file:///d:/Carrer-hound/netlify/functions/stats.ts), [`netlify/functions/ticker.ts`](file:///d:/Carrer-hound/netlify/functions/ticker.ts).
  - Health and readiness probes: [`src/app/api/health/route.ts`](file:///d:/Carrer-hound/src/app/api/health/route.ts), [`src/app/api/health/ready/route.ts`](file:///d:/Carrer-hound/src/app/api/health/ready/route.ts), [`netlify/functions/health.ts`](file:///d:/Carrer-hound/netlify/functions/health.ts).
  - Webhooks and signature-verified handlers: [`netlify/functions/billing-razorpay-webhook.ts`](file:///d:/Carrer-hound/netlify/functions/billing-razorpay-webhook.ts) (verifies HMAC SHA-256 signature), [`src/app/api/email/unsubscribe/route.ts`](file:///d:/Carrer-hound/src/app/api/email/unsubscribe/route.ts), [`netlify/functions/email-unsubscribe.ts`](file:///d:/Carrer-hound/netlify/functions/email-unsubscribe.ts) (verifies signed HMAC token).
  - Public telemetry & waitlist: [`src/app/api/early-access/route.ts`](file:///d:/Carrer-hound/src/app/api/early-access/route.ts), [`src/app/api/auth/security-event/route.ts`](file:///d:/Carrer-hound/src/app/api/auth/security-event/route.ts), [`src/app/api/track/route.ts`](file:///d:/Carrer-hound/src/app/api/track/route.ts).
- **Result:** **PASS**.

---

### Gate 4: Debug Surfaces & Server Logging Posture
- **Policy:** Production pages and routes must not export test or debug fixtures. Server code must never log raw request bodies, user passwords, or authentication bearer tokens.
- **Evidence:**
  - 100 app routes and pages inspected across `src/app/` and `netlify/functions/`: 0 exported debug or test fixtures.
  - 161 server files inspected across `src/app/api/`, `netlify/functions/`, and `src/lib/`: 0 raw `console.log` statements outputting request bodies, user passwords, or tokens.
  - Server logging standardizes on structured loggers ([`src/lib/observability/logger.ts`](file:///d:/Carrer-hound/src/lib/observability/logger.ts), [`netlify/functions/_logger.ts`](file:///d:/Carrer-hound/netlify/functions/_logger.ts)) with automatic redaction of bearer tokens and secrets.
- **Result:** **PASS**.

---

### Gate 5: Payments-OFF Launch State
- **Policy:** For the Monday 16 Nov launch, payments must remain strictly disabled. Checkout creation endpoints must fail safe (503 `BILLING_DISABLED`), and live payment gateway keys must be rejected.
- **Evidence Lines:**
  - Next.js Checkout Gate: [`src/app/api/billing/razorpay/order/route.ts:19-24`](file:///d:/Carrer-hound/src/app/api/billing/razorpay/order/route.ts#L19-L24) checks `process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true"` and immediately responds:
    ```json
    { "error": "Billing is currently unavailable", "code": "BILLING_DISABLED" }
    ```
    with HTTP 503 before inspecting payment payload or merchant keys.
  - Test Key Gate: [`src/app/api/billing/razorpay/order/route.ts:78-87`](file:///d:/Carrer-hound/src/app/api/billing/razorpay/order/route.ts#L78-L87) enforces `rzp_test_` only and returns 503 `RAZORPAY_TEST_KEYS_NOT_CONFIGURED` if live keys or unrecognized modes are supplied.
  - Netlify Function Checkout Gate: [`netlify/functions/billing-razorpay-order.ts:58-67`](file:///d:/Carrer-hound/netlify/functions/billing-razorpay-order.ts#L58-L67) checks `process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true"` and immediately responds with HTTP 503 `BILLING_DISABLED`.
  - Feature Flag Registry: [`src/lib/flags/flags.ts:31`](file:///d:/Carrer-hound/src/lib/flags/flags.ts#L31) defines:
    ```typescript
    { envVar: "NEXT_PUBLIC_BILLING_ENABLED", rule: "strict_true", defaultEnabled: false, scope: "public-build" }
    ```
  - Repository Baseline: [`.env.example:22`](file:///d:/Carrer-hound/.env.example#L22) commits `NEXT_PUBLIC_BILLING_ENABLED=false`.
  - Active Runtime State: `NEXT_PUBLIC_BILLING_ENABLED` is `undefined` / `false` (payments disabled).
- **Result:** **PASS**.

---

## 3. Owner Launch Pre-Flight Verification

Before activating payments or flipping DNS in production:

1. [ ] Run `node scripts/check-prelaunch-security.cjs` to confirm 15/15 checks pass.
2. [ ] Verify Cloudflare Pages environment variables in dashboard: confirm `NEXT_PUBLIC_BILLING_ENABLED` is unset or `false`.
3. [ ] Verify Netlify environment variables in dashboard: confirm `NEXT_PUBLIC_BILLING_ENABLED` is unset or `false`.
4. [ ] Verify Supabase production project ref: ensure `NEXT_PUBLIC_SUPABASE_URL` points to authorized production instance and `SUPABASE_SERVICE_ROLE_KEY` is set in host secrets (never client-exposed).
5. [ ] Confirm that `docs/security/csp.md` and `docs/third-party-scripts.md` remain intact.
