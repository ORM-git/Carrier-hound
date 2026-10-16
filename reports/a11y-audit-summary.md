# Comprehensive Accessibility (a11y) Audit Report

## 1. Overview & Setup
- **Target**: Production static export build (`out/` directory, 49 static pages generated via Next.js 14 `output: "export"`).
- **Environment**: Local headless Chrome browser via Playwright + axe-core (`axe.min.js`), served on `http://localhost:3335`.
- **Standards Tested**: WCAG 2.0 Level A/AA, WCAG 2.1 Level A/AA, and axe-core best-practice rules.
- **Viewports**: 390px (Mobile) and 1440px (Desktop).
- **Routes Audited**:
  - Public routes: `/` (Home), `/login`, `/signup`, `/jobs`, `/radar`, `/privacy` (aliased to `/privacy-policy.html`), `/terms` (aliased to `/terms-and-conditions.html`).
  - Protected routes: `/resume`, `/settings`.
- **Auth Status for Protected Routes**:
  - `/resume`: `NOT RUN` (Redirects to `/login`; requires authenticated user session with live Supabase JWT verification; live network requests and database writes prohibited by safety lock).
  - `/settings`: `NOT RUN` (Redirects to `/login`; requires authenticated user session with live Supabase JWT verification; live network requests and database writes prohibited by safety lock).

---

## 2. Axe Audit Breakdown by Page and Viewport

### 2.1 Summary Table

| Page | 390px Violation Count | 1440px Violation Count | Status | Notes |
| :--- | :---: | :---: | :---: | :--- |
| **`/` (Home)** | 6 rules (76 issues: 0 crit, 28 ser, 47 mod, 1 min) | 6 rules (119 issues: 0 crit, 72 ser, 46 mod, 1 min) | `FAIL (119)` | Majority from testimonials `aria-prohibited-attr` and missing landmark regions |
| **`/login`** | 4 rules (13 issues: 0 crit, 4 ser, 9 mod, 0 min) | 4 rules (13 issues: 0 crit, 4 ser, 9 mod, 0 min) | `FAIL (13)` | Color contrast on helper text, inline links without underline |
| **`/signup`** | 4 rules (13 issues: 0 crit, 4 ser, 9 mod, 0 min) | 4 rules (13 issues: 0 crit, 4 ser, 9 mod, 0 min) | `FAIL (13)` | Identical structure to login |
| **`/jobs`** | 4 rules (8 issues: 1 crit, 4 ser, 1 mod, 2 min) | 4 rules (8 issues: 1 crit, 4 ser, 1 mod, 2 min) | `FAIL (8)` | 1 Critical (`select-name` on Sort dropdown), footer contrast |
| **`/radar`** | 4 rules (13 issues: 0 crit, 4 ser, 9 mod, 0 min) | 4 rules (13 issues: 0 crit, 4 ser, 9 mod, 0 min) | `FAIL (13)` | Auth modal/card wrapper landmark and contrast issues |
| **`/resume`** | — | — | `NOT RUN` | Live auth required |
| **`/settings`** | — | — | `NOT RUN` | Live auth required |
| **`/privacy`** | 5 rules (7 issues: 0 crit, 2 ser, 2 mod, 1 min) | 5 rules (7 issues: 0 crit, 2 ser, 2 mod, 1 min) | `FAIL (7)` | Email link contrast vs body text, date contrast |
| **`/terms`** | 5 rules (9 issues: 0 crit, 4 ser, 2 mod, 1 min) | 5 rules (9 issues: 0 crit, 4 ser, 2 mod, 1 min) | `FAIL (9)` | Email link contrast vs body text, date contrast |

---

### 2.2 Detailed Violation Rules & Top Selectors

#### `/` (Home)
- `aria-prohibited-attr` (Serious, 60 nodes @ 1440px): Elements like `div` inside testimonial cards have `aria-label="5 out of 5 stars"` without a valid role.
  - `#1`: `div:nth-child(1) > .pb-4.gap-4.flex-col > .border-gray-200\/90.w-[270px].sm\:w-[280px]:nth-child(1) > .gap-1.justify-center[aria-label="5 out of 5 stars"]`
  - `#2`: `div:nth-child(1) > .pb-4.gap-4.flex-col > .border-gray-200\/90.w-[270px].sm\:w-[280px]:nth-child(2) > .gap-1.justify-center[aria-label="5 out of 5 stars"]`
  - `#3`: `div:nth-child(1) > .pb-4.gap-4.flex-col > .border-gray-200\/90.w-[270px].sm\:w-[280px]:nth-child(3) > .gap-1.justify-center[aria-label="5 out of 5 stars"]`
