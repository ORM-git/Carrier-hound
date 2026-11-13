# CareerMonke Navigation & Browser History Policy

This document establishes the canonical browser history policy (`push` vs `replace`) for all programmatic client-side navigations across `src/app/` and `src/components/`, and records the complete audit of every programmatic navigation site in the codebase.

---

## 1. Policy Rules

| Navigation Category | Required History Operation | Rationale |
| :--- | :--- | :--- |
| **User-initiated view transition** | `router.push(...)` or `<Link href="...">` | Moving to a new page/view where the user naturally expects Browser **Back** to return to the previous view (e.g., landing globe -> `/radar`, locked CTA -> `/login`, subview -> `/jobs`, dismissing modal -> `/`). |
| **In-page master-detail expansion** | `window.history.pushState(...)` + `popstate` | Selecting a job detail drawer (`?id=...`) pushes a reversible history state so Browser **Back** closes the detail pane and restores scroll position. |
| **State-only URL / filter synchronization** | `router.replace(..., { scroll: false })` or `window.history.replaceState(...)` | Syncing search text, filter facets, sort order, tabs, or filter resets updates the URL in-place without polluting Back/Forward history on every click or keystroke. |
| **Auth / permission / feature-flag guards** | `router.replace(...)` | Unauthenticated redirects to `/login?returnTo=...`, non-admin redirects from `/admin`, disabled feature-flag redirects, already-authenticated redirects off `/login` or `/signup`, and cross-tab sign-out sync must replace the invalid entry so Browser **Back** does not trap the user in a redirect loop. |
| **Transient callback & legacy redirect shims** | `router.replace(...)` (or `window.location.replace(...)`) | One-time OAuth/PKCE `/auth/callback` completion and legacy route shims (`/job-detail`, `/job-search/all`, `/jobs/detail`) must be removed from history after forwarding. |
| **Session teardown (sign-out)** | `router.replace("/")` (recommended) | Leaving an authenticated session replaces the current protected entry so Browser **Back** does not return to a stale authenticated route. *(Sites in open-PR-owned files are noted below for follow-up).* |
| **Explicit error recovery back control** | `router.back()` | Explicit "Go Back" UI actions in error states step back cleanly when triggered by the user. |

---

## 2. Complete Audit of `src/app/` and `src/components/`

Audit baseline: `origin/main` (`539c1c8b`). Sites corrected in this PR: **0** (all audited sites in non-open-PR files conform to the policy; five `router.push("/")` sign-out/account-deletion sites reside in files owned by open PRs and are documented as deferred follow-ups).

### 2A. `router.replace(` Sites (22 sites across 17 files)

