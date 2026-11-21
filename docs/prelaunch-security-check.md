# Pre-Launch Security Sign-Off Gate

```bash
node scripts/check-prelaunch-security.cjs
```

Negative controls self-test command:
```bash
node scripts/check-prelaunch-security.cjs --test-negative-controls
```

**Target Launch Date:** Monday 16 Nov 2026  
**Launch Configuration:** Payments OFF (`NEXT_PUBLIC_BILLING_ENABLED=false`), early access waitlist removed (open signups).  
**Enforcement Tool:** Standalone offline verification script [`scripts/check-prelaunch-security.cjs`](../scripts/check-prelaunch-security.cjs).  
**Production Deployment Posture:** **UNVERIFIED** (Static repository baseline verified; live cloud deployment environment state remains pending manual owner verification).

---

## 1. Sign-Off Summary Table

| Gate | Static Source Baseline | What It Protects | Primary Evidence & Notes |
| :--- | :---: | :--- | :--- |
| **1. Secrets & Credentials** | **PASS** | Scans repository for service-role keys, JWTs, Razorpay secrets, `sb_secret_*`, and modern tokens. | Scanned 1,320 tracked files (24 exact reviewed exemptions skipped): **0 secrets detected**. Complements Gitleaks; does not prove absence of unknown/obfuscated keys. |
| **2. Security Headers & CSP** | **PASS** | Source parity between Cloudflare Pages and Netlify headers to prevent clickjacking, MIME sniffing, and unauthorized script injection. | Whitespace-normalized token parity between [`public/_headers:1-8`](../public/_headers#L1-L8) and [`netlify.toml:141-150`](../netlify.toml#L141-L150). Razorpay checkout is sole payment script exception. Source parity only, not deployed CDN edge enforcement. |
| **3. API & Functions Auth Gating** | **PASS** | Heuristic evidence inventory of API routes & serverless functions; verifies active call invocations, webhook HMAC signatures, and public read boundaries. | 26 user-data routes inventoried with established auth helpers; 17 public/probe/webhook endpoints verified against strict contracts (admin `verifyAdminSession()` invocations, webhook HMAC SHA-256 signatures, unsubscribe tokens, `jobs_public` view reads). |
| **4. Debug Surfaces & Logs** | **PASS** | Prevents debug/test endpoints and fixture exports from shipping in production; prevents sensitive body/token leakage in server logs. | 0 debug endpoints under `src/app/api` or `netlify/functions`. 100 app routes/pages scanned: 0 fixture exports (named or default). 161 server files scanned: 0 `console.(log\|error\|warn)` or logger payloads leaking bodies or tokens. |
| **5. Payments-OFF Launch State** | **PASS** | Enforces fail-closed 503 checkout behavior in static code; verifies local environment payments-off baseline. | Order endpoints fail closed with 503 `BILLING_DISABLED` ([`order/route.ts:19-24`](../src/app/api/billing/razorpay/order/route.ts#L19-L24), [`billing-razorpay-order.ts:58-67`](../netlify/functions/billing-razorpay-order.ts#L58-L67)). Local flag verified `false`/undefined. **Production state UNVERIFIED** pending owner dashboard check. |

---

## 2. Gate Verification Details

### Gate 1: Secrets & Token Protection
- **Policy:** Production repository files outside exact reviewed exemptions must not contain private API keys, service-role tokens, JWTs, or payment gateway secrets.
- **Rule Set:**
  - JWT Tokens (`eyJ...` with 3 valid segments)
  - Supabase Service/Access Tokens (`sbp_...`)
  - Supabase Modern Secret Keys (`sb_secret_...`)
  - Stripe Secret/Public Keys (`sk_live_...`, `pk_live_...`, `sk_test_...`)
  - Razorpay Secret/Key IDs (`rzp_live_...`, `rzp_test_...`)
  - Groq Keys (`gsk_...`)
  - Resend API Keys (`re_...`)
  - GitHub Personal Access Tokens (`ghp_...`, `github_pat_...`)
  - Hardcoded Secret Assignments (`SUPABASE_SERVICE_ROLE_KEY = "..."`, `RAZORPAY_KEY_SECRET = "..."`, `ADMIN_SECRET = "..."`)
- **Reviewed Exemptions Scope:** Rather than blanket-skipping entire directories, the scanner enforces an explicit allowlist of 24 reviewed files containing documentation templates ([`.env.example:21-26`](../.env.example#L21-L26)), GitLeaks configurations ([`.gitleaks.toml:1-13`](../.gitleaks.toml#L1-L13)), offline mock test fixtures ([`scripts/load-handlers-local.ts:24`](../scripts/load-handlers-local.ts#L24), `scripts/test-*.ts`), and provider adapter unit tests ([`src/lib/ai/__tests__/providerAdapter.test.ts:152`](../src/lib/ai/__tests__/providerAdapter.test.ts#L152)).
- **Result:** **PASS** (1,320 files scanned; 24 reviewed exemptions; 0 secrets detected).
- **Residual Risk & Limitations:** This offline static scanner complements GitLeaks pre-commit hooks. It does not prove the absence of high-entropy unknown strings, obfuscated keys, or unrecognized vendor formats.

---

### Gate 2: Security Headers Parity & CSP Hardening
- **Policy:** Both deployment targets—Cloudflare Pages ([`public/_headers`](../public/_headers)) and Netlify ([`netlify.toml`](../netlify.toml))—must declare an identical, hardened baseline of security headers.
- **Verification Method:** Whitespace-normalized source parity check between [`public/_headers:1-8`](../public/_headers#L1-L8) and [`netlify.toml:141-150`](../netlify.toml#L141-L150).
- **Evidence Lines:**
  - `X-Content-Type-Options: nosniff`: [`public/_headers:2`](../public/_headers#L2) <-> [`netlify.toml:144`](../netlify.toml#L144).
  - `X-Frame-Options: DENY`: [`public/_headers:3`](../public/_headers#L3) <-> [`netlify.toml:145`](../netlify.toml#L145).
  - `Referrer-Policy: strict-origin-when-cross-origin`: [`public/_headers:4`](../public/_headers#L4) <-> [`netlify.toml:146`](../netlify.toml#L146).
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`: [`public/_headers:6`](../public/_headers#L6) <-> [`netlify.toml:148`](../netlify.toml#L148).
  - `frame-ancestors 'none'`: [`public/_headers:7`](../public/_headers#L7) <-> [`netlify.toml:149`](../netlify.toml#L149).
  - `Content-Security-Policy`: Normalized token match across all directives (883 characters).
  - `script-src` Allowlist: `https://checkout.razorpay.com` is verified as the sole payment checkout script exception. No external advertising networks, trackers, or secondary payment processors exist in `script-src`.
- **Residual CSP Allowances & Deployment Disclaimer:**
  - `'unsafe-inline'` is currently allowed in `script-src` and `style-src` (required for Next.js App Router RSC inline hydration scripts and style tags as documented in [`docs/security/csp.md:37-56`](../docs/security/csp.md#L37-L56)).
  - Third-party CDN origins allowed in `script-src`: `https://cdnjs.cloudflare.com` (PDF.js rendering worker), `https://checkout.razorpay.com` (Razorpay checkout frame), `https://accounts.google.com` (Google Identity Services OAuth), and `https://apis.google.com`.
  - **Important:** This check asserts source repository configuration parity. It does not verify deployed edge header delivery on production domains (UNVERIFIED).

---

### Gate 3: Heuristic Evidence Inventory: API Routes & Functions Auth Gating & Contracts
- **Policy:** API routes and serverless functions handling user-owned data must import and invoke established auth helpers. Allowlisted public routes and webhooks must satisfy strict contract assertions.
- **Classification:** **Heuristic Evidence Inventory**. Static scan of auth helper imports and call invocations provides evidence of adherence to architectural conventions, but token presence alone is not runtime certification of authorization enforcement.
- **Contract Assertions Enforced:**
  - **Admin Operations (8 Routes):** All admin routes ([`approve`](../src/app/api/admin/early-access/approve/route.ts), [`reject`](../src/app/api/admin/early-access/reject/route.ts), [`early-access`](../src/app/api/admin/early-access/route.ts), [`replay`](../src/app/api/admin/replay/route.ts), [`stats`](../src/app/api/admin/stats/route.ts), [`users`](../src/app/api/admin/users/route.ts), [`activity`](../src/app/api/admin/users/activity/route.ts), [`block`](../src/app/api/admin/users/block/route.ts)) must both import `verifyAdminSession` AND actively execute the `verifyAdminSession(req)` call in their handler body. A mutation retaining the import while removing the call is caught and fails.
  - **Webhook Signature Verification:** [`netlify/functions/billing-razorpay-webhook.ts:120-134`](../netlify/functions/billing-razorpay-webhook.ts#L120-L134) must actively compute HMAC SHA-256 signatures via `crypto.createHmac("sha256", webhookSecret)` and compare against `X-Razorpay-Signature` using constant-time comparison (`timingSafeEqual` / `constantTimeCompare`). Missing HMAC computation fails the check.
  - **Unsubscribe Verification:** [`src/app/api/email/unsubscribe/route.ts:31-40`](../src/app/api/email/unsubscribe/route.ts#L31-L40) and [`netlify/functions/email-unsubscribe.ts:52-65`](../netlify/functions/email-unsubscribe.ts#L52-L65) must actively invoke `verifyUnsubscribeToken(token)` before performing actions.
  - **Public Job Reads Boundary:** Public search and stats endpoints ([`src/app/api/jobs/search/route.ts:133-135`](../src/app/api/jobs/search/route.ts#L133-L135), [`netlify/functions/jobs-search.ts`](../netlify/functions/jobs-search.ts)) must reference and read from the sanitized `jobs_public` database view, ensuring unauthenticated requests cannot access private user or application columns.
  - **User Lifecycle, AI, and Pro Endpoints (26 Routes):** User-data routes under `src/app/api/account/`, `src/app/api/ai/`, `src/app/api/jobs/pro/`, `src/app/api/me/`, and corresponding `netlify/functions/` must match established session verification helpers (`verifyProUser`, `handleAccountDelete`, `handleAccountExport`, `handleSignoutAll`, `handleAiRequest`, `executeAiCore`, or `auth.getUser`).
- **Result:** **PASS** (26 user routes inventoried; all inspected route contracts satisfied).

---

### Gate 4: Debug Surfaces & Server Logging Posture
- **Policy:** Production pages and routes must not export test or debug fixtures. Server code must not expose debug endpoints or log sensitive request bodies, passwords, or authentication bearer tokens.
- **Evidence:**
  - **Debug Endpoints:** 0 endpoints containing `/debug/`, `/test/`, `debug-`, or `test-` exist under `src/app/api/` or `netlify/functions/`.
  - **Exported Fixtures:** 100 app routes and pages inspected across `src/app/` and `netlify/functions/`: 0 exported debug or test fixtures (covering `export const`, `export function`, and `export default` fixtures).
  - **Server Logging:** 161 server files inspected across `src/app/api/`, `netlify/functions/`, and `src/lib/`:
    - 0 raw `console.log` statements in Next.js API routes (`src/app/api/`).
    - 0 logger calls or `console.(log|error|warn|info)` statements passing sensitive payloads (`req.body`, `request.body`, `authHeader`, `password`, `secret`, `bearer`, or raw `token` variables).
    - Logging standardizes on structured loggers ([`src/lib/observability/logger.ts`](../src/lib/observability/logger.ts), [`netlify/functions/_logger.ts`](../netlify/functions/_logger.ts)) with automatic redaction of bearer tokens.
- **Result:** **PASS**.

---

### Gate 5: Payments-OFF Launch State
- **Policy:** For the Monday 16 Nov launch, payments must remain strictly disabled. Checkout creation endpoints must fail safe (503 `BILLING_DISABLED`), live payment gateway keys must be rejected, and the local testing environment must not enable billing.
- **Evidence Lines:**
  - **Next.js Checkout Gate:** [`src/app/api/billing/razorpay/order/route.ts:19-24`](../src/app/api/billing/razorpay/order/route.ts#L19-L24) checks `process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true"` and immediately responds with HTTP 503:
    ```json
    { "error": "Billing is currently unavailable", "code": "BILLING_DISABLED" }
    ```
    Bypass patterns (e.g. `if (false && ...)`) are explicitly rejected by the checker.
  - **Test Key Restriction:** [`src/app/api/billing/razorpay/order/route.ts:78-87`](../src/app/api/billing/razorpay/order/route.ts#L78-L87) requires `rzp_test_` prefix and rejects live keys with 503 `RAZORPAY_TEST_KEYS_NOT_CONFIGURED`.
  - **Netlify Function Checkout Gate:** [`netlify/functions/billing-razorpay-order.ts:58-67`](../netlify/functions/billing-razorpay-order.ts#L58-L67) checks `process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true"` and fails closed with HTTP 503 `BILLING_DISABLED`.
  - **Feature Flag Registry:** [`src/lib/flags/flags.ts:30-33`](../src/lib/flags/flags.ts#L30-L33) defines:
    ```typescript
    { envVar: "NEXT_PUBLIC_BILLING_ENABLED", rule: "strict_true", defaultEnabled: false, scope: "public-build" }
    ```
  - **Repository Baseline:** [`.env.example:22`](../.env.example#L22) commits `NEXT_PUBLIC_BILLING_ENABLED=false`.
  - **Local Environment Verification:** Evaluates `process.env.NEXT_PUBLIC_BILLING_ENABLED`. The checker FAILS if set to `"true"` in the local environment. Currently verified as `false` / undefined.
- **Result:** **PASS** (Static repository baseline verified).
- **Production Status:** **UNVERIFIED**. Local environment and static code checks do not prove production environment variables are configured correctly on Cloudflare Pages or Netlify.

---

## 3. Negative Controls & Invariant Proofs

The checker provides a built-in negative controls suite (`node scripts/check-prelaunch-security.cjs --test-negative-controls`) and dedicated unit tests ([`src/lib/__tests__/prelaunchSecurityNegativeControls.test.ts`](../src/lib/__tests__/prelaunchSecurityNegativeControls.test.ts)) proving that injected security misconfigurations cause non-zero exit codes:

1. **NC1 (Secrets):** Injected modern key (`sb_secret_...`) outside reviewed exemptions causes exit code 1.
2. **NC2 (Headers):** Injected CSP mismatch and unauthorized external script source (`https://unauthorized.tracker.com`) causes exit code 1.
3. **NC3a (Admin Auth):** Removing the `verifyAdminSession(req)` invocation while keeping the import causes exit code 1.
4. **NC3b (Webhook HMAC):** Removing HMAC SHA-256 calculation from `billing-razorpay-webhook.ts` causes exit code 1.
5. **NC4a (Debug Fixtures):** Exporting a `testFixture` or debug endpoint causes exit code 1.
6. **NC4b (Logging Leaks):** Emitting `console.error` with a sensitive token payload causes exit code 1.
7. **NC5a (Billing Local Env):** Setting `NEXT_PUBLIC_BILLING_ENABLED="true"` in the runtime environment causes exit code 1.
8. **NC5b (Billing Gate Bypass):** Bypassing the order route check via `if (false && ...)` causes exit code 1.

---

## 4. Owner Launch Pre-Flight Verification (UNVERIFIED)

> [!WARNING]
> The offline checker verifies repository source code and local environment only. The checks below represent **LIVE PRODUCTION DEPLOYMENT CHECKS** that cannot be verified by offline code analysis and must be confirmed manually by the project owner in cloud provider dashboards prior to launch.

- [ ] **UNVERIFIED: Cloudflare Pages Environment Variables**
  - Host: Cloudflare Dashboard -> Workers & Pages -> CareerMonke -> Settings -> Environment Variables.
  - Check: Confirm `NEXT_PUBLIC_BILLING_ENABLED` is either unset or set to `"false"`. Confirm no live Razorpay secrets are present in client-exposed variables.
- [ ] **UNVERIFIED: Netlify Environment Variables**
  - Host: Netlify Dashboard -> Site Configuration -> Environment Variables.
  - Check: Confirm `NEXT_PUBLIC_BILLING_ENABLED` is either unset or set to `"false"`. Confirm `RAZORPAY_WEBHOOK_SECRET` matches the webhook secret configured in the Razorpay Dashboard.
- [ ] **UNVERIFIED: Supabase Production Project Configuration**
  - Host: Supabase Dashboard -> Project Settings -> API.
  - Check: Confirm `NEXT_PUBLIC_SUPABASE_URL` points to authorized production instance (`https://szakevhxhwpeskidvtfs.supabase.co`). Confirm `SUPABASE_SERVICE_ROLE_KEY` is present only in host server environment variables and never client-exposed.
- [ ] **UNVERIFIED: Razorpay Live Merchant Posture**
  - Host: Razorpay Dashboard -> Settings -> API Keys & Webhooks.
  - Check: Confirm no live merchant keys (`rzp_live_...`) are active in production deployment variables while payments remain disabled for launch. Confirm webhook endpoint points to `https://careermonke.com/.netlify/functions/billing-razorpay-webhook`.
- [ ] **UNVERIFIED: Deployed CDN Security Headers**
  - Check: Execute `curl -I https://careermonke.com/` on the live domain after deployment and verify presence of `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, and `Content-Security-Policy`.
