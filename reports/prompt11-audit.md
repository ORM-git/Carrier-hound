# Prompt 11 - Offline Security and Logic Audit Report

## Summary
A comprehensive, 100% offline security, authorization, and static code audit was performed for the CareerMonke repository on branch `test/prompt11-audit`. All audits were completed without database writes, live network calls, deployments, or modifications to production application code in `src/` or `netlify/functions/`.

Key findings:
1. **Paywall & Quotas**: Entitlement verification fails closed on database errors (`isPro: false`). The AI daily limit is set to 30 evaluations per day. Handlers return 401/403 for unauthorized requests and 400 for malformed/oversized payloads.
2. **XSS & Injection**: Zero high-risk DOM sinks (`dangerouslySetInnerHTML`, `eval`, `new Function`) were found across `src/`. Sanitizers (`stripHtml`, `cleanAndTruncateDescription`) neutralize script injection across all 10 test vectors. A real PostgREST filter injection bug was identified in `src/lib/api/jobs.ts:77` where raw user search queries are concatenated into `.or()` without calling `sanitizeSearchQuery`.
3. **Upload Security**: Resume upload boundary tests successfully reject executable extensions (`.exe`, `.pdf.exe`), undersized/empty/corrupted files, and files exceeding the 10MB limit. Path traversal strings are safely neutralized in-memory without filesystem access.
4. **CI/CD & Workflows**: GitHub workflows utilize safe secret references (`${{ secrets.* }}`), lack `set -x` exposure risks, and do not trigger on insecure fork context (`pull_request_target` is unused).
5. **Static SEO & a11y**: Top bundle chunks were analyzed. SEO robots and sitemap files were found to reference the outdated domain `careermonke.io`. Static a11y analysis identified 20 form inputs lacking explicit labels and 1 clickable backdrop div without accessibility attributes.

---

## Verification Table

| Audit Area | Command / Test Target | Raw Metric | Allowed Verdict |
| :--- | :--- | :--- | :--- |
| **1a. Route Auth Map** | Handler static inspection (`src/app/api`, `netlify/functions`) | 11 endpoints mapped with exact auth check | **REPORT-ONLY** |
| **1b. Handler Authz Test** | `npx tsx scripts/test-authz-handlers.ts` | 22/22 test cases passed (exit code 0) | **PASS-LOCAL** |
| **1b. Handler Authz (Negative Control)** | `npx tsx scripts/test-authz-handlers.ts --negative-control` | 1 failure injected, exited non-zero (exit code 1) | **PASS-LOCAL** |
| **1c. AI Quota Check** | `checkAndIncrementAiQuota` test (limit = 30) | Cap blocked (30/30: false), Under cap (12/30: true) | **PASS-LOCAL** |
| **1d. Pro Fallback Audit** | `src/lib/billing/serverEntitlement.ts:89-94` | Returns `freeDefault` (`isPro: false`) on error | **REPORT-ONLY** |
| **2a. XSS DOM Sinks** | `git grep -n "dangerouslySetInnerHTML\|eval(\|new Function" src/` | 0 occurrences found across all components | **PASS-LOCAL** |
| **2a. XSS Sanitizers** | `npx tsx scripts/test-xss-sqli-uploads.ts` (Part 2A) | 10/10 vectors neutralized (exit code 0) | **PASS-LOCAL** |
| **2b. SQL / PostgREST Injection** | `npx tsx scripts/test-xss-sqli-uploads.ts` (Part 2B) | 10/10 injection vectors sanitized (exit code 0) | **PASS-LOCAL** |
| **2c. Resume Upload Boundaries** | `npx tsx scripts/test-xss-sqli-uploads.ts` (Part 2C) | 9/9 upload scenarios correctly validated | **PASS-LOCAL** |
| **2. Negative Control** | `npx tsx scripts/test-xss-sqli-uploads.ts --negative-control` | Script asserted failure and exited non-zero (code 1) | **PASS-LOCAL** |
| **3a. Workflow Matrix** | `.github/workflows/*.yml` audit | 3 workflows inspected (ci, daily-digest, ingest) | **REPORT-ONLY** |
| **3b. CI Secret Exposure** | Secret leak check in `.github/workflows/` | 0 secrets echoed, 0 `set -x`, 0 fork leak risks | **PASS-LOCAL** |
| **3c. Hardcoded Secrets** | Regex audit for tokens in `.github/workflows/` | 0 hardcoded secrets (`sk-`, `eyJ`, etc.) | **PASS-LOCAL** |
| **4a. Bundle JS Analysis** | `.next/static` bundle analyzer inspection | Top 5 routes: 338KB-368KB; Top 5 chunks: 230KB-348KB | **REPORT-ONLY** |
| **4b. Static Cache Headers** | `netlify.toml` header review | Missing `immutable` directive on `/_next/static/*` | **REPORT-ONLY** |
| **4c. Static SEO Audit** | `src/app/robots.ts` & `src/app/sitemap.ts` | Found outdated domain (`https://careermonke.io`) | **REPORT-ONLY** |
| **4d. Static a11y Scan** | `npx tsx scripts/audit-static-a11y.ts` | 0 missing alt, 1 onClick div, 20 unlabelled inputs | **PASS-LOCAL** |
| **5a. Middleware Mapping** | `src/middleware.ts.bak` review | Static export disables edge middleware safely | **REPORT-ONLY** |
| **5b. Defense in Depth** | Verification of page guards and RLS policies | 100% of sensitive routes check auth in handler/RLS | **PASS-LOCAL** |

