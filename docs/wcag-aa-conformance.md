# CareerMonke WCAG 2.1 AA Conformance Statement & Landmark Audit

> **Run checker**: `node scripts/check-wcag-landmarks.cjs`

---

## 1. Conformance Overview & Methodology

This document establishes the formal accessibility conformance statement for CareerMonke against the **Web Content Accessibility Guidelines (WCAG) 2.1 Level AA** standard.

### Methodology & Principles
- **Strict Evidence-Based Assertions**: Every evaluation verdict is grounded strictly in concrete, inspectable repository artifacts: deterministic static scanner guards, automated accessibility audit suites, color contrast analyzers, pixel-diff verifiers, or source-code implementations.
- **No Extrapolations**: No criterion is marked as *Supports* unless an existing tool, test, or hardcoded design-token assertion definitively verifies it across all applicable routes. Where coverage is limited to sample routes (e.g. contrast axe checks on 8 routes, zoom reflow on 3 routes with 8px tolerance), lacks assertions (e.g. logging tab stops without assertions), or where static rules verify existence rather than semantic correctness (e.g. Rule 2 checking role without keyboard listener, Rule 3 accepting arbitrary id without resolving a label, Rule 4 checking button name presence without matching visible text), the criterion is marked *Partially Supports*. Where no automated evaluation exists in the repository, it is marked *Not Evaluated*.
- **Three Allowed Conformance Verdicts**:
  1. `Supports`: Verified by existing automated tests, scripts, or explicit architecture constraints across all surfaces.
  2. `Partially Supports`: Implemented or tested on primary routes, but subject to known gaps or lacking automated repository-wide test coverage.
  3. `Not Evaluated`: Not covered by active automated test tooling or formal evaluation artifacts in this repository.

---

## 2. WCAG 2.1 AA Per-Criterion Conformance Table

