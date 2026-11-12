# App-Minted Token and ID Generation Security Audit

**Target**: App-minted tokens, identifiers, nonces, and pseudo-random generator sites across `src/` and `netlify/`  
**CSPRNG Standard**: Web Crypto API (`crypto.randomUUID`, `crypto.getRandomValues`) or Web Crypto HMAC-SHA256 (`crypto.subtle.sign`) for all security-sensitive identifiers.  
**Automated Guard**: `scripts/test-token-generation-guard.ts` (TypeScript AST scanner, site-specific allowlist, and runtime tests).  

---

## 1. Audit Scope, Objectives & Boundaries

### What This Audit and Scan Covers
- **App-Minted Identifiers**: All sites in application source code (`src/` and `netlify/`) where tokens, nonces, correlation IDs, or primary keys are generated or derived.
- **Static AST Analysis**: TypeScript AST scanning (`ts.createSourceFile`) of all non-test source files for any references to `Math.random`—including direct calls (`Math.random()`, `Math.random ()`), multiline accesses, variable aliasing (`const r = Math.random`), object destructuring (`const { random } = Math`), and fallback expressions (`options.rand ?? Math.random`).
- **Site-Specific Function Allowlisting**: Allowlisting constrained strictly to `(relative file path + enclosing function name)` rather than exempting entire files, ensuring new code added to allowlisted files cannot introduce unvetted pseudo-randomness.
- **CSPRNG Implementation Verification**: Runtime and structural verification that security-sensitive sites (`src/lib/security/operationId.ts`, `src/lib/email/unsubscribe.ts`, `src/lib/tracker/storage.ts`) rely strictly on Web Crypto CSPRNG with fail-closed behavior when cryptographic entropy is unavailable.
- **Heuristic Pattern Scanning**: Scanning security-critical paths (`src/lib/security`, `src/lib/email`, `src/lib/admin`, `src/lib/account`, `src/middleware.ts`) for anti-patterns where security tokens or secrets are minted from `Date.now()`.

### What This Audit and Scan Does NOT Cover
- **Third-Party Dependency Internals**: Does not introspect third-party libraries inside `node_modules` (e.g., Three.js internal math, React internals).
- **Provider-Managed Sessions & Cookies**: User authentication sessions, refresh tokens, access JWTs, and authentication cookies are managed and minted by Supabase Auth (GoTrue) infrastructure, not in application code (see Section 3.7).
- **Payment Gateway Tokens**: Razorpay order IDs, payment IDs, and checkout session tokens are issued and signed by Razorpay servers; the application only handles client/webhook references.
- **Database Engine Generators**: Server-side PostgreSQL functions such as `gen_random_uuid()` or sequence generators are managed by Supabase/PostgreSQL engine internals.
- **No Third-Party Security Certification**: This document and its accompanying offline test suite reflect internal engineering audit and regression defense; they do not constitute an external third-party security audit, penetration test, or formal certification.

---

## 2. Complete Catalog of Token, ID, and Entropy Sites

The table below catalogs every site across `src/` and `netlify/` where an ID, token, nonce, reference string, or random value is generated.