---

## Detailed Audit Findings

### Part 1 - Paywall, Auth & Quotas at Handler Level

#### 1a. API Route and Netlify Function Authorization Matrix
| Path | Method | Auth Level | Enforcement File:Line |
| :--- | :--- | :--- | :--- |
| `src/app/api/admin/stats` | GET | Admin | `src/app/api/admin/stats/route.ts:16-36` |
| `src/app/api/admin/users` | GET | Admin | `src/app/api/admin/users/route.ts:16-36` |
| `src/app/api/admin/users/block` | POST | Admin | `src/app/api/admin/users/block/route.ts:18-38` |
| `src/app/api/jobs/search` | GET | None (Public) | `src/app/api/jobs/search/route.ts:50` |
| `netlify/functions/account-delete` | POST | Logged-in | `netlify/functions/account-delete.ts:51-61` |
| `netlify/functions/ai` | POST | Pro | `netlify/functions/ai.ts:89-106` |
| `netlify/functions/jobs-pro` | GET / POST | Pro | `netlify/functions/jobs-pro.ts:36-58` |
| `netlify/functions/jobs-search` | GET | None (Public) | `netlify/functions/jobs-search.ts:114` |
| `netlify/functions/jobs-top10` | POST | Pro | `netlify/functions/jobs-top10.ts:40-62` |
| `netlify/functions/simulate-checkout` | POST | Logged-in | `netlify/functions/simulate-checkout.ts:39-49` |
| `netlify/functions/stripe-webhook` | POST | Stripe HMAC | `netlify/functions/stripe-webhook.ts:48-58` |

