# Jobright-Style Profile Page & Edit Drawers Rebuild Report (Prompt 7)

## 1. Overview & Architecture Inspection

### Inspection of Existing Profile Implementation
- **Profile Data Contract**: The profile model is defined by `CandidateProfile` in `src/lib/resume/types.ts`:
  - `name`: Full name
  - `email`, `phone`, `location`: Contact details
  - `headline`: Professional title/role
  - `summary`: Bio/summary
  - `skills`: Core technical & professional competencies (`string[]`)
  - `experience`: Array of `WorkExperienceItem` (`id`, `company`, `role`, `startDate`, `endDate`, `location`, `bullets`)
  - `education`: Array of `EducationItem` (`id`, `degree`, `institution`, `year`, `fieldOfStudy`)
  - `certifications`: Array of strings (`string[]`)
- **Database Schema & Persistence**:
  - Supabase table `candidate_profiles` stores all fields via `saveConfirmedCandidateProfile(profile)` in `src/lib/resume/storage.ts`.
  - Upsert payload targets `user_id`, `name`, `email`, `phone`, `headline`, `summary`, `skills`, `experience_json`, `education_json`, `certifications`, `raw_resume_text`, `confirmed_at`, `updated_at`, and `location`.
  - All 4 supported profile sections (**Personal**, **Education**, **Work Experience**, **Skills**) map directly to persistent database columns. No schema migrations or new database fields were required.
  - **Save Failure Behavior**: When Supabase is unavailable, network fails, or credentials error, `saveConfirmedCandidateProfile` throws an error. The edit drawer catches the error, displays an inline alert (`role="alert"`), keeps the drawer open, preserves all of the user's edits in the local draft, and strictly avoids emitting any success messages or toasts.

---

## 2. Rebuilt Components & Pages

### 1. `src/app/profile/page.tsx`
- **Shell**: Wrapped in `LoggedInAppShell` with `pageLabel="PROFILE"`.
- **Layout**: Centred 2-column grid (`max-w-6xl mx-auto px-4 sm:px-6 py-6 md:py-8 grid grid-cols-1 lg:grid-cols-12 gap-6`), collapsing to single-column on mobile screens.
- **Section Tabs**: Supported sections (**Personal**, **Education**, **Work Experience**, **Skills**). Underlined active tab (`after:h-[2px] after:bg-[#0F172A]`), 14px font, minimum 44px touch targets. Clicking a tab updates state and smoothly scrolls to the section card. Zero unsupported sections.
- **Header Card**:
  - Full name in bold 20-24px `#0F172A`.
  - User avatar with initial on `#2563EB`.
  - Working edit pencil button (`data-testid="edit-header-btn"`) opening the Personal edit drawer.
  - Contact chips conditioned strictly on actual stored, non-empty values (`candidate.email`, `candidate.phone`, `candidate.location`).
  - Zero invented privacy claims.
- **Section Cards**:
  - White surfaces, 16px radius (`rounded-2xl`), 1px `#E2E8F0` border, 20-24px padding.
  - **Personal**: Summary or honest empty state ("No professional summary provided yet.") with "+ Add summary" action.
  - **Work Experience**: Timeline treatment with vertical `#E2E8F0` line, circular `#2563EB` dot nodes, bold role titles, company names, dates, locations, and achievements. Honest empty state when empty.
  - **Education**: Timeline treatment with vertical `#E2E8F0` line, circular `#2563EB` dot nodes, degree, institution, year, and field of study. Honest empty state when empty.
  - **Skills**: Wrapped chips with `#EFF6FF` background, `#1D4ED8` text, `#BFDBFE` border. Honest empty state when empty.
- **Right Rail**:
  - **Profile Strength Card**: Real completion percentage calculated dynamically across Personal, Experience, Education, and Skills. If incomplete, renders an alert banner and actionable checklist where clicking "Add" opens that specific section's edit drawer. If complete, renders a 100% green check state.
  - **Quick Links Card**: Strictly routes to existing internal pages: `/resume`, `/tracker`, `/jobs`, `/settings`. Zero external referrals, zero autofill extensions.

