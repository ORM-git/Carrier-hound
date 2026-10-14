# CareerMonke Security Hardening Report (Prompt 10)

**Date**: 2026-10-14  
**Branch**: `fix/prompt10-hardening`  
**Base Commit**: `6539462` (cut from `test/prompt9-audit`)  
**Commit Range**: `3f7728a..6193dee`  
**Git Author**: `suryakant-source <230859682+suryakant-source@users.noreply.github.com>`  

---

## 1. Executive Summary

In response to the security and audit findings documented in Prompt 9 (`reports/prompt9-audit.md`), four surgical, regression-tested hardening measures were implemented across serverless functions, git ignore boundaries, search rate limiting, and dependency vulnerabilities.

| Part | Component | Description | Commit Hash | Verification Status |
|---|---|---|---|---|
| **Part 1** | Serverless CORS Allow-List | Replaced open wildcard `Access-Control-Allow-Origin: *` across all 7 Netlify serverless functions with strict allow-list via shared helper `netlify/functions/_cors.ts`. Always emits `Vary: Origin`. | `3f7728a` | **VERIFIED (28/28 tests PASS, exit 0)** |
| **Part 2** | Git Ignore Boundaries | Hardened `.gitignore` to match all `.env`, `.env.*` variants (while preserving `.env.example`), `*.key`, and `coverage/`. | `715bde0` | **VERIFIED (git check-ignore + index audit PASS)** |
| **Part 3** | Search API Rate Limiter | Implemented client IP-based bucket rate limiting (30 req / 60s) in `netlify/functions/jobs-search.ts` returning HTTP 429 with `Retry-After` header. | `c7ed6f1` | **VERIFIED (30 x 200, 5 x 429, exit 0; neg control exit 1)** |
| **Part 4** | Dependency Vulnerability Patch | Audited production dependencies; resolved high-severity advisory in `source-map-js` (`1.2.1` -> `1.2.2`). Documented Next 15+ migration plan for remaining vendor CVEs. | `6193dee` | **VERIFIED (tsc exit 0, build exit 0, 26/26 suites PASS)** |

---

## 2. Part 1: Strict CORS Origin Allow-List

### 2.1 Architecture
All Netlify functions now import and execute standard CORS middleware from `netlify/functions/_cors.ts`:
- **Allowed Origins**:
  - `https://careermonke.com`
  - `https://www.careermonke.com`
  - `https://careermonke.netlify.app`
  - `https://careerhound.netlify.app`
  - `process.env.URL` / `process.env.DEPLOY_PRIME_URL` (dynamic Netlify deploy previews)
  - `http://localhost:3000`, `http://127.0.0.1:3000` (development environments)
  - Custom comma-separated origins configured via `process.env.CORS_ALLOWED_ORIGINS`
- **Behavior**:
  - If incoming `Origin` matches an allowed domain, `Access-Control-Allow-Origin: <exact-origin>` and `Vary: Origin` are returned.
  - If incoming `Origin` is unallowed or missing, `Access-Control-Allow-Origin` is completely omitted (never echoed, never wildcarded).
  - OPTIONS preflight requests receive HTTP 204 with standard caching headers (`Access-Control-Max-Age: 86400`).

### 2.2 Serverless Function Audit & Remediation Table