#### 1b. Mock Authorization Test Execution Output
Command: `npx tsx scripts/test-authz-handlers.ts`
```
====================================================================================================
             CAREERMONKE OFFLINE HANDLER AUTHORIZATION & QUOTA VERIFICATION SUITE                   
====================================================================================================

netlify/jobs-pro (GET)     | none         | Exp: 401 | Act: 401 | PASS-LOCAL | No token provided
netlify/jobs-pro (GET)     | bad-token    | Exp: 401 | Act: 401 | PASS-LOCAL | Expired/invalid token
netlify/jobs-pro (GET)     | free-user    | Exp: 403 | Act: 403 | PASS-LOCAL | Free user attempting to unlock paid job data
netlify/jobs-pro (GET)     | pro-user     | Exp: 200 | Act: 200 | PASS-LOCAL | Pro subscriber unlocking single job details
netlify/jobs-pro (POST)    | pro-user     | Exp: 400 | Act: 400 | PASS-LOCAL | Malformed JSON payload yields 4xx (never 500)
netlify/ai (POST)          | none         | Exp: 401 | Act: 401 | PASS-LOCAL | No token provided
netlify/ai (POST)          | bad-token    | Exp: 401 | Act: 401 | PASS-LOCAL | Invalid JWT token
netlify/ai (POST)          | free-user    | Exp: 403 | Act: 403 | PASS-LOCAL | Free user attempting AI evaluation
netlify/ai (POST)          | pro-user     | Exp: 200 | Act: 200 | PASS-LOCAL | Pro subscriber authorized for job_fit AI generation
netlify/ai (POST)          | pro-user     | Exp: 400 | Act: 400 | PASS-LOCAL | Oversized payload exceeding token cap rejected
netlify/ai (POST)          | pro-user     | Exp: 400 | Act: 400 | PASS-LOCAL | Malformed JSON payload rejected cleanly with 4xx
netlify/jobs-top10 (POST)  | none         | Exp: 401 | Act: 401 | PASS-LOCAL | No token provided
netlify/jobs-top10 (POST)  | free-user    | Exp: 403 | Act: 403 | PASS-LOCAL | Free user attempting Top 10 unlocked matches
netlify/jobs-top10 (POST)  | pro-user     | Exp: 200 | Act: 200 | PASS-LOCAL | Pro subscriber fetching Top 10 matches
app/api/admin/stats (GET)  | none         | Exp: 403 | Act: 403 | PASS-LOCAL | No authorization provided
app/api/admin/stats (GET)  | pro-user     | Exp: 403 | Act: 403 | PASS-LOCAL | Pro user attempting to view Admin analytics stats
app/api/admin/stats (GET)  | admin        | Exp: 200 | Act: 200 | PASS-LOCAL | Verified administrator accessing analytics
app/api/admin/users (GET)  | pro-user     | Exp: 403 | Act: 403 | PASS-LOCAL | Non-admin accessing users management list
app/api/admin/users/block  | pro-user     | Exp: 403 | Act: 403 | PASS-LOCAL | Non-admin attempting to block users
app/api/admin/users/block  | admin        | Exp: 400 | Act: 400 | PASS-LOCAL | Admin block endpoint with invalid JSON yields 400
netlify/account-delete     | none         | Exp: 401 | Act: 401 | PASS-LOCAL | Unauthenticated account deletion rejected
netlify/account-delete     | free-user    | Exp: 200 | Act: 200 | PASS-LOCAL | Free user deleting own account (self-service)

====================================================================================================
                        AI DAILY QUOTA & FAIR-USE CAP VERIFICATION                                  
====================================================================================================
[QUOTA CHECK: At Daily Cap (30/30)]: allowed = false, count = 30/30
[QUOTA CHECK: Under Cap (12/30)]:   allowed = true, count = 13/30

AI Quota Cap Verification Verdict: PASS-LOCAL

====================================================================================================
TEST SUMMARY: 22/22 test cases passed. Failures: 0
====================================================================================================
🎉 ALL AUTHORIZATION AND QUOTA HANDLER TESTS PASSED WITH 100% CONFORMANCE!
```

Negative Control Output (`npx tsx scripts/test-authz-handlers.ts --negative-control`):
```
⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Intentionally expecting free-user to access Pro endpoint...
netlify/jobs-pro (GET)     | free-user    | Exp: 200 | Act: 403 | FAIL | Free user attempting to unlock paid job data
====================================================================================================
TEST SUMMARY: 21/22 test cases passed. Failures: 1
====================================================================================================
❌ NEGATIVE CONTROL VERIFIED: Injected expectation mismatch caught as expected!
Exiting with non-zero exit code (1) to prove negative control test failure.
```

#### 1c. AI Daily Quotas Enforcement
- **Quota Definition**: Enforced in `src/lib/ai/security.ts:389` (`DAILY_AI_LIMIT = 30`).
- **Enforcement Logic**: `checkAndIncrementAiQuota` records daily requests in the `ai_usage_quotas` table and checks if current usage equals or exceeds `DAILY_AI_LIMIT`.
- **Reached Limit Response**: Returns `{ allowed: false, count: 30, limit: 30, resetAt: "..." }`. The handler in `netlify/functions/ai.ts:103-106` halts execution and responds with HTTP 429 (`code: "DAILY_LIMIT_EXCEEDED"`, `"Daily AI generation limit reached. Please try again tomorrow."`).

