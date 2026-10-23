# CM Prompt 8: Jobright Auth Reference Layout & Entrance Motion Correction Report

**Date**: 23 October 2026  
**Branch**: `feat/jobright-auth-presentation`  
**Base Commit**: `d10e408` (`origin/main`, merged PR #75)  
**Pull Request**: [#76](https://github.com/ORM-git/Carrier-hound/pull/76) (Open & Unmerged)  
**Status**: All Tests & Browser Checks Passed (`PASS-LOCAL`)

---

## 1. Executive Summary

In response to the follow-up review for PR #76, the authentication presentation on `/login` and `/signup` was corrected to match the verified Jobright auth modal layout specifications and entrance motion, while strictly preserving CareerMonke's branding and primary blue (`#2563EB`, hover `#1D4ED8`), working Supabase authentication contracts, and existing route integrity.

### Reference Layout Implementations:
1. **Modal Card with Dimmed Backdrop**:
   - Renders a modal-style white card over the existing auth route page with a `fixed inset-0 bg-black/40 z-40` dimmed backdrop.
   - Preserves `<GuideHeader />` and `<Footer />` behind the overlay; direct `/login` and `/signup` URLs remain fully functional without rebuilding landing page content behind them.
2. **Desktop Dimensions (488px / 424px Content)**:
   - Card maximum width: `max-w-[488px]`.
   - Corner radius: `rounded-[24px]` (24px).
   - Desktop padding: 48px top (`sm:pt-[48px]`), 32px sides (`sm:px-[32px]`), 32px bottom (`sm:pb-[32px]`).
   - Inner content width: exactly 424px (`488px - 32px - 32px`).
   - No extra drop shadow (`border border-[#E5E7EB]`).
3. **Mobile Viewport at 390px**:
   - Card outer margins: 8px left and 8px right (`mx-2 sm:mx-auto`), resulting in a 374px wide card on a 390px screen.
   - Compact inner spacing (`pt-8 px-4 pb-5`) instead of blindly retaining desktop padding.
   - Reachable on short screens via `max-h-[calc(100vh-32px)] overflow-y-auto` with zero horizontal overflow (`scrollWidth === clientWidth === 390px`).
4. **Top-Right Dark Circular Close Control**:
   - Accessible dark circular button (`w-8 h-8 rounded-full bg-[#1E293B] text-white`) with `aria-label="Close and return to home"`.
   - Navigates to `/` on click.
   - Full keyboard accessibility: handles `Escape` key to navigate to `/`.
   - Card controls sit at `z-50`, strictly above the `z-40` backdrop so controls are never obstructed.
5. **Headings**:
   - Centred 24px light text with brand bold inline:
     - Login: `Welcome back to <span className="font-bold">CareerMonke</span>`
     - Signup: `Welcome to <span className="font-bold">CareerMonke</span>`
   - Removed subtitle text and inside logo tile; existing header branding retained.
6. **Continue with Google Button**:
   - Full-width, 48px high (`h-[48px]`), white background, 1px `#E5E7EB` border, 8px radius (`rounded-[8px]`).
   - Preserves Google icon SVG and OAuth flow.
7. **Plain Small Grey "OR"**:
   - Centred text `text-[12px] font-normal text-[#9CA3AF] uppercase` with zero horizontal divider lines.
8. **Email Input**:
   - 48px high (`h-[48px]`), `#F7F8F9` background fill, 8px radius (`rounded-[8px]`), 14px text (`text-[14px]`), placeholder `"Email"`.
   - Removed visible uppercase label in favor of accessible `<label className="sr-only">Email</label>`.
   - Clear focus ring: `focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD] focus:bg-white`.
9. **Primary Action Button**:
   - 48px high (`h-[48px]`), 8px radius (`rounded-[8px]`), `#2563EB` fill (hover `#1D4ED8`), white semibold text.
   - Truthful magic-link wording: `"Email me a sign-in link"`.
   - Preserves pending loading spinner and disabled state during submission.
10. **Terms & Privacy Links**:
    - Small centred text below primary action linking to `/terms-and-conditions` and `/privacy-policy`.
11. **Account Switch Box**:
    - Full-width 48px light-grey filled box (`w-full h-[48px] rounded-[8px] bg-[#F3F4F5]`).
    - Regular text with bold blue link (`Sign up` / `Sign in`), no divider above.
    - Preserves bidirectional `?next=` query parameter propagation.

---

## 2. Motion Specification & Verification

### Measured Timing & Curve:
- **Card Entrance**: Timing 0.3s with `cubic-bezier(0.08, 0.82, 0.17, 1)`:
  ```css
  @keyframes authModalEntrance {
    0% {
      opacity: 0;
      transform: scale(0.98);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }

  .animate-auth-modal {
    animation: authModalEntrance 0.3s cubic-bezier(0.08, 0.82, 0.17, 1) forwards;
  }
  ```
- **Backdrop Fade**: 0.25s linear/ease fade (`.animate-auth-backdrop`).
- **Reduced Motion**: Honored via global `@media (prefers-reduced-motion: reduce)` in `src/app/globals.css`, reducing animation duration to `0.01ms`.

### Honest Reference Comparison & Remaining Differences:
- **Verified Match**: The 0.3s duration and `cubic-bezier(0.08, 0.82, 0.17, 1)` easing curve match the reference timing measurements exactly.
- **Scale Factor**: Reference uses subtle scale expansion; `scale(0.98)` to `scale(1.0)` was implemented without claiming that `0.98` was an instrumented reference constant.
- **Backdrop Timing**: Backdrop fade timing was not measured in the reference; our implementation uses a subtle `0.25s` fade-in and we make no claim of pixel- or motion-exact fidelity for the backdrop transition.
- **Third-Party Assets**: Proprietary Jobright mascots, brand marks, and green accents were excluded in favor of CareerMonke's authentic brand tokens (`#2563EB`).

---

## 3. Visual & Interactive Token Specifications

| Element | Verified Reference Spec | CareerMonke Implementation |
| :--- | :--- | :--- |
| **Backdrop** | Dimmed page overlay | `fixed inset-0 bg-black/40 z-40 animate-auth-backdrop` |
| **Card Max Width** | 488px desktop | `w-full max-w-[488px]` |
| **Card Radius** | 24px corner radius | `rounded-[24px]` |
| **Card Padding (Desktop)** | 48px top, 32px sides, 32px bottom | `sm:pt-[48px] sm:px-[32px] sm:pb-[32px]` |
| **Content Width** | 424px desktop | Exactly `424px` (`488 - 32 - 32`) |
| **Mobile Margins (390px)** | 8px outer margins | `mx-2 sm:mx-auto` (width 374px, left/right 8px) |
| **Close Control** | Top-right dark circle, navigates to `/` | `w-8 h-8 rounded-full bg-[#1E293B]`, Esc key support |
| **Control Z-Index** | No backdrop covering controls | Card `z-50` > Backdrop `z-40` |
| **Heading** | 24px light text, brand bold inline | `text-[24px] font-light`, brand in `<span className="font-bold">` |
| **Subtitles / Tile** | Removed inside card | Completely removed; header brand retained |
| **Google Button** | Full width, 48px high, white, 8px radius | `h-[48px] rounded-[8px] border border-[#E5E7EB] bg-white` |
| **Divider** | Plain small grey OR, no horizontal lines | `text-[12px] text-[#9CA3AF] uppercase`, zero divider lines |
| **Email Input** | 48px high, #F7F8F9 fill, 8px radius, "Email" | `h-[48px] rounded-[8px] bg-[#F7F8F9] placeholder="Email"` |
| **Input Focus** | Clear focus ring | `focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD]` |
| **Primary Action** | 48px high, 8px radius, blue, white semibold | `h-[48px] rounded-[8px] bg-[#2563EB] text-white font-semibold` |
| **Legal Text** | Small, centred below primary button | `text-[12px] text-center text-[#6B7280]` |
| **Account Switch** | Full width 48px light-grey box (#F3F4F5) | `h-[48px] rounded-[8px] bg-[#F3F4F5]`, no top divider |
| **Entrance Motion** | 0.3s cubic-bezier(0.08, 0.82, 0.17, 1) | `.animate-auth-modal` fade/scale, reduced motion supported |

---

## 4. Verification Evidence & Test Results

### 4.1. TypeScript & Production Build
- `npx tsc --noEmit`: Exited 0 with zero diagnostic errors.
- `npm run build`: Compiled 40 static pages successfully to `out/`.

### 4.2. Static Spec Audit & Negative Control (`scripts/test-auth-presentation.ts`)
```text
==================================================================================
     PROMPT 8 AUDIT — JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC AUDIT         
==================================================================================
Mode: NORMAL VALIDATION

  [PASS] dimmed backdrop: Dimmed backdrop present over auth route page
  [PASS] card dimensions: White modal card 488px max width, 24px radius, 424px content width, 8px mobile outer margins
  [PASS] close control: Dark circular close button navigating to / with Esc key support
  [PASS] headings: Centred 24px light heading with bold brand inline; extra subtitle and inner logo removed
  [PASS] google button: Full width 48px high, 1px #E5E7EB border, 8px radius with Google icon
  [PASS] plain or: Small grey 'OR' with zero horizontal divider lines
  [PASS] email input: 48px high, #F7F8F9 fill, 8px radius, placeholder 'Email', accessible sr-only label
  [PASS] primary button: 48px high, 8px radius, #2563EB with truthful magic-link text
  [PASS] legal links: Small centred Terms and Privacy Policy links preserved
  [PASS] switch box: Full-width 48px #F3F4F5 box, 8px radius, no divider above, ?next preserved
  [PASS] entrance motion: 0.3s cubic-bezier(0.08,0.82,0.17,1) modal entrance with prefers-reduced-motion support

----------------------------------------------------------------------------------
PROMPT 8 JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC AUDIT [PASS-LOCAL]
----------------------------------------------------------------------------------
```

**Negative Control Validation**:
```text
==================================================================================
NEGATIVE CONTROL PASSED: Deliberately injected corruptions caught 3 errors.
==================================================================================
```

### 4.3. Automated Puppeteer Browser Checks (`scripts/test-auth-browser.cjs`)
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
  [PASS] Account switch box verified: 48px height, 8px radius, text "Don't have an account? Sign up"
  [PASS] Close button verified with accessible name and href="/"
  [PASS] Escape key triggered navigation to "/"
  [PASS] Invalid email validation banner displayed: "Please enter a valid email address."
  [PASS] Simulated auth error banner verified: "Rate limit exceeded. Please wait 60 seconds."
  [PASS] Email-sent state rendered with candidate email address and 30s cooldown timer
  [PASS] 'Use a different email' reset the view back to the input form
  [PASS] Return destination ?next preserved from login to signup: "/signup?next=%2Ftracker"
  [PASS] Signup heading verified: "Welcome to CareerMonke"
  [PASS] Signup to login switch link preserved: "/login?next=%2Fjobs"
  [PASS] Mobile 390px viewport: card width 374px with 8px outer margins (left=8px)
  [PASS] Zero horizontal overflow confirmed (scrollWidth=390, clientWidth=390)

==================================================================================
  ALL JOBRIGHT-STYLE AUTH PRESENTATION BROWSER CHECKS PASSED [PASS-LOCAL]         
==================================================================================
```

### 4.4. Public Shell & Authorization Conformance
- `scripts/test-public-shell.ts`: `PASS-LOCAL` (All 13 assertions passed).
- `scripts/test-a11y-main-landmarks.ts`: `PASS-LOCAL` (Valid `<main>` landmarks present).
- `scripts/test-authz-handlers.ts`: `PASS-LOCAL` (22/22 test cases passed).

---

## 5. Visual Artifacts & Entrance Recording

All visual artifacts captured and stored in `reports/prompt8-auth/`:

### 5.1. Entrance Motion Recording:
- **Animated GIF**: [login-entrance.gif](file:///d:/Carrer-hound/reports/prompt8-auth/login-entrance.gif) (Recorded at 10 fps during 0.3s cubic-bezier entrance with palette optimization via ffmpeg).
- **Interpolation Frames**: `reports/prompt8-auth/entrance-frames/frame_000.png` through `frame_006.png`.

### 5.2. Login Page Captures:
- **Desktop (1280x900)**: [login-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-desktop.png)
- **Mobile (390x844)**: [login-mobile.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-mobile.png)
- **Email Focus State**: [login-focus-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-focus-desktop.png)
- **Error State (Simulated 429)**: [login-error-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-error-desktop.png)
- **Email Sent State (30s Cooldown)**: [login-email-sent-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/login-email-sent-desktop.png)

### 5.3. Signup Page Captures:
- **Desktop (1280x900)**: [signup-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-desktop.png)
- **Mobile (390x844)**: [signup-mobile.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-mobile.png)
- **Error State (Account Exists)**: [signup-error-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-error-desktop.png)
- **Email Sent State**: [signup-email-sent-desktop.png](file:///d:/Carrer-hound/reports/prompt8-auth/signup-email-sent-desktop.png)

---

## 6. Changed Files

1. [`src/app/login/page.tsx`](file:///d:/Carrer-hound/src/app/login/page.tsx): Updated to modal layout, 488px max-width, 24px radius, 48px/32px/32px padding, dimmed backdrop, dark circular close button, 24px light heading with brand bold inline, 48px Google button (8px radius), plain OR, 48px email input, 48px `#2563EB` primary button, small centred legal text, and 48px `#F3F4F5` switch box.
2. [`src/app/signup/page.tsx`](file:///d:/Carrer-hound/src/app/signup/page.tsx): Same layout and token corrections with heading `"Welcome to CareerMonke"`.
3. [`src/app/globals.css`](file:///d:/Carrer-hound/src/app/globals.css): Added `@keyframes authModalEntrance` (0.3s cubic-bezier(0.08, 0.82, 0.17, 1)) and `.animate-auth-modal` / `.animate-auth-backdrop`.
4. [`scripts/test-auth-presentation.ts`](file:///d:/Carrer-hound/scripts/test-auth-presentation.ts): Updated static audit and negative control assertions for modal dimensions, 424px content width, 8px mobile margins, plain OR, input/button heights, and motion definitions.
5. [`scripts/test-auth-browser.cjs`](file:///d:/Carrer-hound/scripts/test-auth-browser.cjs): Updated headless Puppeteer test suite to measure card geometry, backdrop z-index, close button, Esc key navigation, input focus, mocked error/sent states, ?next preservation, and 390px mobile viewport margins.
6. [`scripts/capture-auth-screenshots.cjs`](file:///d:/Carrer-hound/scripts/capture-auth-screenshots.cjs): Enhanced screenshot and entrance motion recording generator with ffmpeg GIF compilation.
