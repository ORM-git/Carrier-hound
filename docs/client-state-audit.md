# Client State Audit: Persistent Browser Storage & Invalidation Map

Run command:
```bash
node scripts/check-client-state-audit.cjs
```

This document establishes the formal client-side persistent storage and cache invalidation audit for CareerMonke (`ORM-git/Carrier-hound`). It maps every `localStorage` and `sessionStorage` read, write, and removal site across `src/`, assesses vulnerability to stale schema shapes upon new deployments, cataloges all SWR and memory cache invalidation call sites, and catalogs remaining gaps for follow-up remediation.

---

## 1. Methodology & Classification Principles

### Why Client State Auditing Is Launch-Critical
When a new production build deploys, returning users frequently retain client storage entries serialized under older schema shapes. Without an explicit schema version envelope `{ v: number, data: T }` and migration/fallback logic, JSON parsing or missing expected object properties can silently crash React rendering, corrupt user profile data, or deadlock onboarding and job feed flows.

PRs #440 and #444 introduced the standardized versioned storage helper in `src/lib/storage/versioned.ts`. This audit catalogs all persistent client keys and maps which keys utilize this helper versus unversioned access or bounded exceptions.

### Allowed Conformance Verdicts
Each persistent storage key is assigned exactly one verdict based on strict criteria:

1. `VERSIONED-OK`:
   - Persisted using the standardized versioned envelope `{ v: number, data: T }` via `src/lib/storage/versioned.ts`.
   - Validates data types on read, provides a safe fallback on corruption or future versions, and defines a migration chain for legacy un-enveloped payloads.
2. `BOUNDED-EXCEPTION`:
   - Bounded exception / third-party-owned contract. Persisted without a `{ v, data }` envelope, but constrained by explicit defensive parsing limits:
     - The value is a primitive plain text string (e.g. `careermonke_user_email`, `careermonke_resume_title`) where parsing cannot fail due to property drift.
     - The value is a transient boolean flag (e.g. `careermonke_blocked_notice`) checked strictly against `"true"` and immediately removed.
     - Storage is managed and versioned externally by an official third-party SDK (`sb-*-auth-token` via Supabase GoTrue).
     - Storage is session-scoped (`cm_attribution` in `sessionStorage`). **Important parsing limit note**: `sessionStorage` survives page reloads and deployments within an open browser tab, so it is not inherently schema-safe; its safety is strictly bounded by defensive parsing (`JSON.parse` in `try/catch`, `typeof parsed === "object"` check, optional string fields, and clean `null` fallback).
     - The key is deprecated and accessed only for cleanup during sign-out (`careermonke_pro_active`).
3. `NEEDS-MIGRATION`:
   - Stores structured JSON objects, arrays of objects, or domain entity collections without the standardized `{ v, data }` envelope and migration chain.
   - Property additions, renames, or type changes in future releases risk crashing returning users or leaving orphaned records.
   - **Remediation Rule**: In-flight feature/flow PRs currently own these components; migrations to `writeVersioned`/`readVersioned` are strictly documented here and cataloged for follow-up PRs to avoid merge conflicts.

---

## 2. Persistent Storage Keys Audit Table