### 2. `src/components/profile/ProfileDrawers.tsx`
- Full-height slide-over modal drawer (`fixed inset-0 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[500px] md:w-[560px]`).
- Full-screen on mobile viewports (`inset-0`).
- **Focus Trap**: Traps keyboard focus between interactive elements on `Tab` and `Shift+Tab`.
- **Keyboard Dismissal**: Closes drawer on `Escape` key press.
- **Focus Restoration**: Restores focus to the triggering edit pencil button upon closure.
- **Background Interaction Lock**: Locks body scroll (`document.body.style.overflow = "hidden"`) and overlays `#0F172A]/60` backdrop.
- **Draft Isolation**: Unsaved changes exist in draft state. Clicking Cancel, X, Esc, or backdrop discards unsaved edits; reopening re-initializes from persisted profile data.
- **Validation**: Client-side validation for required name on Personal, degree/institution on Education, and role/company on Experience.
- **Touch Targets**: All interactive buttons, inputs, and close triggers have at least 44px min-height/width (`min-h-[44px]`).

### 3. `src/components/shell/AppIconRail.tsx`
- Updated Profile nav item to route to `/profile` with active state matching `p === "/profile"`.
- Settings gear continues routing to `/settings`.

---

## 3. Verification & Test Evidence

### 1. TypeScript & Static Build
- `npx tsc --noEmit`: **0 errors** (exit code 0).
- `npm run build`: **40 static pages exported successfully**, including `○ /profile` (14.8 kB).

### 2. Dedicated Profile Rebuild Test Suite (`scripts/test-profile-rebuild.ts`)
- **Normal Validation**:
  ```text
  [PASS] shell integration: LoggedInAppShell integrated with pageLabel='PROFILE'
  [PASS] responsive grid: Centred 2-column layout (col-span-8 / col-span-4) on desktop, single-column on mobile
  [PASS] section tabs: Personal, Education, Work Experience, and Skills tabs present
  [PASS] tab visual styling: Active tab underlined with touch target min-h-[44px]
  [PASS] header card: Full name, initial avatar, and working edit pencil present
  [PASS] contact chips: Strictly conditioned on actual stored candidate fields (email, phone, location)
  [PASS] privacy purity: Zero invented privacy claims in header card
  [PASS] card surfaces: White background, 16px radius (rounded-2xl), 1px #E2E8F0 border
  [PASS] timeline treatment: Vertical left track #E2E8F0 with circular dot node for experience and education
  [PASS] skills treatment: Wrapped chips with #EFF6FF background and #1D4ED8 text
  [PASS] empty states: Honest empty states rendered for empty sections with direct add actions
  [PASS] drawer component: Full-height slide-over dialog rendered with backdrop
  [PASS] draft state isolation: Edits are held in draft state and discarded on cancel/X/Esc
  [PASS] drawer validation: Validates required name, email format, and item fields
  [PASS] save error handling: Rejection keeps drawer open, preserves draft edits, and shows inline error alert
  [PASS] keyboard nav: Escape key listener closes drawer and discards unsaved edits
  [PASS] focus trap: Tab and Shift+Tab wrapped strictly within drawer focusable elements
  [PASS] focus return: Restores focus to the triggering element upon drawer closure
  [PASS] backdrop guard: Locks body overflow and prevents background interaction
  [PASS] touch targets: Enforces min-h-[44px] across all drawer and profile action controls
  [PASS] profile strength: Real completion percentage derived from stored sections with direct drawer action triggers
  [PASS] quick links: Strictly links to existing routes (/resume, /tracker, /jobs, /settings) with zero unbacked tools
  [PASS] rail navigation: AppIconRail Profile item routes directly to /profile
  ```
- **Negative Control**:
  `npx tsx scripts/test-profile-rebuild.ts --negative-control`
  ```text
  NEGATIVE CONTROL PASSED: Deliberately injected corruptions caught 6 errors.
  ```

### 3. Suite Runner Integration
- `scripts/suite-runner.ts`: **47 passed, 0 failed, 0 blocked/skipped**.

---

## 4. Visual Comparison & Limitations Reporting

- **Reference Limitation Notice**: The original Jobright live reference assets were not stored in this repository; layout proportions, tab navigation, timeline treatment, and drawer mechanics were implemented using the captured specifications from Prompts 1-6. Exact fidelity cannot be claimed solely through code assertions; visual comparison is based on the captured layout and screenshot artifacts.
- **Captured Artifacts** (in `reports/prompt7-profile/`):
  1. `profile-before.png`: Baseline navigation view prior to dedicated profile page.
  2. `profile-desktop.png`: Centred 2-column desktop view with header card, section cards, timeline treatment, and right rail.
  3. `profile-drawer-personal.png`: Desktop slide-over drawer editing Personal Information with focus trapped.
  4. `profile-drawer-experience.png`: Desktop slide-over drawer editing Work Experience with multi-entry management.
  5. `profile-mobile.png`: Single-column mobile view with bottom tab bar.
  6. `profile-drawer-mobile.png`: Full-screen mobile edit drawer.
