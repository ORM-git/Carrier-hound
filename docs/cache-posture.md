# API Cache Posture & Header Behavior Catalog

**Status**: ACTIVE BASELINE  
**Scope**: All API routes under `src/app/api/**` and serverless functions under `netlify/functions/**`  
**Purpose**: Complete catalog of HTTP caching behavior across all CareerMonke backend endpoints, establishing an explicit baseline to prevent implicit or inconsistent caching across edge nodes, CDNs, and browsers.  
**RFC Standards**: RFC 9111 (HTTP Caching), RFC 9110 (HTTP Semantics), RFC 8058 (One-Click Unsubscribe)  

---

## 1. Executive Summary

This catalog inventories every API route and serverless function in CareerMonke, detailing its authentication requirements, current `Cache-Control` header handling, target classification, and security/correctness posture.

### Summary Metrics
- **Total Files Audited**: 46 files (31 Next.js API route files under `src/app/api/**` + 12 Netlify serverless functions + 3 internal Netlify helper modules).
- **Routable Endpoints**: 43 active endpoints.
- **Currently Cache-Control Compliant Routes**: 22 endpoints (explicitly configured with either shared edge caching `s-maxage` / `stale-while-revalidate`, or strict `no-store` / `no-cache`).
- **Endpoints Lacking Explicit Cache-Control**: 21 endpoints (send `none set`, relying on implicit server/CDN default behaviors).
- **Misclassified / At-Risk Routes**:
  - **19 Sensitive / Authed Endpoints Missing `no-store`**: Admin inspection endpoints (users list PII, analytics, audit activity, dead-letter replay), paid subscriber Pro feeds (`/api/jobs/pro`), user account actions (`delete`, `signout-all`), financial checkout/verification (`billing/razorpay/*`), and personalized email unsubscribe confirmation HTML. These endpoints currently omit `Cache-Control`, risking shared proxy/browser cache retention of confidential or authenticated data.
  - **2 Public Search Endpoints Lacking Explicit Caching**: `/api/jobs/search` (Next.js and Netlify) has no explicit `Cache-Control` policy, causing implicit caching differences between Cloudflare Edge and origin.

---

## 2. Complete Catalog Table

The table below catalogs every API endpoint across `src/app/api/**` and `netlify/functions/**`.