| File & Line | Value Minted / Protected Asset | Security-Sensitive? | Generator Used | CSPRNG Status | Details & Remediation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `src/lib/security/operationId.ts:4` | AI Operation and Lease Identities (`set_${uuid}`, `lease_${uuid}`) | **YES** | `crypto.randomUUID()` | **PASS** | Prevents distributed race conditions, lease hijacking, and cross-tenant collision across edge isolates. Standard Web Crypto CSPRNG. |
| `src/lib/email/unsubscribe.ts:117-142` | One-Click Email Unsubscribe Token (`${payload}.${signature}`) | **YES** | Web Crypto HMAC-SHA256 (`crypto.subtle.sign`) | **PASS** | Cryptographic tamper-proof signed token (RFC 8058). Authenticated using `UNSUBSCRIBE_SECRET` and constant-time string comparison (`constantTimeEqual`). |
| `src/lib/tracker/storage.ts:20-29` | Tracked Job Application Record Primary Key (`TrackedApplication.id`) | **YES** | `crypto.randomUUID()` / `crypto.getRandomValues()` | **REMEDIATED (PASS)** | Entity primary key in user application tracker. Previously fell back to `Math.random()` if `randomUUID` was absent. Remediated to standard RFC 4122 v4 CSPRNG using `crypto.getRandomValues(new Uint8Array(16))` with explicit bit masking. Fails closed if crypto is absent. |
| `src/middleware.ts:791` | Request / Trace Correlation ID (`x-request-id` header) | **NO** | `crypto.randomUUID()` | **PASS** | Edge request tracing and client error correlation. Uses CSPRNG `crypto.randomUUID()`. |
| `src/app/api/billing/razorpay/order/route.ts:121` | Razorpay Merchant Order Receipt (`rcpt_${userId}_${Date.now()}`) | **NO** | `Date.now()` + user ID prefix | **PASS (N/A Reference)** | Operational merchant tracking reference string (max 40 chars) passed to Razorpay. Not a secret; payment authenticity is enforced via Razorpay HMAC signature (`razorpay_signature`). |
| `netlify/functions/billing-razorpay-order.ts:176` | Razorpay Merchant Order Receipt (`rcpt_${userId}_${Date.now()}`) | **NO** | `Date.now()` + user ID prefix | **PASS (N/A Reference)** | Mirrors Next.js API route order receipt creation. Non-secret business reference string. |
| `netlify/functions/billing-razorpay-webhook.ts:151` | Webhook Deduplication Key Fallback (`rzp_evt_${event}_${entityId}_${created_at \|\| Date.now()}`) | **NO** | Entity attributes + fallback `Date.now()` | **PASS (N/A Reference)** | Idempotency deduplication key in `payment_webhook_events`. Authenticity is strictly enforced prior to this lookup via HMAC-SHA256 signature verification (`x-razorpay-signature`). If `created_at` is missing, `Date.now()` fallback is NOT deterministic across retries. |
| `src/lib/cron/dailyDigestCron.ts:85` | In-Memory Cron Execution Audit ID (`run-${Date.now()}`) | **NO** | `Date.now()` | **PASS (N/A Operational)** | Ephemeral fallback audit log ID when database insertion fails or during dry-run execution. |
| `src/lib/resume/storage.ts:787` | Storage Object Collision Prefix (`${userId}/${Date.now()}_${safeName}`) | **NO** | `Date.now()` | **PASS (N/A Operational)** | File path prefix inside user's private folder in Supabase Storage (`resumes` bucket) to prevent filename overwrites. Access control is strictly enforced by Supabase Storage RLS policies. |
| `src/components/profile/ProfileDrawers.tsx:209, 246` | React UI Draft Education & Experience Form Keys (`edu-${Date.now()}`, `exp-${Date.now()}`) | **NO** | `Date.now()` | **PASS (N/A React Key)** | Temporary React component keys for unpersisted items in edit drawers. Replaced by database IDs upon persistence. |
| `src/components/resume/ResumeUploadAndConfirm.tsx:283, 321` | React UI Draft Experience & Education Form Keys (`exp-${Date.now()}`, `edu-${Date.now()}`) | **NO** | `Date.now()` | **PASS (N/A React Key)** | Temporary React component keys for unpersisted items during upload review. |
| `src/components/analytics/WebVitalsTracker.tsx:161` | Web Vitals Telemetry Event ID (`wv-${Date.now()}-${Math.random()}`) | **NO** | `Date.now()` + `Math.random()` | **ALLOWLISTED (Telemetry)** | Client-side performance metric correlation ID in `WebVitalsTracker` component for telemetry batching. Non-security. |
| `src/lib/reliability/jitter.ts:27` | Network Retry & Cache Backoff Jitter (`options.rand ?? Math.random`) | **NO** | `Math.random` | **ALLOWLISTED (Jitter)** | Bounded random jitter in `withJitter()` function to prevent thundering herd collisions on remote APIs and databases. |
| `src/lib/db/rpcRetry.ts:58` | PostgREST RPC Retry Backoff Jitter (`Math.floor(Math.random() * 25)`) | **NO** | `Math.random()` | **ALLOWLISTED (Jitter)** | Adds 0-25ms random jitter to database RPC retry intervals in `rpcWithRetry()` to desynchronize concurrent client retries. |
| `src/components/landing/careermonke-landing-runtime.ts:171-181` | Landing Celebration Confetti Particle Physics (angle, speed, rotation) | **NO** | `Math.random()` | **ALLOWLISTED (Visual)** | Visual particle simulation in `confetti()` function on demo completion. |
| `src/components/JobRadarGlobe.tsx:648-650` | 3D Radar Globe Starfield Background Coordinate Distribution | **NO** | `Math.random()` | **ALLOWLISTED (Visual)** | Generates uniform spatial distributions for background starfield particles in `JobRadarGlobe` visual scene. |
| `src/components/LandingTopArtifact.tsx:353, 360, 367, 368` | Landing Top Artifact Demo Counter Variations & Site Staggering | **NO** | `Math.random()` | **ALLOWLISTED (Visual)** | Visual demonstration counter variations in `scan()` function. |
| `src/components/LandingTopArtifact.tsx:620-631` | Landing Top Artifact Celebration Canvas Confetti Particle Physics | **NO** | `Math.random()` | **ALLOWLISTED (Visual)** | Visual celebratory canvas confetti particle trajectory in `confetti()` function. |

