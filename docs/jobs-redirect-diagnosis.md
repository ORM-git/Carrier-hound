# CareerMonke Launch-Critical Diagnosis: `/jobs` 307 Redirect & Missing 404 Fallback

> **Document Path**: `docs/jobs-redirect-diagnosis.md`  
> **Diagnostic Checker**: `scripts/check-jobs-live.cjs`  
> **Execution**: `node scripts/check-jobs-live.cjs https://careermonke.com [--json]`  
> **Status**: **READ-ONLY DIAGNOSTIC ANALYSIS & LIVE PROBE SPECIFICATION**  
> **Target Launch Date**: Monday 16 Nov (Early Access removed; Payments OFF)

---

## 1. Executive Summary & Problem Statement

During pre-launch smoke testing on the live production deployment (`https://careermonke.com`), two routing anomalies were observed:
1. **Public Job Feed Inaccessible (`/jobs` returns HTTP 307)**:
   Accessing `https://careermonke.com/jobs` as an unauthenticated guest visitor results in an HTTP 307 Temporary Redirect to `https://careermonke.com/early-access`.
2. **Missing 404 Response (Unknown paths return HTTP 307)**:
   Accessing an arbitrary non-existent route (e.g. `https://careermonke.com/this-path-definitely-does-not-exist-404-check`) never renders the committed 404 page (`src/app/not-found.tsx`) and never returns HTTP 404. Instead, it issues an HTTP 307 Temporary Redirect to `https://careermonke.com/early-access`.

This document analyzes the mechanisms across **Netlify Edge**, **Cloudflare Pages Edge**, and **Next.js Edge Middleware** to identify the source of these redirects and define an exhaustive requirements specification for the upcoming launch PR.

---

## 2. Layer-by-Layer Architectural Trace

### Layer 1: Netlify Edge Configuration (`netlify.toml` and `public/_redirects`)

- **Execution Layer**: Netlify Edge (CDN routing engine for backup/preview deployments).
- **Files Inspected**:
  - `netlify.toml` (lines 81–140)
  - `public/_redirects` (lines 1–9)
- **Rules Evaluated**:
  ```toml
  # netlify.toml lines 81-97
  [[redirects]]
    from = "/job-search"
    to = "/jobs"
    status = 301
    force = true

  [[redirects]]
    from = "/paywall"
    to = "/jobs"
    status = 301
    force = true

  # netlify.toml lines 135-139
  [[redirects]]
    from = "/*"
    to = "/404.html"
    status = 404
    force = false
  ```
  ```text
  # public/_redirects lines 3-9
  /job-search /jobs 301!
  /job-search/all /jobs 301!
  /paywall /jobs 301!
  /applications /tracker 301!
  /privacy /privacy-policy 301!
  /jobs/* /jobs/detail 200
  /* /404.html 404
  ```
- **Findings**:
  1. Neither file contains redirect rules targeting `/early-access`. Legacy aliases (`/job-search`, `/paywall`) redirect *to* `/jobs` with HTTP 301.
  2. Both files define an explicit catch-all 404 fallback (`/* -> /404.html 404`).
  3. No HTTP 307 rules are declared in Netlify repository files.
  4. *Limitation*: Repository configuration reflects declared code only; deployed vendor dashboard behavior on Netlify cannot be audited from repository files alone.

---

### Layer 2: Cloudflare Edge (Cloudflare Pages, WAF, Page/Transform Rules)

- **Execution Layer**: Cloudflare Pages reverse proxy, edge cache, and `@cloudflare/next-on-pages` edge worker.
- **Documentation Inspected**:
  - `docs/config-drift.md` (lines 48–56: Cloudflare Pages clickops checklist)
  - `docs/audit-sweeps/be-sweep-1.md` (lines 21–23: edge WAF / rate-limiting)
  - `docs/dns-cutover-runbook.md` (lines 1–25: primary host routing)
- **Live HTTP Request Header Evidence**:
  A live probe against `https://careermonke.com/jobs` and `https://careermonke.com/nonsense-path-404` yields:
  ```http
  HTTP/2 307 
  date: Fri, 13 Nov 2026 09:19:03 GMT
  location: https://careermonke.com/early-access
  server: cloudflare
  cf-cache-status: DYNAMIC
  cf-ray: a59cb14a6feae1f0-MRS
  x-request-id: ed24c804-1288-42bc-9455-d61cc9467165
  ```
