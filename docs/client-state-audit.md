# Client State Audit: Persistent Browser Storage & Invalidation Map

Run command:
```bash
node scripts/check-client-state-audit.cjs
```

This document establishes the formal client-side persistent storage and cache invalidation audit for CareerMonke (`ORM-git/Carrier-hound`). It maps every `localStorage` and `sessionStorage` read, write, and removal site across `src/`, assesses vulnerability to stale schema shapes upon new deployments, cataloges all SWR and memory cache invalidation call sites, and catalogs remaining gaps for follow-up remediation.

---

## 1. Methodology & Classification Principles

### Why Client State Auditing Is Launch-Critical
When a new production build deploys, returning users frequently retain `localStorage` entries serialized under older schema shapes. Without an explicit schema version envelope `{ v: number, data: T }` and migration/fallback logic, JSON parsing or missing expected object properties can silently crash React rendering, corrupt user profile data, or deadlock onboarding and job feed flows.

PRs #440 and #444 introduced the standardized versioned storage helper in `src/lib/storage/versioned.ts`. This audit catalogs all persistent client keys and maps which keys utilize this helper versus raw un-enveloped access.

### Allowed Conformance Verdicts
Each persistent storage key is assigned exactly one verdict based on strict criteria:

1. `VERSIONED-OK`:
   - Persisted using the versioned envelope `{ v: number, data: T }` via `src/lib/storage/versioned.ts` (or an equivalent formal versioning contract).
   - Validates data types on read, provides a safe fallback on corruption or future versions, and defines a migration chain for legacy un-enveloped payloads.
2. `SAFE-RAW`:
   - Persisted without a `{ v, data }` envelope, but objectively safe from schema drift because:
     - The value is a primitive string (e.g. email, resume title, or boolean string `"true"`) with no nested object properties.
     - Storage is scoped strictly to the tab session via `sessionStorage` (`cm_attribution`), automatically cleared on tab/browser close.
     - Storage is owned and maintained by an external third-party SDK (`sb-*-auth-token` via Supabase GoTrue).
     - The key is deprecated and accessed only for cleanup/removal during sign-out (`careermonke_pro_active`).
3. `NEEDS-MIGRATION`:
   - Stores structured JSON objects, arrays of objects, or domain entity collections without a standardized schema version envelope.
   - Any property addition, rename, or type change in future releases risks crashing returning users.
   - **Remediation Rule**: In-flight feature/flow PRs currently own these components; migrations to `writeVersioned`/`readVersioned` are strictly documented here and cataloged for follow-up PRs to avoid merge conflicts.

---

## 2. Persistent Storage Keys Audit Table