| Key Pattern | Storage Medium | Data Shape | Owner Component / Hook | Versioned ({v,data}) | Verdict | Justification & Defensive Parsing Limits | Source Call Sites |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- | :--- |
| `cm_cookie_notice` | `localStorage` | `{ v: 1, data: boolean }` | `src/components/CookieNotice.tsx`, `src/lib/analytics/cookieConsent.ts` | Yes | **VERSIONED-OK** | Standardized `{ v: 1, data }` envelope with boolean type validation and legacy string migration. | `src/components/CookieNotice.tsx`, `src/lib/analytics/cookieConsent.ts`, `src/lib/storage/versioned.ts` |
| `careermonke_sidebar_expanded` | `localStorage` | `{ v: 1, data: boolean }` | `src/lib/sidebar.ts` | Yes | **VERSIONED-OK** | Standardized `{ v: 1, data }` envelope with boolean validation and migration from un-enveloped boolean strings. | `src/lib/sidebar.ts`, `src/lib/storage/versioned.ts` |
| `careermonke_user_email` | `localStorage` | `string` (email) | `src/lib/auth/session.ts` | No | **BOUNDED-EXCEPTION** | Bounded exception: primitive string read as fallback for UI display; validated with string truthiness and cleared on signout; cannot cause JSON schema failure. | `src/lib/auth/session.ts`, `src/components/PaywallModal.tsx`, `src/components/UserMenu.tsx` |
| `careermonke_blocked_notice` | `localStorage` | `string` (`"true"`) | `src/lib/auth/session.ts`, `src/components/auth/BlockedAccountNotice.tsx` | No | **BOUNDED-EXCEPTION** | Bounded exception: transient alert flag parsed with strict equality (`notice === "true"`) and immediately deleted from storage upon user dismissal. | `src/lib/auth/session.ts`, `src/components/auth/BlockedAccountNotice.tsx` |
| `careermonke_pro_active` | `localStorage` | `None` (purge-only) | `src/lib/auth/session.ts` | No | **BOUNDED-EXCEPTION** | Bounded exception: deprecated legacy client override key targeted solely for removal during user sign-out to prevent entitlement spoofing. | `src/lib/auth/session.ts` |
| `sb-*-auth-token` | `localStorage` | `Session` JSON object (`access_token`, `refresh_token`, `user`) | `@supabase/supabase-js` (GoTrue Client) | No | **BOUNDED-EXCEPTION** | Third-party-owned contract: managed by Supabase GoTrue SDK; application code defensively reads tokens with null-checking and falls back to getSession(). | `src/app/admin/users/page.tsx`, `src/components/admin/EarlyAccessRequestsSection.tsx`, `src/components/analytics/PageViewTracker.tsx` |
| `cm_attribution` | `sessionStorage` | `Attribution` JSON object (`utmSource`, `referrer`, `capturedAt`) | `src/lib/analytics/utm.ts` | No | **BOUNDED-EXCEPTION** | Bounded exception: survives reloads in an open tab; defensive parsing limits wrap JSON.parse in try/catch, enforce object typecheck, and treat all fields as optional with null fallback. | `src/lib/analytics/utm.ts`, `src/components/analytics/PageViewTracker.tsx` |
| `careermonke_resume_title` | `localStorage` | `string` (title) | `src/app/resume/page.tsx` | No | **BOUNDED-EXCEPTION** | Bounded exception: primitive plain text string without nested properties; read defensively with fallback to `${cp.name} - Resume`. | `src/app/resume/page.tsx` |
| `cm_hidden_jobs_*` (`cm_hidden_jobs_guest`, `cm_hidden_jobs_${userId}`) | `localStorage` | `string[]` (array of job UUIDs) | `src/app/jobs/page.tsx` | No | **NEEDS-MIGRATION** | Unversioned JSON array; evolving to include hide timestamps or reasons requires a `{ v, data }` migration envelope. | `src/app/jobs/page.tsx` |
| `cm_job_fit_*` (`cm_job_fit_${userId}_${jobId}_${resumeHash}`) | `localStorage` | `{ summary: string, missingSkills: string[], cachedAt: number }` | `src/components/dashboard/WhyMatchPanel.tsx` | No | **NEEDS-MIGRATION** | Unversioned structured explanation cache in localStorage; changes to fit summary or gap diagnostics need versioning. | `src/components/dashboard/WhyMatchPanel.tsx` |
| `careermonke:profile-draft:*` (`careermonke:profile-draft:${email}:${section}`) | `localStorage` | `{ ts: number, draft: CandidateProfile }` | `src/components/profile/ProfileDrawers.tsx` | No | **NEEDS-MIGRATION** | Unversioned full `CandidateProfile` draft persistence; breaking changes to profile fields risk silent edit corruption. | `src/components/profile/ProfileDrawers.tsx` |
| `careermonke_preferences` | `localStorage` | `UserPreferences` JSON object | `src/lib/auth/session.ts` | No | **NEEDS-MIGRATION** | Core user onboarding and filter preferences stored without versioning envelope; field shape changes risk client crashes. | `src/lib/auth/session.ts` |
| `careermonke_applications_*` (`careermonke_applications_guest`, `careermonke_applications_${userId}`, `careermonke_applications_tracker`, `careermonke_applications`) | `localStorage` | `TrackedApplication[]` | `src/lib/tracker/storage.ts` | No | **NEEDS-MIGRATION** | Core application tracker records stored as unversioned JSON arrays; schema changes to stages or notes risk data loss. | `src/lib/tracker/storage.ts` |
| `careermonke_candidate_profile_*` (`careermonke_candidate_profile`, `careermonke_candidate_profile_${userId}`) | `localStorage` | `CandidateProfile` JSON object | `src/lib/resume/storage.ts` | No | **NEEDS-MIGRATION** | Unversioned candidate facts object; changes to structured work experience or education schemas cause deserialization faults. | `src/lib/resume/storage.ts`, `src/app/auth/callback/page.tsx`, `src/app/settings/page.tsx`, `src/lib/auth/session.ts` |
| `careermonke_tailored_resume_*` (`careermonke_tailored_resume_${ownerId}_${jobId}`) | `localStorage` | `TailoredJobResumeResult` | `src/lib/resume/storage.ts` | No | **NEEDS-MIGRATION** | Relies on ad-hoc internal `operationVersion` string rather than standard `{ v, data }` envelope with fallback migration. | `src/lib/resume/storage.ts` |
| `careermonke_tailored_cover_letter_*` (`careermonke_tailored_cover_letter_${ownerId}_${jobId}`) | `localStorage` | `TailoredCoverLetterResult` | `src/lib/resume/storage.ts` | No | **NEEDS-MIGRATION** | Already validates cacheVersion, owner, and candidateFactsHash/jobHash with purge fallback; residual gap is lack of standard {v,data} envelope with migration chain. | `src/lib/resume/storage.ts` |