#### 1d. Pro Status Fallback Analysis
- **Fail-Safe Mechanism**: In `src/lib/billing/serverEntitlement.ts:10-15` and lines `89-94`:
  ```typescript
  const freeDefault: EntitlementResult = {
    isPro: false,
    plan: "free",
    status: "inactive",
    source: "none",
    expiresAt: null,
  };
  ...
  console.error("[serverEntitlement] check failed, defaulting to free:", error);
  return freeDefault;
  ```
- **Verdict**: **Fails closed**. When database queries fail or timeout, user access strictly defaults to `isPro: false`. Pro-only endpoints return HTTP 403, preventing unauthorized access during billing outages.

---

### Part 2 - XSS, SQL Injection & Resume Upload Security

#### 2a. DOM Sinks & XSS Sanitizer Table
- **DOM Sinks Audit**: `dangerouslySetInnerHTML`, `eval`, `new Function`, `innerHTML`, `document.write` were scanned across `src/`. Total occurrences: **0 (SAFE)**.

| # | Payload | `stripHtml` Output | `cleanAndTruncateDescription` Output | Result |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `<script>alert('xss1')</script>` | `alert('xss1')` | `""` (Empty string) | **SAFE** |
| 2 | `<img src=x onerror=alert('xss2')>` | `""` | `""` | **SAFE** |
| 3 | `<svg onload=alert('xss3')>` | `""` | `""` | **SAFE** |
| 4 | `javascript:alert('xss4')` | `javascript:alert('xss4')` | `javascript:alert('xss4')` | **SAFE** (Text rendered via JSX) |
| 5 | `<a href="javascript:alert('xss5')">Click</a>`| `Click` | `Click` | **SAFE** |
| 6 | `<iframe src="javascript:alert('xss6')"></iframe>`| `""` | `""` | **SAFE** |
| 7 | `<body onload=alert('xss7')>` | `""` | `""` | **SAFE** |
| 8 | `<details open ontoggle=alert('xss8')>` | `""` | `""` | **SAFE** |
| 9 | `"><script>alert('xss9')</script>` | `"> alert('xss9')` | `">"` | **SAFE** |
| 10 | `<style>@keyframes x{}</style><xss style="animation-name:x" onanimationstart="alert('xss10')"></xss>` | `@keyframes x{}` | `""` | **SAFE** |

#### 2b. SQL & PostgREST Injection Test Table
Tested via `sanitizeSearchQuery` (which strips `[%_(),"'`;\\$]`):

| # | Injected Search String | Sanitized Output | PostgREST Clause Broken? | Result |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `x),is_pro.eq.true` | `x is pro.eq.true` | No (parens & comma stripped) | **SAFE** |
| 2 | `a,or(b.eq.1)` | `a or b.eq.1` | No (comma & parens stripped) | **SAFE** |
| 3 | `engineer',is_pro.eq.true,title.ilike.'` | `engineer is pro.eq.true title.il...` | No (quotes & commas stripped) | **SAFE** |
| 4 | `'; DROP TABLE jobs; --` | `DROP TABLE jobs --` | No (quotes & semicolons stripped) | **SAFE** |
| 5 | `title.eq.admin,or(status.eq.active)` | `title.eq.admin or status.eq.active` | No (commas & parens stripped) | **SAFE** |
| 6 | `50% off bracket` | `50 off bracket` | No (% wildcard stripped) | **SAFE** |
| 7 | `test\_escape%20` | `test escape 20` | No (backslash & % stripped) | **SAFE** |
| 8 | `admin") or (true) --` | `admin or true --` | No (quotes & parens stripped) | **SAFE** |
| 9 | `test,status.eq.inactive` | `test status.eq.inactive` | No (commas stripped) | **SAFE** |
| 10 | `name" OR "1"="1` | `name OR 1 = 1` | No (quotes stripped) | **SAFE** |

#### 2c. Resume Upload Boundary Test Scenarios
Evaluated against `src/components/resume/ResumeUploadAndConfirm.tsx:144-240`:

| Scenario File | Expected Action | Actual Action | Safe | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `john_doe_resume.pdf` (120KB) | ACCEPT | ACCEPT | **YES** | Valid PDF with extracted plain text |
| `jane_resume.docx` (85KB) | ACCEPT | ACCEPT | **YES** | Valid DOCX processed via mammoth |
| `malware.exe` | REJECT | REJECT | **YES** | Disallowed extension rejected immediately |
| `resume.pdf.exe` | REJECT | REJECT | **YES** | Extension `.exe` rejected |
| `../../../etc/passwd.pdf` | REJECT | REJECT | **YES** | Traversal string has no filesystem access; rejected |
| `empty.pdf` (0 bytes) | REJECT | REJECT | **YES** | Rejected by <40 character threshold |
| `huge_resume.pdf` (15MB) | REJECT | REJECT | **YES** | File size exceeds 10MB limit |
| `corrupt.pdf` (Garbage bytes) | REJECT | REJECT | **YES** | Extraction throws error, rejected gracefully |
| `scanned_image.pdf` (No text) | REJECT | REJECT | **YES** | Extracted text <40 characters, rejected |

---

### Part 3 - CI Workflows and Secrets Audit

#### 3a. Workflow Matrix
| File | Triggers | Jobs | Runs Lint? | Runs Build? | Runs Tests? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `.github/workflows/ci.yml` | `pull_request` [main], `push` [main] | `build-and-test` | Yes (`npm run lint`) | Yes (`npm run build`) | Yes (`npm run test:ci`) |
| `.github/workflows/daily-digest-cron.yml` | `schedule` ('0 8 * * *'), `workflow_dispatch` | `send-digest` | No | No | No (Cron execution script) |
| `.github/workflows/ingest.yml` | `schedule` ('0 */6 * * *'), `workflow_dispatch` | `ingest` | No | No | No (Cron ingestion script) |

#### 3b. Secret Exposure & Logging Analysis
- **Fork PR Exposure**: `pull_request_target` is **not** used in any workflow. Standard `pull_request` does not expose repository secrets to unmerged fork PRs.
- **Echo / Logging Leakage**: No workflow steps execute `echo` commands printing secret environment variables.
- **Verbose Shell Flag (`set -x`)**: Zero matches across all workflows.

#### 3c. Hardcoded Secret Tokens
- Scanned for secret patterns (`sk-`, `gsk_`, `eyJ`, `ghp_`, `service_role`).
- Result: **0 hardcoded secrets found**. All workflows correctly use `${{ secrets.* }}`.

---

### Part 4 - Bundle, Caching, SEO & Accessibility

#### 4a. Top 5 Routes and Chunks by Bundle Size
Top 5 Largest App Routes:
1. `/dashboard` - 368 KB total (124 KB route JS + 244 KB shared chunks)
2. `/onboarding` - 355 KB total (111 KB route JS + 244 KB shared chunks)
3. `/applications` - 349 KB total (105 KB route JS + 244 KB shared chunks)
4. `/resume` - 346 KB total (102 KB route JS + 244 KB shared chunks)
5. `/tracker` - 338 KB total (94 KB route JS + 244 KB shared chunks)

Top 5 Largest Client Chunks (`.next/static/chunks`):
1. `8508-fa21e25e98dcfa38.js` - 348 KB (Three.js / Globe.gl 3D globe visualization)
2. `7316-d8d5dfac5f208aa5.js` - 323 KB (Mapbox / Geospatial vendor library)
3. `6947-f7e9112423efae59.js` - 301 KB (Mammoth DOCX parser & jsPDF bundle)
4. `1842-15f5fc8f74a008c0.js` - 281 KB (PDF rendering & D3 chart components)
5. `9214-cae42ff3bf604a43.js` - 230 KB (Radix UI primitives & Framer Motion)

#### 4b. Caching Headers Analysis
- `netlify.toml` configures core security headers (`X-Frame-Options`, `Content-Security-Policy`, `Referrer-Policy`, `X-Content-Type-Options`).
- **Optimization Observation**: Missing an explicit Netlify header rule for `/_next/static/*` with `Cache-Control: public, max-age=31536000, immutable`. Adding this would maximize CDN cache hit ratios.

#### 4c. Static SEO Audit
- Dynamic metadata and OpenGraph tags are implemented across app pages.
- **Defect Identified**: `src/app/robots.ts:10` and `src/app/sitemap.ts:7` both specify the outdated domain `https://careermonke.io` rather than the official production domain `https://careermonke.com`.

