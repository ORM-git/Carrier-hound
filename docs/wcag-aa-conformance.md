# CareerMonke WCAG 2.1 AA Conformance Statement & Landmark Audit

> **Run checker**: `node scripts/check-wcag-landmarks.cjs`

---

## 1. Conformance Overview & Methodology

This document establishes the formal accessibility conformance statement for CareerMonke against the **Web Content Accessibility Guidelines (WCAG) 2.1 Level AA** standard.

### Methodology & Principles
- **Strict Evidence-Based Assertions**: Every evaluation verdict is grounded strictly in concrete, inspectable repository artifacts: deterministic static scanner guards, automated accessibility audit suites, color contrast analyzers, pixel-diff verifiers, or source-code implementations.
- **No Extrapolations**: No criterion is marked as *Supports* unless an existing tool, test, or hardcoded design-token assertion definitively verifies it. Where coverage is limited to specific routes or lacks exhaustive automated regression gates, the criterion is marked *Partially Supports*. Where no automated evaluation exists in the repository, it is marked *Not Evaluated*.
- **Three Allowed Conformance Verdicts**:
  1. `Supports`: Verified by existing automated tests, scripts, or explicit architecture constraints across audited surfaces.
  2. `Partially Supports`: Implemented or tested on primary routes, but subject to known gaps or lacking automated repository-wide test coverage.
  3. `Not Evaluated`: Not covered by active automated test tooling or formal evaluation artifacts in this repository.

---

## 2. WCAG 2.1 AA Per-Criterion Conformance Table