- **Findings & Causality Bounds**:
  1. No Cloudflare Transform Rules or Page Rules are documented in repository files.
  2. The response header contains `x-request-id: <uuid>`.
  3. In `src/middleware.ts` (lines 782–795), `x-request-id` is generated and attached by the Next.js edge middleware.
  4. The presence of `x-request-id` in the response is *consistent with* the Next.js edge middleware path running, but is not proof on its own (an edge transform rule, worker, or upstream proxy could also inject or pass through this header).
  5. **Causality & Deployed Scope Bound**: Source middleware provides a *sufficient matching mechanism* to produce the 307 redirect. However, **deployed causality and dashboard/worker/cache rules are unverified**: repository files alone cannot prove or rule out whether Cloudflare dashboard rules (e.g. Page Rules, Transform Rules, Worker routes, or edge cache overrides) are configured or interacting with traffic in production.

---

### Layer 3: Next.js Edge Middleware (`src/middleware.ts`)

- **Execution Layer**: Next.js Edge Middleware running in the Cloudflare Pages Worker (`_worker.js`).
- **File**: `src/middleware.ts`
- **Sufficient Matching Mechanism in Source**:
  - **Lines 15–27**: Definition of `PROTECTED_ROUTES`:
    ```typescript
    export const PROTECTED_ROUTES: readonly string[] = [
      "/dashboard",
      "/jobs",       // Line 17: /jobs is listed in PROTECTED_ROUTES
      "/resume",
      "/tracker",
      "/profile",
      "/radar",
      "/settings",
      "/applications",
      "/job-search",
      "/job-detail",
      "/onboarding",
    ];
    ```
  - **Lines 722–743**: Logged-in + unapproved user gate:
    ```typescript
    // 2. Logged-in + not approved = early-access page
    if (hasValidSession && !isAllowedEarlyAccess) {
      if (pathname === "/early-access" || pathname.startsWith("/early-access/")) {
        return NextResponse.next();
      }
      if (pathname.startsWith("/api") || pathname.startsWith("/.netlify")) {
        return NextResponse.json(
          { error: "Early access only" },
          { status: 403 }
        );
      }
      const earlyAccessUrl = new URL("/early-access", request.url);
      const redirectRes = NextResponse.redirect(earlyAccessUrl); // Line 738: 307
      if (signedOutNonAllowedUser) {
        clearAuthCookiesOnResponse(request, redirectRes);
      }
      return redirectRes;
    }
    ```
  - **Lines 745–767**: Unauthenticated (Guest / Logged-out) handling:
    ```typescript
    // 3. Logged-out = existing behaviour
    if (
      pathname === "/" ||
      pathname === "/early-access" ||
      pathname.startsWith("/early-access/") ||
      pathname === "/login" ||
      pathname === "/auth/callback" ||
      pathname === "/pricing" ||
      pathname.startsWith("/pricing/")
    ) {
      return NextResponse.next();
    }

    if (pathname.startsWith("/api") || pathname.startsWith("/.netlify")) {
      return NextResponse.json(
        { error: "Early access only" },
        { status: 403 }
      );
    }

    const earlyAccessUrl = new URL("/early-access", request.url);
    return NextResponse.redirect(earlyAccessUrl); // Line 766: CATCH-ALL 307 REDIRECT
    ```

- **Mechanism Summary**:
  1. **Guest `/jobs` Request**:
     - `hasValidSession` is `false`.
     - Middleware checks the public allowlist in lines 746–754 (`/`, `/early-access`, `/login`, `/auth/callback`, `/pricing`).
     - `/jobs` is not in this allowlist.
     - Execution falls through to line 765–766: `return NextResponse.redirect(earlyAccessUrl)`.
     - In Next.js, `NextResponse.redirect()` emits an **HTTP 307 Temporary Redirect**.
  2. **Guest Unknown Paths (`/this-path-definitely-does-not-exist-404-check`)**:
     - `hasValidSession` is `false`.
     - The path is not in the allowlist.
     - Line 765–766 executes, bouncing the request to `/early-access` via HTTP 307.
     - Because middleware intercepts before route resolution, Next.js never evaluates route matching, never reaches `src/app/not-found.tsx`, and never emits an HTTP 404 status.
  3. **Logged-in Unapproved Sessions**:
     - Lines 722–743 bounce unapproved users to `/early-access` via 307 and return 403 on `/api/*`.
  4. **API Requests**:
     - Lines 758–763 return HTTP 403 with `{"error": "Early access only"}` for non-allowlisted API routes.

---

## 3. Redirect & Gating Inventory

