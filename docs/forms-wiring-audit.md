# Form Wiring Verification Audit

This document records the comprehensive frontend wiring verification audit conducted across all form surfaces that mutate data within CareerMonke.

## Audit Scope & Standards

Every form surface performing state mutations or external API mutations was evaluated against three core operational criteria:
1. **(a) Submit Control Disabled & Pending State**: When a mutation or submission request is in-flight, the triggering control (submit button) must disable further interaction (`disabled` attribute) and display a visual pending indicator (spinner icon, loading label, or reduced opacity).
2. **(b) Resume Upload Progress Bar Wiring**: File upload flows must wire the existing accessible progress component (`ProgressBar` from `src/components/ui/progress-bar.tsx`) to convey document upload and processing progress to the user.
3. **(c) Failed Mutation Retry Affordance**: When a mutation fails (network error, API rejection, validation failure), the UI must surface an actionable retry affordance (e.g., an explicit "Retry" button or direct resend action) allowing the user to recover without reloading the page or losing input data.

Per project guidelines, this batch is **audit-only**. Gaps identified below are cataloged with exact `file:line` locations for future UI remediation; no visual layouts or component diffs were introduced.

---

## Form-by-Form Audit Results

### 1. Login (`src/app/login/page.tsx`)
- **Mutating Actions**: `handleEmailSubmit` (Magic link OTP dispatch via Supabase Auth) and `handleGoogle` (OAuth provider initialization).
- **Criterion (a) Submit Control Disabled / Pending**:
  - Email Submit Button (`src/app/login/page.tsx:308-322`):
    - `disabled={loading || googleLoading}` is properly bound.
    - Pending state renders `<Loader2 className="w-4 h-4 animate-spin text-white" />` and label `"Sending link…"`.
    - **Status**: **WIRED (PASS)**
  - Google OAuth Button (`src/app/login/page.tsx:258-275`):
    - `disabled={googleLoading || loading}` is properly bound.
    - Pending state renders `<Loader2 className="w-4 h-4 animate-spin text-[#64748B]" />` and label `"Connecting to Google…"`.
    - **Status**: **WIRED (PASS)**
- **Criterion (b) Resume Upload Progress Bar**:
  - Not applicable to authentication forms.
  - **Status**: **N/A**
- **Criterion (c) Failed Mutation Retry Affordance**:
  - Resend Magic Link (`src/app/login/page.tsx:232-242`):
    - When `emailSent` is true, an explicit resend button `<RefreshCw />` with a 30-second cooldown is provided.
    - **Status**: **WIRED (PASS)**
  - Direct Submit Error Alert (`src/app/login/page.tsx:204-214`):
    - When `error` is populated, an alert banner (`role="alert"`) displays the error text.
    - **Gap**: The error banner lacks an inline "Retry" button; recovery requires manual re-clicking of the primary submit button.
    - **Status**: **GAP** at `src/app/login/page.tsx:204-214`

---

### 2. Signup (`src/app/signup/page.tsx`)
- **Mutating Actions**: `handleEmailSubmit` (Sign-up magic link dispatch) and `handleGoogle` (Google OAuth registration).
- **Criterion (a) Submit Control Disabled / Pending**:
  - Email Submit Button (`src/app/signup/page.tsx:302-316`):
    - `disabled={loading || googleLoading}` is properly bound.
    - Pending state renders `<Loader2 className="w-4 h-4 animate-spin text-white" />` and label `"Sending link…"`.
    - **Status**: **WIRED (PASS)**
  - Google OAuth Button (`src/app/signup/page.tsx:252-269`):
    - `disabled={googleLoading || loading}` is properly bound.
    - Pending state renders `<Loader2 className="w-4 h-4 animate-spin text-[#64748B]" />` and label `"Connecting to Google…"`.
    - **Status**: **WIRED (PASS)**
- **Criterion (b) Resume Upload Progress Bar**:
  - Not applicable to authentication forms.
  - **Status**: **N/A**
- **Criterion (c) Failed Mutation Retry Affordance**:
  - Direct Signup Error Alert (`src/app/signup/page.tsx:198-208`):
    - When `error` is set, `<div role="alert" id="signup-error-msg">` displays the error message.
    - **Gap**: No explicit retry affordance is present inside the notification banner.
    - **Status**: **GAP** at `src/app/signup/page.tsx:198-208`