| Function File | Previous Behavior (Before) | New Behavior (After) | Test Cases Evaluated | Status |
|---|---|---|---|---|
| `netlify/functions/account-delete.ts` | Wildcard `*` on DELETE & OPTIONS | Strict allow-list, `Vary: Origin`, 204 preflight | Allowed origin, localhost, evil origin, no origin | **PASS (4/4)** |
| `netlify/functions/ai.ts` | Wildcard `*` on POST & OPTIONS | Strict allow-list, `Vary: Origin`, 204 preflight | Allowed origin, localhost, evil origin, no origin | **PASS (4/4)** |
| `netlify/functions/jobs-pro.ts` | Wildcard `*` on GET, POST & OPTIONS | Strict allow-list, `Vary: Origin`, 204 preflight | Allowed origin, localhost, evil origin, no origin | **PASS (4/4)** |
| `netlify/functions/jobs-search.ts` | Wildcard `*` on GET & OPTIONS | Strict allow-list, `Vary: Origin`, 204 preflight | Allowed origin, localhost, evil origin, no origin | **PASS (4/4)** |
| `netlify/functions/jobs-top10.ts` | Wildcard `*` on GET & OPTIONS | Strict allow-list, `Vary: Origin`, 204 preflight | Allowed origin, localhost, evil origin, no origin | **PASS (4/4)** |
| `netlify/functions/simulate-checkout.ts` | Wildcard `*` on POST & OPTIONS | Strict allow-list, `Vary: Origin`, 204 preflight | Allowed origin, localhost, evil origin, no origin | **PASS (4/4)** |
| `netlify/functions/stats.ts` | Wildcard `*` on GET & OPTIONS | Strict allow-list, `Vary: Origin`, 204 preflight | Allowed origin, localhost, evil origin, no origin | **PASS (4/4)** |

### 2.3 Verification Output
- **Normal Verification Suite**: `npx tsx scripts/test-cors.ts` (Exit Code: 0)
  - 28/28 checks passed with 100% compliance.
- **Negative Control Suite**: `npx tsx scripts/test-cors.ts --negative-control` (Exit Code: 1)
  - Injected wildcard `*` into mock handler response; test runner detected header violation and exited with non-zero exit code 1 as expected.

---

## 3. Part 2: Git Ignore Hardening

### 3.1 Patterns Added

| Pattern | Rationale | Pre-existing Risk | Status |
|---|---|---|---|
| `.env` | Prevents root unadorned production/development environment file accidental staging | Prior pattern `.env*.local` only matched files starting with `.env` and ending with `.local` | **Active & Verified** |
| `.env.*` | Blanket covers all env variants (`.env.production`, `.env.staging`, `.env.test`, `.env.backup`, `.env.local`) | Missing variants like `.env.development` or `.env.production` could be committed | **Active & Verified** |
| `!.env.example` | Whitelist exception for template config | Safe template must remain trackable in git for developer onboarding | **Active & Verified** |
| `*.key` | Excludes private encryption and SSL keys | Any exported SSL/TLS or SSH key was untracked | **Active & Verified** |
| `coverage/` | Excludes test runner coverage outputs | Unwanted test artifacts in working tree | **Active & Verified** |

### 3.2 Verification
1. `git ls-files | grep -i env`: Confirmed ONLY `.env.example` is tracked in the repository.
2. `git check-ignore -v .env .env.local .env.production .env.staging .env.example`:
   - `.env` -> `.gitignore:13:.env`
   - `.env.local` -> `.gitignore:14:.env.*`
   - `.env.production` -> `.gitignore:14:.env.*`
   - `.env.example` -> Negated (`!.env.example`) and tracked.

---

## 4. Part 3: Search API Rate Limiter

### 4.1 Specification
- **Endpoint**: `/api/jobs/search` (`netlify/functions/jobs-search.ts`)
- **Quota**: 30 requests per 60-second sliding window per client IP.
- **Client IP Resolution**:
  ```ts
  const xfwd = event.headers["x-forwarded-for"] || event.headers["X-Forwarded-For"];
  const clientIp = xfwd ? xfwd.split(",")[0].trim() : (event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "anonymous-client");
  ```
- **Response On Quota Exceeded**:
  - HTTP Status: `429 Too Many Requests`
  - Header: `Retry-After: <seconds-remaining>`
  - Header: `Content-Type: application/json`
  - CORS Headers: Preserved from request origin
  - JSON Body:
    ```json
    {
      "error": "Rate limit exceeded. Please wait a moment.",
      "retryAfter": 50
    }
    ```

