# App-Minted Token and ID Generation Security Audit

**Status**: COMPLIANT  
**Scope**: All source code under `src/` and `netlify/`  
**Audit Target**: App-minted tokens, IDs, nonces, secrets, and pseudo-random generator sites  
**CSPRNG Standard**: Web Crypto API (`crypto.randomUUID`, `crypto.getRandomValues`) or Node.js `crypto.randomBytes` / Web Crypto HMAC for all security-sensitive identifiers.  

---

## 1. Executive Summary

This audit catalogs and verifies every site in `src/` and `netlify/` where the CareerMonke application generates, mints, hashes, or derives tokens, identifiers, nonces, or secrets. 

### Key Findings & Metrics
- **Total Token / ID / Entropy Sites Audited**: 17 distinct sites (covering security identifiers, tracing, idempotency keys, storage prefixes, and visual/operational randomness).
- **Security-Sensitive Sites**: 3 sites (`src/lib/security/operationId.ts`, `src/lib/email/unsubscribe.ts`, `src/lib/tracker/storage.ts`).
- **Non-Compliant Security Sites Identified Prior to Remediation**: 1 site (`src/lib/tracker/storage.ts` contained a fallback using `Math.random()` to generate UUIDv4 strings for tracked job application records).
- **Remediated Sites**: 1 site (`src/lib/tracker/storage.ts` was refactored in-place to strictly require CSPRNG Web Crypto via `crypto.randomUUID()` or `crypto.getRandomValues()`, completely eliminating `Math.random()`).
- **Non-Compliant Security Sites After Remediation**: **0 (Zero)**.
- **Legitimate Non-Security Allowlisted Sites**: 6 files using `Math.random()` strictly for non-security operational jitter, telemetry fallback, or client-side visual animations.
- **Automated Regression Guard**: Added `scripts/test-token-generation-guard.ts` registered append-only in `scripts/suite-runner.ts`.

---

## 2. Complete Catalog of Token, ID, and Entropy Sites

The table below catalogs every site across `src/` and `netlify/` where an ID, token, nonce, or random value is generated.