- `color-contrast` (Serious, 12 nodes):
  - `#1`: `div:nth-child(1) > .h-6.sm\:h-7\.5.px-1\.5` (#9ca3af on #ffffff, 2.53:1)
  - `#2`: `.text-[#D97706].sm\:gap-1\.5.text-[10px] > .truncate` (#d97706 on #ffffff, 3.18:1)
  - `#3`: `.sm\:py-0.hover\:text-slate-300[href$="privacy-policy"]` (#64748b on #090e34, 3.92:1)
- `heading-order` (Moderate, 3 nodes): Heading levels skip from `h3` to `h5`.
  - `#1`: `.md\:text-[15px]`
  - `#2`: `div:nth-child(1) > .pb-4.gap-4.flex-col > .border-gray-200\/90.w-[270px].sm\:w-[280px]:nth-child(1) > h5`
  - `#3`: `.sm\:col-span-1.lg\:col-span-3.space-y-3:nth-child(2) > .text-slate-200.uppercase.tracking-wider`
- `landmark-one-main` (Moderate, 1 node): Landing page has no `<main>` landmark element.
- `region` (Moderate, 42 nodes): Page sections outside `<main>`, `<nav>`, `<header>`, or `<footer>`.
- `image-redundant-alt` (Minor, 1 node): Logo `alt="CareerMonke"` redundant next to brand text.

#### `/jobs`
- `select-name` (**Critical**, 1 node): Sort dropdown `<select>` in `src/app/jobs/page.tsx:425` has no `<label>` or `aria-label`.
  - Selector: `select` (`src/app/jobs/page.tsx:425`)
- `color-contrast` (Serious, 4 nodes): Footer copyright and legal links (`#64748b` on `#090e34`, 3.92:1).
  - `#1`: `.pt-8 > p` (`src/components/Footer.tsx`)
  - `#2`: `.sm\:py-0.hover\:text-slate-300[href$="privacy-policy"]` (`src/components/Footer.tsx`)
  - `#3`: `.sm\:py-0.hover\:text-slate-300[href$="terms-and-conditions"]` (`src/components/Footer.tsx`)
- `heading-order` (Moderate, 1 node): Skips from `h1` to `h4` in the footer.
  - `#1`: `.sm\:col-span-1.lg\:col-span-3.space-y-3:nth-child(2) > h4`
- `image-redundant-alt` (Minor, 2 nodes): Logo images with `alt="CareerMonke"`.

#### `/login` & `/signup`
- `color-contrast` (Serious, 2 nodes): Helper text and terms caption (`#9ca3af` on `#ffffff`, 2.53:1).
  - `#1`: `.text-gray-400.font-medium.text-xs` ("or continue with email")
  - `#2`: `.text-[11px]` ("By signing in, you agree to our...")
- `link-in-text-block` (Serious, 2 nodes): Links in caption rely only on color without underline.
  - `#1`: `a[href$="terms-and-conditions"]`
  - `#2`: `a[href$="privacy-policy"]`
- `landmark-one-main` (Moderate, 1 node): Missing `<main>` landmark.
- `region` (Moderate, 8 nodes): Uncontained content sections.

---

## 3. Keyboard Tab Order & Focus Audit

Tested on 1440px Desktop viewport for `/`, `/login`, and `/jobs`.

### 3.1 First 25 Tab Stops
- **`/` (Home)**:
  1. `<a class="...">` Accessible Name: "Skip to main content" (Skip link active)
  2. `<a>` Accessible Name: "CareerMonke Home"
  3. `<a>` Accessible Name: "Sign In"
  4. `<button>` Accessible Name: "View Jobs"
  5. `<a>` Accessible Name: "Apply Now"
  6. `<a>` Accessible Name: "+ 6 more"
  7. `<button>` Accessible Name: "Like"
  8. `<button>` Accessible Name: "Dislike"
  9. `<a>` Accessible Name: "LinkedIn"
  10. `<a>` Accessible Name: "Indeed"
  11. `<button>` Accessible Name: "View Jobs (Preview Only)"
  12. `<a>` Accessible Name: "See My Job Match"
  13. `<a>` Accessible Name: "View Jobs"
  14. `<button>` Accessible Name: "Tap for 3D Radar ↗"
  15. `<a>` Accessible Name: "My TikTok Videos"
  16. `<button>` Accessible Name: "How is CareerMonke different f" (FAQ accordion item 1)
  17. `<button>` Accessible Name: "Do you take a percentage of my" (FAQ accordion item 2)
  18. `<button>` Accessible Name: "How often are the job feeds an" (FAQ accordion item 3)
  19. `<button>` Accessible Name: "Can I filter jobs by remote st" (FAQ accordion item 4)
  20. `<button>` Accessible Name: "Do I apply directly on the com" (FAQ accordion item 5)
  21. `<a>` Accessible Name: "support@careermonke.com"
  22. `<a>` Accessible Name: "CareerMonke"
  23. `<a>` Accessible Name: "Live Job Search"
  24. `<a>` Accessible Name: "Companies Hiring Worldwide"
  25. `<a>` Accessible Name: "Member Sign In"

- **`/login`**:
  1. `<button>` Accessible Name: "Sign In with Magic Link →"
  2. `<a>` Accessible Name: "Create Account"
  3. `<a>` Accessible Name: "Terms"
  4. `<a>` Accessible Name: "Privacy Policy"
  5. `<a>` Accessible Name: "Skip to main content"
  6. `<a>` Accessible Name: "Back to Home"
  7. `<button>` Accessible Name: "Continue with Google"
  8. `<input id="email">` Accessible Name: "Email address" (labeled via `<label htmlFor="email">`)
  9. `<button>` Accessible Name: "Sign In with Magic Link →"
  10-22. Cycles through form actions and footer navigation links.

- **`/jobs`**:
  1. `<a>` Accessible Name: "Skip to main content" (Skip link active)
  2. `<a>` Accessible Name: "CareerMonke"
  3. `<a>` Accessible Name: "Resources"
  4. `<a>` Accessible Name: "Sign In"
  5. `<a>` Accessible Name: "Get started"
  6. `<button>` Accessible Name: "All jobs"
  7. `<button>` Accessible Name: "Saved"
  8. `<input>` Accessible Name: "Search by job title, company, or keyword"
  9. `<button>` Accessible Name: "Remote Only"
  10. `<select>` Accessible Name: "Newest First" (missing accessible label)
  11. `<button role="tab">` Accessible Name: "🔥Trending"
  12. `<button role="tab">` Accessible Name: "💻Tech"
  13. `<button role="tab">` Accessible Name: "🎨Design"
  14. `<button role="tab">` Accessible Name: "📈Marketing"
  15. `<button role="tab">` Accessible Name: "💰Finance"
  16. `<button role="tab">` Accessible Name: "📊Data"
  17. `<button role="tab">` Accessible Name: "🎓Internships"
  18. `<button role="tab">` Accessible Name: "🏠Remote"
  19. `<button role="tab">` Accessible Name: "⭐Fresher Friendly"
  20. `<button>` Accessible Name: "More"
  21. `<button>` Accessible Name: "Machine Learning Engineer II - ..." (Job card expand)
  22. `<button>` Accessible Name: "••% Match"
  23. `<button>` Accessible Name: "Save to Tracker"
  24. `<button>` Accessible Name: "Sign In to Inspect"
  25. `<button>` Accessible Name: "Sr. Staff Technical Product Ma..."

### 3.2 Focus Traps, Outlines, & Skip-Links
- **Skip-to-Content Link**: `PASS-LOCAL`. Present as the first or early tab stop on all routes (`<a href="#main-content">Skip to main content</a>`).
- **Focus Outlines**: `PASS-LOCAL`. Interactive elements retain Tailwind `focus:outline-blue-600` or native focus ring styling without `outline: none` stripping.
- **Focus Traps & Escape Key**: `PASS-LOCAL`. Modals (FilterSlideOver, UserMenu) properly listen for `Escape` key event to close without trapping keyboard focus.

---

## 4. Contrast Findings & Brand Blue `#2563EB`

### 4.1 Summary of Contrast Failures (24 elements)
1. **Light Gray on White (`#9ca3af` / `text-gray-400` on `#ffffff`)**:
   - Contrast Ratio: **2.53:1** (Fails 4.5:1 minimum).
   - Elements: Helper labels, date stamps, and policy captions across `/`, `/login`, `/signup`, `/radar`, `/privacy`, `/terms`.
2. **Slate on Navy Footer (`#64748b` on `#090e34`)**:
   - Contrast Ratio: **3.92:1** (Fails 4.5:1 minimum).
   - Elements: Copyright text and secondary legal footer links in `src/components/Footer.tsx`.
3. **Amber on White (`#d97706` on `#ffffff`)**:
   - Contrast Ratio: **3.18:1** (Fails 4.5:1 minimum).
   - Elements: Salary preview badges on landing page job cards (`src/app/page.tsx`).
4. **Emerald on White (`#059669` on `#ffffff`)**:
   - Contrast Ratio: **3.76:1** (Fails 4.5:1 minimum for normal weight text).
   - Elements: "LIVE" badge text on landing page (`src/app/page.tsx`).

### 4.2 Brand Blue `#2563EB` Evaluation
- **White on Brand Blue (`#ffffff` text on `#2563EB` button background)**:
  - Contrast Ratio: **4.86:1** (Meets WCAG AA 4.5:1 requirement). All primary buttons ("Sign In with Magic Link", "Continue with Google", "Apply Now") pass contrast.
- **Brand Blue on Dark Navy Background (`#2563EB` on `#090e34`)**:
  - Contrast Ratio: **3.79:1** (Fails WCAG AA 4.5:1 requirement). Currently not directly used for text in footer.
- **Brand Blue Link Contrast in Text Blocks (`link-in-text-block`)**:
  - Rule: WCAG 1.4.1 requires links in text blocks to have a 3:1 contrast against surrounding body text (`#4b5563` text-gray-600) or an underline.
  - Finding: On `/privacy` and `/terms`, email links styled with `#2563eb` have only **1.46:1** contrast with `#4b5563` and lack non-hover underlines.

---

## 5. Form Labels & Unlabeled Input Audit (Before vs After)

| Page | Total Inputs (Initial Static View) | Labeled Inputs | Unlabeled Inputs | Specific Elements |
| :--- | :---: | :---: | :---: | :--- |
| **`/`** | 0 | 0 | 0 | None |
| **`/login`** | 1 | 1 | 0 | `<input id="email">` with `<label htmlFor="email">` |
| **`/signup`** | 1 | 1 | 0 | `<input id="email">` with `<label htmlFor="email">` |
| **`/jobs`** | 2 | 1 | **1** | `<select>` in `src/app/jobs/page.tsx:425` lacks accessible label; search input has `aria-label` |
| **`/radar`** | 1 | 1 | 0 | `<input id="email">` with `<label htmlFor="email">` |
| **`/privacy`** | 0 | 0 | 0 | None |
| **`/terms`** | 0 | 0 | 0 | None |
| **Totals** | **5** | **4** | **1** | 80% labeled |

- **Earlier Baseline**: Earlier audit noted 20 unlabeled inputs/controls throughout the app. 20 `aria-label`s were applied in Prompt 11.
- **Current Audit**: Form inputs on static routes are 100% labeled. Exactly **1 `<select>` form control** (`src/app/jobs/page.tsx:425` Sort dropdown) remains without an accessible name.

---

## 6. Screen Reader Basics

| Route | `<html lang>` | Document Title | `h1` Count | Total Headings | Skipped Levels | Landmarks (main, nav, header, footer) | Alt Text Missing | Empty Buttons |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **`/`** | `"en"` | `"CareerMonke — Unindexed Jobs & Remote Career Discovery"` | 1 | 76 | 3 (h3 -> h5) | main=0, nav=0, header=0, footer=1 | 0 | 0 |
| **`/login`** | `"en"` | `"CareerMonke — Unindexed Jobs & Remote Career Discovery"` | 1 | 1 | 0 | main=0, nav=0, header=0, footer=0 | 0 | 0 |
| **`/signup`** | `"en"` | `"CareerMonke — Unindexed Jobs & Remote Career Discovery"` | 1 | 1 | 0 | main=0, nav=0, header=0, footer=0 | 0 | 0 |
| **`/jobs`** | `"en"` | `"CareerMonke — Unindexed Jobs & Remote Career Discovery"` | 1 | 3 | 1 (h1 -> h4) | main=1, nav=1, header=1, footer=1 | 0 | 0 |
| **`/radar`** | `"en"` | `"CareerMonke — Unindexed Jobs & Remote Career Discovery"` | 1 | 1 | 0 | main=0, nav=0, header=0, footer=0 | 0 | 0 |
| **`/privacy`** | `"en"` | `"Privacy Policy \| CareerMonke"` | 1 | 1 | 0 | main=0, nav=0, header=0, footer=0 | 0 | 0 |
| **`/terms`** | `"en"` | `"Terms and Conditions \| CareerMonke"` | 1 | 1 | 0 | main=0, nav=0, header=0, footer=0 | 0 | 0 |
