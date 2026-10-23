# CM Prompt 8: Jobright Auth Reference Layout & Mobile Drawer Correction Report

**Date**: 23 October 2026  
**Branch**: `feat/jobright-auth-presentation`  
**Base Commit**: `d10e408` (`origin/main`, merged PR #75)  
**Pull Request**: [#76](https://github.com/ORM-git/Carrier-hound/pull/76) (Open & Unmerged)  
**Status**: All Tests & Browser Checks Passed (`PASS-LOCAL`)

---

## 1. Executive Summary

In response to the mobile follow-up review for PR #76, the mobile authentication presentation on `/login` and `/signup` was corrected to match the verified Jobright 390px reference layout specifications as a **bottom-anchored drawer**, while strictly preserving CareerMonke's branding, primary blue (`#2563EB`, hover `#1D4ED8`), working Supabase authentication contracts, existing desktop modal geometry, and the dual-mode primary navigation sidebar work (commit `82aad73`).

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

**Negative Control Validation**:
```text
==================================================================================
     PROMPT 8 AUDIT — JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC AUDIT         
==================================================================================
Mode: NEGATIVE CONTROL (Expect Failure)

  [PASS] dimmed backdrop: Dimmed backdrop present over auth route page
  [PASS] close control: Dark circular close button navigating to / with Esc key support
  [PASS] google button: Full width 48px high, 1px #E5E7EB border, 8px radius with Google icon
  [PASS] plain or: Small grey 'OR' with zero horizontal divider lines
  [PASS] email input: 48px high, #F7F8F9 fill, 8px radius, placeholder 'Email', accessible sr-only label
  [PASS] primary button: 48px high, 8px radius, #2563EB with truthful magic-link text
  [PASS] legal links: Terms and Privacy Policy links preserved with valid destinations
  [PASS] entrance motion: 0.3s cubic-bezier(0.08,0.82,0.17,1) mobile drawer slide-up & desktop modal scale entrance with prefers-reduced-motion

==================================================================================
NEGATIVE CONTROL PASSED: Deliberately injected corruptions caught 5 errors.
==================================================================================
```

### 3.3. Automated Puppeteer Browser Checks (`scripts/test-auth-browser.cjs`)
```text
==================================================================================
     AUTOMATED BROWSER CHECKS: JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC      
==================================================================================

[PASS] Mock static server listening on http://localhost:3458
  [PASS] Desktop modal card: width 488px, content width 424px, radius 24px
  [PASS] Desktop padding: top 48px, sides 32px/32px, bottom 32px
  [PASS] Dimmed backdrop active (z-index: 40) behind card controls (z-index: 50)
  [PASS] Login heading verified: "Welcome back to CareerMonke" with inline brand bold (weight 700)
  [PASS] Google button verified: 48px height, 8px radius
  [PASS] Plain small grey 'OR' verified with no horizontal divider lines
  [PASS] Email input verified: 48px height, 8px radius, placeholder 'Email'
  [PASS] Desktop switch box verified: 48px height, 8px radius, #F3F4F5 grey fill
  [PASS] Close button verified with accessible name and href="/"
  [PASS] Escape key triggered navigation to "/"
  [PASS] Invalid email validation banner displayed: "Please enter a valid email address."
  [PASS] Simulated auth error banner verified: "Rate limit exceeded. Please wait 60 seconds."
  [PASS] Email-sent state rendered with candidate email address and 30s cooldown timer
  [PASS] 'Use a different email' reset the view back to the input form
  [PASS] Return destination ?next preserved from login to signup: "/signup?next=%2Ftracker"
  [PASS] Signup heading verified: "Welcome to CareerMonke"
  [PASS] Signup to login switch link preserved: "/login?next=%2Fjobs"
  [PASS] Desktop signup layout verified: Terms/Privacy line is above the switch box
  [PASS] Mobile bottom-anchored drawer: full width 390px, 0 side margins (left=0px), bottom-anchored (bottom=844px)
  [PASS] Mobile corner radii: 20px top corners (20px), square bottom corners (0px)
  [PASS] Mobile account switch box: white background with 1px #E5E7EB border
  [PASS] Mobile close control: visible and accessible
  [PASS] Zero horizontal overflow confirmed (scrollWidth=390, clientWidth=390)
  [PASS] Mobile signup layout verified: Terms/Privacy line is positioned BELOW the account switch box with valid destinations
  [PASS] Short screen (390x600) vertical scroll verified: card height 461px, overflow-y: auto

==================================================================================
  ALL JOBRIGHT-STYLE AUTH PRESENTATION BROWSER CHECKS PASSED [PASS-LOCAL]         
==================================================================================
```

### 3.4. Full Central Suite Runner (`scripts/suite-runner.ts`)
```text
================================================================================
SUMMARY: 48 passed, 0 failed, 0 blocked/skipped
================================================================================
```

---

## 4. Visual Artifacts

All visual artifacts captured and stored in `reports/prompt8-auth/`:

### 4.1. Motion Recordings:
- **Desktop Entrance GIF**: [login-entrance.gif](file:///d:/Carrer-hound/reports/prompt8-auth/login-entrance.gif) (Scale 0.98 -> 1.0 at 10 fps).
- **Mobile Drawer Entrance GIF**: [mobile-drawer-entrance.gif](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-drawer-entrance.gif) (Slide-up `translateY(100%)` -> `0%` at 10 fps).

### 4.2. Mobile Captures (390px Viewport):
- **Mobile Login Drawer (390x844)**: [login-mobile.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-mobile.png) (Bottom-anchored drawer, 20px top radii, square bottom, white switch box with 1px border).
- **Mobile Signup Drawer (390x844)**: [signup-mobile.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-mobile.png) (Terms and Privacy Policy line placed below the white switch box).
- **Short Screen Mobile View (390x600)**: [login-mobile-short.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-mobile-short.png) (Vertical scroll with safe-area spacing and visible close control).

### 4.3. Desktop Captures (1280x900):
- **Desktop Login Modal**: [login-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-desktop.png) (Centred 488px card, 24px radius, filled `#F3F4F5` switch box).
- **Desktop Signup Modal**: [signup-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-desktop.png) (Terms line above the switch box).
- **Email Focus State**: [login-focus-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-focus-desktop.png).
- **Error State (Simulated 429)**: [login-error-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-error-desktop.png).
- **Email Sent State (30s Cooldown)**: [login-email-sent-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-email-sent-desktop.png).
- **Signup Error State**: [signup-error-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-error-desktop.png).
- **Signup Email Sent State**: [signup-email-sent-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-email-sent-desktop.png).

### 4.4. Primary Navigation Dual-Mode Sidebar (Preserved from Commit `82aad73`):
- **Narrow Mode (72px Rail)**: [sidebar-narrow-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/sidebar-narrow-desktop.png).
- **Expanded Mode (240px Sidebar)**: [sidebar-expanded-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/sidebar-expanded-desktop.png).
- **Coaching Hover Highlight**: [sidebar-hover-highlight.png](file:///d:/Carrer-hound/reports/prompt8-auth/sidebar-hover-highlight.png).
- **Keyboard Focus State**: [sidebar-keyboard-focus.png](file:///d:/Carrer-hound/reports/prompt8-auth/sidebar-keyboard-focus.png).
- **Mobile Hamburger Drawer**: [mobile-nav-drawer.png](file:///d:/Carrer-hound/reports/prompt8-auth/mobile-nav-drawer.png).

---

## 5. Changed Files Summary

1. [`src/app/login/page.tsx`](file:///d:/Carrer-hound/src/app/login/page.tsx): Responsive mobile bottom drawer (`fixed bottom-0 left-0 right-0 sm:relative sm:bottom-auto`), 20px top radii, square bottom corners, mobile white switch box with 1px `#E5E7EB` border.
2. [`src/app/signup/page.tsx`](file:///d:/Carrer-hound/src/app/signup/page.tsx): Same mobile bottom drawer geometry, mobile white switch box, and Terms/Privacy line placed below switch box on mobile (`sm:hidden`) while staying above switch box on desktop (`hidden sm:block`).
3. [`src/app/globals.css`](file:///d:/Carrer-hound/src/app/globals.css): Added `@keyframes authDrawerEntranceMobile` (translateY 100% to 0%) for mobile drawer entrance and responsive `@media (min-width: 640px)` switch to `@keyframes authModalEntrance`.
4. [`scripts/test-auth-presentation.ts`](file:///d:/Carrer-hound/scripts/test-auth-presentation.ts): Updated assertions and negative control for mobile bottom drawer, corner radii, mobile switch box border, and signup terms placement.
5. [`scripts/test-auth-browser.cjs`](file:///d:/Carrer-hound/scripts/test-auth-browser.cjs): Added browser checks for mobile drawer bottom anchoring (`rect.bottom === 844`), full width (390px, left=0), 20px top / 0px bottom radii, white switch box, mobile terms below switch box, short screen scroll (390x600), and unchanged desktop card/switch box layout.
6. [`scripts/capture-auth-screenshots.cjs`](file:///d:/Carrer-hound/scripts/capture-auth-screenshots.cjs): Enhanced to capture mobile bottom drawer screenshots, short screen check, and mobile slide-up entrance animation GIF (`mobile-drawer-entrance.gif`).
7. [`reports/prompt8-auth/auth-presentation-report.md`](file:///d:/Carrer-hound/reports/prompt8-auth/auth-presentation-report.md): Updated audit and verification documentation.