| Route / File Path | Methods | Auth Requirement | Current Cache-Control Header | Target Classification | Posture Assessment & Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `src/app/api/account/delete/route.ts` | POST | User Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Account deletion mutation lacks explicit `no-store`. Should send `private, no-cache, no-store, must-revalidate`. |
| `src/app/api/account/export/route.ts` | POST | User Auth | `"no-store"` (via handler) | `private/no-store` | ✅ **Compliant**: Sends `no-store` header with `attachment` disposition for GDPR personal data export. |
| `src/app/api/account/signout-all/route.ts` | POST | User Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Global session invalidation mutation lacks explicit `no-store`. Should send `private, no-cache, no-store`. |
| `src/app/api/admin/early-access/approve/route.ts` | POST | Admin Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Administrative mutation lacks explicit `no-store`. |
| `src/app/api/admin/early-access/reject/route.ts` | POST | Admin Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Administrative mutation lacks explicit `no-store`. |
| `src/app/api/admin/early-access/route.ts` | GET, POST | Admin Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: GET returns early access email requests (PII) to admins without `no-store`. Risk of shared cache leak. |
| `src/app/api/admin/replay/route.ts` | GET, POST | Admin Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Admin dead-letter queue retrieval and re-execution lacks explicit `no-store`. |
| `src/app/api/admin/stats/route.ts` | GET | Admin Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Internal admin analytics numbers returned without `private, no-store`. |
| `src/app/api/admin/users/activity/route.ts` | GET | Admin Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Security audit log and IP activity data returned without `private, no-store`. |
| `src/app/api/admin/users/block/route.ts` | POST | Admin Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: User suspension/ban administrative mutation lacks explicit `no-store`. |
| `src/app/api/admin/users/route.ts` | GET | Admin Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Returns full user list with PII to verified admins; lacks `private, no-store` header. |
| `src/app/api/ai/route.ts` | POST | User Auth / Quota | `none set` | `intentionally uncached` | ✅ **Acceptable**: Dynamic AI completion POST. Recommended to add explicit `no-store` for defense in depth. |
| `src/app/api/ai/stream/route.ts` | POST | User Auth / Quota | `"no-cache, no-transform"` | `private/no-store` | ✅ **Compliant**: Streaming SSE route explicitly disables caching and compression/proxy transformation. |
| `src/app/api/auth/security-event/route.ts` | POST | Public | `none set` | `intentionally uncached` | ✅ **Compliant**: Security telemetry ingest endpoint. |
| `src/app/api/billing/razorpay/order/route.ts` | POST | User Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Financial checkout order creation returns order ID and key; lacks explicit `no-store`. |
| `src/app/api/billing/razorpay/verify/route.ts` | POST | Webhook / User Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Financial payment fulfillment transaction lacks explicit `no-store`. |
| `src/app/api/early-access/route.ts` | POST | Public | `none set` | `intentionally uncached` | ✅ **Compliant**: Public waitlist email submission POST. |
| `src/app/api/email/unsubscribe/route.ts` | GET, POST | Signed HMAC Token | `none set` | `private/no-store` | ⚠️ **Misclassified**: GET renders HTML containing user's personal email address; POST performs suppression; both lack `no-store`. |
| `src/app/api/health/ready/route.ts` | GET, HEAD | Public | `"no-store, no-cache, must-revalidate"` | `private/no-store` | ✅ **Compliant**: Readiness probe explicitly forbids caching to ensure real-time health checks. |
| `src/app/api/health/route.ts` | GET, HEAD | Public | `"no-store, no-cache, must-revalidate"` | `private/no-store` | ✅ **Compliant**: Liveness probe explicitly forbids caching to ensure real-time health checks. |
| `src/app/api/jobs/interview-pack/route.ts` | GET | Public Sample / Pro | `"private, no-cache, no-store, must-revalidate"` (via handler) | `private/no-store` | ✅ **Compliant**: Handler enforces strict `private, no-cache, no-store, must-revalidate` for user-specific interview prep. |
| `src/app/api/jobs/pro/route.ts` | GET, POST | Pro User (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Misclassified**: Paid subscriber-only exclusive job listings and salary data returned without `private, no-store`. |
| `src/app/api/jobs/search/route.ts` | GET | Public | `none set` | `public cacheable` | ⚠️ **Misclassified**: Public job search read queries omit explicit `Cache-Control`. Should send edge `s-maxage` or explicit baseline. |
| `src/app/api/jobs/skill-what-if/route.ts` | GET | Public Sample / Pro | `"private, no-cache, no-store, must-revalidate"` (via handler) | `private/no-store` | ✅ **Compliant**: Handler enforces strict `private, no-cache, no-store, must-revalidate` for candidate simulation data. |
| `src/app/api/jobs/suggest/route.ts` | GET | Public | `"public, max-age=60"` (200) / `"no-store"` (err) | `public cacheable` | ✅ **Compliant**: Public search autocomplete queries cached 60 seconds; rate limits and errors strictly `no-store`. |
| `src/app/api/jobs/top10/route.ts` | POST | User Auth / Guest | `none set` | `intentionally uncached` | ✅ **Compliant**: Dynamic personalized candidate scoring computation POST. |
| `src/app/api/me/quota/route.ts` | GET | User Auth | `"private, no-cache, no-store, must-revalidate"` | `private/no-store` | ✅ **Compliant**: Authenticated user quota accurately enforces `private, no-cache, no-store, must-revalidate`. |
| `src/app/api/radar/route.ts` | GET | Public | `'public, s-maxage=300, stale-while-revalidate=600'` | `public cacheable` | ✅ **Compliant**: Global job radar cacheable on shared CDN edge for 5 mins with 10 min SWR and weak ETag support. |
| `src/app/api/stats/route.ts` | GET | Public / User Auth | `"public, s-maxage=60, stale-while-revalidate=300"` (anon) / `"no-store"` (auth) | `public cacheable` (anon) / `private/no-store` (auth) | ✅ **Compliant**: Dual-posture: anonymous public corpus count edge-cached with SWR; authenticated full metrics strictly `no-store`. |
| `src/app/api/ticker/route.ts` | GET | Public | `"public, s-maxage=60, stale-while-revalidate=300"` (200) / `"no-store"` (err) | `public cacheable` | ✅ **Compliant**: Public recent job feed edge-cached 60s with SWR and weak ETag; failures strictly `no-store`. |
| `src/app/api/track/route.ts` | POST | Public / Session | `none set` | `intentionally uncached` | ✅ **Compliant**: Funnel analytics ingest POST. |
| `netlify/functions/account-delete.ts` | POST | User Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Authed account deletion serverless endpoint lacks explicit `no-store`. |
| `netlify/functions/ai.ts` | POST | User Auth / Quota | `none set` | `intentionally uncached` | ✅ **Acceptable**: Serverless AI completion POST. |
| `netlify/functions/billing-razorpay-order.ts` | POST | User Auth | `none set` | `private/no-store` | ⚠️ **Misclassified**: Financial order creation serverless endpoint lacks explicit `no-store`. |
| `netlify/functions/billing-razorpay-verify.ts` | POST | Webhook / Signature | `none set` | `private/no-store` | ⚠️ **Misclassified**: Payment verification serverless endpoint lacks explicit `no-store`. |
| `netlify/functions/billing-razorpay-webhook.ts` | POST | Webhook Signature | `none set` | `intentionally uncached` | ✅ **Compliant**: Webhook receiver endpoint. |
| `netlify/functions/email-unsubscribe.ts` | GET, POST | Signed HMAC Token | `none set` | `private/no-store` | ⚠️ **Misclassified**: User confirmation HTML rendering serverless endpoint lacks explicit `no-store`. |
| `netlify/functions/health.ts` | GET | Public | `"no-store, no-cache, must-revalidate"` | `private/no-store` | ✅ **Compliant**: Netlify health check explicitly forbids caching. |
| `netlify/functions/jobs-pro.ts` | GET, POST | Pro User (`Bearer`) | `none set` | `private/no-store` | ⚠️ **Misclassified**: Serverless Pro subscriber feed lacks explicit `no-store`. |
| `netlify/functions/jobs-search.ts` | GET | Public | `none set` | `public cacheable` | ⚠️ **Misclassified**: Serverless search endpoint lacks explicit `Cache-Control` header. |
| `netlify/functions/jobs-top10.ts` | POST | User Auth / Guest | `none set` | `intentionally uncached` | ✅ **Compliant**: Top 10 match scoring serverless POST. |
| `netlify/functions/stats.ts` | GET | Public / User Auth | `"public, max-age=300, s-maxage=300, stale-while-revalidate=600"` (anon) / `"no-store"` (err) | `public cacheable` / `private/no-store` | ✅ **Compliant**: Edge-cached public stats with 5m TTL / 10m SWR; errors no-store. |
| `netlify/functions/ticker.ts` | GET | Public | `"public, max-age=60, s-maxage=60, stale-while-revalidate=120"` (200) / `"no-store"` (err) | `public cacheable` | ✅ **Compliant**: Edge-cached ticker with 60s TTL / 120s SWR. |
| `netlify/functions/_cors.ts` | N/A | N/A | `none set` | `intentionally uncached` | ℹ️ **Internal Helper**: CORS header builder utility module (not a standalone HTTP endpoint). |
| `netlify/functions/_logger.ts` | N/A | N/A | `none set` | `intentionally uncached` | ℹ️ **Internal Helper**: Safe structured logger utility module (not a standalone HTTP endpoint). |
| `netlify/functions/_sharedRateLimit.ts` | N/A | N/A | `none set` | `intentionally uncached` | ℹ️ **Internal Helper**: Distributed rate limit verification utility module (not a standalone HTTP endpoint). |

---

## 3. Detailed Classification Analysis

### 3.1 Public Cacheable
Routes whose payload is identical for all callers and contains no personally identifiable, financial, or subscriber-gated data:
- `src/app/api/radar/route.ts`: `'public, s-maxage=300, stale-while-revalidate=600'`
- `src/app/api/stats/route.ts` (anonymous caller mode): `"public, s-maxage=60, stale-while-revalidate=300"`, `Vary: Authorization`
- `src/app/api/ticker/route.ts`: `"public, s-maxage=60, stale-while-revalidate=300"`
- `src/app/api/jobs/suggest/route.ts`: `"public, max-age=60"`
- `netlify/functions/stats.ts`: `"public, max-age=300, s-maxage=300, stale-while-revalidate=600"`
- `netlify/functions/ticker.ts`: `"public, max-age=60, s-maxage=60, stale-while-revalidate=120"`
- `src/app/api/jobs/search/route.ts` and `netlify/functions/jobs-search.ts`: Target classification is `public cacheable`, but currently omitted.

### 3.2 Private / No-Store
Routes returning sensitive personal information (PII), administrative audits, financial data, health telemetry, or user-specific quotas:
- **Health probes**: `src/app/api/health/route.ts`, `src/app/api/health/ready/route.ts`, `netlify/functions/health.ts` properly set `"no-store, no-cache, must-revalidate"`.
- **User quotas & calculations**: `src/app/api/me/quota/route.ts`, `src/app/api/jobs/interview-pack/route.ts`, `src/app/api/jobs/skill-what-if/route.ts` properly set `"private, no-cache, no-store, must-revalidate"`.
- **Account export**: `src/app/api/account/export/route.ts` properly sets `"no-store"`.
- **Streaming AI**: `src/app/api/ai/stream/route.ts` properly sets `"no-cache, no-transform"`.
- **At-Risk Authed Routes (Missing `no-store`)**: All `src/app/api/admin/**` routes (users, stats, activity, early-access, replay), `src/app/api/jobs/pro/route.ts`, `netlify/functions/jobs-pro.ts`, account mutations (`delete`, `signout-all`), and checkout operations (`billing/razorpay/*`). These require remediation in future PRs to explicitly declare `private, no-store, must-revalidate`.

### 3.3 Intentionally Uncached
Dynamic write operations and telemetry ingestion:
- Waitlist submissions (`early-access`)
- Client analytics and security event collectors (`track`, `auth/security-event`)
- Webhook endpoints (`billing-razorpay-webhook.ts`)
- Interactive AI generation mutations (`ai/route.ts`, `netlify/functions/ai.ts`)

---

## 4. Remediation Plan & Recommendations

1. **Phase 1 (This PR)**: Snapshot and lock the baseline catalog via `docs/cache-posture.md` and offline guard test `scripts/test-cache-posture.ts` to prevent undocumented routes or silent drift.
2. **Phase 2 (Proposed Runtime Hardening)**:
   - Introduce an edge-level middleware default or utility wrapper setting `Cache-Control: private, no-cache, no-store, must-revalidate` on all `/api/admin/**` and authenticated endpoints.
   - Add explicit `Cache-Control: public, s-maxage=60, stale-while-revalidate=120` to `/api/jobs/search` with appropriate `Vary` headers.
   - Standardize all financial mutation endpoints to strictly emit `no-store`.
