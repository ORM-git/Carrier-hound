# Frontend Lifecycle & Memory-Leak Hygiene Audit

- **Audit date:** 2026-11-12
- **Scope:** All non-landing, non-test TypeScript/TSX modules under `src/` (`src/app/`, `src/components/`, `src/lib/`), plus re-verification of PR #441 (`JobRadarGlobe.tsx`) and PR #447 (`GlobalErrorReporter.tsx`).
- **Offline guard test:** `scripts/test-lifecycle-cleanup.ts`

## Exclusions

- **Landing files excluded (read-only / unmodified per scope):** `src/app/page.tsx`, `src/components/LandingTopArtifact.tsx`, `src/components/LandingGlobeFeatureSection.tsx`, `src/components/LandingJobsTickerStrip.tsx`, `src/components/landing/*`.
- **Unit tests excluded from runtime leak scan:** `**/__tests__/**`, `**/*.test.*`.

---

## Cleanups Added in This Audit

All 5 genuine missing cleanups discovered in non-landing modules outside open PRs were fixed with minimal unmount/re-run teardown changes (zero visual, copy, or layout changes):

1. `src/components/GlobeLiveStats.tsx`: Tracked `requestAnimationFrame` handles from `runCountUp` in `animFrameRef` and added `useEffect` unmount cleanup + pre-start cancellation calling `cancelAnimationFrame`.
2. `src/components/analytics/PageViewTracker.tsx`: Tracked `requestIdleCallback` (`idleId`) and fallback `setTimeout` (`fallbackTimeout`) handles and cancelled both (`cancelIdleCallback` / `clearTimeout`) plus checked `cancelled` in the `useEffect` cleanup on route change or unmount.
3. `src/components/ui/auth-ui.tsx` (`Typewriter`): Tracked the nested pause `setTimeout(() => setIsDeleting(true), delay)` in `pauseTimeout` and cleared it alongside the outer `timeout` in `useEffect` cleanup.
4. `src/components/ui/typewriter-text.tsx` (`Typewriter`): Same nested `pauseTimeout` tracking and `clearTimeout` cleanup in `Typewriter`.
5. `src/app/auth/callback/page.tsx`: Tracked `hashTimeoutId` (1500ms hash-session fallback) and `fallbackTimeoutId` (1000ms session fallback), cleared both in `useEffect` cleanup, and marked `resolved = true` on unmount alongside `subscription.unsubscribe()`.

---

## Re-Verification of PR #441 (`JobRadarGlobe.tsx` WebGL Teardown) & PR #447 (`GlobalErrorReporter.tsx`)

### PR #441 — `src/components/JobRadarGlobe.tsx` WebGL & Listener Teardown Chain

Re-verified line-by-line against current `main` (component file itself was left untouched; guarded continuously by `scripts/test-globe-cleanup.ts`):

| Teardown Item | Expected Behavior | Verified Implementation in `src/components/JobRadarGlobe.tsx` | Status |
| --- | --- | --- | --- |
| Subscription custom events | Remove `careermonke_pro_updated` and `careermonke_auth_updated` listeners on unmount | Lines 238-243 (`window.removeEventListener`) | PASS |
| Initial `/api/radar` telemetry fetch | Abort in-flight `fetch` on unmount | Lines 277-281 (`controller.abort()`) | PASS |
| Tab visibility telemetry refetch | Remove `document` `visibilitychange` listener on unmount | Lines 286-294 (`document.removeEventListener`) | PASS |
| Post-unmount `TextureLoader` callback | Dispose decoded GPU texture immediately if `TextureLoader.load` resolves after unmount | Lines 665-672 (`if (isCancelled) { texture.dispose(); return; }`) | PASS |
| Starfield / Earth / Atmosphere disposables | Dispose all tracked geometries & materials and clear `disposablesRef.current` | Lines 877-882 (`disposablesRef.current.forEach((d) => d.dispose())`) | PASS |
| Dynamic marker meshes (`markersGroupRef`) | Drain & dispose geometry/materials on unmount (plus Effect 9 pre-rebuild drain) | Lines 886-897 (unmount drain), Lines 918-926 (update drain) | PASS |
| `OrbitControls` instance | Dispose DOM listeners and control state; instance-scoped `controls.addEventListener("start", ...)` drops with `controls` | Line 899 (`controls.dispose()`) | PASS |
| `WebGLRenderer` & WebGL context | Dispose renderer resources, explicitly force context loss (~16 context browser limit), remove canvas from DOM | Lines 900-909 (`renderer.dispose()`, `renderer.forceContextLoss()`, `renderer.domElement.remove()`) | PASS |
| Animation frame & window/doc handlers | Cancel RAF handle and remove `resize` & `visibilitychange` listeners | Lines 873-875 (`cancelAnimationFrame`, `window.removeEventListener`, `document.removeEventListener`) | PASS |
| Dead component note | Confirm `src/components/ui/wireframe-dotted-globe.tsx` remains unreferenced dead code | Zero imports across `src/`; still has `IntersectionObserver.disconnect()`, `removeEventListener`, `cancelAnimationFrame` | PASS |