| Criterion | Level | Verdict | Evidence & File Citations |
| :--- | :---: | :---: | :--- |
| **1.1.1 Non-text Content** | A | Partially Supports | `scripts/audit-static-a11y.ts` (Rule 1 scans `src/` components for `img`/`Image` missing `alt`); `scripts/test-a11y-fixes.ts` (star rating `role="img"`, icons `aria-hidden="true"`). Gap: Decorative SVGs and WebGL canvas in `src/components/JobRadarGlobe.tsx` lack exhaustive automated alt/hidden static enforcement across the full codebase. |
| **1.2.1 Audio-only and Video-only (Prerecorded)** | A | Not Evaluated | No prerecorded standalone audio/video media hosted or streamed; no evaluation pipeline exists. |
| **1.2.2 Captions (Prerecorded)** | A | Not Evaluated | No prerecorded video with synchronized speech hosted; no evaluation artifact exists. |
| **1.2.3 Audio Description or Media Alternative (Prerecorded)** | A | Not Evaluated | No prerecorded synchronized video media present; no test artifact exists. |
| **1.2.4 Captions (Live)** | AA | Not Evaluated | No live streaming media delivered by application. |
| **1.2.5 Audio Description (Prerecorded)** | AA | Not Evaluated | No prerecorded video media delivered by application. |
| **1.3.1 Info and Relationships** | A | Partially Supports | `scripts/audit-static-a11y.ts` (Rule 3 inputs with labels, Rule 2 click roles); `scripts/test-heading-order.ts` (heading outline); `scripts/test-a11y-main-landmarks.ts` (main landmarks on auth/radar/legal). Gap: 28 non-landing routes have landmark gaps (missing headers, navs, or unlabeled asides). |
| **1.3.2 Meaningful Sequence** | A | Partially Supports | `scripts/test-heading-order.ts` (source order hierarchy); `scripts/verify-keyboard-raw.js` (logs tab stops across `/`, `/login`, `/jobs`). Gap: `verify-keyboard-raw.js` only logs tab stops without asserting DOM sequence vs visual reading order. |
| **1.3.3 Sensory Characteristics** | A | Not Evaluated | No instructions rely solely on shape, size, visual orientation, or sound; no automated inspection script exists in the repository. |
| **1.3.4 Orientation** | AA | Supports | `src/app/layout.tsx` (`viewport` configuration sets `width: device-width, initialScale: 1` without orientation locks or `user-scalable=no`); CSS media queries adapt freely to portrait and landscape. |
| **1.3.5 Identify Input Purpose** | AA | Partially Supports | Form inputs in `src/app/login/page.tsx` and `src/app/signup/page.tsx` use standard input types (`type="email"`, `type="text"`). Gap: Comprehensive `autoComplete` auditing across all dynamic forms lacks a standalone static guard. |
| **1.4.1 Use of Color** | A | Partially Supports | `scripts/run-contrast-axe-check.js` (`link-in-text-block` check across 8 sample routes); interactive states use underlines, background fills, and text labels. Gap: `run-contrast-axe-check.js` logs without asserting exit code 1 on violations and only covers 8 routes. |
| **1.4.2 Audio Control** | A | Not Evaluated | No audio plays automatically on page load or background; no audio controls implemented. |
| **1.4.3 Contrast (Minimum)** | AA | Partially Supports | `scripts/run-contrast-axe-check.js` (axe `color-contrast` checks on 8 routes); `scripts/verify-contrast-pixel-diff.js` (pixel-diff baseline); `scripts/test-contrast-negative-control.js` (negative control pass); `docs/design-system.md` & `docs/frontend-guidelines.md` (token discipline). Gap: `run-contrast-axe-check.js` logs without failing on violations, relies on local environment, and covers only 8 routes. |
| **1.4.4 Resize Text** | AA | Partially Supports | `scripts/test-zoom-reflow.ts` (Puppeteer text zoom to 200% font-size across `/`, `/jobs`, `/login`). Gap: Limited to 3 routes, allows 8px overflow tolerance, and does not assert across all 32 routes. |
| **1.4.5 Images of Text** | AA | Supports | UI renders textual content exclusively via web fonts (`Inter` via `next/font/google`), SVG icons (`lucide-react`, `src/components/BrandIcon.tsx`), and CSS; no raster images of text used. |
| **1.4.10 Reflow** | AA | Partially Supports | `scripts/test-zoom-reflow.ts` (Puppeteer 400% zoom verification at 320px viewport width on `/`, `/jobs`, `/login`). Gap: Evaluated on 3 routes only, allows 8px tolerance, and skips overflow-hidden/scroll ancestors. |
| **1.4.11 Non-text Contrast** | AA | Partially Supports | `src/styles/tokens.css` defines 3:1 focus ring boundaries (`focus-visible:ring-2 focus-visible:ring-blue-600`); UI borders use high-contrast slate-200/slate-300 on white backgrounds. Gap: No automated checker gates non-text contrast across all routes. |
| **1.4.12 Text Spacing** | AA | Not Evaluated | Layouts use Tailwind line-height and spacing defaults; no automated text-spacing override script exists in the repository. |
| **1.4.13 Content on Hover or Focus** | AA | Partially Supports | `scripts/test-hover-touch-guards.ts` (audits `src/app/globals.css` and `src/styles/tokens.css`, ensuring `:hover` rules are guarded with `@media (hover: hover)`); interactive menus close on Escape/click-outside. Gap: No automated test for tooltip dismissal without moving hover. |
| **2.1.1 Keyboard** | A | Partially Supports | `scripts/audit-static-a11y.ts` (Rule 2 checks `role` on clickable `div`/`span`); `src/app/pricing/page.tsx` (`handleKeyDownPlan` supports Space, Enter, Arrow keys). Gap: Rule 2 checks role only without asserting keyboard listeners (`onKeyDown`), and tab order is not asserted across all routes. |
| **2.1.2 No Keyboard Trap** | A | Partially Supports | `scripts/verify-keyboard-raw.js` (dispatches Escape key on `/jobs` modal/drawer); modal handlers implement Escape listeners in `src/components/FilterSlideOver.tsx` and `src/components/UserMenu.tsx`. Gap: `verify-keyboard-raw.js` logs tab stops without asserting entrapment avoidance. |
| **2.1.4 Character Key Shortcuts** | AA | Not Evaluated | No single-character non-modifier access keys are implemented in the application. |
| **2.2.1 Timing Adjustable** | A | Not Evaluated | No session expiration timers or countdowns restrict job search or dashboard usage. |
| **2.2.2 Pause, Stop, Hide** | A | Partially Supports | `scripts/test-ticker-paging-and-strip.ts` & `src/components/LandingJobsTickerStrip.tsx` (ticker pauses on hover and focus); WebGL globe in `src/components/JobRadarGlobe.tsx` supports graceful unmount. Gap: Lacks explicit persistent user pause/stop control toggles. |
| **2.3.1 Three Flashes or Below Threshold** | A | Supports | `src/app/globals.css` (CSS animations are limited to smooth spinners and transitions below 3 Hz threshold); application contains zero flashing or strobing content. |
| **2.4.1 Bypass Blocks** | A | Partially Supports | `src/app/layout.tsx` (Skip link `<a href="#main-content">Skip to main content</a>` mounted in root layout); `scripts/test-redesign-jobs-page.ts` (asserts `id="main-content"` on jobs page). Gap: 28 non-landing pages lack `<main id="main-content">` or have landmark gaps, preventing skip link from working universally. |
| **2.4.2 Page Titled** | A | Partially Supports | `src/lib/__tests__/perPageMetadata.test.ts` (verifies title and description metadata across segment layouts `login`, `signup`, `pricing`, `early-access`, `radar`, `job-detail`, and `worldwide`); `src/app/layout.tsx` (root title fallback). Gap: Dynamic subroutes and admin pages lack individual title assertion tests. |
| **2.4.3 Focus Order** | A | Partially Supports | `src/components/a11y/RouteFocusManager.tsx` & `scripts/test-route-focus.ts` (moves focus to `#main-content` with `tabindex="-1"` and `preventScroll: true` on route transitions). Gap: In-page logical tab focus order is logged by `scripts/verify-keyboard-raw.js` but lacks automated pass/fail assertion tests. |
| **2.4.4 Link Purpose (In Context)** | A | Partially Supports | `scripts/run-contrast-axe-check.js` (`link-in-text-block` check on 8 routes); link text across primary routes provides clear destination labels. Gap: No automated repository-wide test proving all link texts are descriptive in context. |
| **2.4.5 Multiple Ways** | AA | Partially Supports | Navigation rails and footer directories in `src/components/Footer.tsx` and `src/components/GuideHeader.tsx`; job listings discoverable via search query inputs, category filters, and location pills. Gap: Lacks formal automated architecture test asserting discovery paths for all public pages. |
| **2.4.6 Headings and Labels** | AA | Partially Supports | `scripts/test-heading-order.ts` (proves logical heading hierarchy on public pages); `scripts/audit-static-a11y.ts` (Rule 3 checks input label presence, Rule 4 checks button name presence). Gap: Rule 3 accepts any `id` without resolving matching label, and Rule 4 checks name existence rather than matching visible text. |
| **2.4.7 Focus Visible** | AA | Partially Supports | `src/styles/tokens.css` and `src/app/globals.css` define focus ring styles (`focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none`). Gap: No automated test asserts that visible focus rings render on every interactive element across routes. |
| **2.5.1 Pointer Gestures** | A | Supports | Standard pointer activations in `src/app/jobs/page.tsx` and `src/components/jobs/JobFilterBar.tsx` operate via single-pointer activations (simple clicks or taps); no multi-point or path-based gestures required. |
| **2.5.2 Pointer Cancellation** | A | Supports | Standard React `onClick` event handlers in `src/components/GuideHeader.tsx` and `src/components/jobs/JobFilterBar.tsx` execute on pointer release (`mouseup`/`touchend`), permitting user cancellation by dragging the pointer away before release. |
| **2.5.3 Label in Name** | A | Partially Supports | `scripts/audit-static-a11y.ts` (Rule 4 checks that buttons have an accessible name). Gap: Rule 4 checks only accessible name existence (`aria-label`, visible text, or `title`), but does not verify that the accessible name contains or matches the visible text string. |
| **2.5.4 Motion Actuation** | A | Supports | `src/app/layout.tsx` (no device motion listeners or shaking/tilting triggers implemented in application). |
| **3.1.1 Language of Page** | A | Supports | `src/app/layout.tsx` configures `<html lang="en">` on root HTML element. |
| **3.1.2 Language of Parts** | AA | Not Evaluated | Content is strictly English; no multilingual inline phrases require distinct `lang` attributes. |
| **3.2.1 On Focus** | A | Partially Supports | `scripts/test-route-focus.ts` & `src/components/a11y/RouteFocusManager.tsx` (route focus management skips initial load, applies `preventScroll`, and suppresses unexpected context shifts). Gap: No repository-wide automated test asserting interactive controls do not initiate context changes on focus. |
| **3.2.2 On Input** | A | Partially Supports | Search and filter change handlers in `src/components/jobs/JobFilterBar.tsx` do not trigger automatic navigation or form submission on value change; actions require explicit button submission or Enter key. Gap: Lacks automated static assertion across all inputs. |
| **3.2.3 Consistent Navigation** | AA | Partially Supports | Reusable shell layouts and navigation bars in `src/components/shell/LoggedInAppShell.tsx` and `src/components/GuideHeader.tsx` appear in consistent order and layout across mounting pages. Gap: Lacks automated suite verifying navigation ordering across all 32 routes. |
| **3.2.4 Consistent Identification** | AA | Partially Supports | UI components, branding assets (`src/components/BrandIcon.tsx`), and directories (`src/components/Footer.tsx`) share consistent visual presentation and nomenclature. Gap: Lacks automated icon/label consistency tests across all views. |
| **3.3.1 Error Identification** | A | Partially Supports | Authentication forms in `src/app/login/page.tsx` and `src/app/signup/page.tsx` display visible inline error messages with `role="alert"` or text descriptions. Gap: Comprehensive error identification guard covering all interactive dialogs is not yet registered. |
| **3.3.2 Labels or Instructions** | A | Partially Supports | `scripts/audit-static-a11y.ts` (Rule 3 scans for `<input>` labels). Gap: Rule 3 accepts any `id` on `<input>` without checking whether a corresponding `<label htmlFor="...">` exists in the markup. |
| **3.3.3 Error Suggestion** | AA | Partially Supports | Authentication forms in `src/app/login/page.tsx` provide actionable remediation guidance for invalid email formatting. Gap: Lacks centralized validation rule dictionary test. |
| **3.3.4 Error Prevention (Legal, Financial, Data)** | AA | Partially Supports | Subscription order creation (`src/app/api/billing/razorpay/order/route.ts`) and account deletion flows (`src/app/settings/page.tsx`) display pricing terms and require explicit user confirmation. Gap: Lacks formalized review-and-confirm patterns across all forms. |
| **4.1.1 Parsing** | A | Supports | `src/app/layout.tsx` and React JSX compilation ensure well-formed HTML without duplicate attributes or unclosed elements (formally obsolete in WCAG 2.1/2.2 errata). |
| **4.1.2 Name, Role, Value** | A | Partially Supports | `scripts/audit-static-a11y.ts` (Rule 2 role on clickables, Rule 3 input labels, Rule 4 button names); `scripts/test-a11y-fixes.ts` (select `aria-label="Sort by"`, star rating roles). Gap: Rule 2 checks role only (no keyboard handlers), Rule 3 accepts unlinked ids, and Rule 4 checks name existence without text matching. |
| **4.1.3 Status Messages** | AA | Partially Supports | `src/app/layout.tsx` mounts `ToastContainer` for transient alerts; search result counts announced via aria-live. Gap: Automated test coverage does not span all dynamic views. |

