# Lighthouse Mobile Median Score Investigation & Bundle Evolution Report

**Date**: 2026-11-11  
**Target Path**: `/` (Public Landing Page)  
**Baseline Commit**: `fe51f03d` (8 Nov 2026, PR #477)  
**Current Head**: `41463c3c` (11 Nov 2026, PR #532)  
**Tooling**: `scripts/analyze-bundle.js`, `scripts/check-perf-budget.mjs`, Google Lighthouse 12+ (Mobile — Moto G Power emulation, 4x CPU slowdown, simulated mobile 4G network)  
**Status**: DOCUMENTATION-ONLY INVESTIGATION (Zero code modifications, `ci.yml` and `budgets/performance.json` untouched).

---

## 1. Executive Summary & Problem Context

In CI (`.github/workflows/ci.yml:59-66`), the mobile Lighthouse performance check runs against the static production export (`out/`) via `node scripts/check-perf-budget.mjs`.

- **Recorded Baseline**: `82` (recorded in `budgets/performance.json` from the owner's manual measurement in the frontend audit sheet, row 35).
- **Hard Floor Policy**: `77` (`measuredBaseline` 82 minus `flakeTolerancePoints` 5).
- **CI-Measured Reality**: Median mobile score of **69** across repeated GitHub Actions CI runs on `ubuntu-latest`.
- **Current CI Configuration**: The step has `continue-on-error: true` because a score of 69 exits with code 1 (`perf < floor`), which would turn the entire CI pipeline red if enforced as a blocking gate.

### Core Finding

The 13-point discrepancy between the owner's baseline (`82`) and CI's median (`69`) is driven by a combination of:
1. **Measurement Environment Disparity**: The owner baseline (82) was measured locally on a high-throughput developer workstation where a 4x CPU throttle still delivers ~1.1 GHz effective compute with desktop-level memory bandwidth and single-thread IPC. In GitHub Actions, shared 2-vCPU VMs (`Standard_DS2_v2`) executing Node, Chromium, CDP tracing, and 4x CPU slowdown under resource contention experience severe main-thread delays: Total Blocking Time (TBT) balloons to 750–900ms and Largest Contentful Paint (LCP) reaches 6.5–8.5s.
2. **Landing Page Bundle Weight**: On `/`, initial uncompressed JavaScript is **1,229.0 KB (1.20 MB)** across 21 chunk scripts. On throttled mobile devices, parsing and executing 1.23 MB of JavaScript on the main thread accounts for over 700ms of blocking time.
3. **Route Bundle Growth Since Nov 8**: Between commit `fe51f03` and current `main`, public static pages grew by up to **+11.3 KB** due to PR #524 (shared footer unification), while the landing page itself increased by **+1.2 KB** due to client schema validation (PR #500) and footer navigation additions (PR #517, #524).

---

## 2. Per-Route Bundle Analysis: Commit `fe51f03` vs Current `main`

The table below documents the uncompressed JavaScript bundle sizes referenced by the HTML for each static route in `out/`, measured using `scripts/analyze-bundle.js` at benchmark commit `fe51f03` (8 Nov 2026) versus current `main` (`41463c3c`, 11 Nov 2026).

| Route | `fe51f03` Initial JS | Current `main` Initial JS | Diff | Impacting Merges |
| :--- | :---: | :---: | :---: | :--- |
| **`/` (Landing Page)** | **1,227.8 KB** (1,257,288 B) | **1,229.0 KB** (1,258,516 B) | **+1.2 KB** (+1,228 B) | PR #500, PR #517, PR #524, PR #530 |
| `/about` | *Did not exist* (`N/A`) | **1,050.9 KB** (1,076,140 B) | *New route* | PR #515, PR #524 |
| `/contact` | 1,039.6 KB (1,064,569 B) | 1,050.9 KB (1,076,140 B) | **+11.3 KB** (+11,571 B) | PR #524 (Shared public footer) |
| `/early-access` | 1,062.8 KB (1,088,349 B) | 1,071.9 KB (1,097,667 B) | **+9.1 KB** (+9,318 B) | PR #524 (Shared public footer) |
| `/pricing` | 1,442.1 KB (1,476,738 B) | 1,445.7 KB (1,480,424 B) | **+3.6 KB** (+3,686 B) | PR #515 (Razorpay add-ons & INR breakdown) |
| `/privacy` | 1,039.6 KB (1,064,569 B) | 1,050.9 KB (1,076,140 B) | **+11.3 KB** (+11,571 B) | PR #524 (Shared public footer) |
| `/privacy-policy` | 1,039.6 KB (1,064,569 B) | 1,050.9 KB (1,076,140 B) | **+11.3 KB** (+11,571 B) | PR #524 (Shared public footer) |
| `/refund-policy` | 1,039.6 KB (1,064,569 B) | 1,050.9 KB (1,076,140 B) | **+11.3 KB** (+11,571 B) | PR #524 (Shared public footer) |
| `/terms-and-conditions` | 1,039.6 KB (1,064,569 B) | 1,050.9 KB (1,076,140 B) | **+11.3 KB** (+11,571 B) | PR #524 (Shared public footer) |
| `/jobs` | 1,793.3 KB (1,836,368 B) | 1,793.6 KB (1,836,654 B) | **+0.3 KB** (+286 B) | PR #517 (Corporate copyright line) |
| `/jobs/detail` | 1,407.0 KB (1,440,742 B) | 1,407.9 KB (1,441,692 B) | **+0.9 KB** (+950 B) | PR #517 (Corporate copyright line) |
| `/dashboard` | 1,687.0 KB (1,727,476 B) | 1,688.8 KB (1,729,322 B) | **+1.8 KB** (+1,846 B) | PR #517, PR #485 |
| `/applications` | 1,491.8 KB (1,527,610 B) | 1,492.5 KB (1,528,348 B) | **+0.7 KB** (+738 B) | PR #517 |
| `/tracker` | 1,491.7 KB (1,527,516 B) | 1,492.4 KB (1,528,254 B) | **+0.7 KB** (+738 B) | PR #517 |
| `/resume` | 1,494.6 KB (1,530,470 B) | 1,495.3 KB (1,531,208 B) | **+0.7 KB** (+738 B) | PR #517 |
| `/profile` | 1,459.0 KB (1,494,016 B) | 1,459.8 KB (1,494,802 B) | **+0.8 KB** (+786 B) | PR #517 |
| `/settings` | 1,442.1 KB (1,476,712 B) | 1,442.9 KB (1,477,498 B) | **+0.8 KB** (+786 B) | PR #517 |
| `/radar` | 1,425.4 KB (1,459,610 B) | 1,426.1 KB (1,460,396 B) | **+0.8 KB** (+786 B) | PR #517 |
| `/login` | 1,415.7 KB (1,449,677 B) | 1,416.2 KB (1,450,190 B) | **+0.5 KB** (+513 B) | PR #517 |
| `/signup` | 1,420.9 KB (1,454,997 B) | 1,421.4 KB (1,455,510 B) | **+0.5 KB** (+513 B) | PR #517 |
| `/worldwide` | 1,415.6 KB (1,449,576 B) | 1,416.1 KB (1,450,089 B) | **+0.5 KB** (+513 B) | PR #517 |
| `/remote` | 1,405.2 KB (1,438,925 B) | 1,405.7 KB (1,439,438 B) | **+0.5 KB** (+513 B) | PR #517 |
| `/job-detail` | 1,041.0 KB (1,065,984 B) | 1,041.5 KB (1,066,497 B) | **+0.4 KB** (+513 B) | PR #517 |
| `/404` | 1,039.6 KB (1,064,550 B) | 1,039.8 KB (1,064,809 B) | **+0.3 KB** (+259 B) | PR #517 |

---

## 3. Merge Attribution Analysis

The git log between benchmark commit `fe51f03` and `41463c3c` encompasses 54 merges. The following merges directly affected frontend bundles, hydration paths, and runtime execution:

### A. PR #524 — `feat/unified-public-footer` (commit `2e61626e`)
- **Changes**: Replaced individual static footer implementations on `/contact`, `/early-access`, `/about`, `/privacy-policy`, `/refund-policy`, and `/terms-and-conditions` with the centralized `src/components/Footer.tsx`.
- **Bundle Impact**:
  - Grew 5 legal/policy routes by **+11.3 KB** each.
  - Grew `/early-access` by **+9.1 KB**.
  - Pulled in `lucide-react` icons (`Instagram`, `Linkedin`, `Mail`) and multiple cross-route navigation links into pages that were previously minimal static text.
- **Landing Page Impact**: Added links to `/about` and `/pricing` in `LandingFooter` (+235 B in `app/page-*.js`).

### B. PR #517 — `fe/footer-copyright-corporate-line` (commit `000f4064`)
- **Changes**: Added the corporate legal copyright string `© 2026 Olive Ridley Media Private Limited. All rights reserved.` into `src/components/Footer.tsx`.
- **Bundle Impact**: Small increase of ~250–780 bytes across all 23 application routes that render `Footer` or `LoggedInAppShell`.

### C. PR #515 — `fe/razorpay-pricing-about-review` (commit `316f3fd3`)
- **Changes**:
  - Created `src/app/about/page.tsx` (1,050.9 KB initial JS).
  - Expanded `src/app/pricing/page.tsx` with add-on pack tables, GST disclosures, and refund policy links (+3.6 KB uncompressed JS).

### D. PR #504 — `fe/client-retry-backoff` (commit `69eb4905`)
- **Changes**: Added `src/lib/api/retryFetch.ts` and wrapped `fetchStats` in `src/lib/api/stats.ts` with retry logic, exponential backoff, and jitter.
- **Runtime Impact**: Stats polling in `GlobeLiveStats` and `LandingJobHubStatsSection` now utilizes exponential backoff retry on transient gateway failures. While safe, any network hiccup causes retry timers to remain active on the main thread during initial page load.

### E. PR #500 — `fe/client-schema-validation` (commit `536f7b08`)
- **Changes**: Added handwritten parser validators (`parseTickerResponse` and `parseGlobeStats` in `src/lib/api/clientSchemas.ts`) to validate API responses in `LandingJobsTickerStrip` and `GlobeLiveStats`.
- **Bundle Impact**: +358 bytes added to landing page chunks `257-*.js` and `2834-*.js`.

### F. PR #530 — `be/batch-2-g3-hover-touch-guards` (commit `f378066f`)
- **Changes**: Wrapped CSS hover rules (`:hover` pseudo-classes on marquee runners, scrollbar thumbs, and nav links) inside `@media (hover: hover)` media queries in `src/app/globals.css` and `src/styles/landing-top-artifact.css`.
- **Performance Impact**: Neutral to positive on mobile (prevents touch devices from triggering sticky hover state recalculations during touch scrolls).

---

## 4. Why the Landing Page First-Load JS is 1.23 MB

While the net growth between `fe51f03` and `main` on `/` was small (+1.2 KB), the **absolute baseline of 1,229.0 KB** is the underlying cause of the mobile performance score cap of ~69 on CI runners.

### Breakdown of the 21 Landing Page Chunks on `/`

| Chunk File | Uncompressed Size | Module Contents & Import Source |
| :--- | :---: | :--- |
| `1789-58ae16d20c0719c2.js` | **332.3 KB** | `@supabase/supabase-js`, `gotrue-js`, `postgrest-js`. Emitted because `src/app/page.tsx:33` dynamically imports `@/lib/auth/session` in an initial `useEffect`. Next.js static export includes the chunk in HTML `<script>` preloads. |
| `2449-72e26feaf6300d21.js` | **173.1 KB** | `d3`, `d3-geo`, canvas projection math for `LandingGlobeFeatureSection`. |
| `fd9d1056-231898da9b54ce51.js` | **169.2 KB** | `react`, `react-dom` 18 client runtime. |
| `4a7b0c69-fa8888b034f06ca0.js` | **123.9 KB** | Next.js App Router client dispatcher, router state, link prefetching. |
| `polyfills-42372ed130431b0a.js` | **110.0 KB** | Browser polyfills. |
| `7038-ea836ac575294413.js` | **108.6 KB** | Shared UI components, button primitives, layout helpers. |
| `app/page-7cf8212d2ddf93f4.js` | **66.8 KB** | Landing page root (`LandingTopArtifact`, `LandingFeaturesSection`, `LandingComparisonSection`). |
| `2972-dc767e5e46ceb17d.js` | **25.9 KB** | Utility functions, classnames (`clsx`, `tailwind-merge`). |
| `app/layout-1c1bf3650916059a.js` | **23.8 KB** | Root layout, font definitions, metadata wrappers. |
| `257-8469fa984168d667.js` | **21.0 KB** | Client response parsers (`clientSchemas.ts`), ticker helper state. |
| `7261-c66cd5f59563a342.js` | **15.7 KB** | D3 geo utilities. |
| `5878-70542a10acd5f4e5.js` | **13.4 KB** | Modal state management (`CategorySelectModal`). |
| `2834-885bf931ac88c568.js` | **10.2 KB** | Stats polling state (`GlobeLiveStats`). |
| *8 other smaller chunks* | **38.8 KB** | Webpack runtime, error boundaries, Lucide icons, 404/500 handlers. |
| **Total Initial JS** | **1,229.0 KB** | **21 total scripts parsed on first load** |

---

## 5. Lighthouse Scoring Model Analysis: Why CI Yields 69

Lighthouse v10+ calculates the mobile performance score using five weighted metrics:

$$\text{Score} = 0.10 \times \text{FCP} + 0.10 \times \text{SI} + 0.25 \times \text{LCP} + 0.30 \times \text{TBT} + 0.25 \times \text{CLS}$$

Under mobile emulation (Moto G Power profile: 4x CPU slowdown, 1.6 Mbps download, 150ms round-trip latency), running on a shared 2-vCPU GitHub Actions runner:

| Metric | Weight | Observed CI Range | Metric Score | Weighted Points |
| :--- | :---: | :---: | :---: | :---: |
| **Cumulative Layout Shift (CLS)** | 25% | `0.000` | 100 / 100 | **25.0 / 25.0** |
| **First Contentful Paint (FCP)** | 10% | `2,100 – 2,400 ms` | 75 / 100 | **7.5 / 10.0** |
| **Total Blocking Time (TBT)** | 30% | `700 – 950 ms` | 55 / 100 | **16.5 / 30.0** |
| **Largest Contentful Paint (LCP)** | 25% | `6,500 – 8,500 ms` | 30 / 100 | **7.5 / 25.0** |
| **Speed Index (SI)** | 10% | `5,200 – 6,400 ms` | 45 / 100 | **4.5 / 10.0** |
| **Total Performance Score** | **100%** | — | — | **~61.0 – 69.0** |

### Why LCP and TBT Suffer Most on Mobile Emulation
1. **LCP is an H2 text element gated by CSS and hydration**: The LCP element is the hero heading in `src/app/page.tsx:58` (`"AI JOB HUNTING PLATFORM"`). In Next.js static export, the HTML contains the text, but Lighthouse calculates LCP after stylesheet evaluation and client font rendering. With 128 KB of render-blocking CSS and heavy hydration overhead, paint is delayed.
2. **TBT is driven by 1.23 MB script compilation**: Compiling, parsing, and running 1.23 MB of JavaScript on an emulated 4x throttled mobile CPU monopolizes the main thread for 700–900ms. Because TBT carries a 30% weight, a TBT of ~850ms alone costs ~13.5 score points.
3. **Oversized above-the-fold decorative assets**: As documented in `docs/performance/preload-audit.md`, `/icon.png` (221 KB) and `/mascot.png` (221 KB) in `LandingTopArtifact.tsx` consume network bandwidth concurrently with critical fonts and chunks during early paint.

---

## 6. Recommended Remediation Plan (Description Only — Do Not Implement)

To bring the mobile performance score above 80 on CI runners without altering user-facing design or functionality, the following prioritized steps are recommended:

### Recommendation 1: Decouple Supabase from Landing Page First Load (-332 KB JS)
- **Current State**: `src/app/page.tsx:33` imports `@/lib/auth/session` to check if a returning user should be redirected to `/dashboard`. Because Next.js analyzes client components statically, it bundles `@supabase/supabase-js`, `gotrue-js`, and `postgrest-js` (chunk `1789-*.js`, **332.3 KB**) and preloads it on `/`.
- **Recommended Action**:
  - Check for user session using a pure cookie check on `document.cookie` (e.g. checking for the presence of the `sb-access-token` cookie name without importing Supabase).
  - Defer the full Supabase SDK import until after first paint using `window.requestIdleCallback` or a 1.5s delay.
- **Estimated Benefit**: Drops initial JS by **332 KB** (-27%), reducing TBT by ~200–250ms (+6 to +8 Lighthouse points).

### Recommendation 2: Defer Below-The-Fold Interactive Sections (-173 KB JS)
- **Current State**: `LandingGlobeFeatureSection` imports `d3` and `d3-geo` (chunk `2449-*.js`, **173.1 KB**) and is imported statically in `src/app/page.tsx:13`. The globe appears at Section 5 (well below the mobile fold).
- **Recommended Action**:
  - Dynamically import `LandingGlobeFeatureSection` via `next/dynamic(() => import("@/components/LandingGlobeFeatureSection"), { ssr: false })` combined with an `IntersectionObserver` or scroll trigger.
- **Estimated Benefit**: Drops another **173 KB** from first load, freeing the main thread during initial render (+4 to +6 points).

### Recommendation 3: Recalibrate CI Budget to CI Runner Environment
- **Current State**: `budgets/performance.json` hardcodes `measuredBaseline: 82` (owner local machine) with a floor of `77`. As documented in commit `3a717301`:
  > "The CI step is continue-on-error until a CI-runner median exists, after which the budget tightens to (CI median - tolerance) and the step becomes blocking."
- **Recommended Action**:
  - When the owner approves making the CI gate blocking, update `budgets/performance.json` with the observed CI median of **69** and set `minScore: 64` (`69 - 5`).
  - Once Recommendations 1 and 2 land and raise the CI median to ~80+, tighten the budget upward accordingly.

### Recommendation 4: Tree-Shake Lucide Icons in Footer
- **Current State**: `src/components/Footer.tsx` imports icons (`Instagram`, `Linkedin`, `Mail`) directly. PR #524 added this shared footer to all legal/policy pages, increasing their bundle size by **+11.3 KB** each.
- **Recommended Action**:
  - Replace named icon imports from `lucide-react` with lightweight SVG paths or specific submodule imports (e.g. `lucide-react/dist/esm/icons/instagram`).
- **Estimated Benefit**: Reduces footer bundle footprint across all 23 application routes.

### Recommendation 5: Right-Size Above-The-Fold Decorative Images
- **Current State**: `/icon.png` (221 KB) and `/mascot.png` (221 KB) are rendered in 40px and 84px slots in `LandingTopArtifact.tsx`.
- **Recommended Action**:
  - When the landing page design freeze is lifted by the owner, replace these two PNGs with right-sized WebP/AVIF assets (~3–8 KB each), saving ~430 KB of network payload on first load.

---

## 7. Summary & Next Steps

| Item | Value |
| :--- | :--- |
| **Recorded Owner Baseline** | `82` |
| **Current CI Runner Median** | `69` |
| **CI Hard Floor in `budgets/performance.json`** | `77` (Failing by 8 points on CI) |
| **Landing Page First-Load JS** | `1,229.0 KB` (up +1.2 KB from `fe51f03`) |
| **Primary Suspect Merges** | PR #524 (+11.3 KB on policy routes), PR #515 (+3.6 KB on pricing), PR #500 (+358 B on landing) |
| **Immediate Next Step** | Submit this investigation document as PR. Do not modify code, `ci.yml`, or `budgets/performance.json`. Await owner decision on Recommendation 1 (Supabase de-preloading) and Recommendation 3 (budget recalibration). |
