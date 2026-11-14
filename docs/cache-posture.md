# API Cache Posture & Header Behavior Catalog

**Status**: ACTIVE BASELINE  
**Scope**: All API routes under `src/app/api/**` and serverless functions under `netlify/functions/**`  
**Purpose**: Complete catalog of HTTP caching behavior across all CareerMonke backend endpoints, establishing a textual snapshot baseline to prevent undocumented routes or silent header drift across edge nodes, CDNs, and browsers.  
**RFC Standards**: RFC 9111 (HTTP Caching), RFC 9110 (HTTP Semantics)  
**Guard Scope**: `scripts/test-cache-posture.ts` is an **offline textual snapshot guard** (static file discovery plus source-text `Cache-Control` presence and snippet matching against this catalog). It does not execute runtime route handlers or simulate request branches unless representative branch fixtures are added.

---

## 1. Executive Summary

This catalog inventories every API route and serverless function in CareerMonke, detailing its authentication requirements, current `Cache-Control` header handling, target classification (split by caller state for dual-mode endpoints), and remediation posture.

### Summary Metrics
- **Total Files Audited**: 47 files (`32` Next.js API route files under `src/app/api/**` + `12` Netlify routable serverless functions + `3` internal Netlify helper modules).
- **Routable Endpoints**: 44 active endpoints.
- **Explicitly Sending `Cache-Control`**: 14 endpoints (`12` fully aligned + `2` with partial/unsafe directives noted below).
- **Sending `none set` (No Explicit `Cache-Control`)**: 30 endpoints (`7` `intentionally uncached` POST webhooks/telemetry/ingest/AI RPCs + `21` single-mode `private/no-store` routes + `2` dual-mode `/jobs/search` routes).
- **At-Risk / Remediation Needed (25 endpoints total)**:
  - **21 Single-Mode Private / Authed / Sensitive Routes Missing `no-store`** (`none set`): All 8 admin routes (PII, analytics, audit activity, dead-letter replay), subscriber-only Pro feeds (`jobs/pro`, `netlify/functions/jobs-pro`), Bearer-authenticated candidate match routes (`jobs/top10`, `netlify/functions/jobs-top10`), user account actions (`account/delete`, `account/signout-all`), financial checkout/verification (`billing/razorpay/order`, `billing/razorpay/verify`), and HMAC email unsubscribe HTML/POST routes.
  - **2 Dual-Mode Search Routes (`src/app/api/jobs/search/route.ts`, `netlify/functions/jobs-search.ts`)**: Both read optional `Authorization: Bearer` tokens, check approval and Pro entitlement, read `user_preferences` (Next route also writes `eligibility_filter` on `?eligibility=on|off`), and return Pro-unmasked vs preview-masked rows. Neither sets `Cache-Control` (`none set`) or `Vary: Authorization`. Their **anonymous-safe preview** path is `public cacheable`, while their **authenticated/private** path is `private/no-store` and must **never** be shared-cached.
  - **1 Dual-Mode Stats Route Publicly Caching Authenticated Responses (`netlify/functions/stats.ts`)**: Anonymous `200` sets `"public, max-age=300, s-maxage=300, stale-while-revalidate=600"` (`public cacheable`), and errors return `"no-store"`, **but** the `isAuthenticated && isApproved` `200` branch reuses the same `headers` map and emits `public, max-age=300, s-maxage=300...` without `no-store` or `Vary: Authorization` (unlike `src/app/api/stats/route.ts`, which switches to `"no-store"` with `Vary: Authorization`).
  - **1 Streaming SSE Route Using `no-cache` Rather Than `no-store` (`src/app/api/ai/stream/route.ts`)**: Sends `"no-cache, no-transform"` on HTTP 200 SSE streams (`none set` on 404/JSON errors). Under RFC 9111, `no-cache` permits storage with revalidation—it is **not** equivalent to `private/no-store`.

---

## 2. RFC 9111 Directive Distinction: `no-store` vs `no-cache`