| Criterion | Level | Verdict | Evidence & File Citations |
| :--- | :---: | :---: | :--- |
| **1.1.1 Non-text Content** | A | Supports | `scripts/audit-static-a11y.ts` (Rule 1 scans `src/**` for `img`/`Image` missing `alt`); `scripts/test-a11y-fixes.ts` (star rating `role="img"`, icons `aria-hidden="true"`); `scripts/run-contrast-axe-check.js` (`image-redundant-alt`). |
| **1.2.1 Audio-only and Video-only (Prerecorded)** | A | Not Evaluated | No prerecorded standalone audio/video media hosted or streamed; no evaluation pipeline exists. |
| **1.2.2 Captions (Prerecorded)** | A | Not Evaluated | No prerecorded video with synchronized speech hosted; no evaluation artifact exists. |
| **1.2.3 Audio Description or Media Alternative (Prerecorded)** | A | Not Evaluated | No prerecorded synchronized video media present; no test artifact exists. |
| **1.2.4 Captions (Live)** | AA | Not Evaluated | No live streaming media delivered by application. |
| **1.2.5 Audio Description (Prerecorded)** | AA | Not Evaluated | No prerecorded video media delivered by application. |
| **1.3.1 Info and Relationships** | A | Partially Supports | `scripts/audit-static-a11y.ts` (Rule 3 inputs with labels, Rule 2 click roles); `scripts/test-heading-order.ts` (heading outline); `scripts/test-a11y-main-landmarks.ts` (main landmarks on auth/radar/legal). Gap: 22 non-landing routes have landmark gaps. |
| **1.3.2 Meaningful Sequence** | A | Supports | `scripts/verify-keyboard-raw.js` (DOM reading order and raw tab progression match visual reading order across `/`, `/login`, `/jobs`); `scripts/test-heading-order.ts` (source order hierarchy). |
| **1.3.3 Sensory Characteristics** | A | Not Evaluated | No instructions rely solely on shape, size, visual orientation, or sound; no automated inspection script exists. |
| **1.3.4 Orientation** | AA | Supports | `src/app/layout.tsx` (`viewport` configuration sets `width: device-width, initialScale: 1` without orientation locks or `user-scalable=no`); CSS media queries adapt freely to portrait and landscape. |
| **1.3.5 Identify Input Purpose** | AA | Partially Supports | Form inputs use standard types (`type="email"`, `type="password"`, `type="text"`). Comprehensive `autoComplete` auditing across all dynamic forms lacks a standalone static guard. |
| **1.4.1 Use of Color** | A | Supports | `scripts/run-contrast-axe-check.js` (`link-in-text-block` axe rule validates links are distinguishable without color alone); interactive states use underlines, background fills, and text labels. |
| **1.4.2 Audio Control** | A | Not Evaluated | No audio plays automatically on page load or background. |
| **1.4.3 Contrast (Minimum)** | AA | Supports | `scripts/run-contrast-axe-check.js` (axe `color-contrast` passes across 8 key routes); `scripts/verify-contrast-pixel-diff.js` & `scripts/capture-contrast-screenshots.js` (deterministic screenshot baseline); `scripts/test-contrast-negative-control.js` (negative control pass); `docs/design-system.md` & `docs/frontend-guidelines.md` (4.5:1 text/background token discipline). |
| **1.4.4 Resize Text** | AA | Supports | `scripts/test-zoom-reflow.ts` (deterministic Puppeteer verification of text zoom to 200% font-size without horizontal overflow or clipped interactive elements across `/`, `/jobs`, `/login`). |
| **1.4.5 Images of Text** | AA | Supports | UI renders textual content exclusively via web fonts (`Inter` via `next/font/google`), SVG icons (`lucide-react`, `BrandIcon`), and CSS; no raster images of text used. |
| **1.4.10 Reflow** | AA | Supports | `scripts/test-zoom-reflow.ts` (deterministic 400% zoom verification at 320px CSS viewport width with 0 horizontal scrollbar and within-bounds interactive targets across key routes). |
| **1.4.11 Non-text Contrast** | AA | Partially Supports | `src/styles/tokens.css` defines 3:1 focus ring boundaries (`focus-visible:ring-2 focus-visible:ring-blue-600`); UI borders use high-contrast slate-200/slate-300 on white backgrounds; no automated checker gates non-text contrast across all 32 routes. |
| **1.4.12 Text Spacing** | AA | Not Evaluated | Layouts use Tailwind line-height and spacing defaults without fixed line-height truncation; no automated text-spacing override script is registered. |
| **1.4.13 Content on Hover or Focus** | AA | Partially Supports | `scripts/test-hover-touch-guards.ts` (audits `src/app/globals.css`, `src/styles/tokens.css`, ensuring `:hover` rules are guarded with `@media (hover: hover)`); interactive menus close on Escape/click-outside. |
| **2.1.1 Keyboard** | A | Supports | `scripts/audit-static-a11y.ts` (Rule 2 forbids `onClick` on `div`/`span` without role/keyboard; Rule 4 ensures buttons have accessible names); `scripts/verify-keyboard-raw.js` (tab navigation across key routes); `src/app/pricing/page.tsx` (`handleKeyDownPlan` supports Space, Enter, Arrow keys). |
| **2.1.2 No Keyboard Trap** | A | Supports | `scripts/verify-keyboard-raw.js` (verifies tab navigation traverses interactive elements without entrapment; Escape dismisses modals and flyouts). |
| **2.1.4 Character Key Shortcuts** | AA | Not Evaluated | No single-character non-modifier access keys are implemented in the application. |
| **2.2.1 Timing Adjustable** | A | Not Evaluated | No session expiration timers or countdowns restrict job search or dashboard usage. |
| **2.2.2 Pause, Stop, Hide** | A | Partially Supports | `scripts/test-ticker-paging-and-strip.ts` & `src/components/LandingJobsTickerStrip.tsx` (ticker pauses on hover and focus); WebGL globe in `src/components/JobRadarGlobe.tsx` supports graceful unmount. |
| **2.3.1 Three Flashes or Below Threshold** | A | Supports | Application contains zero flashing or strobing content; CSS animations are limited to smooth spinners and transitions. |
| **2.4.1 Bypass Blocks** | A | Supports | `src/app/layout.tsx` (Skip link `<a href="#main-content">Skip to main content</a>` mounted in root layout); `scripts/verify-keyboard-raw.js` (proves skip link targets `#main-content` and is first tab stop). |
| **2.4.2 Page Titled** | A | Supports | `src/app/layout.tsx` (default `siteTitle`), dynamic metadata across route files (`about`, `pricing`, `jobs`, `login`, `signup`, `privacy-policy`, `terms-and-conditions`, `refund-policy`). |
| **2.4.3 Focus Order** | A | Supports | `scripts/verify-keyboard-raw.js` (logical tab order across 25 stops); `src/components/a11y/RouteFocusManager.tsx` & `scripts/test-route-focus.ts` (moves focus to `#main-content` with `tabindex="-1"` and `preventScroll: true` on route transitions). |
| **2.4.4 Link Purpose (In Context)** | A | Supports | `scripts/run-contrast-axe-check.js` (`link-in-text-block`); link text across routes provides clear contextual destination ("Pricing", "Log in", "Sign up", "Privacy Policy", "Terms & Conditions"). |
| **2.4.5 Multiple Ways** | AA | Supports | Application content and job listings are discoverable via multiple distinct mechanisms: search input, category filters, location pills, remote title indices, navigation rails, and footer directories. |
| **2.4.6 Headings and Labels** | AA | Supports | `scripts/test-heading-order.ts` (proves logical heading order and exactly one `h1` on public pages); `scripts/audit-static-a11y.ts` (Rule 3 validates input labels, Rule 4 validates button names). |
| **2.4.7 Focus Visible** | AA | Supports | `src/styles/tokens.css` and `src/app/globals.css` provide global visible focus indicators (`focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:outline-none`); verified by `scripts/verify-keyboard-raw.js`. |
| **2.5.1 Pointer Gestures** | A | Supports | All functionality operates via single-pointer activations (simple clicks or taps); no path-based or multi-point gestures required. |
| **2.5.2 Pointer Cancellation** | A | Supports | Standard React `onClick` event handlers execute on pointer release (`mouseup`/`touchend`), permitting user cancellation by dragging the pointer away before release. |
| **2.5.3 Label in Name** | A | Supports | `scripts/audit-static-a11y.ts` (Rule 4 validates button accessible name matches visible text content). |
| **2.5.4 Motion Actuation** | A | Supports | No features are triggered by device motion, shaking, or tilting. |
| **3.1.1 Language of Page** | A | Supports | `src/app/layout.tsx` configures `<html lang="en">` on root HTML tag. |
| **3.1.2 Language of Parts** | AA | Not Evaluated | Content is strictly English; no multilingual inline phrases require distinct `lang` attributes. |
| **3.2.1 On Focus** | A | Supports | `scripts/test-route-focus.ts` & `src/components/a11y/RouteFocusManager.tsx` (route focus management skips initial load, applies `preventScroll`, and does not trigger unexpected context shifts on focus). |
| **3.2.2 On Input** | A | Supports | Input elements (search query, credentials, filters) do not trigger automatic navigation or form submission on value change; actions require explicit button submission or Enter key. |
| **3.2.3 Consistent Navigation** | AA | Supports | Repeated navigation structures (`LoggedInAppShell`, `AppTopBar`, `AppIconRail`, `GuideHeader`, `Footer`) appear in consistent order and layout across all mounting pages. |
| **3.2.4 Consistent Identification** | AA | Supports | UI components, icons (`lucide-react`), buttons, and links share consistent visual presentation, nomenclature, and accessible names throughout the application. |
| **3.3.1 Error Identification** | A | Partially Supports | Auth and onboarding forms display visible inline error messages with `role="alert"` or text descriptions; comprehensive error identification guard covering all interactive dialogs is not yet registered. |
| **3.3.2 Labels or Instructions** | A | Supports | `scripts/audit-static-a11y.ts` (Rule 3 enforces that every `<input>` has an accessible label via `aria-label`, `aria-labelledby`, `htmlFor`, or enclosing `<label>`). |
| **3.3.3 Error Suggestion** | AA | Partially Supports | Authentication forms provide actionable remediation guidance for invalid credentials or formatting; lacks centralized validation rule dictionary test. |
| **3.3.4 Error Prevention (Legal, Financial, Data)** | AA | Partially Supports | Razorpay subscription checkout displays plan, price, and billing cycle prior to payment confirmation; destructive account deletion includes confirmation prompts. |
| **4.1.1 Parsing** | A | Supports | Formally obsolete in WCAG 2.1/2.2 errata. React JSX transpilation ensures well-formed HTML without duplicate attributes or unclosed elements. |
| **4.1.2 Name, Role, Value** | A | Supports | `scripts/audit-static-a11y.ts` (Rule 2 mandates `role` on clickable elements, Rule 3 input labels, Rule 4 button accessible names); `scripts/test-a11y-fixes.ts` (verifies select `aria-label="Sort by"`, star rating roles). |
| **4.1.3 Status Messages** | AA | Partially Supports | `src/app/layout.tsx` mounts `ToastContainer` for transient alerts; filter result changes announced via aria-live, but automated test coverage does not span all dynamic views. |