### 4.2 Serverless Edge Architecture & Limitations Analysis
- **In-Memory Store Mechanism**: The current rate limiter uses an in-memory `Map<string, { count: number; resetAt: number }>` inside the serverless execution context.
- **Value as First Line of Defense**:
  - Effectively thwarts rapid automated scrapers, brute-force loops, or runaway client re-fetch loops hitting the same container.
  - Zero added external latency or dependency on Redis/external cache during normal operation.
  - Keeps serverless function cold starts minimal and free of third-party network roundtrips.
- **Edge Limitation Under Scale**:
  - Netlify / AWS Lambda serverless functions run across ephemeral container instances. When incoming traffic scales out to $N$ concurrent instances, memory is isolated per container.
  - An attacker distributing requests across multiple concurrent containers could theoretically execute $>30$ requests within 60s before each container saturates its quota.
  - **Long-term recommendation**: When sustained production traffic warrants distributed rate limiting, integrate Upstash Redis or Netlify Edge Functions with Netlify Blobs / KV store.

### 4.3 Test Verification
- **Test File**: `scripts/test-search-ratelimit.ts`
- **Normal Execution**:
  - 35 consecutive requests simulated from Primary IP `198.51.100.42`:
    - Requests 1 to 30 returned `200 OK`.
    - Requests 31 to 35 returned `429 Too Many Requests` with `Retry-After: 50s`.
  - 1 request simulated from Secondary IP `203.0.113.19`:
    - Returned `200 OK` (confirmed client IP isolation).
  - Exit Code: `0`
- **Negative Control Execution (`--negative-control`)**:
  - Injected `maxRequests = 1000`; all 35 requests returned 200 (0 rate-limited).
  - Test runner asserted the failure condition and exited with non-zero exit code `1`.

---

## 5. Part 4: Dependency Vulnerability Review & Patch

### 5.1 Audit Findings (`npm audit --omit=dev`)