| Directive | RFC 9111 Semantics | Suitable Use Case | Safe for Authenticated / PII / Pro Payloads? |
| :--- | :--- | :--- | :--- |
| **`no-store`** (e.g. `private, no-store` / `private, no-cache, no-store, must-revalidate`) | Prohibits **all** caches (browser and shared CDN/proxy) from storing any part of the request or response. | Account actions, admin PII, billing, Pro feeds, health probes, personalized quotas/recommendations. | **Yes** — guarantees zero cached copies remain on disk or shared edges. |
| **`no-cache`** (e.g. `no-cache, no-transform` on SSE) | Allows caches to **store** the response, requiring origin revalidation before serving a cached copy; `no-transform` forbids proxy compression/buffering. | Server-Sent Events (`text/event-stream`) where proxy buffering breaks chunk delivery. | **No (on its own)** — `no-cache` is **not** `private/no-store` and should be paired with `private, no-store` when streaming user-specific AI completions. |

---

## 3. Complete Catalog Table

> For dual-mode routes (`/api/jobs/search`, `/api/stats`, `netlify/functions/jobs-search.ts`, `netlify/functions/stats.ts`), caller posture is split explicitly into **Anonymous** vs **Authenticated (`Bearer`)**.

| Route / File Path | Methods | Auth Requirement | Current `Cache-Control` Header | Target Classification (Split if Dual-Mode) | Posture Assessment & Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `src/app/api/account/delete/route.ts` | POST | User Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Authenticated account deletion lacks explicit `no-store`. |
| `src/app/api/account/export/route.ts` | POST | User Auth (`Bearer`) | `"no-store"` (via handler) | `private/no-store` | ✅ **Compliant**: Sends `no-store` with `attachment` disposition for personal data export. |
| `src/app/api/account/signout-all/route.ts` | POST | User Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Authenticated global session invalidation lacks explicit `no-store`. |
| `src/app/api/admin/early-access/approve/route.ts` | POST | Admin Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Administrative approval mutation lacks explicit `no-store`. |
| `src/app/api/admin/early-access/reject/route.ts` | POST | Admin Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Administrative rejection mutation lacks explicit `no-store`. |
| `src/app/api/admin/early-access/route.ts` | GET, POST | Admin Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: GET returns early access email PII to admins without `no-store`. |
| `src/app/api/admin/replay/route.ts` | GET, POST | Admin Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Admin dead-letter inspection and replay lacks explicit `no-store`. |
| `src/app/api/admin/stats/route.ts` | GET | Admin Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Internal admin analytics read without `private, no-store`. |
| `src/app/api/admin/users/activity/route.ts` | GET | Admin Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Security audit log and IP activity returned without `private, no-store`. |
| `src/app/api/admin/users/block/route.ts` | POST | Admin Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Admin user suspension mutation lacks explicit `no-store`. |
| `src/app/api/admin/users/route.ts` | GET | Admin Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Returns user list with PII to admins without `private, no-store`. |
| `src/app/api/ai/route.ts` | POST | User Auth (`Bearer`) / Quota | `none set` | `intentionally uncached` | ℹ️ **POST RPC**: Dynamic AI generation POST (`no-store` recommended for defense in depth). |
| `src/app/api/ai/stream/route.ts` | POST | User Auth (`Bearer`) / Quota | `"no-cache, no-transform"` (200 SSE) / `none set` (errors) | Target: `private/no-store` (Current: `no-cache, no-transform`) | ⚠️ **Directive Distinction**: Sends `no-cache, no-transform` for SSE framing (prevents proxy buffering/transform), which is **not** `private/no-store`. Should add `private, no-store` on SSE and `no-store` on JSON errors. |
| `src/app/api/auth/security-event/route.ts` | POST | Public | `none set` | `intentionally uncached` | ✅ **Aligned**: Security telemetry ingest returning `204`. |
| `src/app/api/billing/razorpay/order/route.ts` | POST | User Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Financial order creation lacks explicit `no-store`. |
| `src/app/api/billing/razorpay/verify/route.ts` | POST | User Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Payment verification mutation (`Bearer`-authed) lacks explicit `no-store`. |
| `src/app/api/billing/razorpay/webhook/route.ts` | POST | Razorpay Webhook Signature | `none set` | `intentionally uncached` | ✅ **Aligned**: Server-to-server webhook receiver. |
| `src/app/api/email/unsubscribe/route.ts` | GET, POST | Signed HMAC Token | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: GET renders HTML containing user's email; POST suppresses email; lacks `no-store`. |
| `src/app/api/health/ready/route.ts` | GET, HEAD | Public | `"no-store, no-cache, must-revalidate"` | `private/no-store` | ✅ **Compliant**: Readiness probe prohibits caching via `no-store`. |
| `src/app/api/health/route.ts` | GET, HEAD | Public | `"no-store, no-cache, must-revalidate"` | `private/no-store` | ✅ **Compliant**: Liveness probe prohibits caching via `no-store`. |
| `src/app/api/jobs/interview-pack/route.ts` | GET | Public Sample / Pro (`Bearer`) | `"private, no-cache, no-store, must-revalidate"` (via handler) | `private/no-store` | ✅ **Compliant**: Handler enforces `private, no-cache, no-store, must-revalidate` across responses. |
| `src/app/api/jobs/pro/route.ts` | GET, POST | Pro User (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Paid subscriber job feed returned without `private, no-store`. |
| `src/app/api/jobs/search/route.ts` | GET | Dual-Mode: Public (masked) / User Auth (`Bearer`: Pro & prefs) | `none set` | **Split**: Anon-safe = `public cacheable` / Authed = `private/no-store` | ⚠️ **Dual-Mode Unhedged**: Reads `Authorization: Bearer`, Pro entitlement, and `user_preferences` (and updates `eligibility_filter` on `?eligibility=on|off`), returning Pro-unmasked vs masked data with `none set`. Shared caching **must be strictly forbidden** on authenticated/personalized calls; only unauthenticated calls may be shared-cached with `Vary: Authorization`. |
| `src/app/api/jobs/skill-what-if/route.ts` | GET | Public Sample / Pro (`Bearer`) | `"private, no-cache, no-store, must-revalidate"` (via handler) | `private/no-store` | ✅ **Compliant**: Handler enforces `private, no-cache, no-store, must-revalidate`. |
| `src/app/api/jobs/suggest/route.ts` | GET | Public | `"public, max-age=60"` (200) / `"no-store"` (err) | `public cacheable` | ✅ **Compliant**: Masked `jobs_public` title autocomplete cached 60s; errors/429 strictly `no-store`. |
| `src/app/api/jobs/top10/route.ts` | POST | User Auth (`Bearer`) + Approved / Pro | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Strictly requires `Authorization: Bearer <token>` (returns `401` to guests—no guest path) and computes personalized Pro job rankings; currently omits explicit `no-store`. |
| `src/app/api/me/quota/route.ts` | GET | User Auth (`Bearer`) | `"private, no-cache, no-store, must-revalidate"` | `private/no-store` | ✅ **Compliant**: Authenticated user quota enforces `private, no-cache, no-store, must-revalidate`. |
| `src/app/api/radar/route.ts` | GET | Public | `'public, s-maxage=300, stale-while-revalidate=600'` | `public cacheable` | ✅ **Compliant**: Uniform public job radar edge-cached 5m with 10m SWR and weak ETag. |
| `src/app/api/stats/route.ts` | GET | Dual-Mode: Public (anon) / Approved User Auth (`Bearer`) | `"public, s-maxage=60, stale-while-revalidate=300"` (no `Auth`) / `"no-store"` (`Auth` or err) + `Vary: Authorization` | **Split**: Anon-safe = `public cacheable` / Authed = `private/no-store` | ✅ **Compliant**: Any request with `Authorization` header (valid or invalid) receives `"no-store"` + `Vary: Authorization`; only anonymous calls receive edge `s-maxage`. |
| `src/app/api/ticker/route.ts` | GET | Public | `"public, s-maxage=60, stale-while-revalidate=300"` (200) / `"no-store"` (err) | `public cacheable` | ✅ **Compliant**: Public recent job feed edge-cached 60s with SWR and weak ETag; errors `no-store`. |
| `src/app/api/track/route.ts` | POST | Public / Optional `Bearer` | `none set` | `intentionally uncached` | ✅ **Aligned**: Analytics funnel ingest POST. |
| `netlify/functions/account-delete.ts` | POST | User Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Authed account deletion serverless endpoint lacks explicit `no-store`. |
| `netlify/functions/ai.ts` | POST | User Auth (`Bearer`) / Quota | `none set` | `intentionally uncached` | ℹ️ **POST RPC**: Serverless AI completion POST (`no-store` recommended for defense in depth). |
| `netlify/functions/billing-razorpay-order.ts` | POST | User Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Financial order creation serverless endpoint lacks explicit `no-store`. |
| `netlify/functions/billing-razorpay-verify.ts` | POST | User Auth (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Payment verification serverless endpoint (`Bearer`-authed) lacks explicit `no-store`. |
| `netlify/functions/billing-razorpay-webhook.ts` | POST | Razorpay Webhook Signature | `none set` | `intentionally uncached` | ✅ **Aligned**: Server-to-server webhook receiver. |
| `netlify/functions/email-unsubscribe.ts` | GET, POST | Signed HMAC Token | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Confirmation HTML and email suppression endpoint lacks explicit `no-store`. |
| `netlify/functions/health.ts` | GET | Public | `"no-store, no-cache, must-revalidate"` | `private/no-store` | ✅ **Compliant**: Serverless health check prohibits caching via `no-store`. |
| `netlify/functions/jobs-pro.ts` | GET, POST | Pro User (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Serverless Pro subscriber feed lacks explicit `no-store`. |
| `netlify/functions/jobs-search.ts` | GET | Dual-Mode: Public (masked) / User Auth (`Bearer`: Pro & prefs) | `none set` | **Split**: Anon-safe = `public cacheable` / Authed = `private/no-store` | ⚠️ **Dual-Mode Unhedged**: Mirrors `/api/jobs/search`: inspects `Bearer`, Pro status, and `user_preferences` with `none set`. Shared caching **must not** apply to authenticated/Pro responses; split anonymous-safe vs authenticated/private headers with `Vary: Authorization`. |
| `netlify/functions/jobs-top10.ts` | POST | User Auth (`Bearer`) + Approved / Pro | `none set` | `private/no-store` | ⚠️ **Needs Remediation**: Strictly requires `Authorization: Bearer <token>` (returns `401` to guests—no guest path) and returns personalized Pro job matches without explicit `no-store`. |
| `netlify/functions/stats.ts` | GET | Dual-Mode: Public (anon) / Approved User Auth (`Bearer`) | `"public, max-age=300, s-maxage=300, stale-while-revalidate=600"` (all 200, **even auth!**) / `"no-store"` (403/5xx) | **Split**: Anon-safe = `public cacheable` / Authed = `private/no-store` | ⚠️ **Auth Branch Publicly Cached**: Anonymous 200 is safely `public cacheable`, **but** authenticated approved `200` responses inherit the same `public, max-age=300, s-maxage=300` header with no `Vary: Authorization` or `no-store` override. |
| `netlify/functions/ticker.ts` | GET | Public | `"public, max-age=60, s-maxage=60, stale-while-revalidate=120"` (200) / `"no-store"` (err) | `public cacheable` | ✅ **Compliant**: Edge-cached public ticker with 60s TTL / 120s SWR; errors `no-store`. |
| `netlify/functions/_cors.ts` | N/A | N/A (Helper) | `none set` | `intentionally uncached` | ℹ️ **Internal Helper**: CORS header builder module (not a routable endpoint). |
| `netlify/functions/_logger.ts` | N/A | N/A (Helper) | `none set` | `intentionally uncached` | ℹ️ **Internal Helper**: Safe logger module (not a routable endpoint). |
| `netlify/functions/_sharedRateLimit.ts` | N/A | N/A (Helper) | `none set` | `intentionally uncached` | ℹ️ **Internal Helper**: Shared rate limit utility (not a routable endpoint). |

---

## 4. Classification Breakdown

### 4.1 Anonymous-Safe `public cacheable` Endpoints
Routes whose response is identical for all anonymous callers and exposes zero PII, user preferences, or Pro-unmasked attributes:
- `src/app/api/radar/route.ts`: `'public, s-maxage=300, stale-while-revalidate=600'`
- `src/app/api/ticker/route.ts`: `"public, s-maxage=60, stale-while-revalidate=300"` (`"no-store"` on errors)
- `src/app/api/jobs/suggest/route.ts`: `"public, max-age=60"` (`"no-store"` on 400/429/5xx)
- `netlify/functions/ticker.ts`: `"public, max-age=60, s-maxage=60, stale-while-revalidate=120"` (`"no-store"` on errors)
- **Dual-Mode Anonymous Branches Only**:
  - `src/app/api/stats/route.ts` (**no `Authorization` header only**): `"public, s-maxage=60, stale-while-revalidate=300"`, `Vary: Authorization` (authenticated or any `Authorization` header switches to `"no-store"`).
  - `netlify/functions/stats.ts` (**anonymous callers only**): `"public, max-age=300, s-maxage=300, stale-while-revalidate=600"` (⚠️ authenticated branch must be fixed to send `"no-store"` + `Vary: Authorization`).
  - `src/app/api/jobs/search/route.ts` and `netlify/functions/jobs-search.ts` (**anonymous-safe preview branch only**, no `Authorization` header): target `public cacheable` (currently `none set`).

### 4.2 Private / No-Store Endpoints & Branches
Endpoints handling authenticated sessions (`Bearer`), PII, admin operations, billing, Pro-unmasked data, user preferences, HMAC tokens, or health checks:
- **Compliant (`no-store` already set)**:
  - `src/app/api/health/route.ts`, `src/app/api/health/ready/route.ts`, `netlify/functions/health.ts` (`"no-store, no-cache, must-revalidate"`)
  - `src/app/api/me/quota/route.ts`, `src/app/api/jobs/interview-pack/route.ts`, `src/app/api/jobs/skill-what-if/route.ts` (`"private, no-cache, no-store, must-revalidate"`)
  - `src/app/api/account/export/route.ts` (`"no-store"`)
  - `src/app/api/stats/route.ts` (**authenticated / any `Authorization` header branch**: `"no-store"` + `Vary: Authorization`)
- **Non-`no-store` / Missing `no-store` Remediation Targets**:
  - **Dual-Mode Authenticated Branches (Never Shared-Cache)**: `src/app/api/jobs/search/route.ts` (authenticated `Bearer` / Pro / `user_preferences` / `?eligibility=on|off`), `netlify/functions/jobs-search.ts` (authenticated `Bearer` / Pro / `user_preferences`), and `netlify/functions/stats.ts` (authenticated approved `200` branch currently inherits `public, max-age=300...`).
  - **21 Single-Mode Private/Authed Routes (`none set`)**: All 8 `admin/**` routes, `jobs/pro` & `netlify/functions/jobs-pro`, `jobs/top10` & `netlify/functions/jobs-top10` (`Bearer`-required, no guest mode), `account/delete` & `netlify/functions/account-delete`, `account/signout-all`, `billing/razorpay/order` & `verify` (Next + Netlify), and `email/unsubscribe` (Next + Netlify).
  - **SSE Stream Lacking `no-store`**: `src/app/api/ai/stream/route.ts` currently emits `"no-cache, no-transform"` (`no-cache` != `no-store`).

### 4.3 Intentionally Uncached
Dynamic write operations, webhook receivers, telemetry ingest, and AI RPC endpoints (with `"no-store"` recommended for defense in depth on authed AI RPCs):
- `src/app/api/auth/security-event/route.ts`, `src/app/api/track/route.ts`
- `netlify/functions/billing-razorpay-webhook.ts`, `src/app/api/billing/razorpay/webhook/route.ts`
- `src/app/api/ai/route.ts`, `netlify/functions/ai.ts`
- Internal utility modules: `netlify/functions/_cors.ts`, `_logger.ts`, `_sharedRateLimit.ts`

---

## 5. Remediation Plan & Recommendations

1. **Phase 1 (This PR — Guard & Accurate Catalog Only)**: Lock this baseline via `docs/cache-posture.md` and the offline textual snapshot guard `scripts/test-cache-posture.ts` with zero runtime modifications.
2. **Phase 2 (Future Runtime Hardening)**:
   - **Never add an unconditional `public, s-maxage` header to `/api/jobs/search` or `netlify/functions/jobs-search.ts`.** Follow the exact dual-mode pattern in `src/app/api/stats/route.ts`:
     - Whenever `Authorization` is present (valid or invalid), user preferences are read/mutated (`?eligibility=on|off`), or Pro data is served: return `Cache-Control: no-store` (or `private, no-store, must-revalidate`) and `Vary: Authorization`.
     - Only allow shared caching (`public, s-maxage=60, stale-while-revalidate=120` + `Vary: Authorization`) when no `Authorization` header is present and no user-specific mutation occurred.
   - **Fix `netlify/functions/stats.ts` authenticated `200` branch** to override `headers["Cache-Control"] = "no-store"` and add `Vary: Authorization` whenever `Authorization` is present, matching `src/app/api/stats/route.ts`.
   - **Update `src/app/api/ai/stream/route.ts`** from `"no-cache, no-transform"` to `"private, no-store, no-cache, no-transform"` on HTTP 200 SSE frames (preserving `no-transform` for streaming while preventing storage) and `"no-store"` on non-200 JSON responses.
   - **Add explicit `private, no-store`** across all `/api/admin/**`, `jobs/pro`, `jobs/top10`, `account/**`, `billing/razorpay/**`, and `email/unsubscribe` routes.