---

### 3. Settings (`src/app/settings/page.tsx`)
- **Mutating Actions**:
  - `handleSavePreferences` (Preferences & Notifications save to Supabase / localStorage)
  - `handleCancelSubscription` (Stripe/Razorpay subscription renewal cancellation)
  - `handleDeleteResume` (Candidate profile facts purge)
  - `handleDeleteAccount` (Account deletion via `/api/account/delete`)
- **Criterion (a) Submit Control Disabled / Pending**:
  - Target Job Preferences Save Button (`src/app/settings/page.tsx:430-437`):
    - Form `<button type="submit">` lacks `disabled` binding and lacks a pending spinner during `saveUserPreferences`.
    - **Status**: **GAP** at `src/app/settings/page.tsx:430-437`
  - Notification Settings Save Button (`src/app/settings/page.tsx:471-479`):
    - `<button type="button" onClick={handleSavePreferences}>` lacks `disabled` binding and lacks pending feedback during save.
    - **Status**: **GAP** at `src/app/settings/page.tsx:471-479`
  - Delete Account Button (`src/app/settings/page.tsx:606-614`):
    - `<button type="button" onClick={handleDeleteAccount}>` has no `disabled={isDeleting}` or loading indicator while the asynchronous deletion fetch is running.
    - **Status**: **GAP** at `src/app/settings/page.tsx:606-614`
- **Criterion (b) Resume Upload Progress Bar**:
  - Not applicable to settings forms.
  - **Status**: **N/A**
- **Criterion (c) Failed Mutation Retry Affordance**:
  - Preferences Save (`src/app/settings/page.tsx:88-106`):
    - `handleSavePreferences` lacks a `try / catch` block; unhandled promise rejections are not surfaced in the UI.
    - **Status**: **GAP** at `src/app/settings/page.tsx:88-106`
  - Delete Account (`src/app/settings/page.tsx:188-204`):
    - Failed responses dispatch a generic `toast.error`, but provide no inline retry button.
    - **Status**: **GAP** at `src/app/settings/page.tsx:188-204`

---

### 4. Resume Upload & Fact Confirmation (`src/components/resume/ResumeUploadAndConfirm.tsx` / `src/app/resume/page.tsx`)
- **Mutating Actions**:
  - `processFile`: Local text extraction (`extractTextFromFile`) + rule-based parser (`parseResumeText`) + Groq AI extraction (`extractResumeFactsWithGroq`).
  - `handleSaveConfirmedProfile`: Commits confirmed candidate facts to local storage and Supabase database.
- **Criterion (a) Submit Control Disabled / Pending**:
  - Dropzone Parsing State (`src/components/resume/ResumeUploadAndConfirm.tsx:417-432`):
    - When `isParsing` is true, displays `<RefreshCw className="w-6 h-6 animate-spin" />` and `"Parsing Document Facts..."`.
    - **Status**: **WIRED (PASS)**
  - Profile Save Buttons (`src/components/resume/ResumeUploadAndConfirm.tsx:590-596` and `1026-1038`):
    - `disabled={isSaving}` is bound to both top and bottom save controls.
    - Text alternates between `"Save Edits Now"` / `"Confirm Facts & Save Profile"` and `"Saving..."` / `"Saving Profile..."`.
    - **Status**: **WIRED (PASS)**
- **Criterion (b) Resume Upload Progress Bar**:
  - The repository contains an accessible, determinate `ProgressBar` component (`src/components/ui/progress-bar.tsx`) supporting ARIA progress values and tone styling.
  - **Gap**: `ResumeUploadAndConfirm.tsx` does NOT import or render `ProgressBar`. It currently relies on an indeterminate spinning icon (`RefreshCw`).
  - **Status**: **GAP** at `src/components/resume/ResumeUploadAndConfirm.tsx:417-432`
- **Criterion (c) Failed Mutation Retry Affordance**:
  - Document Parse Failure (`src/components/resume/ResumeUploadAndConfirm.tsx:434-451`):
    - When `parseError` is set, an alert card renders an explicit `<button ...>Retry Upload</button>` that triggers `fileInputRef.current?.click()`.
    - **Status**: **WIRED (PASS)**
  - Save Confirmed Profile Failure (`src/components/resume/ResumeUploadAndConfirm.tsx:358-362`):
    - The `catch (err)` block logs via `console.warn` without setting an error state or displaying a retry affordance.
    - **Status**: **GAP** at `src/components/resume/ResumeUploadAndConfirm.tsx:358-362`