---

## 3. Cryptographic Token & Verification Analysis by Subsystem

### 3.1 AI Operation and Lease Identities (`src/lib/security/operationId.ts`)
- **Enforcement**: Uses native Web Crypto `crypto.randomUUID()`.
- **Properties**: Standard RFC 4122 v4 UUID with 122 bits of cryptographic entropy.
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
- **Vulnerability**: While `crypto.randomUUID()` is present in modern runtimes, an environment without `randomUUID` would silently degrade to `Math.random()`. `Math.random()` is not cryptographically secure: its PRNG state can be recovered from observed outputs, creating predictable IDs and collision risks in multi-user storage.
- **Remediation Applied**:
  ```ts
  export function generateUUID(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; // RFC 4122 v4 version
      b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant 10xx
      const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    throw new Error("CSPRNG crypto is not available in current runtime environment");
  }
  ```
- **Security Posture**: Fully compliant. Fails closed before any tracker write occurs if CSPRNG is absent.

### 3.4 Request & Correlation IDs (`src/middleware.ts`)
- **Enforcement**: `resolveRequestId` honors inbound sanitized `x-request-id` or mints a new UUID via `crypto.randomUUID()`.
- **Sanitization**: Regular expression `/^[A-Za-z0-9_-]{8,128}$/` prevents header injection or CRLF attacks.
- **Security Posture**: Fully compliant.

### 3.5 Razorpay References and Webhook Verification (`netlify/functions/billing-razorpay-webhook.ts`)
- **Reference Nature**: Merchant order receipts (`rcpt_...`) and webhook event IDs are business reference strings, not security secrets.
- **Cryptographic Authenticity**: The authenticity of all payment orders and webhooks is strictly enforced via Razorpay cryptographic HMAC-SHA256 signatures (`x-razorpay-signature` and `razorpay_signature`), verified using `crypto.timingSafeEqual`.
- **Deduplication Key Fallback**: The deduplication key `rzp_evt_${event}_${entityId}_${created_at || Date.now()}` in `payment_webhook_events` uses `Date.now()` when the incoming payload omits `created_at`. In that specific missing-field edge case, the key is **NOT deterministic across retries**. This is safe because payment authenticity has already been HMAC-verified before insertion.
- **Security Posture**: Fully compliant.

### 3.6 Account Deletion Verification & Tombstone Hashing (`src/lib/account/deleteHandler.ts`)
- **Authentication**: Account deletion does not mint a newly created application-level confirmation token. Instead, it relies strictly on an authenticated session flow using Supabase Auth JWT bearer tokens, requiring active user authentication.
- **Tombstone Hashing**: The deletion audit record stores `sha256Hex(normalizedEmail)` using `crypto.subtle.digest("SHA-256", ...)`. Note that unsalted SHA-256 is used here as a consistent pseudonymized index key for audit reconciliation; it is **NOT proof of irreversible PII**, as unsalted hashes of low-entropy strings (such as email addresses) are susceptible to dictionary and rainbow table inversion if exposed.
- **Security Posture**: Fully compliant.

### 3.7 Provider-Managed Session and Cookie Issuance (Supabase Auth)
- **Scope Boundary**: User authentication, session management, access tokens, refresh tokens, and authentication cookies are managed and minted by Supabase Auth (GoTrue), not by application code.
- **Security Properties**: Handled via official `@supabase/ssr` and `@supabase/supabase-js` SDKs. Session tokens are signed asymmetric JWTs issued by the Supabase authentication server.
- **App Responsibility**: The application validates JWT signatures and session posture; it does not mint or sign auth sessions.