### Summary of Storage Keys Verdicts
- **VERSIONED-OK**: 2 keys (12.50%)
- **NEEDS-MIGRATION**: 8 keys (50.00%)
- **BOUNDED-EXCEPTION**: 6 keys (37.50%)
- **Total Audited Keys**: 16 keys

---

## 3. Cache Invalidation Map (SWR & In-Memory Client Caches)

CareerMonke employs a multi-tiered client cache architecture:
1. **SWR Client Cache (`src/lib/cache/swr.ts`)**: Memory-only store with a 200-entry bound (`SWR_MAX_ENTRIES`) and 60-second default TTL. Serves fast client paints and dedupes concurrent requests. Note: `invalidateSwr` is defined and unit-tested in `src/lib/cache/swr.ts:93`, but has zero runtime call sites in production code.
2. **In-Memory Service Caches**: Module-scoped singletons in `subscription.ts` (Pro status), `approval.ts` (Early Access status), `tracker/storage.ts` (Application records), and `resume/storage.ts` (Candidate profile).

### Cache Invalidation Call Sites & Assessment

| Invalidation Call Site | Target Cache / Key Prefix | Trigger Event / Mutation | Invalidation Mechanism | Status / Risk Flag | Notes & Remediation |
| :--- | :--- | :--- | :--- | :---: | :--- |
| `src/app/jobs/page.tsx:1363` | `dashboard:${user.id}` | Application stage update (`handleStageChange`) | `updateSwr` | **OK** | In-place update of `appsRes` array in cached bundle. Modifies memory cache; does not automatically re-render already mounted dashboard state. |
| `src/app/jobs/page.tsx:1398` | `dashboard:${user.id}` | New application tracked (`handleCreateApplication`) | `updateSwr` | **OK** | In-place prepend of created application into cached `DashboardBundle` in memory. |
| `src/app/jobs/page.tsx:1420` | `dashboard:${user.id}` | Application removed (`handleDeleteApplication`) | `updateSwr` | **OK** | In-place filtering of deleted application ID from cached `DashboardBundle` in memory. |
| `src/lib/admin/earlyAccess.ts:457` | `approvalCache` (`normalizedEmail`) | Admin updates early access request status | `invalidateApprovalCache` | **OK** | Purges target user's in-memory approval record from `approvalCache`. |
| `src/lib/billing/subscription.ts:40-44` | `cachedProStatus` (Global memory) | Window events (`careermonke_auth_updated`, `careermonke_pro_updated`, `careermonke_route_changed`, `focus`, `popstate`) | `invalidateProAccessCache` | **FLAGGED (TOO BROAD)** | `focus` and `popstate` listeners clear in-memory cache and can trigger an extra fetch to the `"subscriptions"` table on the next `getProAccessStatus()` call. |
| `src/lib/tracker/storage.ts:210` | `cachedApplications` (Global memory) | Local application save / update | `invalidateTrackedApplicationsCache` | **FLAGGED (MISSED KEY)** | Clears tracker memory cache, but does not invalidate or update SWR `dashboard:${userId}`, leaving dashboard with stale applications until remount or visibility change. |
| `src/lib/resume/storage.ts:314` | `memoizedProfile` (Global memory) | Candidate profile deletion (`deleteCandidateProfile`) | `clearCandidateProfileMemoryCache` | **FLAGGED (MISSED KEY)** | Clears profile memory cache, but does not invalidate SWR `dashboard:${userId}`, leaving dashboard match state stale. |
| `src/app/auth/callback/page.tsx:34` | `memoizedProfile` (Global memory) | Auth callback completion / user login | `clearCandidateProfileMemoryCache` | **OK** | Purges in-memory profile cache on login so fresh user profile facts are fetched from Supabase. |
| `src/lib/auth/session.ts:267` | `memoizedProfile` (Global memory) | User sign-out (`signOutUser`) | `clearCandidateProfileMemoryCache` | **OK** | Wipes active in-memory profile cache to prevent cross-account profile leaks on shared devices. |
| `src/lib/auth/session.ts:268` | `cachedApplications` (Global memory) | User sign-out (`signOutUser`) | `clearTrackerMemoryState` | **OK** | Increments generation token and clears tracker memory cache to isolate user data. |