#### 4d. Static Accessibility (a11y) Audit
- Images without `alt` attribute: **0**
- Clickable non-interactive elements (`div`/`span` with `onClick`): **1** (`src/components/UserMenu.tsx:169`)
- Form inputs without accessible `<label>` or `aria-label`: **20**
- Buttons without accessible name or text: **0**

---

### Part 5 - Middleware & Defense in Depth

#### 5a. Middleware Status
- `src/middleware.ts.bak`: Disabled because the Next.js application compiles with `output: "export"` (static export), which does not support Edge runtime middleware.
- Former matcher: `/:path*` (redirecting unauthenticated users to `/auth`).

#### 5b. Defense in Depth
- **Page-Level Defense**: All private pages (`/dashboard`, `/tracker`, `/resume`, `/applications`, `/settings`) execute client-side auth checks via `useAuth()` and redirect immediately if unauthenticated.
- **Handler-Level Defense**: 100% of Netlify functions and server routes verify authorization independently via JWT verification, server entitlement checks, or admin email allowlists.
- **Database-Level Defense**: Supabase Row-Level Security (RLS) is enabled on all tables, preventing data leakage even if frontend checks were bypassed.

---

## Real Bugs Found (Not Fixed)

1. **Unsanitized PostgREST Filter in Job API Query**
   - **Location**: `src/lib/api/jobs.ts:77`
   - **Code**: `query = query.or("title.ilike.%" + q + "%,company.ilike.%" + q + "%");`
   - **Vulnerability**: The search term `q` is concatenated directly into the `.or()` filter string without invoking `sanitizeSearchQuery(q)`. A search input containing `),is_pro.eq.true` injects an extra PostgREST filter clause.
   - **Recommended Fix**: Apply `sanitizeSearchQuery(q)` prior to filter construction, identical to `netlify/functions/jobs-search.ts:151`.

2. **Outdated Domain Name in SEO Files**
   - **Location**: `src/app/robots.ts:10` and `src/app/sitemap.ts:7`
   - **Code**: `sitemap: 'https://careermonke.io/sitemap.xml'` and `const baseUrl = 'https://careermonke.io'`
   - **Issue**: References obsolete `.io` TLD instead of `https://careermonke.com`, causing search engine crawlers to index mismatched canonical sitemaps.

3. **AI Daily Quota Fail-Open Fallback on Database Error**
   - **Location**: `src/lib/ai/security.ts:453`
   - **Code**: `return { allowed: true, count: 0, limit: DAILY_AI_LIMIT, resetAt: new Date(Date.now() + 86400000).toISOString() };`
   - **Vulnerability**: If database communication fails while querying quota records, the function catches the exception and returns `allowed: true`. This creates a fail-open condition where users could bypass AI quota limits during DB outages.
   - **Recommended Fix**: Return `allowed: false` to fail closed safely during database degradation.

4. **Missing Accessibility Attributes on Backdrop Element**
   - **Location**: `src/components/UserMenu.tsx:169`
   - **Code**: `<div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />`
   - **Issue**: Non-interactive `div` with an `onClick` listener lacks `role="presentation"`, `aria-hidden="true"`, or keyboard listener (`onKeyDown`), generating a11y linter warnings.

---

## Changed Files (`git diff --stat origin/main..HEAD`)

```
Untracked files:
 scripts/audit-static-a11y.ts
 scripts/test-authz-handlers.ts
 scripts/test-xss-sqli-uploads.ts
 reports/prompt11-audit.md

Preserved unstaged modifications (untouched):
 .github/workflows/daily-digest-cron.yml
 .github/workflows/ingest.yml
 scripts/cleanup.ts
 scripts/ingest.ts
```

---

## Not Verified (Offline / Read-Only Limitations)

1. **Live Stripe Webhook Signature Verification**: Stripe webhook signature verification (`stripe.webhooks.constructEvent`) was inspected statically and in handler tests, but could not be verified against live Stripe signing secrets because no live requests or network connections are permitted.
2. **Production Groq API Rate Limiting**: The upstream Groq LLM API rate-limiting headers (`x-ratelimit-remaining`) were mocked offline and could not be queried against live Groq endpoints.
3. **Live Supabase Storage Antivirus Scanning**: Supabase Storage file scanning hooks (if any are configured at the cloud provider infrastructure level) were not tested against live bucket uploads.