| File | Line | Trigger / Context | Current Method | Policy Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `src/app/admin/layout.tsx` | 31 | Non-admin guard SSR fallback redirect to `/` | `router.replace("/")` | `replace` | Compliant |
| `src/app/admin/layout.tsx` | 45 | Admin auth check error SSR fallback redirect to `/` | `router.replace("/")` | `replace` | Compliant |
| `src/app/auth/callback/page.tsx` | 39 | Transient OAuth/PKCE callback finishing into `destination` | `router.replace(destination)` | `replace` | Compliant |
| `src/app/dashboard/page.tsx` | 218 | Unauthenticated mount guard on `/dashboard` | `router.replace("/login?returnTo=/dashboard")` | `replace` | Compliant |
| `src/app/job-detail/page.tsx` | 12 | Legacy route redirect shim (`/job-detail` -> `/jobs`) | ``router.replace(`/jobs${search}`)`` | `replace` | Compliant |
| `src/app/job-search/all/page.tsx` | 13 | Legacy route redirect shim (`/job-search/all` -> `/jobs`) | `router.replace(target)` | `replace` | Compliant |
| `src/app/jobs/[id]/interview-pack/InterviewPackClient.tsx` | 38 | Disabled feature-flag mount guard to `/dashboard` | `router.replace("/dashboard")` | `replace` | Compliant |
| `src/app/jobs/[id]/interview-pack/InterviewPackClient.tsx` | 45 | Unauthenticated mount guard to `/login` | ``router.replace(`/login?returnTo=/jobs/${jobId}/interview-pack`)`` | `replace` | Compliant |
| `src/app/jobs/[id]/skill-what-if/SkillWhatIfClient.tsx` | 38 | Disabled feature-flag mount guard to `/dashboard` | `router.replace("/dashboard")` | `replace` | Compliant |
| `src/app/jobs/[id]/skill-what-if/SkillWhatIfClient.tsx` | 45 | Unauthenticated mount guard to `/login` | ``router.replace(`/login?returnTo=/jobs/${jobId}/skill-what-if`)`` | `replace` | Compliant |
| `src/app/jobs/page.tsx` | 598 | Filter/search/tab/sort URL query param sync (`useEffect`) | `router.replace(newUrl, { scroll: false })` | `replace` | Compliant |
| `src/app/jobs/page.tsx` | 1312 | Reset all filters clearing query params in place | `router.replace(newUrl, { scroll: false })` | `replace` | Compliant |
| `src/app/login/page.tsx` | 75 | Already-authenticated auto-redirect off `/login` | `router.replace(next)` | `replace` | Compliant |
| `src/app/onboarding/page.tsx` | 141 | Unauthenticated mount guard on `/onboarding` | ``router.replace(`/login?returnTo=${encodeURIComponent(returnUrl)}`)`` | `replace` | Compliant |
| `src/app/profile/page.tsx` | 73 | Unauthenticated mount guard on `/profile` | `router.replace("/login?returnTo=/profile")` | `replace` | Compliant |
| `src/app/radar/page.tsx` | 49 | Unauthenticated mount guard on `/radar` | `router.replace("/login?returnTo=/radar")` | `replace` | Compliant |
| `src/app/resume/page.tsx` | 130 | Unauthenticated mount guard on `/resume` | `router.replace("/login?returnTo=/resume")` | `replace` | Compliant |
| `src/app/settings/page.tsx` | 64 | Unauthenticated mount guard on `/settings` | `router.replace("/login?returnTo=/settings")` | `replace` | Compliant |
| `src/app/signup/page.tsx` | 76 | Already-authenticated auto-redirect off `/signup` | `router.replace(next)` | `replace` | Compliant |
| `src/app/tracker/page.tsx` | 105 | Unauthenticated mount guard on `/tracker` | `router.replace("/login?returnTo=/tracker")` | `replace` | Compliant |
| `src/components/UserMenu.tsx` | 91 | Same-tab sign-out exit away from authenticated view | `router.replace("/")` | `replace` | Compliant |
| `src/components/shell/LoggedInAppShell.tsx` | 47 | Cross-tab sign-out `storage` listener on protected views | `router.replace("/login")` | `replace` | Compliant |

### 2B. `router.push(` and `router.back(` Sites (22 sites across 11 files)

| File | Line | Trigger / Context | Current Method | Policy Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `src/app/jobs/page.tsx` | 1384 | Unauthenticated click on Save Job -> `/signup` | ``router.push(`/signup?next=${encodeURIComponent("/jobs")}`)`` | `push` | Compliant |
| `src/app/jobs/page.tsx` | 1521 | Unauthenticated click on locked action -> `/login` | ``router.push(`/login?returnTo=${encodeURIComponent(currentPath)}`)`` | `push` | Compliant |
| `src/app/login/page.tsx` | 64 | Escape key dismisses `/login` modal route to `/` | `router.push("/")` | `push` | Compliant |
| `src/app/login/page.tsx` | 172 | Backdrop click dismisses `/login` modal route to `/` | `router.push("/")` | `push` | Compliant |
| `src/app/onboarding/page.tsx` | 226 | `handleSkipResume` proceeds to `next` (user may go back) | `router.push(next)` | `push` | Compliant |
| `src/app/onboarding/page.tsx` | 318 | Resume uploaded -> proceeds to `next` (user may go back) | `router.push(next)` | `push` | Compliant |
| `src/app/settings/page.tsx` | 199 | Post-account-deletion sign-out redirect to `/` | `router.push("/")` | `replace` (rec.) | Deferred (open PRs `#533`, `#301`, `#237`) |
| `src/app/settings/page.tsx` | 264 | Settings card Sign Out button redirect to `/` | `router.push("/")` | `replace` (rec.) | Deferred (open PRs `#533`, `#301`, `#237`) |
| `src/app/signup/page.tsx` | 65 | Escape key dismisses `/signup` modal route to `/` | `router.push("/")` | `push` | Compliant |
| `src/app/signup/page.tsx` | 166 | Backdrop click dismisses `/signup` modal route to `/` | `router.push("/")` | `push` | Compliant |
| `src/components/CategorySelectModal.tsx` | 19 | Continue click after category selection -> `/early-access` | `router.push("/early-access")` | `push` | Compliant |
| `src/components/GuideHeader.tsx` | 110 | Top header Sign Out handler redirect to `/` | `router.push("/")` | `replace` (rec.) | Deferred (open PR `#573`) |
| `src/components/JobRadarGlobe.tsx` | 550 | Unauthenticated click on locked radar job -> `/login` | ``router.push(`/login?returnTo=${encodeURIComponent(currentPath)}`)`` | `push` | Compliant |
| `src/components/interview-pack/InterviewPackView.tsx` | 121 | Error state "Go Back" button | `router.back()` | `back` | Compliant |
| `src/components/interview-pack/InterviewPackView.tsx` | 193 | Header back arrow to `/jobs` / selected job | `router.push(...)` | `push` | Compliant |
| `src/components/interview-pack/InterviewPackView.tsx` | 258 | Rail "Back to jobs" action to `/jobs` / selected job | `router.push(...)` | `push` | Compliant |
| `src/components/shell/AppTopBar.tsx` | 71 | Mobile drawer Sign Out handler redirect to `/` | `router.push("/")` | `replace` (rec.) | Deferred (open PR `#573`) |
| `src/components/shell/AppTopBar.tsx` | 266 | Avatar dropdown Sign Out button redirect to `/` | `router.push("/")` | `replace` (rec.) | Deferred (open PR `#573`) |
| `src/components/skill-what-if/SkillWhatIfView.tsx` | 185 | Header back arrow to `/jobs` / selected job | `router.push(...)` | `push` | Compliant |
| `src/components/ui/wireframe-dotted-globe.tsx` | 149 | Mouse click on hero globe -> `/radar` | `router.push("/radar")` | `push` | Compliant |
| `src/components/ui/wireframe-dotted-globe.tsx` | 188 | Touch tap on hero globe -> `/radar` | `router.push("/radar")` | `push` | Compliant |
| `src/components/ui/wireframe-dotted-globe.tsx` | 365 | "Tap for 3D Radar" button -> `/radar` | `router.push("/radar")` | `push` | Compliant |