---

## 4. Key Gaps & Invalidation Blindspots

### 1. Dashboard SWR Lifecycle, Freshness Eligibility, and Invalidation Blindspots
`src/app/dashboard/page.tsx` consumes a composite bundle (`DashboardBundle`) keyed by `dashboard:${authUser.id}` via `readSwr` and `swrFetch`. This bundle aggregates four data sources:
- `proRes`: Pro subscription status
- `prefRes`: User onboarding and job preferences
- `profileRes`: Candidate facts and resume data
- `appsRes`: Tracked job applications

**Crucial Lifecycle Realities**:
- **`readSwr` Serves Any Age for Instant Paint**: When mounting, `readSwr` returns cached data regardless of how old it is to prevent layout shift and paint immediately.
- **60-Second TTL Is Freshness Eligibility, Not An Automatic Update**: The 60-second window in `swrFetch` (`ttlMs = 60_000`) is an eligibility rule for skipping network requests when a fetch is initiated. It is **not** an automatic polling timer or background reload trigger. Nothing refreshes already mounted component state when 60 seconds elapses.
- **Dashboard Reload Triggers**: The dashboard initiates data loading **only on initial mount** (`useEffect(() => loadData(u), [loadData])`) and **on Page Visibility changes** (`document.addEventListener("visibilitychange", onVisible)`), which re-executes `loadData(user)` only when `!document.hidden && isSwrStale("dashboard:" + user.id)`.
- **Decoupling of Cached Bundle Writes from Mounted Component State**: `updateSwr` calls in `src/app/jobs/page.tsx` write directly through to the memory cache `store`. This ensures that subsequent dashboard mounts or revalidations see the updated application list, but it does not trigger a React state re-render inside an already-mounted dashboard tab.
- **Blindspots Across Non-Job Mutations**:
  - **Profile Updates**: When a user uploads a new resume, edits facts in `src/components/profile/ProfileDrawers.tsx`, or confirms a profile in `src/app/resume/page.tsx`, `dashboard:${userId}` is never invalidated or updated.
  - **Preferences Changes**: When a user updates salary preferences or completes onboarding in `src/lib/auth/session.ts` (`saveUserPreferences`), `dashboard:${userId}` is not invalidated.
  - **Pro Subscription Upgrades**: When a user upgrades via `src/components/PaywallModal.tsx` or Razorpay checkout, `invalidateProAccessCache` resets subscription memory, but the SWR cache in `dashboard:${userId}` continues serving the old `proRes` until the cache is evicted or reloaded while stale.
  - **Tracker Page Edits**: When a user drags or updates applications on `/tracker` (via `src/lib/tracker/storage.ts`), `updateSwr` is never called. Only actions performed from `/jobs` update the dashboard SWR cache.

