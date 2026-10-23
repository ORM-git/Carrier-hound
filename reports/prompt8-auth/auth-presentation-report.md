# CM Prompt 8: Jobright-Style Login & Signup Presentation Rebuild Report

**Date**: 23 October 2026  
**Branch**: `feat/jobright-auth-presentation`  
**Base Commit**: `d10e408` (`origin/main`, including merged PR #75)  
**Status**: Completed, Verified & Ready for PR Review (`PASS-LOCAL`)

---

## 1. Executive Summary

As part of Prompt 8 of the CareerMonke Jobright-style UI rebuild, the authentication presentation on `/login` and `/signup` was overhauled to mirror Jobright's modern, focused auth card presentation while strictly preserving CareerMonke's existing branding, color tokens (`#2563EB`, hover `#1D4ED8`), and production Supabase authentication mechanics.

### Key Deliverables:
1. **Centred Auth Card**: Sized at `max-w-[460px]` with `rounded-[24px]` radius, subtle border (`#E2E8F0`), and `p-8 sm:p-10` desktop padding on a clean `bg-blue-50` backdrop.
2. **Standardized Brand Headers**: Centred brand icon (`BrandIcon`) with exact typography:
   - Login: `Welcome back to CareerMonke`
   - Signup: `Create your CareerMonke account`
3. **Pill-Style Continue with Google Button**: White rounded pill (`rounded-full`, `min-h-[44px]`) with preserved multi-color Google SVG logo.
4. **Subtle OR Divider**: Centred uppercase neutral text (`#64748B`) over thin horizontal hairline (`#E2E8F0`).
5. **Neutral Email Input & Focus States**: Neutral background (`#F8FAFC`), `rounded-[12px]`, clear label, `min-h-[44px]`, with `ring-2 ring-[#93C5FD]` focus indicator.
6. **Primary Pill Submit Action**: Full-width `#2563EB` pill button (`rounded-full`, `min-h-[44px]`) with text `Email me a sign-in link`.
7. **Readable Error & State Notifications**:
   - Error banner: `bg-[#FEF2F2] border-[#FECACA] text-[#B91C1C]` with `role="alert"`.
   - Sent state: `bg-[#F0FDF4] border-[#BBF7D0] text-[#166534]` with 30-second resend cooldown timer and `Use a different email` reset action.
8. **Destination Query Preservation**: Full bidirectional `?next=` preservation between login and signup switch links.
9. **Accessibility & Responsive Integrity**: Fully responsive with zero horizontal overflow at 390px mobile viewport, `<main id="main-content">` landmark maintained, and `<GuideHeader />` / `<Footer />` preserved.

---

## 2. Authentication Contract & Security Map

No authentication contracts, API routes, or database configurations were modified. CareerMonke's security rules were strictly adhered to:
- **Email Magic Link OTP**: Triggered via `supabase.auth.signInWithOtp` with email redirect target `${getSiteUrl()}/auth/callback?next=${encodeURIComponent(next)}`.
- **Google OAuth**: Triggered via `supabase.auth.signInWithOAuth` with `redirectTo: ${getSiteUrl()}/auth/callback?next=${encodeURIComponent(next)}`.
- **Zero Insecure Additions**: No password fields, unbacked third-party OAuth providers (e.g. Apple/GitHub), or unauthenticated mock logins.
- **Return URL Sanitization**: All incoming `?next=` parameters are validated through `getValidReturnUrl(rawNext, defaultUrl)` before redirecting, preventing open-redirect vulnerabilities.
- **Accurate Legal Text**: Clear disclaimers linking directly to `/terms-and-conditions` and `/privacy-policy` without false claims regarding billing or access.

---

## 3. Visual & Interactive Token Specifications

| UI Element | Specification / Token | Implementation Class / Attribute |
| :--- | :--- | :--- |
| **Backdrop** | Soft light blue canvas | `bg-blue-50 min-h-screen` |
| **Card Max Width** | 440px – 470px centred | `w-full max-w-[460px] mx-auto` |
| **Card Corner Radius** | 24px curved surface | `rounded-[24px]` |
| **Card Padding** | 32px – 40px desktop, 16px mobile | `p-8 sm:p-10`, container `px-4` |
| **Card Border** | 1px subtle line | `border border-[#E2E8F0]` |
| **Google Button** | White pill, subtle border, min 44px | `rounded-full border border-[#CBD5E1] bg-white min-h-[44px]` |
| **Divider** | Centred hairline with neutral badge | `border-t border-[#E2E8F0]`, `text-[#64748B]` |
| **Email Input** | Neutral fill, 12px radius, min 44px | `bg-[#F8FAFC] rounded-[12px] border-[#CBD5E1] min-h-[44px]` |
| **Input Focus Ring** | Blue accent highlight | `focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD]` |
| **Submit Button** | Blue pill, white text, min 44px | `bg-[#2563EB] hover:bg-[#1D4ED8] rounded-full min-h-[44px]` |
| **Error Banner** | Red tinted container with alert role | `bg-[#FEF2F2] border-[#FECACA] text-[#B91C1C] role="alert"` |
| **Success Banner** | Green tinted confirmation box | `bg-[#F0FDF4] border-[#BBF7D0] text-[#166534]` |
| **Switch Links** | Neutral text with blue link | `text-[#64748B]` with `text-[#2563EB] font-bold underline` |

---

## 4. Verification Evidence & Test Results

### 4.1. Static Specification & Negative Control Audit (`scripts/test-auth-presentation.ts`)
```text
==================================================================================
     PROMPT 8 AUDIT — JOBRIGHT-STYLE LOGIN & SIGNUP PRESENTATION AUDIT            
==================================================================================
Mode: NORMAL VALIDATION

  [PASS] page background: Blue-50 background present on both /login and /signup
  [PASS] card dimensions: White auth card ~460px max width, 24px radius, 32-40px desktop padding
  [PASS] branding & headings: Centred CareerMonke logo, exact requested login and signup headings
  [PASS] google button: Working Continue with Google rounded pill button with preserved SVG asset
  [PASS] divider: Centred neutral OR divider with thin border line
  [PASS] email input: Subtle neutral background (#F8FAFC), 12px radius, visible focus, min-h-[44px]
  [PASS] submit pill: Full-width blue primary pill (#2563EB) 'Email me a sign-in link'
  [PASS] error banner: Readable red-tinted alert banner with role='alert'
  [PASS] email-sent state: Verified confirmation instructions with 30s resend cooldown
  [PASS] switch links: Separated by divider, preserves ?next return-destination parameter
  [PASS] auth security: Strictly email OTP & Google OAuth only; zero password or unbacked claims

----------------------------------------------------------------------------------
PROMPT 8 JOBRIGHT-STYLE AUTH PRESENTATION VALIDATED LOCALLY [PASS-LOCAL]
----------------------------------------------------------------------------------
```

**Negative Control Validation**:
```text
==================================================================================
NEGATIVE CONTROL PASSED: Deliberately injected corruptions caught 4 errors.
==================================================================================
```

### 4.2. Puppeteer End-to-End Browser Check (`scripts/test-auth-browser.cjs`)
```text
==================================================================================
     AUTOMATED BROWSER CHECKS: LOGIN & SIGNUP AUTH PRESENTATION & FLOWS          
==================================================================================

[PASS] Mock static server listening on http://localhost:3458
  [PASS] Desktop login card dimensions: width 460px, radius 24px
  [PASS] Login heading verified: "Welcome back to CareerMonke"
  [PASS] Invalid email validation banner displayed: "Please enter a valid email address."
  [PASS] Simulated auth error banner verified: "Rate limit exceeded. Please wait 60 seconds."
  [PASS] Email-sent state rendered with candidate email address and resend cooldown
  [PASS] 'Use a different email' reset the auth view back to input form
  [PASS] Return destination preserved in switch link: "/signup?next=%2Ftracker"
  [PASS] Signup heading verified: "Create your CareerMonke account"
  [PASS] Signup to login switch link preserved: "/login?next=%2Fjobs"
  [PASS] Mobile 390px viewport: zero horizontal overflow (scrollWidth=390, clientWidth=390)

==================================================================================
  ALL AUTH PRESENTATION & INTERACTION BROWSER CHECKS PASSED [PASS-LOCAL]          
==================================================================================
```

### 4.3. TypeScript & Static Production Export
- `npx tsc --noEmit`: Exited with code `0` (Zero compiler diagnostic errors).
- `npm run build`: Compiled 40 static pages successfully to `out/` with zero hydration mismatch warnings.

### 4.4. Regression Suite Conformance
- `scripts/test-public-shell.ts`: `PASS-LOCAL` (13/13 assertions passed).
- `scripts/test-a11y-main-landmarks.ts`: `PASS-LOCAL` (All 5 pages have valid `<main>` landmarks).
- `scripts/test-authz-handlers.ts`: `PASS-LOCAL` (22/22 test cases passed with 100% authorization conformance).

---

## 5. Captured Screenshots

All screenshots captured directly via headless Chrome under Puppeteer:

### 5.1. Login Screen
- **Desktop (1280x900)**: `reports/prompt8-auth/login-desktop.png`
- **Mobile (390x844)**: `reports/prompt8-auth/login-mobile.png`
- **Input Focus State**: `reports/prompt8-auth/login-focus-desktop.png`
- **Validation/Error Banner**: `reports/prompt8-auth/login-error-desktop.png`
- **Email-Sent State (Cooldown Active)**: `reports/prompt8-auth/login-email-sent-desktop.png`

### 5.2. Signup Screen
- **Desktop (1280x900)**: `reports/prompt8-auth/signup-desktop.png`
- **Mobile (390x844)**: `reports/prompt8-auth/signup-mobile.png`
- **Error Banner**: `reports/prompt8-auth/signup-error-desktop.png`
- **Email-Sent State**: `reports/prompt8-auth/signup-email-sent-desktop.png`

---

## 6. Explicit Reference Limitations

In accordance with project instructions:
1. **Third-Party Mascot & Marketing Assets**: Proprietary Jobright mascots, illustrations, and third-party marketing imagery were strictly omitted. CareerMonke's authentic brand logo (`BrandIcon`) and color palette (`#2563EB`) were used.
2. **Authentication Modality**: CareerMonke supports Supabase passwordless email OTP and Google OAuth. No mock password forms, passkeys, or unsupported third-party login providers were added.