### Summary of Criteria Verdicts
- **Supports**: 8
- **Partially Supports**: 31
- **Not Evaluated**: 11
- **Total Evaluated / Audited**: 50 criteria (100% of WCAG 2.1 Level A & AA)

---

## 3. Semantic Landmark Structure Audit

This audit evaluates every non-landing page in `src/app` (32 pages total; landing page `src/app/page.tsx` is excluded as it is owned by a separate PR) against the W3C WAI-ARIA and HTML5 semantic landmark requirements:
1. **Main Landmark**: Exactly one `<main>` (or `role="main"`) landmark per page.
2. **Banner Header**: Exactly one banner `<header>` (or `role="banner"`) landmark per page.
3. **Labeled Navigation**: Every `<nav>` (or `role="navigation"`) landmark must have an accessible label (`aria-label` or `aria-labelledby`).
4. **Labeled Complementary**: Any `<aside>` (or `role="complementary"`) landmark must have an accessible label (`aria-label` or `aria-labelledby`).

> **Note on Navigation Landmarks**: While WCAG 2.1 does not universally mandate that every page must contain a `<nav>` landmark (e.g. standalone wizards or legal disclosures), the project's stricter rubric enforces that all application pages should provide a labeled `<nav>` to support landmark jump navigation for assistive technologies.