| File & Line | Value Minted / Protected Asset | Security-Sensitive? | Generator Used | CSPRNG Compliance Status | Details & Remediation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `src/lib/security/operationId.ts:4` | AI Operation and Lease Identities (`set_${uuid}`, `lease_${uuid}`) | **YES** | `crypto.randomUUID()` | **PASS** | Prevents distributed race conditions, lease hijacking, and cross-tenant collision across edge isolates. Standard Web Crypto CSPRNG. |
| `src/lib/email/unsubscribe.ts:117-142` | One-Click Email Unsubscribe Token (`${payload}.${signature}`) | **YES** | Web Crypto HMAC-SHA256 (`crypto.subtle.sign`) | **PASS** | Cryptographic tamper-proof signed token (RFC 8058). Authenticated using `UNSUBSCRIBE_SECRET` and constant-time string comparison (`constantTimeEqual`). |
| `src/lib/tracker/storage.ts:20-29` | Tracked Job Application Record Primary Key (`TrackedApplication.id`) | **YES** | `crypto.randomUUID()` / `crypto.getRandomValues()` | **REMEDIATED (PASS)** | Entity primary key in user application tracker. Previously fell back to `Math.random()` if `randomUUID` was absent. Remediated to standard RFC 4122 v4 CSPRNG using `crypto.getRandomValues(new Uint8Array(16))`. Zero `Math.random()` calls remain. |
| `src/middleware.ts:791` | Request / Trace Correlation ID (`x-request-id` header) | **NO** | `crypto.randomUUID()` | **PASS** | Edge request tracing and client error correlation. Uses CSPRNG `crypto.randomUUID()`. |
| `src/app/api/billing/razorpay/order/route.ts:121` | Razorpay Merchant Order Receipt (`rcpt_${userId}_${Date.now()}`) | **NO** | `Date.now()` + user ID prefix | **PASS (N/A Non-Security)** | Human-readable merchant tracking string (max 40 chars) passed to Razorpay. Payment verification is cryptographically secured via Razorpay HMAC signature (`razorpay_signature`). |
| `netlify/functions/billing-razorpay-order.ts:176` | Razorpay Merchant Order Receipt (`rcpt_${userId}_${Date.now()}`) | **NO** | `Date.now()` + user ID prefix | **PASS (N/A Non-Security)** | Mirrors Next.js API route order receipt creation. Non-security merchant reference string. |
| `netlify/functions/billing-razorpay-webhook.ts:151` | Webhook Deduplication Key Fallback (`rzp_evt_${event}_${entityId}_${created_at \|\| Date.now()}`) | **NO** | Deterministic entity attributes + `Date.now()` | **PASS (N/A Non-Security)** | Idempotency deduplication key in `payment_webhook_events`. Authenticity is strictly enforced prior to this lookup via HMAC-SHA256 signature verification (`x-razorpay-signature`). |
| `src/lib/cron/dailyDigestCron.ts:85` | In-Memory Cron Execution Audit ID (`run-${Date.now()}`) | **NO** | `Date.now()` | **PASS (N/A Non-Security)** | Ephemeral fallback audit log ID when database insertion fails or during dry-run execution. |
| `src/lib/resume/storage.ts:787` | Storage Object Collision Prefix (`${userId}/${Date.now()}_${safeName}`) | **NO** | `Date.now()` | **PASS (N/A Non-Security)** | File path prefix inside user's private folder in Supabase Storage (`resumes` bucket) to prevent filename overwrites. Access control is strictly enforced by Supabase Storage RLS policies. |
| `src/components/profile/ProfileDrawers.tsx:209, 246` | React UI Draft Education & Experience Form Keys (`edu-${Date.now()}`, `exp-${Date.now()}`) | **NO** | `Date.now()` | **PASS (N/A Non-Security)** | Temporary React component keys for unpersisted items in edit drawers. Replaced by database IDs upon persistence. |
| `src/components/resume/ResumeUploadAndConfirm.tsx:283, 321` | React UI Draft Experience & Education Form Keys (`exp-${Date.now()}`, `edu-${Date.now()}`) | **NO** | `Date.now()` | **PASS (N/A Non-Security)** | Temporary React component keys for unpersisted items during upload review. |
| `src/components/analytics/WebVitalsTracker.tsx:161` | Web Vitals Telemetry Event ID (`wv-${Date.now()}-${Math.random()}`) | **NO** | `Date.now()` + `Math.random()` | **ALLOWLISTED (Non-Security)** | Client-side performance metric correlation ID for Google Analytics and internal telemetry. Non-security. |
| `src/lib/reliability/jitter.ts:27` | Network Retry & Cache Backoff Jitter (`options.rand ?? Math.random`) | **NO** | `Math.random()` | **ALLOWLISTED (Non-Security)** | Full jitter and decorrelated jitter implementation to prevent thundering herd collisions on remote APIs and databases. |
| `src/lib/db/rpcRetry.ts:58` | PostgREST RPC Retry Backoff Jitter (`Math.floor(Math.random() * 25)`) | **NO** | `Math.random()` | **ALLOWLISTED (Non-Security)** | Adds 0-25ms random jitter to database RPC retry intervals to desynchronize concurrent client retries. |
| `src/components/landing/careermonke-landing-runtime.ts:171, 172, 178, 179, 180, 181` | Landing Celebration Confetti Particle Physics (angle, speed, rotation) | **NO** | `Math.random()` | **ALLOWLISTED (Non-Security)** | Visual physics simulation for celebratory confetti particles on demo completion. |
| `src/components/JobRadarGlobe.tsx:648, 649, 650` | 3D Radar Globe Starfield Background Coordinate Distribution | **NO** | `Math.random()` | **ALLOWLISTED (Non-Security)** | Generates uniform spatial distributions for background starfield particles in Three.js visual scene. |
| `src/components/LandingTopArtifact.tsx:353, 360, 367, 368, 620-631` | Landing Top Artifact Demo Counters & Canvas Confetti Physics | **NO** | `Math.random()` | **ALLOWLISTED (Non-Security)** | Visual demonstration counter variations and celebration canvas confetti particles. |

---

## 3. Cryptographic Token & Verification Analysis by Subsystem

### 3.1 AI Operation and Lease Identities (`src/lib/security/operationId.ts`)
- **Enforcement**: Uses native Web Crypto `crypto.randomUUID()`.
- **Properties**: RFC 4122 v4 UUID with 122 bits of cryptographic entropy.
- **Fail-Closed**: No timestamp or `Math.random()` fallback; fails closed if the Web Crypto environment is unavailable.
- **Security Posture**: Fully compliant.

### 3.2 One-Click Unsubscribe Tokens (`src/lib/email/unsubscribe.ts`)
- **Enforcement**: Web Crypto HMAC-SHA256 (`crypto.subtle.sign`).
- **Format**: `${base64url(payload)}.${base64url(signature)}` conforming to RFC 8058.
- **Payload**: `{ email: string, topic: string, iat: number, exp: number }`.
- **Secret Management**: Requires dedicated `UNSUBSCRIBE_SECRET` from environment; fails closed if secret is missing or empty.
- **Verification**: `verifyUnsubscribeToken` checks signature with `constantTimeEqual` preventing timing attacks, and rejects expired tokens (`exp`).
- **Security Posture**: Fully compliant.