| Key Pattern | Storage Medium | Data Shape | Owner Component / Hook | Versioned ({v,data}) | Verdict | Justification | Source Call Sites |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- | :--- |
| `cm_cookie_notice` | `localStorage` | `{ v: 1, data: boolean }` | `src/components/CookieNotice.tsx`, `src/lib/analytics/cookieConsent.ts` | Yes | **VERSIONED-OK** | Standardized `{ v: 1, data }` envelope with boolean type validation and legacy string migration. | `src/components/CookieNotice.tsx`, `src/lib/analytics/cookieConsent.ts`, `src/lib/storage/versioned.ts` |
| `careermonke_sidebar_expanded` | `localStorage` | `{ v: 1, data: boolean }` | `src/lib/sidebar.ts` | Yes | **VERSIONED-OK** | Standardized `{ v: 1, data }` envelope with boolean validation and migration from un-enveloped boolean strings. | `src/lib/sidebar.ts`, `src/lib/storage/versioned.ts` |
| `careermonke_user_email` | `localStorage` | `string` (email) | `src/lib/auth/session.ts` | No | **SAFE-RAW** | Primitive plain text string used strictly as an offline UI display fallback before session resolves; cleared on sign-out. | `src/lib/auth/session.ts`, `src/components/PaywallModal.tsx`, `src/components/UserMenu.tsx` |
| `careermonke_blocked_notice` | `localStorage` | `string` (`"true"`) | `src/lib/auth/session.ts`, `src/components/auth/BlockedAccountNotice.tsx` | No | **SAFE-RAW** | Transient alert flag checked with strict equality (`notice === "true"`) and immediately deleted upon user dismissal. | `src/lib/auth/session.ts`, `src/components/auth/BlockedAccountNotice.tsx` |
| `careermonke_pro_active` | `localStorage` | `None` (purge-only) | `src/lib/auth/session.ts` | No | **SAFE-RAW** | Deprecated legacy client override key; targeted solely for removal during user sign-out to prevent client-side entitlement spoofing. | `src/lib/auth/session.ts` |
| `sb-*-auth-token` | `localStorage` | `Session` JSON object (`access_token`, `refresh_token`, `user`) | `@supabase/supabase-js` (GoTrue Client) | No | **SAFE-RAW** | Managed and versioned externally by the Supabase GoTrue SDK; application code only reads tokens with defensive JSON parsing. | `src/app/admin/users/page.tsx`, `src/components/admin/EarlyAccessRequestsSection.tsx`, `src/components/analytics/PageViewTracker.tsx` |
| `cm_attribution` | `sessionStorage` | `Attribution` JSON object (`utmSource`, `referrer`, `capturedAt`) | `src/lib/analytics/utm.ts` | No | **SAFE-RAW** | Session-scoped strictly to tab lifetime in `sessionStorage` and automatically destroyed on tab close; read parses with try/catch and object typecheck. | `src/lib/analytics/utm.ts`, `src/components/analytics/PageViewTracker.tsx` |
| `careermonke_resume_title` | `localStorage` | `string` (title) | `src/app/resume/page.tsx` | No | **SAFE-RAW** | Primitive plain text title string without nested properties; used as local fallback label for master resume. | `src/app/resume/page.tsx` |
| `cm_hidden_jobs_*` (`cm_hidden_jobs_guest`, `cm_hidden_jobs_${userId}`) | `localStorage` | `string[]` (array of job UUIDs) | `src/app/jobs/page.tsx` | No | **NEEDS-MIGRATION** | Unversioned JSON array; evolving to include hide timestamps or reasons requires a `{ v, data }` migration envelope. | `src/app/jobs/page.tsx` |
| `cm_job_fit_*` (`cm_job_fit_${userId}_${jobId}_${resumeHash}`) | `localStorage` | `{ summary: string, missingSkills: string[], cachedAt: number }` | `src/components/dashboard/WhyMatchPanel.tsx` | No | **NEEDS-MIGRATION** | Unversioned structured explanation cache in localStorage; changes to fit summary or gap diagnostics need versioning. | `src/components/dashboard/WhyMatchPanel.tsx` |
| `careermonke:profile-draft:*` (`careermonke:profile-draft:${email}:${section}`) | `localStorage` | `{ ts: number, draft: CandidateProfile }` | `src/components/profile/ProfileDrawers.tsx` | No | **NEEDS-MIGRATION** | Unversioned full `CandidateProfile` draft persistence; breaking changes to profile fields risk silent edit corruption. | `src/components/profile/ProfileDrawers.tsx` |
| `careermonke_preferences` | `localStorage` | `UserPreferences` JSON object | `src/lib/auth/session.ts` | No | **NEEDS-MIGRATION** | Core user onboarding and filter preferences stored without versioning envelope; field shape changes risk client crashes. | `src/lib/auth/session.ts` |
| `careermonke_applications_*` (`careermonke_applications_guest`, `careermonke_applications_${userId}`, `careermonke_applications_tracker`, `careermonke_applications`) | `localStorage` | `TrackedApplication[]` | `src/lib/tracker/storage.ts` | No | **NEEDS-MIGRATION** | Core application tracker records stored as unversioned JSON arrays; schema changes to stages or notes risk data loss. | `src/lib/tracker/storage.ts` |
| `careermonke_candidate_profile_*` (`careermonke_candidate_profile`, `careermonke_candidate_profile_${userId}`) | `localStorage` | `CandidateProfile` JSON object | `src/lib/resume/storage.ts` | No | **NEEDS-MIGRATION** | Unversioned candidate facts object; changes to structured work experience or education schemas cause deserialization faults. | `src/lib/resume/storage.ts`, `src/app/auth/callback/page.tsx`, `src/app/settings/page.tsx`, `src/lib/auth/session.ts` |
| `careermonke_tailored_resume_*` (`careermonke_tailored_resume_${ownerId}_${jobId}`) | `localStorage` | `TailoredJobResumeResult` | `src/lib/resume/storage.ts` | No | **NEEDS-MIGRATION** | Relies on ad-hoc internal `operationVersion` string rather than standard `{ v, data }` envelope with fallback migration. | `src/lib/resume/storage.ts` |
| `careermonke_tailored_cover_letter_*` (`careermonke_tailored_cover_letter_${ownerId}_${jobId}`) | `localStorage` | `TailoredCoverLetterResult` | `src/lib/resume/storage.ts` | No | **NEEDS-MIGRATION** | Uses domain property `cacheVersion` instead of standard `{ v, data }` envelope; unversioned legacy items are dropped without migration chain. | `src/lib/resume/storage.ts` |

