# CM Prompt 8: Jobright Auth Reference Layout & Mobile Drawer Correction Report

**Date**: 23 October 2026  
**Branch**: `feat/jobright-auth-presentation`  
**Base Commit**: `d10e408` (`origin/main`, merged PR #75)  
**Pull Request**: [#76](https://github.com/ORM-git/Carrier-hound/pull/76) (Open & Unmerged)  
**Status**: All Tests & Browser Checks Passed (`PASS-LOCAL`)

---

## 1. Executive Summary

In response to the mobile follow-up review for PR #76, the mobile authentication presentation on `/login` and `/signup` was corrected to match the verified Jobright 390px reference layout specifications as a **bottom-anchored drawer**, while strictly preserving CareerMonke's branding, primary blue (`#2563EB`, hover `#1D4ED8`), working Supabase authentication contracts, existing desktop modal geometry, and the dual-mode primary navigation sidebar work (commit `82aad73`).

Additionally, the mobile navigation stacking order was fortified: both the mobile navigation backdrop (`z-[60]`) and drawer (`z-[61]`) were raised strictly above the root `CookieNotice` (`z-50`), ensuring the candidate account row and Sign Out button are 100% visible, hit-tested, and interactive on mobile at both 390x844 and 390x600 without modifying cookie-consent behavior.

### Key Specifications & Corrections:
1. **Mobile Bottom-Anchored Drawer (390px Viewport)**:
   - Full viewport width (`w-full left-0 right-0`), anchored to the bottom of the viewport (`fixed bottom-0` on mobile, `sm:relative sm:bottom-auto`), with zero side margins (`m-0 sm:mx-auto`).
   - 20px top corner radii and square bottom corners (`rounded-t-[20px] rounded-b-none sm:rounded-[24px]`).
   - Dark circular close control visible, accessible, and interactive (`aria-label="Close and return to home"`).
   - Safe-area insets respected (`pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-[32px]`).
   - Vertical scrolling on short mobile screens (`max-h-[92vh] sm:max-h-[calc(100vh-32px)] overflow-y-auto`) with zero horizontal overflow (`scrollWidth === clientWidth === 390px`).
2. **Mobile Account-Switch Box**:
   - White background with a 1px `#E5E7EB` border on mobile instead of the desktop grey fill (`bg-white border border-[#E5E7EB] sm:bg-[#F3F4F5] sm:border-transparent`).
   - 48px height, 8px radius, regular text with bold blue link (`Sign up` / `Sign in`), preserving bidirectional `?next=` destination query parameter.
3. **Signup Terms & Privacy Placement**:
   - **Mobile Signup**: The Terms and Privacy Policy line is positioned **BELOW** the account-switch box (`sm:hidden text-[12px] text-center text-[#6B7280] pt-1`). Preserves text and valid destinations (`/terms-and-conditions` and `/privacy-policy`).
   - **Desktop Signup**: Positioned **ABOVE** the switch box (`hidden sm:block text-[12px] text-center text-[#6B7280]`).
4. **Desktop Layout Unchanged**:
   - Centred white modal card with 488px max width (`max-w-[488px]`), 24px corner radius (`rounded-[24px]`), 48px top / 32px sides / 32px bottom padding, and 424px content width.
   - Filled grey switch box (`#F3F4F5`), Terms above switch box.
5. **Mobile Slide-Up Drawer Entrance Motion**:
   - Mobile: 0.3s `translateY(100%)` to `translateY(0)` slide-up drawer entrance (`authDrawerEntranceMobile`).
   - Desktop: 0.3s `scale(0.98)` to `scale(1)` modal scale entrance (`authModalEntrance`).
   - Both use easing `cubic-bezier(0.08, 0.82, 0.17, 1)` and honor `prefers-reduced-motion`.
6. **Mobile Navigation Drawer & CookieNotice Stacking Context**:
   - Mobile nav backdrop raised to `z-[60]` (above `CookieNotice` `z-50`).
   - Mobile nav drawer raised to `z-[61]` (above backdrop `z-[60]` and `CookieNotice` `z-50`).
   - Drawer container equipped with `overflow-y-auto overscroll-contain` and drawer footer has `shrink-0` to guarantee user profile and Sign Out button remain reachable on short screens (390x600).
   - Close button and Escape key dismiss drawer and return focus to hamburger trigger button.

---

## 2. Visual & Interactive Token Comparison

| Element | Desktop Modal Specification | Mobile Drawer Specification |
| :--- | :--- | :--- |
| **Surface Positioning** | Centred in viewport (`sm:relative sm:mx-auto sm:my-4`) | Anchored to bottom (`fixed bottom-0 left-0 right-0`) |
| **Surface Width** | Max-width 488px (`sm:max-w-[488px]`), content 424px | Full viewport width 390px, 0 side margins (`m-0`) |
| **Corner Radii** | 24px all corners (`sm:rounded-[24px]`) | 20px top corners, 0px bottom corners (`rounded-t-[20px] rounded-b-none`) |
| **Padding** | 48px top, 32px sides, 32px bottom | 32px top, 20px sides, safe-area inset bottom |
| **Switch Box** | Light-grey filled box (`#F3F4F5`, transparent border) | White background, 1px `#E5E7EB` border |
| **Signup Terms** | Placed **ABOVE** switch box (`hidden sm:block`) | Placed **BELOW** switch box (`sm:hidden`) |
| **Entrance Motion** | Scale `0.98` -> `1.0` (0.3s cubic-bezier(0.08, 0.82, 0.17, 1)) | Slide-up `translateY(100%)` -> `translateY(0)` (0.3s) |
| **Vertical Scroll** | `max-h-[calc(100vh-32px)] overflow-y-auto` | `max-h-[92vh] overflow-y-auto` (responsive on short screens) |
| **Horizontal Overflow** | Zero overflow (`scrollWidth === clientWidth`) | Zero overflow (`scrollWidth === clientWidth === 390px`) |
| **Nav Drawer Stacking** | Desktop rail in normal layout (`hidden md:flex`) | Backdrop `z-[60]`, Drawer `z-[61]` above CookieNotice (`z-50`) |

---

## 3. Verification Evidence & Test Results

### 3.1. TypeScript & Production Build
- `npx tsc --noEmit`: Exited 0 with zero diagnostic errors.
- `npm run build`: Compiled 40 static pages successfully to `out/`.

### 3.2. Static Spec Audit & Negative Control (`scripts/test-auth-presentation.ts`)
```text
==================================================================================
     PROMPT 8 AUDIT — JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC AUDIT         
==================================================================================
Mode: NORMAL VALIDATION

  [PASS] dimmed backdrop: Dimmed backdrop present over auth route page
  [PASS] desktop card dimensions: White modal card 488px max width, 24px radius, 424px content width
  [PASS] mobile bottom drawer: Full width, bottom-anchored, 0 side margins, 20px top corners, square bottom, safe-area aware, vertical scrolling
  [PASS] close control: Dark circular close button navigating to / with Esc key support
  [PASS] headings: Centred 24px light heading with bold brand inline; extra subtitle and inner logo removed
  [PASS] google button: Full width 48px high, 1px #E5E7EB border, 8px radius with Google icon
  [PASS] plain or: Small grey 'OR' with zero horizontal divider lines
  [PASS] email input: 48px high, #F7F8F9 fill, 8px radius, placeholder 'Email', accessible sr-only label
  [PASS] primary button: 48px high, 8px radius, #2563EB with truthful magic-link text
  [PASS] legal links: Terms and Privacy Policy links preserved with valid destinations
  [PASS] signup terms placement: Desktop above switch box; mobile below switch box
  [PASS] switch box: Mobile white + 1px #E5E7EB border; Desktop #F3F4F5 grey fill, 8px radius, ?next preserved
  [PASS] entrance motion: 0.3s cubic-bezier(0.08,0.82,0.17,1) mobile drawer slide-up & desktop modal scale entrance with prefers-reduced-motion

----------------------------------------------------------------------------------
PROMPT 8 JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC AUDIT [PASS-LOCAL]
----------------------------------------------------------------------------------
```

### 3.3. Logged-In App Shell Audit (`scripts/test-loggedin-shell.ts`)
```text
==================================================================================
            PROMPT 8 REBUILD — LOGGED-IN APP SHELL AUDIT SUITE                   
==================================================================================
Mode: NORMAL VALIDATION

  [PASS] dual-mode dimensions: narrow 72px (w-[72px]) and expanded 240px (w-[240px]) desktop modes supported
  [PASS] rail branding: small CareerMonke logo mark at top
  [PASS] rail nav items: Dashboard, Jobs, Resume, Profile, Tracker, Radar present
  [PASS] rail item sizing: 24px line icons over 11px labels in narrow mode
  [PASS] rail geometry: 56x56px footprint, 8px inset, 64px pitch verified
  [PASS] sidebar toggle & persistence: accessible expand/collapse control with localStorage persistence
  [PASS] rail bottom: fixed Settings item at the bottom of the sidebar
  [PASS] coaching-style hover: soft light-blue background (#F0F7FF) and blue text (#2563EB) on hover
  [PASS] persistent active route: distinct active route state with #EFF6FF background and aria-current
  [PASS] keyboard focus: accessible WCAG 2.1 focus indicators on all nav items
  [PASS] top bar shell: 56px height (h-14), white background, 1px bottom border #E2E8F0
  [PASS] top bar cleanup: duplicated desktop primary nav links removed from top bar
  [PASS] top bar account controls: avatar initial, bold 13px name, Free/Pro plan pill verified
  [PASS] top bar search: fully-rounded search input present
  [PASS] dynamic content reflow: content smoothly reflows without clipping or overlap based on chosen sidebar mode
  [PASS] mobile responsiveness & stacking: desktop rail hidden on mobile; drawer has >=44px targets, backdrop z-[60] & drawer z-[61] above CookieNotice
  [PASS] legacy cleanup: zero 220px sidebar references across all pages
  [PASS] shell adoption: AppIconRail and AppTopBar integrated across /dashboard, /jobs, /tracker, /resume, /settings
  [PASS] brand & feature purity: zero Jobright copy, mascots, or coaching/agent/autofill pills
  [PASS] tab counts: zero hardcoded "24+" count literal; External tab badge derives dynamically and hides when 0/loading
  [PASS] applied tab list: filters live jobs by tracker applied jobIds to match badge count
  [PASS] tab buttons: min-h-[44px] touch target enforced across desktop and mobile tabs

----------------------------------------------------------------------------------
PROMPT 8 LOGGED-IN APP SHELL & DUAL-MODE SIDEBAR VALIDATED LOCALLY [PASS-LOCAL]
----------------------------------------------------------------------------------
```

**Negative Control Validation**: Detected 13 deliberate corruptions including `z-[60]` and `z-[61]` verification (`exit code 1`).

### 3.4. Mobile Navigation Drawer & CookieNotice Stacking Checks (`scripts/test-mobile-nav-stacking.cjs`)
```text
==================================================================================
     AUTOMATED BROWSER CHECKS: MOBILE NAV DRAWER & COOKIENOTICE STACKING          
==================================================================================

[PASS] Mock static server listening on http://localhost:3466
TEST 1: Mobile 390x844 Viewport Stacking & Interaction...
  [PASS] Root CookieNotice active at bottom (z-index: 50, height: 102px)
  [PASS] Stacking order confirmed: Drawer (z-61) > Backdrop (z-60) > CookieNotice (z-50)
  [PASS] Element hit test on Sign Out button: hit verified (not occluded by CookieNotice)
  [SAVED] reports/prompt8-auth/mobile-drawer-stacking-390x844.png
  [PASS] Sign Out button interactive click verified with mocked handler
  [PASS] Close button closed drawer and returned focus to hamburger trigger
  [PASS] Escape key closed drawer and returned focus to hamburger trigger

TEST 2: Short Mobile 390x600 Viewport Stacking & Scroll Reachability...
  [PASS] Short screen (390x600): drawer height 600px matches viewport
  [PASS] Drawer overflow-y: auto
  [PASS] Footer Sign Out button reachable at bottom: 580px <= 600px
  [SAVED] reports/prompt8-auth/mobile-drawer-stacking-390x600.png
  [SAVED] reports/prompt8-auth/mobile-drawer-footer-reachable.png

==================================================================================
  ALL MOBILE NAVIGATION DRAWER & COOKIENOTICE STACKING CHECKS PASSED [PASS-LOCAL] 
==================================================================================
```

---

## 4. Visual Artifacts

All visual artifacts captured and stored in `reports/prompt8-auth/`:

### 4.1. Mobile Navigation & Stacking Captures:
- **Mobile Drawer Stacking at 390x844**: [mobile-drawer-stacking-390x844.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-drawer-stacking-390x844.png) (Drawer z-[61] and backdrop z-[60] overlay cleanly above CookieNotice z-50; account row and Sign Out button fully interactive).
- **Mobile Drawer Stacking at 390x600**: [mobile-drawer-stacking-390x600.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-drawer-stacking-390x600.png) (Short screen view confirming scrolling and visible footer).
- **Footer Reachability Proof**: [mobile-drawer-footer-reachable.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-drawer-footer-reachable.png) (Sign Out button and profile row unoccluded by CookieNotice).
- **Mobile Hamburger Drawer**: [mobile-nav-drawer.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-nav-drawer.png).

### 4.2. Auth Bottom Drawer & Motion:
- **Mobile Login Drawer (390x844)**: [login-mobile.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-mobile.png) (Bottom-anchored drawer, 20px top radii, square bottom, white switch box with 1px border).
- **Mobile Signup Drawer (390x844)**: [signup-mobile.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-mobile.png) (Terms and Privacy Policy line placed below the white switch box).
- **Short Screen Mobile View (390x600)**: [login-mobile-short.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-mobile-short.png) (Vertical scroll with safe-area spacing and visible close control).
- **Mobile Drawer Entrance Motion**: [mobile-drawer-entrance.gif](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-drawer-entrance.gif) (Slide-up `translateY(100%)` -> `0%` at 10 fps).

### 4.3. Desktop Captures (1280x900):
- **Desktop Login Modal**: [login-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-desktop.png) (Centred 488px card, 24px radius, filled `#F3F4F5` switch box).
- **Desktop Signup Modal**: [signup-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-desktop.png) (Terms line above the switch box).
- **Narrow Mode (72px Rail)**: [sidebar-narrow-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/sidebar-narrow-desktop.png).
- **Expanded Mode (240px Sidebar)**: [sidebar-expanded-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/sidebar-expanded-desktop.png).
- **Coaching Hover Highlight**: [sidebar-hover-highlight.png](file:///d:/Carrer-hound/reports/prompt8-auth/sidebar-hover-highlight.png).
- **Keyboard Focus State**: [sidebar-keyboard-focus.png](file:///d:/Carrer-hound/reports/prompt8-auth/sidebar-keyboard-focus.png).

---

## 5. Changed Files Summary

1. [`src/components/shell/AppTopBar.tsx`](file:///d:/Carrer-hound/src/components/shell/AppTopBar.tsx): Raised mobile navigation backdrop to `z-[60]` and drawer to `z-[61]` above root `CookieNotice` (`z-50`). Added `overflow-y-auto overscroll-contain` on drawer and `shrink-0` on footer for short screen scroll reachability.
2. [`scripts/test-loggedin-shell.ts`](file:///d:/Carrer-hound/scripts/test-loggedin-shell.ts): Added assertions for `z-[60]` backdrop and `z-[61]` drawer with negative control coverage.
3. [`scripts/test-mobile-nav-stacking.cjs`](file:///d:/Carrer-hound/scripts/test-mobile-nav-stacking.cjs): Created automated browser test suite verifying drawer stacking above CookieNotice, hit testing on Sign Out button, interactive click with mocked handler, close button, Escape key, focus return, and 390x600 short screen reachability.
4. [`scripts/capture-sidebar-screenshots.cjs`](file:///d:/Carrer-hound/scripts/capture-sidebar-screenshots.cjs): Updated screenshot capture runner.
5. [`reports/prompt8-auth/auth-presentation-report.md`](file:///d:/Carrer-hound/reports/prompt8-auth/auth-presentation-report.md): Updated audit and verification documentation.

---

## 6. Prompt 1/4: Auth Overlays (Cookie Fix) & Job-Detail Actions

### 6.1. Stacking Order Resolution (Auth Backdrops & Drawers)
To prevent the root `CookieNotice` (`z-50`) from occluding bottom links on mobile `/login` and `/signup`:
- **Auth Backdrop**: Set to `z-[70]` in both `src/app/login/page.tsx` and `src/app/signup/page.tsx`.
- **Auth Card/Drawer**: Set to `z-[71]` in both pages.
- **Navigation Layers**: Retained at `z-[60]` (backdrop) and `z-[61]` (drawer) in `AppTopBar.tsx`.
- **Root Cookie Notice**: Retained at `z-50` in `CookieNotice.tsx` without auto-dismissal or altering consent logic.
- **Desktop Geometry**: Unaltered (centred 488px card, 24px radius, 48px/32px padding).

#### Stacking Hierarchy Matrix
| Surface | Z-Index Layer | DOM Location | Relative Order |
| :--- | :--- | :--- | :--- |
| **Auth Card / Drawer** | `z-[71]` | `src/app/login/page.tsx`, `signup/page.tsx` | Highest active modal surface |
| **Auth Backdrop** | `z-[70]` | `src/app/login/page.tsx`, `signup/page.tsx` | Above nav & cookie notice |
| **Mobile Nav Drawer** | `z-[61]` | `src/components/shell/AppTopBar.tsx` | Above nav backdrop & cookie notice |
| **Mobile Nav Backdrop** | `z-[60]` | `src/components/shell/AppTopBar.tsx` | Above cookie notice |
| **Cookie Notice** | `z-50` | `src/components/CookieNotice.tsx` | Global bottom banner |

### 6.2. Job-Detail Actions (Share & Report Issue)
1. **Canonical Job URL Sharing**:
   - `getCanonicalJobUrl(jobId)` pure helper strictly generates `${base}/jobs?id=${encodeURIComponent(jobId)}`.
   - Strips all private, tracking, and session query parameters (`search`, `tab`, `session`, `token`, `utm_*`).
   - Reuses `getSiteUrl()` from `@/lib/siteUrl` with fallback to `window.location.origin`.
2. **Share Control Success & Failure Handling**:
   - Success: Copies canonical URL to clipboard, button switches to emerald state (`border-emerald-200 bg-emerald-50 text-emerald-700`) with `<Check>` icon and `"Link copied"` text.
   - Failure: When clipboard API is unavailable or throws, `"Link copied"` is **strictly omitted**. Renders an accessible alert box (`role="alert"`, `data-testid="share-fallback-container"`) containing `"Unable to copy automatically"`, a dismiss button, and an auto-selecting read-only input (`data-testid="share-fallback-input"`) with the canonical URL for manual copying.
   - Mobile: Dedicated 44px tap target Share button added to the sticky bottom apply bar, with mobile floating confirmation toast (`data-testid="share-success-banner"`) on success and top fallback on failure.
3. **Report Issue Inspection & Gap Analysis**:
   - **Inspection**: Codebase search across `src/`, `netlify/`, and `reports/` confirmed that `support@careermonke.com` is the platform's verified configured destination (referenced in `src/app/page.tsx:438`, `src/components/Footer.tsx:325`, `src/components/auth/BlockedAccountNotice.tsx:43`, and `src/app/terms-and-conditions/page.tsx:18`).
   - **Gap Analysis**: CareerMonke currently has **no dedicated backend ticketing API** or database table (e.g. `/api/jobs/report` or `job_reports` table) for automated issue submission.
   - **Implementation**: Reused verified `support@careermonke.com` destination via structured `mailto:` link (`getReportJobMailto`) with sanitized public job context (`[Job Issue] ${job.title} (${job.id})`, company, canonical URL) and **zero private candidate data**.

### 6.3. Prompt 1/4 Visual Artifacts
- **Mobile Login (390x844) Stacking**: [mobile-login-390x844-cookie-stacking.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-login-390x844-cookie-stacking.png)
- **Mobile Signup (390x844) Stacking**: [mobile-signup-390x844-cookie-stacking.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-signup-390x844-cookie-stacking.png)
- **Mobile Login (390x600) Short View**: [mobile-login-390x600-cookie-stacking.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-login-390x600-cookie-stacking.png)
- **Mobile Signup (390x600) Short View**: [mobile-signup-390x600-cookie-stacking.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-signup-390x600-cookie-stacking.png)
- **Job Detail Desktop Actions**: [job-detail-desktop-actions.png](file:///d:/Carrer-hound/reports/prompt8-auth/job-detail-desktop-actions.png)
- **Job Detail Desktop Share Success**: [job-detail-share-success-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/job-detail-share-success-desktop.png)
- **Job Detail Desktop Share Failure Fallback**: [job-detail-share-failure-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/job-detail-share-failure-desktop.png)
- **Job Detail Mobile Actions**: [job-detail-mobile-actions.png](file:///d:/Carrer-hound/reports/prompt8-auth/job-detail-mobile-actions.png)
- **Job Detail Mobile Share Success**: [job-detail-share-success-mobile.png](file:///d:/Carrer-hound/reports/prompt8-auth/job-detail-share-success-mobile.png)
- **Job Detail Mobile Share Failure Fallback**: [job-detail-share-failure-mobile.png](file:///d:/Carrer-hound/reports/prompt8-auth/job-detail-share-failure-mobile.png)