### PR #447 — `src/components/monitoring/GlobalErrorReporter.tsx` Hydration & Error Listener Guard

Re-verified against current `main`:

- Attaches `window.addEventListener("error", onError)` and `window.addEventListener("unhandledrejection", onRejection)` inside `useEffect(..., [])` (lines 51-52).
- Removes both handlers identically (`window.removeEventListener("error", onError)` / `"unhandledrejection"`) in `useEffect` cleanup (lines 53-56).
- Bounds `recentFingerprints` (`DEDUPE_WINDOW_MS = 10_000`, pruned when `recentFingerprints.size > 100`) so long-lived tabs cannot leak memory via error deduplication state.

---

## Intentional App-Lifetime & Framework-Scoped Allowlist

Entries allowlisted in `scripts/test-lifecycle-cleanup.ts`:

1. **`src/lib/billing/subscription.ts`** (`addEventListener` without `removeEventListener`): Registers 5 module-singleton `window` listeners (`careermonke_auth_updated`, `careermonke_pro_updated`, `careermonke_route_changed`, `focus`, `popstate`) at module initialization to keep `cachedProStatus` consistent for the entire browser session across client navigations.
2. **`src/components/JobRadarGlobe.tsx`** (`controls.addEventListener("start", ...)`): Registered on a locally instantiated `THREE.OrbitControls` instance that is disposed on unmount via `controls.dispose()` (PR #441), not on `window`/`document`.
3. **`src/app/jobs/page.tsx` & `src/components/jobs/JobCardMenu.tsx`** (one-shot `requestAnimationFrame`): Single-shot `window.scrollTo` / `itemRefs.current[0]?.focus()` scheduled inside `popstate`, detail-close handler, or menu-open effect rather than a recursive animation loop.

---

## Complete Listener / Observer / Timer / Subscription -> Cleanup Map (`src/`)

| File | Resource(s) Registered | Cleanup Mechanism | Status |
| --- | --- | --- | --- |
| `src/app/auth/callback/page.tsx` | `supabase.auth.onAuthStateChange`; 1500ms & 1000ms `setTimeout` | `subscription.unsubscribe()`; `clearTimeout(hashTimeoutId / fallbackTimeoutId)` + `resolved = true` (fixed) | CLEAN |
| `src/app/dashboard/page.tsx` | `document.addEventListener("visibilitychange")` | `document.removeEventListener("visibilitychange", onVisible)` | CLEAN |
| `src/app/jobs/page.tsx` | `setTimeout`; `dialog.addEventListener("keydown")`; `window.addEventListener("popstate", ...4x careermonke_*)`; one-shot `requestAnimationFrame` | `clearTimeout`; `dialog.removeEventListener`; `window.removeEventListener` (all 5); one-shot `scrollTo` RAF allowlisted | CLEAN |
| `src/app/login/page.tsx` | `window.addEventListener("keydown")`; `setInterval` cooldown | `window.removeEventListener`; `clearInterval` | CLEAN |
| `src/app/onboarding/page.tsx` | Post-upload 400ms redirect `setTimeout` in submit handler | Transient one-shot redirect feedback after async save completion | CLEAN |
| `src/app/pricing/page.tsx` | `window.addEventListener` (`careermonke_pro_updated`, `careermonke_auth_updated`) | `window.removeEventListener` (both) | CLEAN |
| `src/app/profile/page.tsx` | `window.addEventListener("careermonke_profile_updated", "scroll")`; `requestAnimationFrame`; `scrollTimerRef` `setTimeout` | `window.removeEventListener` (both); `cancelAnimationFrame`; `clearTimeout` | CLEAN |
| `src/app/resume/page.tsx` | `document.addEventListener("mousedown")`; `window.addEventListener("careermonke_profile_updated")` | `document.removeEventListener`; `window.removeEventListener` | CLEAN |
| `src/app/signup/page.tsx` | `window.addEventListener("keydown")`; `setInterval` cooldown | `window.removeEventListener`; `clearInterval` | CLEAN |
| `src/app/tracker/page.tsx` | `window.addEventListener("careermonke_tracker_updated")` | `window.removeEventListener` | CLEAN |
| `src/components/BackToTop.tsx` | `window.addEventListener("scroll")` | `window.removeEventListener` | CLEAN |
| `src/components/CategoryPillBar.tsx` | `document.addEventListener("mousedown", "keydown")` | `document.removeEventListener` (both) | CLEAN |
| `src/components/CookieNotice.tsx` | `window.addEventListener(COOKIE_CONSENT_EVENT, "resize")`; `MutationObserver`; height `window.addEventListener("resize")` | `window.removeEventListener` (all 3); `observer.disconnect()` | CLEAN |
| `src/components/FilterSlideOver.tsx` | `document.addEventListener("keydown")` | `document.removeEventListener` | CLEAN |
| `src/components/GlobeLiveStats.tsx` | `setInterval` (60s fetch, 30s label); `IntersectionObserver`; `requestAnimationFrame` count-up loop | `clearInterval` (both); `observer.disconnect()`; `cancelAnimationFrame(animFrameRef.current)` (fixed) | CLEAN |
| `src/components/GuideHeader.tsx` | `document.addEventListener("keydown", "mousedown")`; `window.addEventListener` (`careermonke_auth_updated`, `careermonke_pro_updated`) | Matching `document.removeEventListener` & `window.removeEventListener` in each effect | CLEAN |
| `src/components/JobRadarGlobe.tsx` | `window` custom/resize listeners; `document` `visibilitychange`; `controls.addEventListener("start")`; `requestAnimationFrame`; `THREE.Texture` & marker meshes | `removeEventListener`; `cancelAnimationFrame`; `disposablesRef` + `markersGroupRef` + `controls.dispose()` + `renderer.dispose()` + `forceContextLoss()` + `isCancelled` texture dispose | CLEAN |
| `src/components/UserMenu.tsx` | `supabase.auth.onAuthStateChange`; `window.addEventListener` (`careermonke_auth_updated`, `careermonke_pro_updated`, `storage`) | `listener.subscription.unsubscribe()`; `window.removeEventListener` (all 3) | CLEAN |
| `src/components/analytics/PageViewTracker.tsx` | `window.addEventListener(COOKIE_CONSENT_EVENT)`; `requestIdleCallback` / `setTimeout` | `window.removeEventListener`; `cancelIdleCallback` / `clearTimeout` + `cancelled` guard (fixed) | CLEAN |
| `src/components/analytics/WebVitalsTracker.tsx` | `window.addEventListener(COOKIE_CONSENT_EVENT)` | `window.removeEventListener` | CLEAN |
| `src/components/auth/BlockedAccountNotice.tsx` | `window.addEventListener("careermonke_auth_updated")` | `window.removeEventListener` | CLEAN |
| `src/components/dashboard/WhyMatchPanel.tsx` | Rate-limit `setTimeout` in `useEffect` | `clearTimeout(timer)` | CLEAN |
| `src/components/interview-pack/AskThemSection.tsx` | 2s copy-badge `setTimeout` in click handler | Transient event-triggered UX reset | CLEAN |
| `src/components/interview-pack/QuestionsCardDeck.tsx` | `window.addEventListener("keydown")` | `window.removeEventListener` | CLEAN |
| `src/components/interview-pack/SourcesDrawer.tsx` | Focus `setTimeout`; `window.addEventListener("keydown")` | `clearTimeout(timer)`; `window.removeEventListener` | CLEAN |
| `src/components/interview-pack/YourAnswersSection.tsx` | 2s copy-badge `setTimeout` in click handler | Transient event-triggered UX reset | CLEAN |
| `src/components/jobs/AllFiltersDrawer.tsx` | `document.addEventListener("keydown")` | `document.removeEventListener` | CLEAN |
| `src/components/jobs/JobCardMenu.tsx` | `document.addEventListener("mousedown", "touchstart")`; one-shot focus `requestAnimationFrame` | `document.removeEventListener` (both); one-shot optional-chained `itemRefs.current[0]?.focus()` allowlisted | CLEAN |
| `src/components/jobs/JobDetailView.tsx` | `window.addEventListener("scroll")`; 2.5s copy-feedback `setTimeout` | `window.removeEventListener`; transient event-triggered UX reset | CLEAN |
| `src/components/jobs/JobFilterBar.tsx` | `document.addEventListener("keydown", "mousedown")` | `document.removeEventListener` (both) | CLEAN |
| `src/components/jobs/MobileFilterSheet.tsx` | `document.addEventListener("keydown")` | `document.removeEventListener` | CLEAN |
| `src/components/monitoring/GlobalErrorReporter.tsx` | `window.addEventListener("error", "unhandledrejection")` | `window.removeEventListener` (both, PR #447 verified) | CLEAN |
| `src/components/profile/ProfileDrawers.tsx` | Focus `window.setTimeout`; `window.addEventListener("keydown")` | `window.clearTimeout`; `window.removeEventListener` | CLEAN |
| `src/components/resume/CoverLetterModal.tsx` | `window.addEventListener("careermonke_auth_updated")`; `onAuthStateChange`; 2s copy `setTimeout` | `window.removeEventListener`; `authListener?.unsubscribe()` | CLEAN |
| `src/components/resume/ResumeUploadAndConfirm.tsx` | 4s save-badge `setTimeout` in submit handler | Transient submit-triggered UX reset | CLEAN |
| `src/components/resume/TailorResumeModal.tsx` | `window.addEventListener("careermonke_auth_updated")`; `onAuthStateChange`; 2s copy `setTimeout` | `window.removeEventListener`; `authListener?.unsubscribe()` | CLEAN |
| `src/components/shell/AppIconRail.tsx` | `window.addEventListener("careermonke_detail_open")` | `window.removeEventListener` | CLEAN |
| `src/components/shell/AppTopBar.tsx` | `window.addEventListener("keydown")` | `window.removeEventListener` | CLEAN |
| `src/components/shell/LoggedInAppShell.tsx` | `window.addEventListener("storage")` | `window.removeEventListener` | CLEAN |
| `src/components/testimonials.tsx` | `mediaQuery.addEventListener("change")`; `IntersectionObserver`; `ResizeObserver`; `window.addEventListener("resize")` | `mediaQuery.removeEventListener`; `observer.disconnect()`; `ro.disconnect()`; `window.removeEventListener` | CLEAN |
| `src/components/ui/auth-ui.tsx` | `Typewriter` outer & nested `pauseTimeout` `setTimeout` | `clearTimeout(timeout)` & `clearTimeout(pauseTimeout)` (fixed) | CLEAN |
| `src/components/ui/typewriter-text.tsx` | `Typewriter` outer & nested `pauseTimeout` `setTimeout` | `clearTimeout(timeout)` & `clearTimeout(pauseTimeout)` (fixed) | CLEAN |
| `src/components/ui/wireframe-dotted-globe.tsx` | `IntersectionObserver`; `canvas`/`window` mouse & touch `addEventListener`; `requestAnimationFrame` | `observer.disconnect()`; `removeEventListener` (all); `cancelAnimationFrame` | CLEAN |
| `src/lib/admin/auditLog.ts` | Per-request `setTimeout` abort timer | `clearTimeout(timeout)` in `finally` | CLEAN |
| `src/lib/ai/serviceHandler.ts` | Per-request `abortController.signal.addEventListener("abort", ..., { once: true })`; `setTimeout` | `{ once: true }` single-fire per request + `clearTimeout(timeoutHandle)` | CLEAN |
| `src/lib/api/sharedRateLimit.ts` | Per-call `setTimeout` race timer | `clearTimeout(timeout)` | CLEAN |
| `src/lib/api/stats.ts` | `useLiveStats` `setInterval` | `clearInterval(interval)` + `mounted` flag | CLEAN |
| `src/lib/billing/subscription.ts` | Module-level `window.addEventListener` x5 (`careermonke_*`, `focus`, `popstate`) | Allowlisted intentional app-lifetime singleton cache invalidators | ALLOWLISTED |
| `src/lib/companies/logoResolver.ts` | Per-fetch `setTimeout` abort timer | `clearTimeout(timer)` in `finally` | CLEAN |
| `src/lib/early-access/gmail.ts` | `parentSignal.addEventListener("abort", ..., { once: true })`; `setTimeout` | `removeEventListener` + `clearTimeout` in `finally` | CLEAN |
| `src/lib/health/dbHealth.ts` | Per-probe `setTimeout` abort timer | `clearTimeout(timer)` in `finally` | CLEAN |
| `src/lib/health/readiness.ts` | Per-probe `setTimeout` timeout | `clearTimeout(timer)` in `finally` | CLEAN |
| `src/lib/resume/useCandidateProfile.ts` | `subscribeCandidateProfile(...)` | Returned `unsubscribe()` called in `useEffect` cleanup | CLEAN |
| `src/lib/salary/fx.ts` | Per-fetch `setTimeout` abort timer | `clearTimeout(timeoutId)` in `finally` | CLEAN |
| `src/lib/sidebar.ts` | `useSidebarMode` `window.addEventListener(SIDEBAR_EVENT_KEY, "storage")` | `window.removeEventListener` (both) | CLEAN |