### Summary of Storage Keys Verdicts
- **VERSIONED-OK**: 2 keys (12.50%)
- **NEEDS-MIGRATION**: 8 keys (50.00%)
- **SAFE-RAW**: 6 keys (37.50%)
- **Total Audited Keys**: 16 keys

---

## 3. Cache Invalidation Map (SWR & In-Memory Client Caches)

CareerMonke employs a multi-tiered client cache architecture:
1. **SWR Client Cache (`src/lib/cache/swr.ts`)**: Memory-only store with a 200-entry bound (`SWR_MAX_ENTRIES`) and 60-second default TTL. Serves fast client paints and dedupes concurrent requests.
2. **In-Memory Service Caches**: Module-scoped singletons in `subscription.ts` (Pro status), `approval.ts` (Early Access status), `tracker/storage.ts` (Application records), and `resume/storage.ts` (Candidate profile).

### Cache Invalidation Call Sites & Assessment

| Invalidation Call Site | Target Cache / Key Prefix | Trigger Event / Mutation | Invalidation Mechanism | Status / Risk Flag | Notes & Remediation |
| :--- | :--- | :--- | :--- | :---: | :--- |
| `src/app/jobs/page.tsx:1363` | `dashboard:${user.id}` | Application stage update (`handleStageChange`) | `updateSwr` | **OK** | Correctly writes through mutation result in place to prevent stale dashboard application counts. |
| `src/app/jobs/page.tsx:1398` | `dashboard:${user.id}` | New application tracked (`handleCreateApplication`) | `updateSwr` | **OK** | Correctly prepends created application into cached `DashboardBundle` without triggering full re-fetch. |
| `src/app/jobs/page.tsx:1420` | `dashboard:${user.id}` | Application removed (`handleDeleteApplication`) | `updateSwr` | **OK** | Correctly filters out deleted application ID from cached `DashboardBundle` in place. |
| `src/lib/admin/earlyAccess.ts:457` | `approvalCache` (`normalizedEmail`) | Admin updates early access request status | `invalidateApprovalCache` | **OK** | Precisely purges the target user's in-memory approval entry upon approval or rejection. |
| `src/lib/billing/subscription.ts:40-44` | `cachedProStatus` (Global memory) | Window events (`auth_updated`, `pro_updated`, `route_changed`, `focus`, `popstate`) | `invalidateProAccessCache` | **FLAGGED (TOO BROAD)** | Listening to `focus` and `popstate` invalidates pro status whenever user switches browser tabs, causing redundant network fetches. |
| `src/lib/tracker/storage.ts:210` | `cachedApplications` (Global memory) | Local application save / update | `invalidateTrackedApplicationsCache` | **FLAGGED (MISSED KEY)** | Clears tracker memory cache, but does NOT invalidate SWR `dashboard:${userId}`, leaving dashboard with stale applications until 60s TTL. |
| `src/lib/resume/storage.ts:314` | `memoizedProfile` (Global memory) | Candidate profile deletion (`deleteCandidateProfile`) | `clearCandidateProfileMemoryCache` | **FLAGGED (MISSED KEY)** | Clears profile memory cache, but does NOT invalidate SWR `dashboard:${userId}`, leaving dashboard match state stale. |
| `src/app/auth/callback/page.tsx:34` | `memoizedProfile` (Global memory) | Auth callback completion / user login | `clearCandidateProfileMemoryCache` | **OK** | Purges in-memory profile cache on login so fresh user profile facts are fetched from Supabase. |
| `src/lib/auth/session.ts:267` | `memoizedProfile` (Global memory) | User sign-out (`signOutUser`) | `clearCandidateProfileMemoryCache` | **OK** | Wipes active in-memory profile cache to prevent cross-account profile leaks on shared devices. |
| `src/lib/auth/session.ts:268` | `cachedApplications` (Global memory) | User sign-out (`signOutUser`) | `clearTrackerMemoryState` | **OK** | Increments generation token and clears tracker memory cache to isolate user data. |
| `src/lib/cache/swr.ts:93` | `keyOrPrefix: string` | Generic key or prefix invalidation | `invalidateSwr` | **FLAGGED (UNUSED)** | Implemented and verified in unit tests, but currently has zero runtime call sites in production code. |