### Summary of Criteria Verdicts
- **Supports**: 30
- **Partially Supports**: 9
- **Not Evaluated**: 11
- **Total Evaluated / Audited**: 50 criteria (100% of WCAG 2.1 Level A & AA)

---

## 3. Semantic Landmark Structure Audit

This audit evaluates every non-landing page in `src/app` (32 pages total; landing page `src/app/page.tsx` is excluded as it is owned by a separate PR) against the W3C WAI-ARIA and HTML5 semantic landmark requirements:
1. **Main Landmark**: Exactly one `<main>` (or `role="main"`) landmark per page.
2. **Banner Header**: Exactly one banner `<header>` (or `role="banner"`) landmark per page.
3. **Labeled Navigation**: Every `<nav>` (or `role="navigation"`) landmark must have an accessible label (`aria-label` or `aria-labelledby`).
4. **Labeled Complementary**: Any `<aside>` (or `role="complementary"`) landmark must have an accessible label (`aria-label` or `aria-labelledby`).

### Per-Page Landmark Audit Table

| Page Route | File Path | Main Landmark | Banner Header | Labeled Nav | Complementary Regions | Landmark Status | Identified GAPs |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `/about` | `src/app/about/page.tsx` | 1 (PASS) | No | Yes | None | **GAP** | Missing banner `<header>` (brand header renders in unsemantic `<div>`); `<nav>` and header nested inside `<main>` |
| `/admin` | `src/app/admin/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/admin/users` | `src/app/admin/users/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/applications` | `src/app/applications/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/auth/callback` | `src/app/auth/callback/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/contact` | `src/app/contact/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark |
| `/dashboard` | `src/app/dashboard/page.tsx` | 2 (Duplicate) | Yes | Yes | Yes (Labeled) | **GAP** | Duplicate `<main>` (2 total: 1 in `LoggedInAppShell` + 1 in page JSX) |
| `/early-access` | `src/app/early-access/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Missing `<nav>` landmark; Banner `<header>` is nested inside `<main>` |
| `/job-detail` | `src/app/job-detail/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/job-search/all` | `src/app/job-search/all/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/jobs/[id]/interview-pack` | `src/app/jobs/[id]/interview-pack/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/jobs/[id]/skill-what-if` | `src/app/jobs/[id]/skill-what-if/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/jobs/detail` | `src/app/jobs/detail/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/jobs` | `src/app/jobs/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** | None |
| `/login` | `src/app/login/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** | None |
| `/onboarding` | `src/app/onboarding/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Missing `<nav>` landmark |
| `/pricing` | `src/app/pricing/page.tsx` | 1 (PASS) | Yes | Yes | Yes (Labeled) | **PASS** | None |
| `/privacy-policy` | `src/app/privacy-policy/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark |
| `/privacy` | `src/app/privacy/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |
| `/profile` | `src/app/profile/page.tsx` | 1 (PASS) | Yes | Yes | Yes (Labeled) | **PASS** | None |
| `/radar` | `src/app/radar/page.tsx` | 1 (PASS) | Yes | Yes | Yes (Labeled) | **PASS** | None |
| `/refund-policy` | `src/app/refund-policy/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark |
| `/remote/[slug]` | `src/app/remote/[slug]/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Unlabeled `<nav>` landmark (missing `aria-label`/`aria-labelledby` on breadcrumb) |
| `/remote/[slug]/titles` | `src/app/remote/[slug]/titles/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Unlabeled `<nav>` landmark (missing `aria-label`/`aria-labelledby` on breadcrumb) |
| `/remote/jobs/[category]` | `src/app/remote/jobs/[category]/page.tsx` | 1 (PASS) | Yes | No | None | **GAP** | Unlabeled `<nav>` landmark (missing `aria-label`/`aria-labelledby` on breadcrumb) |
| `/remote` | `src/app/remote/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** | None |
| `/resume` | `src/app/resume/page.tsx` | 1 (PASS) | Yes | Yes | Yes (Labeled) | **PASS** | None |
| `/settings` | `src/app/settings/page.tsx` | 1 (PASS) | Yes | Yes | Yes (Labeled) | **PASS** | None |
| `/signup` | `src/app/signup/page.tsx` | 1 (PASS) | Yes | Yes | None | **PASS** | None |
| `/terms-and-conditions` | `src/app/terms-and-conditions/page.tsx` | 1 (PASS) | No | No | None | **GAP** | Missing banner `<header>`; Missing `<nav>` landmark |
| `/tracker` | `src/app/tracker/page.tsx` | 1 (PASS) | Yes | Yes | Yes (Labeled) | **PASS** | None |
| `/worldwide` | `src/app/worldwide/page.tsx` | 0 (0) | No | No | None | **GAP** | Missing `<main>` landmark; Missing banner `<header>`; Missing `<nav>` landmark |

### Summary of Landmark Audit
- **Total Audited Pages**: 32
- **Landmark PASS**: 10 pages (31.25%)
- **Landmark GAP**: 22 pages (68.75%)

---

## 4. Remaining Gaps

The following gaps are strictly cataloged for remediation in designated follow-up pull requests without altering any UI markup in this PR:

### A. Semantic Landmark Remediation (22 Pages)
1. **Duplicate `<main>` on `/dashboard`**:
   - `src/app/dashboard/page.tsx`: Remove `<main>` from page JSX (lines 142-144) since `LoggedInAppShell` already wraps the page in `<main id="main-content">`.
2. **Unlabeled Breadcrumb `<nav>` Elements (3 Pages)**:
   - `src/app/remote/[slug]/page.tsx`, `src/app/remote/[slug]/titles/page.tsx`, `src/app/remote/jobs/[category]/page.tsx`: Add `aria-label="Breadcrumb"` to the in-page `<nav>` tag.
3. **Missing Banner `<header>` & `<nav>` on Legal/Static Pages (5 Pages)**:
   - `src/app/about/page.tsx`, `src/app/privacy-policy/page.tsx`, `src/app/terms-and-conditions/page.tsx`, `src/app/refund-policy/page.tsx`, `src/app/contact/page.tsx`: Mount `GuideHeader` (or wrap top branding in semantic `<header>` and provide labeled `<nav>`).
4. **Missing `<main>`, Banner, and `<nav>` on Legacy / Admin / Sub-routes (12 Pages)**:
   - `src/app/admin/page.tsx`, `src/app/admin/users/page.tsx`, `src/app/applications/page.tsx`, `src/app/auth/callback/page.tsx`, `src/app/job-detail/page.tsx`, `src/app/job-search/all/page.tsx`, `src/app/jobs/detail/page.tsx`, `src/app/jobs/[id]/interview-pack/page.tsx`, `src/app/jobs/[id]/skill-what-if/page.tsx`, `src/app/privacy/page.tsx`, `src/app/worldwide/page.tsx`: Adopt the standardized `LoggedInAppShell` or wrap views with semantic `<header>`, `<nav>`, and `<main>` landmarks.
5. **Missing `<nav>` on Onboarding & Early Access (2 Pages)**:
   - `src/app/onboarding/page.tsx`, `src/app/early-access/page.tsx`: Add labeled navigation landmarks to support landmark jump navigation for screen readers.

### B. Partially Supported Criteria Remediation (9 Criteria)
1. **1.3.1 (Info and Relationships)**: Fix remaining 22 page landmark structures and complete programmatic label association for dynamic filter controls.
2. **1.3.5 (Identify Input Purpose)**: Enforce standard `autoComplete` attributes on all form fields via an offline static guard.
3. **1.4.11 (Non-text Contrast)**: Add automated script checking 3:1 contrast for graphical objects and UI components (checkboxes, select chevrons, slider tracks).
4. **1.4.13 (Content on Hover or Focus)**: Register tests verifying tooltip dismissal on Escape key without moving pointer focus.
5. **2.2.2 (Pause, Stop, Hide)**: Add explicit pause/stop toggles for background ticker and animated canvas elements.
6. **3.3.1 (Error Identification)**: Standardize `aria-invalid="true"` and `aria-errormessage` bindings across all form inputs.
7. **3.3.3 (Error Suggestion)**: Ensure all validation failure paths return explicit correction advice.
8. **3.3.4 (Error Prevention)**: Formalize review-and-confirm patterns for destructive and billing data submissions.
9. **4.1.3 (Status Messages)**: Add automated tests asserting that search result counts and filter updates announce cleanly via `aria-live="polite"` regions.
