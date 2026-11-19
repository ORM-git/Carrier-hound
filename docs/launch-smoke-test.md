# Launch Smoke Test: Automated Verification & Manual Operator Runbook

> **Automated Probe Script**: `scripts/launch-smoke-test.ts`  
> **Execution Command**: `npx tsx scripts/launch-smoke-test.ts [baseUrl] [--json]`  
> **Safety Guarantee**: 100% Read-Only — No logins, no payments, no writes, no secrets. 10s timeout per request.

---

## 1. Overview & Launch Readiness Workflow

The CareerMonke launch gate combines an **automated read-only HTTP probe** with a **3-step manual operator verification checklist**.

```
  +-------------------------------------------------------------------------+
  | STEP 1: Run Automated HTTP Probe                                        |
  | Command: npx tsx scripts/launch-smoke-test.ts https://careermonke.com   |
  +-------------------------------------------------------------------------+
                                     |
                                     v
  +-------------------------------------------------------------------------+
  | STEP 2: Execute Manual Operator Checks (Post-Script)                    |
  | 1. Login with Google (OAuth callback & session persistence)             |
  | 2. Mobile 390px Onboarding (Step 1 roles, location, responsive layout)  |
  | 3. Profile Enrichment (Step 2 LinkedIn validation & private resume)     |
  +-------------------------------------------------------------------------+
                                     |
                                     v
  +-------------------------------------------------------------------------+
  | STEP 3: Sign-Off & Launch Gate Decision                                 |
  +-------------------------------------------------------------------------+
```

---

## 2. Automated Smoke Probe (`scripts/launch-smoke-test.ts`)

### Usage

```bash
# Run against production default (https://careermonke.com)
npx tsx scripts/launch-smoke-test.ts

# Run against a specific deployment (preview or staging)
npx tsx scripts/launch-smoke-test.ts https://carrier-hound.pages.dev

# Machine-readable JSON output
npx tsx scripts/launch-smoke-test.ts --json
```

### The 7 Automated Checks

| # | Check Name | Target Endpoint | Method | Assertion Criteria |
| :-: | :--- | :--- | :-: | :--- |
| **1** | **Public Pages Availability** | `/`, `/pricing`, `/jobs`, `/privacy`, `/terms-and-conditions`, `/refund-policy` | `GET` | Every route returns HTTP 200 without error or crash page. |
| **2** | **WWW Host Redirection** | `https://www.careermonke.com/` | `GET` (manual) | Returns HTTP 301 redirect with `Location` pointing to apex origin (`https://careermonke.com/`). |
| **3** | **Security Headers** | `/` (apex root) | `GET` | Presence of `Strict-Transport-Security` (HSTS), `X-Content-Type-Options: nosniff`, Frame Protection (`X-Frame-Options: DENY` or CSP `frame-ancestors`), and `Content-Security-Policy`. |
| **4** | **Jobs API Gating & Feed** | `/api/jobs/search?pageSize=10` & `/api/jobs/pro` | `GET` | Public `/api/jobs/search` returns HTTP 200 and a non-empty `jobs` JSON array. Protected `/api/jobs/pro` rejects unauthenticated requests with HTTP 401 or 403. |
| **5** | **Pricing Page Copy** | `/pricing` | `GET` | Checks **visible text only** (scripts, styles, asset URLs and hidden elements are stripped). Must show `₹399`, `₹499` and `₹2,199` as whole numbers and must not show `692`, `799` (whole numbers) or `"first month"`. Any auto-renew mention must be a denial ("do not auto-renew"); questions such as "Does my plan renew automatically?" are allowed. The 10s timeout covers the body read. Mock tests: `scripts/test-launch-smoke-pricing-probe.ts`. |
| **6** | **Search Engine Files** | `/robots.txt` & `/sitemap.xml` | `GET` | Both endpoints respond with HTTP 200. |
| **7** | **Razorpay Order Gating** | `/api/billing/razorpay/order` | `POST` (`{ "plan": "weekly" }`) | Unauthenticated request is strictly rejected with HTTP 401 or 403. Pure auth-gating check: no orders created, no checkout modals opened, no credentials sent. |

---

## 3. Manual Operator Verification Runbook (Post-Script)

Execute these three human verification steps in a clean browser session (Incognito/Private Browsing) immediately following the automated script.

---

### Manual Check 1: Login with Google

**Objective**: Verify end-to-end OAuth authentication, token exchange, and authenticated session establishment.

1. **Open a fresh Incognito window**:
   - Navigate to `https://careermonke.com/login` (or click "Sign In" from the header).
2. **Initiate Google Sign-In**:
   - Click the **"Continue with Google"** button.
   - Verify redirection to Google's OAuth consent screen (`accounts.google.com`).
   - Authenticate with a test or staging Google account.