| Mechanism | File & Lines | Layer | What It Catches | Current Response | Target Launch Behavior |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **Guest Early-Access Fallback** | `src/middleware.ts:745-767` | Next.js Edge Middleware | Any unauthenticated page request not on allowlist (`/jobs`, `/nonsense-404`, etc.) | **HTTP 307** $\to$ `/early-access` | **HTTP 200** for `/jobs`; **HTTP 404** for unknown paths |
| **Logged-in Unapproved Gate** | `src/middleware.ts:722-743` | Next.js Edge Middleware | Logged-in users whose email is not in `early_access_approved` table | **HTTP 307** $\to$ `/early-access` | Transition to open access / dashboard; no early-access trap |
| **Unauthenticated API Block** | `src/middleware.ts:758-763` | Next.js Edge Middleware | Unauthenticated requests to non-allowlisted `/api/*` routes | **HTTP 403** `{"error": "Early access only"}` | Remove blanket block; preserve handler contracts (POST 503 billing-OFF, GET public radar, GET signed token unsubscribe, GET/HEAD readiness) |
| **Protected Routes Array** | `src/middleware.ts:15-27` | Next.js Edge Middleware | Lists `"/jobs"` in `PROTECTED_ROUTES` (line 17) | Flags `/jobs` as protected | Remove `"/jobs"` from `PROTECTED_ROUTES`; add to `PUBLIC_ROUTES` |
| **Legacy Unlock Fallback** | `src/middleware.ts:628-656` | Next.js Edge Middleware | Test-only flag `__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK` | Bounces protected routes to `/login?returnTo=...` | Retired / superseded by launch open access |
| **Legacy Job Search Alias** | `netlify.toml:81-91` | Netlify Edge | `/job-search`, `/job-search/all` | **HTTP 301** $\to$ `/jobs` | Keep (canonical redirect) |
| **Legacy Paywall Alias** | `netlify.toml:93-97` | Netlify Edge | `/paywall` | **HTTP 301** $\to$ `/jobs` | Keep (canonical redirect) |
| **Netlify Static 404 Fallback** | `netlify.toml:135-139` | Netlify Edge | Unmatched static files on Netlify | **HTTP 404** $\to$ `/404.html` | Keep (static fallback) |

---

## 4. Comprehensive Requirements Specification per Case

Modifying the middleware to remove early access is not a one-line fallback replacement; it involves multiple interdependent branches (guest, session, approved, unapproved, API, unknown paths, and personal route protection). 

**The actual code changes must be executed in a dedicated implementation PR with full regression test coverage across all 7 cases.** Below is the complete requirements specification:

### Case 1: Unauthenticated Guest (`guest`)
- Public browse pages (`/`, `/jobs`, `/jobs/*`, `/pricing`, `/about`, legal pages) must serve HTTP 200 with valid HTML page shell and bounded tokens.
- Must not issue an HTTP 307 redirect to `/early-access`.
- Personal routes (`/dashboard`, `/tracker`, `/resume`, `/profile`, `/settings`, `/radar`, `/applications`, `/onboarding`) must redirect to `/login?returnTo=...` (not `/early-access`).

### Case 2: Logged-in Approved User (`approved`)
- Users with valid sessions access both personal routes (`/dashboard`, `/tracker`, etc.) and public routes without interruption.
- Accessing `/early-access`, `/login`, or `/auth/callback` redirects to `/dashboard`.

### Case 3: Logged-in Unapproved User (`unapproved`)
- Early-access gating is being removed for launch. Signed-in users whose emails were not in `early_access_approved` must NOT remain trapped in an `/early-access` redirect loop or blocked from APIs.
- They must be transitioned to standard authenticated user status (dashboard access or onboarding).

### Case 4: Session Validity & Error Handling (`session`)
- Expired or malformed Supabase sessions must clear auth cookies and redirect to `/login?returnTo=...`.
- Transient database errors or network timeouts during session verification must handle gracefully without infinite redirect loops.