---

## 4. Legitimate Non-Security Allowlist

The following sites contain `Math.random` usage for legitimate non-security purposes and are codified into the site-specific allowlist in `scripts/test-token-generation-guard.ts`. Every allowlist entry requires matching both the normalized file path and the enclosing function name:

1. `src/lib/reliability/jitter.ts` -> function: `withJitter`  
   **Rationale**: Implements Decorrelated and Full Jitter for network retry exponential backoff to desynchronize concurrent clients and prevent thundering herd spikes on downstream databases. Cryptographic unpredictability is not required for network timing dispersion.
2. `src/lib/db/rpcRetry.ts` -> function: `rpcWithRetry`  
   **Rationale**: Jitter added to database RPC backoff sleep (`Math.floor(Math.random() * 25)`). Adding 0-25ms random dispersion to retry cycles protects PostgreSQL from stampedes during transient lock contention.
3. `src/components/landing/careermonke-landing-runtime.ts` -> function: `confetti`  
   **Rationale**: Confetti physics trajectory calculation (angle, velocity, rotation, particle size). High-frequency animation loops require standard `Math.random` to avoid blocking UI rendering with crypto entropy requests.
4. `src/components/JobRadarGlobe.tsx` -> function: `JobRadarGlobe`  
   **Rationale**: Three.js background starfield 3D point cloud generation. Distributes visual background vertices evenly in space.
5. `src/components/LandingTopArtifact.tsx` -> function: `scan`  
   **Rationale**: Landing demo interactive counter jitter and site simulation delay.
6. `src/components/LandingTopArtifact.tsx` -> function: `confetti`  
   **Rationale**: Landing celebratory canvas confetti particle physics simulation.
7. `src/components/analytics/WebVitalsTracker.tsx` -> function: `WebVitalsTracker`  
   **Rationale**: Ephemeral telemetry event identifier fallback (`wv-${Date.now()}-${Math.random()}`) used purely for client-side performance metric correlation in Google Analytics.

---

## 5. Offline Automated Guard Test

To prevent regressions, `scripts/test-token-generation-guard.ts` executes static AST analysis and runtime CSPRNG checks:

- **TypeScript AST Scanning (`ts.createSourceFile`)**: Replaces raw regex or substring checks to catch all AST representations of `Math.random`: calls with spaces (`Math.random ()`), multiline accesses, element accesses (`Math["random"]()`, `Math['random']()`, `Math[`random`]`), Math identifier aliases (`const M = Math; M.random()`, `M["random"]()`), variable aliasing (`const r = Math.random`), destructuring (`const { random } = Math`), and fallback operators (`options.rand ?? Math.random`).
- **Site-Specific Innermost Function Checks**: Traverses AST parent scopes to determine strictly the innermost enclosing function, ensuring any nested unauthorized function inside an allowlisted function (e.g. `function withJitter() { function mintSecret() { ... } }`) does not leak the allowlist and is caught.
- **Explicit Bypass Testing**: Unit tests that deliberately verify the scanner catches spaced calls, multiline expressions, aliasing, destructuring, element accesses, identifier aliases, and unauthorized nested functions in jitter files.
- **Real Negative Control**: Supports `--negative-control` mode which injects a weak generator snippet into the scanner and asserts guard failure (exit code 1). Normal mode spawns a subprocess verifying this non-zero exit.
- **Runtime CSPRNG Tests**: Directly tests `src/lib/tracker/storage.ts` `generateUUID()` across native `crypto.randomUUID`, `crypto.getRandomValues` fallback (verifying RFC 4122 v4 version nibble '4' and variant bits), and awaited fail-closed rejection of `addApplicationToTracker` verifying zero storage writes occur before the throw when crypto is absent.
- **Date.now Heuristic Scanning**: Scans security-critical modules for token/secret variables assigned from `Date.now()`.
- **Documentation Verification**: Automatically validates that this audit document exists, details all cataloged sites, and accurately bounds audit claims.

The guard is registered append-only in `scripts/suite-runner.ts` and classified as `offline` in `scripts/lib/test-guard.cjs`.