---

## 4. Key Gaps & Invalidation Blindspots

### 1. Dashboard SWR Bundle Invalidation Misses
`src/app/dashboard/page.tsx` consumes a composite bundle (`DashboardBundle`) keyed by `dashboard:${authUser.id}` via `swrFetch` (60s TTL). This bundle contains:
- `proRes`: Pro subscription status
- `prefRes`: User onboarding and job preferences
- `profileRes`: Candidate facts and resume data
- `appsRes`: Tracked job applications

While `src/app/jobs/page.tsx` updates `appsRes` via `updateSwr`, the other 3 data sources suffer from complete invalidation blindspots:
- **Profile Updates**: When a user uploads a new resume, edits facts in `src/components/profile/ProfileDrawers.tsx`, or confirms a profile in `src/app/resume/page.tsx`, `dashboard:${userId}` is never invalidated. The dashboard continues rendering stale profile facts and match scores until the 60s TTL elapses.
- **Preferences Changes**: When a user updates salary preferences or completes onboarding in `src/lib/auth/session.ts` (`saveUserPreferences`), `dashboard:${userId}` is not invalidated.
- **Pro Subscription Upgrades**: When a user upgrades via `src/components/PaywallModal.tsx` or Razorpay checkout, `invalidateProAccessCache` resets subscription memory, but the SWR cache in `dashboard:${userId}` continues serving `proRes: { isPro: false }` until TTL expires.
- **Tracker Page Edits**: When a user drags or updates applications on `/tracker` (via `src/lib/tracker/storage.ts`), `updateSwr` is never called. Only actions performed from `/jobs` update the dashboard SWR cache.

### 2. Overly Aggressive Pro Status Invalidation
In `src/lib/billing/subscription.ts:40-44`, `invalidateProAccessCache` is bound to:
```typescript
window.addEventListener("focus", invalidateProAccessCache);
window.addEventListener("popstate", invalidateProAccessCache);
```
Every time a user switches tabs or navigates back/forward, the pro access cache is wiped. Because `isSwrStale` or session cache expects a 60-second window, this defeats caching benefits and produces bursty network requests to Supabase `user_subscriptions`.

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
2. **Client State Migration PR (Preferences & Hidden Jobs)**:
   - Migrate `careermonke_preferences` and `cm_hidden_jobs_*` to `readVersioned` and `writeVersioned`.
   - Add schema validation and safe fallback defaults.
3. **SWR Invalidation Bus Alignment PR**:
   - Call `invalidateSwr(`dashboard:${userId}`)` on `careermonke_profile_updated`, `careermonke_preferences_updated`, and `careermonke_pro_updated` events.
   - Wire `updateSwr` into `src/lib/tracker/storage.ts` so tracker mutations from any route update the dashboard cache.
   - Remove window `focus` listener from `subscription.ts` to prevent redundant network bursts.