### Case 5: API Endpoints (`API`)
- **Preservation Rule**: Launch removal of the blanket early-access middleware block (`pathname.startsWith("/api") -> 403 {"error": "Early access only"}`) must strictly preserve each existing route handler's authentication, signed-token, HTTP method, request validation, rate-limit, and billing-OFF contracts.
- **Source-Verified Handler Facts**:
  1. **Billing Order & Verify Gates (Payments OFF)**:
     - [`../src/app/api/billing/razorpay/order/route.ts#L19-L24`](../src/app/api/billing/razorpay/order/route.ts#L19-L24): Method **POST** returns **HTTP 503** `BILLING_DISABLED` while payments are OFF (`NEXT_PUBLIC_BILLING_ENABLED !== "true"`).
     - [`../src/app/api/billing/razorpay/verify/route.ts#L92-L97`](../src/app/api/billing/razorpay/verify/route.ts#L92-L97): Method **POST** returns **HTTP 503** `BILLING_DISABLED` while payments are OFF (`NEXT_PUBLIC_BILLING_ENABLED !== "true"`).
  2. **Geo Radar Feed**:
     - [`../src/app/api/radar/route.ts#L233-L270`](../src/app/api/radar/route.ts#L233-L270): Method **GET** is public (has no session or Bearer check).
  3. **Email Unsubscribe Handler**:
     - [`../src/app/api/email/unsubscribe/route.ts#L18-L63`](../src/app/api/email/unsubscribe/route.ts#L18-L63): Method **GET** requires a signed query `token` parameter (returns **HTTP 400** HTML if missing/invalid; returns **HTTP 200** HTML confirmation page if valid).
  4. **Readiness Probe**:
     - [`../src/app/api/health/ready/route.ts#L34-L45`](../src/app/api/health/ready/route.ts#L34-L45): Method **GET** returns JSON with **HTTP 200** or **503**; method **HEAD** returns status only (**HTTP 200** or **503**, no body).

### Case 6: Unknown / Non-existent Paths (`unknown path`)
- Unmatched page routes (e.g. `/this-path-definitely-does-not-exist-404-check`) must NOT be intercepted by middleware or redirected to `/early-access` or `/login`.
- Middleware must allow unknown routes to pass through (`NextResponse.next()`) so that the Next.js App Router performs route resolution, recognizes that no matching page exists, and renders `src/app/not-found.tsx` with a true **HTTP 404** status and the actual branded marker (`Lost in the jungle?`).
- Unmatched API routes must return **HTTP 404**, not redirect to `/early-access`.

### Case 7: Personal Routes Protection (`personal routes`)
- Personal routes (`/dashboard`, `/tracker`, `/resume`, `/profile`, `/settings`, `/radar`, `/applications`, `/onboarding`) **MUST STAY PROTECTED**.
- Removing early access must not make private user areas public or fail open.
- Any unauthenticated access to personal routes must redirect to `/login?returnTo=...`.

---

## 5. Ownership Matrix

| Area | Scope | Ownership | Notes |
| :--- | :--- | :--- | :--- |
| **Public Jobs Feed** | Making `/jobs` public in `src/middleware.ts` | **Flow PR** | Remove `/jobs` from `PROTECTED_ROUTES`; add to `PUBLIC_ROUTES` |
| **Launch Gating Removal** | Removing early-access gate & implementing the 7 requirements | **Config PR** | Dedicated PR with regression tests across all 7 cases |
| **Host Dashboard Review** | Verifying Cloudflare Pages & Netlify clickops | **Dashboard** | Site Owner / Ops check of Page Rules, WAF, and host env vars |

---

## 6. Standalone Live Verification Protocol

The standalone checker `scripts/check-jobs-live.cjs` verifies these conditions against any base URL without third-party dependencies or test runner modifications.

### What It Asserts
**Status plus bounded token heuristic (not job-content or DOM verification)**:
1. **`/jobs` Public Feed**:
   - Asserts HTTP 200 status (rejects 3xx redirects and non-200s).
   - Validates that response is HTML page shell (rejects plain text responses).
   - Rejects empty bodies, server error text (`500 Internal Server Error`, `Application error`, `Unhandled Server Exception`), and soft-404 / error text (`temporarily unavailable`, `job temporarily unavailable`, `404 Page Not Found`, `Page Not Found`, `Lost in the jungle?`).
   - Asserts bounded token heuristic: brand marker (`CareerMonke`) and job keyword (`Jobs`, `job`, `Search`).
2. **Nonsense Path 404 Fallback**:
   - Asserts real HTTP 404 status (rejects 3xx redirects and 200 soft-404s).
   - Token heuristic: requires actual branded not-found marker from `src/app/not-found.tsx` (`Lost in the jungle?` AND `CareerMonke`), not a valid HTML shell.
   - Rejects empty 404 bodies and generic proxy/upstream error strings (e.g. `CareerMonke 404 upstream route failed`).

### Usage
```bash
# Run against live production site (expected to FAIL today with redirect evidence)
node scripts/check-jobs-live.cjs https://careermonke.com

# Run and append dated record to reports/smoke/
node scripts/check-jobs-live.cjs https://careermonke.com --json

# Run offline fixture self-test suite (covers 11 passing and negative control scenarios)
node scripts/check-jobs-live.cjs --test
```