### 2C. `window.history.*` Sites (4 sites across 2 files)

| File | Line | Trigger / Context | Current Method | Policy Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `src/app/jobs/page.tsx` | 1461 | `handleSelectJob` opens detail pane (`?id=...`) with `popstate` sync | `window.history.pushState(...)` | `pushState` | Compliant |
| `src/app/jobs/page.tsx` | 1486 | `handleBackToList` clears `?id`/`?jobId` while restoring scroll position without duplicating `/jobs` in history | `window.history.replaceState(...)` | `replaceState` | Compliant |
| `src/components/JobRadarGlobe.tsx` | 358 | Syncing 4 light radar filters (`country`, `cat`, `remote`, `internship`) to URL | `window.history.replaceState(null, "", newUrl)` | `replaceState` | Compliant |
| `src/components/JobRadarGlobe.tsx` | 372 | `handleResetAllFilters` resetting URL to `/radar` | `window.history.replaceState(null, "", "/radar")` | `replaceState` | Compliant |

### 2D. Appendix: Direct `window.location.*` Navigations (Informational)

| File | Line | Trigger / Context | Current Method | Policy Alignment |
| :--- | :--- | :--- | :--- | :--- |
| `src/app/admin/layout.tsx` | 29 | Non-admin guard hard redirect to `/` in browser | `window.location.replace("/")` | Compliant (`replace`) |
| `src/app/admin/layout.tsx` | 43 | Admin auth error fallback hard redirect to `/` | `window.location.replace("/")` | Compliant (`replace`) |
| `src/app/jobs/detail/page.tsx` | 8 | Legacy `/jobs/detail` route redirect shim -> `/jobs` | ``window.location.replace(`/jobs${...}`)`` | Compliant (`replace`) |
| `src/components/JobRadarGlobe.tsx` | 498 | 401 session check inside drawer Pro unlock -> `/login` | `window.location.assign(...)` | Compliant (`assign` / auth boundary) |
| `src/components/billing/ProUpgradeScreen.tsx` | 33 | Sign out on Pro upgrade wall -> `/` | `window.location.href = "/"` | Full reload to reset session state |
| `src/components/jobs/JobAiToolsPanel.tsx` | 99 | User clicks Tailor without resume -> `/resume` | `window.location.href = decision.destination \|\| "/resume"` | View transition |

---

## 3. Automated Enforcement

`scripts/test-navigation-history.ts` (registered in `scripts/suite-runner.ts` and `scripts/lib/test-guard.cjs`) statically scans `src/app/` and `src/components/` for `router.replace(` calls. Any new or unapproved `router.replace(` not listed in the documented, individually justified allowlist fails the test so history-destroying regressions cannot be introduced silently.