### 3.3 Application Tracker IDs (`src/lib/tracker/storage.ts`)
- **Initial Finding**: `generateUUID()` checked for `crypto.randomUUID()`, but included a legacy fallback substituting `Math.random()` into `"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"`.
- **Vulnerability**: While `crypto.randomUUID()` is supported in modern runtimes, an environment without `randomUUID` would silently degrade to `Math.random()`, which provides only 53 bits of pseudo-random entropy from a linear PRNG, vulnerable to state recovery.
- **Remediation Applied**:
  ```ts
  function generateUUID(): string {
    if (typeof crypto !== "undefined") {
      if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
      if (typeof crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 v4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10xx
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
    }
    throw new Error("CSPRNG crypto is not available in current runtime environment");
  }
  ```
- **Security Posture**: Fully compliant. Fails closed if CSPRNG is absent.

### 3.4 Request & Correlation IDs (`src/middleware.ts`)
- **Enforcement**: `resolveRequestId` honors inbound sanitized `x-request-id` or mints a new UUID via `crypto.randomUUID()`.
- **Sanitization**: Regular expression `/^[A-Za-z0-9_-]{8,128}$/` prevents header injection or CRLF attacks.
- **Security Posture**: Fully compliant.

### 3.5 Webhook Event Identifiers (`netlify/functions/billing-razorpay-webhook.ts`)
- **Authentication**: All webhook payloads are cryptographically authenticated before processing via `crypto.timingSafeEqual` comparing the `x-razorpay-signature` against `crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex")`.
- **Deduplication**: `eventId` is extracted from Razorpay header/payload. The fallback `rzp_evt_${event}_${entityId}_${created_at}` provides deterministic idempotency so webhook retries match the existing log record.
- **Security Posture**: Fully compliant.

### 3.6 Account Deletion Confirmations (`src/lib/account/deleteHandler.ts`)
- **Authentication**: Account deletion is authenticated via Supabase Auth JWT session cookies/Bearer tokens, requiring an active authenticated user session.
- **Data Anonymization**: The deletion tombstone records `sha256Hex(normalizedEmail)` using Web Crypto `crypto.subtle.digest("SHA-256", ...)`, ensuring no reversible PII remains in logs.
- **Security Posture**: Fully compliant.

---

## 4. Legitimate Non-Security Allowlist

The following 6 files contain `Math.random()` calls for legitimate non-security purposes and are codified into the allowlist in `scripts/test-token-generation-guard.ts`:

1. `src/lib/reliability/jitter.ts`  
   **Rationale**: Implements Decorrelated and Full Jitter for network retry exponential backoff to desynchronize concurrent clients and prevent thundering herd spikes on downstream databases. Cryptographic unpredictability is not required for network timing dispersion.
2. `src/lib/db/rpcRetry.ts`  
   **Rationale**: Jitter added to database RPC backoff sleep (`Math.floor(Math.random() * 25)`). Adding 0-25ms random dispersion to retry cycles protects PostgreSQL from stampedes during transient lock contention.
3. `src/components/landing/careermonke-landing-runtime.ts`  
   **Rationale**: Confetti physics trajectory calculation (angle, velocity, rotation, particle size). High-frequency animation loops require standard `Math.random()` to avoid blocking UI rendering with crypto entropy requests.
4. `src/components/JobRadarGlobe.tsx`  
   **Rationale**: Three.js background starfield 3D point cloud generation. Distributes 1,500 visual background vertices evenly in space.
5. `src/components/LandingTopArtifact.tsx`  
   **Rationale**: Landing demo interactive counter jitter and celebratory canvas confetti physics.
6. `src/components/analytics/WebVitalsTracker.tsx`  
   **Rationale**: Ephemeral telemetry event identifier fallback (`wv-${Date.now()}-${Math.random()}`) used purely for client-side performance metric correlation in Google Analytics.

---

## 5. Offline Automated Guard Test

To prevent regressions, `scripts/test-token-generation-guard.ts` performs static AST/regex analysis over all source files in `src/` and `netlify/`:

- **Math.random( Detection**: Scans all `.ts`, `.tsx`, `.js`, and `.mjs` files outside test folders. Fails if any `Math.random(` call appears in an unallowlisted file.
- **Security-Sensitive Date.now ID Patterns**: Scans for token, secret, nonce, or session identifier patterns derived solely from timestamps in security-critical modules.
- **Direct CSPRNG Verification**: Validates that `operationId.ts`, `unsubscribe.ts`, and `tracker/storage.ts` use standard Web Crypto APIs and contain no weak fallbacks.
- **Documentation Verification**: Confirms `docs/token-generation-audit.md` exists and is up to date.
- **Negative Control**: Includes `--negative-control` mode validating that the scanner detects and rejects unallowlisted `Math.random(` occurrences.

The guard is registered in `scripts/suite-runner.ts` under pure offline suites.