3. **Verify OAuth Callback**:
   - Observe automatic redirect to `https://careermonke.com/auth/callback`.
   - Confirm seamless session initialization without stranded tokens in the URL hash.
4. **Verify Session State & Routing**:
   - First-time user: Redirected to `/onboarding`.
   - Returning user: Redirected to `/dashboard` or `/jobs`.
   - Open Browser DevTools (`F12`) -> **Application** -> **Cookies**:
     - Verify Supabase session cookies (`sb-*-auth-token`) are set with `Secure`, `HttpOnly` or proper storage flags.
   - Header should display user avatar / initials and account navigation.

---

### Manual Check 2: Mobile 390px Onboarding Flow

**Objective**: Ensure the mobile onboarding flow (PR #653) renders flawlessly at 390px viewport width (iPhone standard) without horizontal overflow or tap-target issues.

1. **Configure Mobile Viewport**:
   - Open Chrome DevTools (`F12` / `Ctrl+Shift+I`).
   - Toggle **Device Toolbar** (`Ctrl+Shift+M`).
   - Select **iPhone 12 / 13 / 14 / 15** or manually enter dimensions: **390 x 844 px** at 100% zoom.
2. **Access Onboarding Step 1**:
   - Navigate to `https://careermonke.com/onboarding`.
3. **Evaluate Layout & UX**:
   - [ ] **No Horizontal Overflow**: Verify `document.documentElement.scrollWidth <= window.innerWidth` (no horizontal scrollbar appears).
   - [ ] **Role Selection**: Type in role search input; verify autocomplete pill selection works smoothly on touch emulation.
   - [ ] **Location Preferences**: Toggle country/remote preferences; verify selections update instantly.
   - [ ] **Job Types**: Tap through employment type chips (Full-time, Contract, Internship, Remote); ensure minimum tap target size (>= 44x44px).
   - [ ] **Bottom Action Bar**: Verify the "Continue" / "Next" button remains accessible and does not overlap content or virtual navigation bars.
4. **Proceed**:
   - Click **"Continue"** to transition to Step 2.

---

### Manual Check 3: Profile Enrichment (Resume & LinkedIn Steps)

**Objective**: Verify Onboarding Step 2 (PR #655) input validation for LinkedIn profile URLs and private resume file uploads.

1. **LinkedIn Profile URL Validation**:
   - In the LinkedIn Profile input field:
     - Enter an invalid or malicious URL: `https://facebook.com/user` or `javascript:alert(1)`.
     - Verify immediate client-side error indication ("Please enter a valid LinkedIn profile URL: https://linkedin.com/in/...").
     - Enter a valid LinkedIn URL: `https://www.linkedin.com/in/alex-developer`.
     - Verify green success state / validation cleared.
2. **Private Resume Upload**:
   - **Supported File Formats**:
     - Drag-and-drop or browse to select a sample resume (`.pdf` or `.docx`).
     - Verify file name, size, and preview icon display.
   - **Size Limit Enforcement**:
     - Attempt to upload a test file > 5MB.
     - Verify client-side rejection banner ("File exceeds 5MB limit").
   - **Upload & Storage Isolation**:
     - Upload an accepted `.pdf` file (< 5MB).
     - Verify upload progress indicator reaches 100% and displays success checkmark.
     - Confirm resume is saved to private Supabase storage bucket (`resumes/`) guarded by Row Level Security (RLS) — not publicly accessible.
3. **Complete Onboarding**:
   - Click **"Finish Setup"** / **"Go to Dashboard"**.
   - Verify navigation to `/jobs` or `/dashboard` with personalised job recommendations active.

---

## 4. Launch Sign-Off Gate Matrix

All automated checks and manual checklists must satisfy the pass criteria before opening production traffic:

| Gate Component | Status Required | Action on Failure |
| :--- | :---: | :--- |
| **Automated Checks 1, 3, 4, 6, 7** | **PASS** | Block release. Investigate edge routing, CSP headers, or auth regression. |
| **Automated Check 2 (WWW 301)** | **PASS** | Configure Cloudflare Redirect Rule: `*www.careermonke.com/*` -> `https://careermonke.com/$2` (301 Permanent). |
| **Automated Check 5 (Pricing Copy)** | **PASS** | Verify `/pricing` renders 399, 499, 2199 prepaid non-auto-renew copy. |
| **Manual Check 1 (Google Login)** | **PASS** | Check Google Cloud Console OAuth redirect URI whitelist (`https://careermonke.com/auth/callback`). |
| **Manual Check 2 (Mobile 390px)** | **PASS** | Fix CSS padding / flex wrap in onboarding step 1 container. |
| **Manual Check 3 (LinkedIn/Resume)** | **PASS** | Fix regex validator or check Supabase `resumes` bucket RLS policies. |