### 2. Overly Aggressive Pro Status Invalidation
In `src/lib/billing/subscription.ts:40-44`, `invalidateProAccessCache` is bound to:
```typescript
window.addEventListener("careermonke_auth_updated", invalidateProAccessCache);
window.addEventListener("careermonke_pro_updated", invalidateProAccessCache);
window.addEventListener("careermonke_route_changed", invalidateProAccessCache);
window.addEventListener("focus", invalidateProAccessCache);
window.addEventListener("popstate", invalidateProAccessCache);
```
Binding to `focus` and `popstate` clears the in-memory cache (`cachedProStatus = null`). While this does not trigger an immediate network request on every tab switch, it causes the next call to `getProAccessStatus(userId)` to issue an unnecessary query against the `"subscriptions"` table in Supabase, bypassing normal TTL benefits during active browsing.

### 3. Orphaned and Unversioned Local Storage Keys
- `cm_hidden_jobs_*`: Stored as raw JSON arrays with no metadata. If the application adds hide reasons or undo histories, existing client arrays cannot be upgraded safely.
- `cm_job_fit_*`: Cached explanations in `localStorage` have no expiration or eviction policy; returning users accumulate unbounded keys over time.
- `careermonke:profile-draft:*`: Unversioned drafts survive up to 7 days; if profile fields change during a deployment, restoring an older draft can overwrite newer database models with corrupted shapes.

---

## 5. Remediation Plan (Follow-up PRs)

To respect in-flight PR ownership and avoid merge conflicts across active branches, the following migrations are cataloged for dedicated follow-up PRs:

1. **Client State Migration PR (Tracker & Resume)**:
   - Migrate `careermonke_applications_*` and `careermonke_candidate_profile_*` to `readVersioned` and `writeVersioned` from `src/lib/storage/versioned.ts`.
   - Provide a migration chain from `v0` (un-enveloped raw JSON) to `v1` (`{ v: 1, data }`).
   - Standardize `careermonke_tailored_cover_letter_*` to the unified `{ v, data }` envelope.
2. **Client State Migration PR (Preferences & Hidden Jobs)**:
   - Migrate `careermonke_preferences` and `cm_hidden_jobs_*` to `readVersioned` and `writeVersioned`.
   - Add schema validation and safe fallback defaults.
3. **SWR Invalidation Bus Alignment PR**:
   - Call `invalidateSwr("dashboard:" + userId)` on `careermonke_profile_updated`, `careermonke_preferences_updated`, and `careermonke_pro_updated` events.
   - Wire `updateSwr` into `src/lib/tracker/storage.ts` so tracker mutations from any route update the dashboard cache.
   - Remove window `focus` listener from `subscription.ts` to prevent redundant network queries against `"subscriptions"`.