### Per-Page Landmark Audit Table

| Page Route | File Path | Main Landmark | Banner Header | Labeled Nav | Complementary Regions | Landmark Status | Identified GAPs |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `/about` | `src/app/about/page.tsx` | 1 (PASS) | No | Yes | None | **GAP** | Missing banner `<header>` (brand header renders in unsemantic `<div>`); `<nav>` and header nested inside `<main>` |
| `/admin` | `src/app/admin/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/admin/users` | `src/app/admin/users/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/applications` | `src/app/applications/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/auth/callback` | `src/app/auth/callback/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/contact` | `src/app/contact/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark (required by project rubric) |
| `/dashboard` | `src/app/dashboard/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`). Note: `DashboardSkeleton` and `LoggedInAppShell` are mutually exclusive conditional states, each rendering exactly one `<main>`. |
| `/early-access` | `src/app/early-access/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Missing `<nav>` landmark (required by project rubric); Banner `<header>` is nested inside `<main>` |
| `/job-detail` | `src/app/job-detail/page.tsx` | 0 (0) | No | No | None | **GAP** | Redirect stub: missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/job-search/all` | `src/app/job-search/all/page.tsx` | 0 (0) | No | No | None | **GAP** | Redirect stub: missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/jobs` | `src/app/jobs/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/jobs/detail` | `src/app/jobs/detail/page.tsx` | 0 (0) | No | No | None | **GAP** | Redirect stub: missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/jobs/[id]/interview-pack` | `src/app/jobs/[id]/interview-pack/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/jobs/[id]/skill-what-if` | `src/app/jobs/[id]/skill-what-if/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/login` | `src/app/login/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** | None |
| `/onboarding` | `src/app/onboarding/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Missing `<nav>` landmark (required by project rubric) |
| `/pricing` | `src/app/pricing/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/privacy` | `src/app/privacy/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark (re-exports `privacy-policy/page`) |
| `/privacy-policy` | `src/app/privacy-policy/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark (required by project rubric) |
| `/profile` | `src/app/profile/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/radar` | `src/app/radar/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/refund-policy` | `src/app/refund-policy/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark (required by project rubric) |
| `/remote` | `src/app/remote/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** | None |
| `/remote/[slug]` | `src/app/remote/[slug]/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Unlabeled `<nav>` landmark (breadcrumb `<nav>` missing `aria-label`/`aria-labelledby`) |
| `/remote/[slug]/titles` | `src/app/remote/[slug]/titles/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Unlabeled `<nav>` landmark (breadcrumb `<nav>` missing `aria-label`/`aria-labelledby`) |
| `/remote/jobs/[category]` | `src/app/remote/jobs/[category]/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Unlabeled `<nav>` landmark (breadcrumb `<nav>` missing `aria-label`/`aria-labelledby`) |
| `/resume` | `src/app/resume/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/settings` | `src/app/settings/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/signup` | `src/app/signup/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** | None |
| `/terms-and-conditions` | `src/app/terms-and-conditions/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark (required by project rubric) |
| `/tracker` | `src/app/tracker/page.tsx` | 1 (PASS) | Yes | Yes | Unlabeled | **GAP** | Unlabeled complementary region (`<aside>` in `AppIconRail.tsx:107` missing `aria-label`/`aria-labelledby`) |
| `/worldwide` | `src/app/worldwide/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** | None (renders `WorldwideClient` with `GuideHeader` and single `<main>`) |

### Summary of Landmark Audit
- **Total Audited Pages**: 32
- **Landmark PASS**: 4 pages (12.50%)
- **Landmark GAP**: 28 pages (87.50%)

---

## 4. Remaining Gaps

The following gaps are strictly cataloged for remediation in designated follow-up pull requests without altering any UI markup in this PR:

### A. Semantic Landmark Remediation (28 Pages)
1. **Unlabeled Complementary Regions in `AppIconRail` (11 Pages)**:
   - `src/components/shell/AppIconRail.tsx:107`: Add `aria-label="Application sidebar"` to the `<aside>` element. This directly resolves the complementary landmark gap on all 11 pages composing `LoggedInAppShell` or `AppIconRail`:
     - `/applications` (`src/app/applications/page.tsx` via `TrackerPage`)
     - `/dashboard` (`src/app/dashboard/page.tsx`)
     - `/jobs` (`src/app/jobs/page.tsx`)
     - `/jobs/[id]/interview-pack` (`src/app/jobs/[id]/interview-pack/page.tsx` via `InterviewPackClient`)
     - `/jobs/[id]/skill-what-if` (`src/app/jobs/[id]/skill-what-if/page.tsx` via `SkillWhatIfClient`)
     - `/pricing` (`src/app/pricing/page.tsx`)
     - `/profile` (`src/app/profile/page.tsx`)
     - `/radar` (`src/app/radar/page.tsx`)
     - `/resume` (`src/app/resume/page.tsx`)
     - `/settings` (`src/app/settings/page.tsx`)
     - `/tracker` (`src/app/tracker/page.tsx`)
2. **Unlabeled Breadcrumb `<nav>` Elements (3 Pages)**:
   - `src/app/remote/[slug]/page.tsx`, `src/app/remote/[slug]/titles/page.tsx`, `src/app/remote/jobs/[category]/page.tsx`: Add `aria-label="Breadcrumb"` to the in-page `<nav>` tag.
3. **Missing Banner `<header>` & `<nav>` on Legal/Static Pages (6 Pages)**:
   - `src/app/about/page.tsx`, `src/app/contact/page.tsx`, `src/app/privacy-policy/page.tsx`, `src/app/privacy/page.tsx`, `src/app/refund-policy/page.tsx`, `src/app/terms-and-conditions/page.tsx`: Mount `GuideHeader` (or wrap top branding in semantic `<header>` and provide labeled `<nav>`).
4. **Missing `<main>`, Banner, and `<nav>` on Legacy Redirect Stubs & Admin Views (6 Pages)**:
   - `src/app/admin/page.tsx`, `src/app/admin/users/page.tsx`, `src/app/auth/callback/page.tsx`, `src/app/job-detail/page.tsx`, `src/app/job-search/all/page.tsx`, `src/app/jobs/detail/page.tsx`: Adopt the standardized `LoggedInAppShell` or wrap views with semantic `<header>`, `<nav>`, and `<main>` landmarks.
5. **Missing `<nav>` on Onboarding & Early Access (2 Pages)**:
   - `src/app/onboarding/page.tsx`, `src/app/early-access/page.tsx`: Add labeled navigation landmarks to support landmark jump navigation for screen readers under the project rubric.

### B. Partially Supported Criteria Remediation (31 Criteria)
1. **1.1.1 (Non-text Content)**: Extend static auditing to verify `aria-hidden="true"` or fallback labels on all SVG icons and WebGL canvas elements.
2. **1.3.1 (Info and Relationships)**: Fix remaining 28 page landmark structures and complete programmatic label association for dynamic filter controls.
3. **1.3.2 (Meaningful Sequence)**: Register automated DOM-order assertion tests asserting that focus sequence matches visual presentation.
4. **1.3.5 (Identify Input Purpose)**: Enforce standard `autoComplete` attributes on all form fields via an offline static guard.
5. **1.4.1 (Use of Color)**: Add automated rule failing when color is the sole indicator of state across all 32 routes.
6. **1.4.3 (Contrast Minimum)**: Expand automated axe color-contrast scanning from 8 routes to all 32 routes with strict exit-on-violation gates.
7. **1.4.4 (Resize Text)**: Eliminate 8px tolerance in reflow tests and test 200% text scaling across all routes without clipping.
8. **1.4.10 (Reflow)**: Expand 320px viewport zoom tests across all 32 routes with zero horizontal overflow tolerance.
9. **1.4.11 (Non-text Contrast)**: Add automated script checking 3:1 contrast for graphical objects and UI components (checkboxes, select chevrons, slider tracks).
10. **1.4.13 (Content on Hover or Focus)**: Register tests verifying tooltip dismissal on Escape key without moving pointer focus.
11. **2.1.1 (Keyboard)**: Upgrade `audit-static-a11y.ts` Rule 2 to enforce matching `onKeyDown`/`onKeyUp` handlers for every interactive role.
12. **2.1.2 (No Keyboard Trap)**: Add automated tests asserting that Tab and Shift+Tab traverse dialogs without focus traps.
13. **2.2.2 (Pause, Stop, Hide)**: Add explicit user-accessible pause/stop toggles for background ticker and animated canvas elements.
14. **2.4.1 (Bypass Blocks)**: Ensure `<main id="main-content">` is mounted on all 32 routes so the skip link resolves reliably.
15. **2.4.2 (Page Titled)**: Register unit tests asserting unique title metadata for all 32 routes.
16. **2.4.3 (Focus Order)**: Register automated tests asserting logical tab navigation sequences on all pages.
17. **2.4.4 (Link Purpose)**: Enforce meaningful contextual destination text across all `<a>` tags via static scanner.
18. **2.4.5 (Multiple Ways)**: Document and test discovery paths across the sitemap and directories.
19. **2.4.6 (Headings and Labels)**: Upgrade static checks to verify that labels accurately describe purpose and headings follow single-h1 hierarchy repository-wide.
20. **2.4.7 (Focus Visible)**: Add automated tests asserting visible focus ring bounding boxes across all interactive controls.
21. **2.5.3 (Label in Name)**: Upgrade `audit-static-a11y.ts` Rule 4 to assert that every accessible name contains or matches the element's visible text.
22. **3.2.1 (On Focus)**: Add tests asserting that focusing inputs does not trigger context navigation.
23. **3.2.2 (On Input)**: Add tests asserting that input changes require explicit submission actions.
24. **3.2.3 (Consistent Navigation)**: Add layout assertion test verifying navigation items appear in identical order across views.
25. **3.2.4 (Consistent Identification)**: Standardize accessible naming dictionary across shared components.
26. **3.3.1 (Error Identification)**: Standardize `aria-invalid="true"` and `aria-errormessage` bindings across all form inputs.
27. **3.3.2 (Labels or Instructions)**: Upgrade Rule 3 to verify that `<input id="...">` has a corresponding `<label htmlFor="...">` in the DOM.
28. **3.3.3 (Error Suggestion)**: Ensure all validation failure paths return explicit correction advice.
29. **3.3.4 (Error Prevention)**: Formalize review-and-confirm patterns for destructive and billing data submissions.
30. **4.1.2 (Name, Role, Value)**: Require complete WAI-ARIA state bindings (`aria-expanded`, `aria-selected`, `aria-controls`) on custom controls.
31. **4.1.3 (Status Messages)**: Add automated tests asserting that search result counts and filter updates announce cleanly via `aria-live="polite"` regions.