---

### 5. Tracker Actions (`src/app/tracker/page.tsx`)
- **Mutating Actions**:
  - `handleCreateApplication` (Manual application creation dialog)
  - `handleSaveNotes` (Application notes update dialog)
  - `handleDrop` / `handleStageSelect` (Kanban column transitions)
  - `handleDelete` (Application deletion)
- **Criterion (a) Submit Control Disabled / Pending**:
  - Add Application Modal Submit Button (`src/app/tracker/page.tsx:1009-1014`):
    - The `<button type="submit">Save Application</button>` lacks a `disabled` attribute or pending spinner during async creation.
    - **Status**: **GAP** at `src/app/tracker/page.tsx:1009-1014`
  - Notes Editor Save Button (`src/app/tracker/page.tsx:1063-1069`):
    - The `<button type="button" onClick={handleSaveNotes}>Save Notes</button>` lacks a `disabled` attribute or pending spinner.
    - **Status**: **GAP** at `src/app/tracker/page.tsx:1063-1069`
- **Criterion (b) Resume Upload Progress Bar**:
  - Not applicable to application tracking.
  - **Status**: **N/A**
- **Criterion (c) Failed Mutation Retry Affordance**:
  - Application Creation Failure (`src/app/tracker/page.tsx:249-251`):
    - Dispatches `toast.error("Failed to add application.")` with no inline retry action.
    - **Status**: **GAP** at `src/app/tracker/page.tsx:249-251`
  - Notes Update Failure (`src/app/tracker/page.tsx:210-213`):
    - Dialog closes optimistically (`setActiveNotesApp(null)` on line 205); failed updates display toast only.
    - **Status**: **GAP** at `src/app/tracker/page.tsx:210-213`
  - Stage Movement Failure (`src/app/tracker/page.tsx:161-164`, `174-177`):
    - Optimistic revert with toast notice; no inline retry button.
    - **Status**: **GAP** at `src/app/tracker/page.tsx:161-164` and `src/app/tracker/page.tsx:174-177`
  - Delete Application Failure (`src/app/tracker/page.tsx:186-189`):
    - Toast error with reload; no retry affordance.
    - **Status**: **GAP** at `src/app/tracker/page.tsx:186-189`

---

## Summary Gap Matrix

| Form / Surface | Action | (a) Submit Control Disabled / Pending | (b) Progress Bar Wired | (c) Retry Affordance | File & Line Reference |
|---|---|---|---|---|---|
| **Login** | Email & Google Magic Auth | WIRED | N/A | GAP (Direct banner) | `src/app/login/page.tsx:204-214` |
| **Login** | Resend Magic Link | WIRED | N/A | WIRED | `src/app/login/page.tsx:232-242` |
| **Signup** | Email & Google Signup | WIRED | N/A | GAP (Direct banner) | `src/app/signup/page.tsx:198-208` |
| **Settings** | Save Target Preferences | GAP | N/A | GAP | `src/app/settings/page.tsx:430-437`, `88-106` |
| **Settings** | Save Notifications | GAP | N/A | GAP | `src/app/settings/page.tsx:471-479`, `88-106` |
| **Settings** | Delete Account | GAP | N/A | GAP | `src/app/settings/page.tsx:606-614`, `188-204` |
| **Resume Upload** | Document Parse | WIRED | GAP (Indeterminate spinner only) | WIRED (Retry button) | `src/components/resume/ResumeUploadAndConfirm.tsx:417-451` |
| **Resume Upload** | Save Confirmed Profile | WIRED | N/A | GAP (Console only) | `src/components/resume/ResumeUploadAndConfirm.tsx:358-362` |
| **Tracker** | Create Application Modal | GAP | N/A | GAP | `src/app/tracker/page.tsx:1009-1014`, `249-251` |
| **Tracker** | Save Notes Modal | GAP | N/A | GAP | `src/app/tracker/page.tsx:1063-1069`, `210-213` |
| **Tracker** | Stage Transitions & Delete | Optimistic | N/A | GAP | `src/app/tracker/page.tsx:161-189` |