| Package | Direct/Transitive | Severity | Advisory / GHSA ID | Summary | Remediation Status |
|---|---|---|---|---|---|
| `source-map-js` | Transitive | High | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | Event-loop denial of service through indexed source-map section offsets | **FIXED**: Bumped from `1.2.1` to `1.2.2` via `npm audit fix` |
| `next` | Direct | Critical | [GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36) | Remote Code Execution on Windows-hosted servers (`>=13.4.0 <15.5.24`) | **NEEDS OWNER DECISION**: Requires Next 15.5.24+ / Next 16+ |
| `next` | Direct | Critical | [GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) | RCE in Image Optimization API with AVIF (`>=10.0.0 <15.5.24`) | **NEEDS OWNER DECISION**: Requires Next 15.5.24+ / Next 16+ |
| `next` | Direct | High | [GHSA-p9j2-gv94-2wf4](https://github.com/advisories/GHSA-p9j2-gv94-2wf4) | SSRF in rewrites via attacker hostname (`>=12.0.0 <15.5.21`) | **NEEDS OWNER DECISION**: Requires Next 15.5.21+ / Next 16+ |
| `next` | Direct | Moderate | [GHSA-4633-3j49-mh5q](https://github.com/advisories/GHSA-4633-3j49-mh5q) | Cache confusion with invalid UTF-8 byte sequences | **NEEDS OWNER DECISION**: Requires Next 15.5.21+ |
| `next` | Direct | Moderate | [GHSA-4c39-4ccg-62r3](https://github.com/advisories/GHSA-4c39-4ccg-62r3) | Unbounded Server Action payload in Edge runtime | **NEEDS OWNER DECISION**: Requires Next 15.5.21+ |
| `next` | Direct | Moderate | [GHSA-955p-x3mx-jcvp](https://github.com/advisories/GHSA-955p-x3mx-jcvp) | Unauthenticated disclosure of Server Function endpoints | **NEEDS OWNER DECISION**: Requires Next 15.5.21+ |
| `postcss` | Transitive (vendored in `next/node_modules/postcss`) | High | [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | Path traversal / sourceMappingURL file disclosure | **LOCKED BY NEXT.JS 14**: Top-level PostCSS is `8.5.28`, but Next 14 bundles `8.4.31`. Fix requires Next 16.4.0. |
| `sprintf-js` | Transitive (`argparse` -> `mammoth`) | Moderate | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) | DoS through unbounded precision specifiers | **MAJOR BREAKING**: Fix requires `mammoth@0.3.29` which is semver major breaking change. |

### 5.2 Next.js Major Upgrade Migration Plan (For Repository Owner)
> [!IMPORTANT]
> Next.js major upgrade to 15.x/16.x is needed for GHSA-p293-qw3h-jr36 and GHSA-2xp9-vwfh-vxw4.  
> It was **NOT** upgraded here because it introduces breaking changes:
> 1. Breaks React 18 (requires React 19 upgrade and verification of all Radix UI and Lucide dependencies).
> 2. Breaks synchronous request APIs (`headers()`, `cookies()`, `params`, `searchParams` become asynchronous Promises in App Router).
> 3. Modifies fetch caching defaults (from default cache to default uncached).
> 
> **Recommended Owner Action**: Schedule a dedicated migration epic to upgrade `next@15.x` / `next@16.x` alongside `react@19` with end-to-end regression validation.

---

## 6. Complete Verification Matrix

Every command below was executed against the repository working tree and verified with raw terminal outputs:

| Command | Purpose | Result / Raw Metric | Exit Code | Verdict |
|---|---|---|---|---|
| `npx tsx scripts/test-cors.ts` | Serverless CORS verification | 7 handlers, 28 test cases, 0 violations | `0` | **PASS** |
| `npx tsx scripts/test-cors.ts --negative-control` | Negative control for CORS suite | Caught injected wildcard, exited 1 | `1` | **PASS (Negative)** |
| `git check-ignore -v .env .env.local .env.production .env.example` | Git ignore boundary check | All variants ignored, example retained | `0` | **PASS** |
| `npx tsx scripts/test-search-ratelimit.ts` | Search API rate limiter contract | 30 x 200 OK, 5 x 429 Retry-After, IP isolated | `0` | **PASS** |
| `npx tsx scripts/test-search-ratelimit.ts --negative-control` | Negative control for rate limiter | Asserted quota failure, exited 1 | `1` | **PASS (Negative)** |
| `npx tsc --noEmit` | TypeScript static analysis | 0 type errors across all files & functions | `0` | **PASS** |
| `npm run build` | Next.js production build | 49/49 static & dynamic routes compiled cleanly | `0` | **PASS** |
| `npx tsx scripts/test-seniority-ts.ts` | Seniority classification regression | 108/108 test cases passed (100.0%) | `0` | **PASS** |
| `npx tsx scripts/suite-runner.ts` | Comprehensive repository test suite | **26 passed, 0 failed, 0 skipped** | `0` | **PASS** |

---

## 7. What Remains Unverified

1. **Distributed Multi-Container Rate Limiting**: The search API rate limiter is in-memory per Netlify serverless container. Under rapid scale-out across multiple simultaneous serverless instances, requests may be distributed across isolated process memories.
2. **Next.js Windows RCE under Self-Hosted Windows Production**: On Netlify (Linux container runtime), the Windows-specific RCE advisory `GHSA-p293-qw3h-jr36` is non-applicable at runtime; however, local development on Windows machines remains aware of the advisory until Next 15+ migration.
3. **Third-Party Upstream Mammoth / Sprintf-js**: The transitive DoS in `sprintf-js` remains unpatched pending owner decision on upgrading `mammoth` across major versions.

---

## 8. Do Not Merge Yet Instructions

In strict compliance with the prompt's hard locks:
- No merge to `main` has been performed.
- No push to remote `origin` has been performed.
- All changes are cleanly isolated on local branch `fix/prompt10-hardening`.
- Review the diff using:
  ```bash
  git log origin/main..HEAD --oneline
  git diff origin/main..HEAD
  ```
