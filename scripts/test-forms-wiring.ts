/**
 * scripts/test-forms-wiring.ts
 *
 * Form wiring static audit guard:
 * Inspects application form source files across the repository to verify:
 *   (a) Submit control disables and shows pending state during inflight requests (or records verified gap)
 *   (b) Resume upload wires the existing progress component (or records verified gap)
 *   (c) Failed mutations surface retry affordances (or records verified gap)
 *
 * Strictly scoped as an offline static code analysis audit of source files in src/app/
 * and src/components/. Does not perform synthetic DOM or AST emulation.
 * Includes a negative control proving non-zero exit on synthetic failures.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(__dirname, "..");
const isNegativeControl = process.argv.includes("--negative-control");

let passed = 0;
let failed = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`PASS: ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Negative Control Mode
// ---------------------------------------------------------------------------
if (isNegativeControl) {
  console.log("Running in --negative-control mode (expecting failure)...");
  // Inject synthetic invalid condition: assert that Settings save button is already wired with disabled
  const settingsSource = fs.readFileSync(path.join(ROOT, "src/app/settings/page.tsx"), "utf8");
  const syntheticExpectation = /<button[^>]*type="submit"[^>]*disabled=\{isSaving\}/.test(settingsSource);
  check(syntheticExpectation, "Synthetic check: settings save button has disabled={isSaving} (must fail)");
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Section 1: Static Source Code Analysis & Verified Gaps
// ---------------------------------------------------------------------------
console.log("\n--- Section 1: Static Code Analysis ---");

// 1.1 Login Page (src/app/login/page.tsx)
const loginSrc = fs.readFileSync(path.join(ROOT, "src/app/login/page.tsx"), "utf8");
check(
  loginSrc.includes("disabled={loading || googleLoading}") || loginSrc.includes("disabled={googleLoading || loading}"),
  "Login: Email & Google submit buttons bind disabled={loading || googleLoading}"
);
check(
  loginSrc.includes("Loader2") && loginSrc.includes("animate-spin"),
  "Login: Inflight state renders spinning Loader2 icon"
);
check(
  loginSrc.includes("Sending link…") && loginSrc.includes("Connecting to Google…"),
  "Login: Inflight state displays pending labels for email and Google actions"
);
check(
  loginSrc.includes("resendTimer") && loginSrc.includes("Resend magic link"),
  "Login: Magic link email sent state provides resend affordance"
);

// 1.2 Signup Page (src/app/signup/page.tsx)
const signupSrc = fs.readFileSync(path.join(ROOT, "src/app/signup/page.tsx"), "utf8");
check(
  signupSrc.includes("disabled={loading || googleLoading}"),
  "Signup: Email submit button binds disabled={loading || googleLoading}"
);
check(
  signupSrc.includes("Loader2") && signupSrc.includes("animate-spin"),
  "Signup: Inflight state renders spinning Loader2 icon"
);
check(
  signupSrc.includes("Sending link…") && signupSrc.includes("Connecting to Google…"),
  "Signup: Inflight state displays pending labels for email and Google actions"
);

// 1.3 Settings Page (src/app/settings/page.tsx)
const settingsSrc = fs.readFileSync(path.join(ROOT, "src/app/settings/page.tsx"), "utf8");
// Verify identified gaps: Preferences save and Notification save buttons lack disabled state
const prefsButtonMatch = settingsSrc.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?Save Preferences[\s\S]*?<\/button>/);
check(
  Boolean(prefsButtonMatch && !prefsButtonMatch[0].includes("disabled")),
  "Settings: Confirmed gap - Save Preferences button currently lacks disabled attribute"
);
const notifButtonMatch = settingsSrc.match(/<button[^>]*onClick=\{handleSavePreferences\}[^>]*>[\s\S]*?Save Notification Settings[\s\S]*?<\/button>/);
check(
  Boolean(notifButtonMatch && !notifButtonMatch[0].includes("disabled")),
  "Settings: Confirmed gap - Save Notification Settings button currently lacks disabled attribute"
);

// 1.4 Resume Upload Component (src/components/resume/ResumeUploadAndConfirm.tsx)
const resumeSrc = fs.readFileSync(path.join(ROOT, "src/components/resume/ResumeUploadAndConfirm.tsx"), "utf8");
check(
  resumeSrc.includes("isParsing") && resumeSrc.includes("RefreshCw") && resumeSrc.includes("animate-spin"),
  "Resume: Dropzone displays spinning RefreshCw indicator while isParsing is true"
);
check(
  resumeSrc.includes("disabled={isSaving}"),
  "Resume: Save confirmed profile button binds disabled={isSaving}"
);
check(
  resumeSrc.includes("Saving Profile...") || resumeSrc.includes("Saving..."),
  "Resume: Save confirmed profile displays pending label while saving"
);
// Progress Bar Component check
const progressBarPath = path.join(ROOT, "src/components/ui/progress-bar.tsx");
check(fs.existsSync(progressBarPath), "ProgressBar component exists in src/components/ui/progress-bar.tsx");
const progressBarSrc = fs.readFileSync(progressBarPath, "utf8");
check(
  progressBarSrc.includes('role="progressbar"') && progressBarSrc.includes("aria-valuenow"),
  "ProgressBar: Implements accessible role='progressbar' with aria-valuenow attributes"
);
// Confirm gap: ResumeUploadAndConfirm does not currently wire ProgressBar
check(
  !resumeSrc.includes("ProgressBar"),
  "Resume: Confirmed gap - ResumeUploadAndConfirm does not yet import or wire ProgressBar"
);
// Retry affordance check
check(
  resumeSrc.includes("parseError") && resumeSrc.includes("Retry Upload"),
  "Resume: Surfaces 'Retry Upload' button inside parseError alert container"
);

// 1.5 Tracker Page (src/app/tracker/page.tsx)
const trackerSrc = fs.readFileSync(path.join(ROOT, "src/app/tracker/page.tsx"), "utf8");
const addAppMatch = trackerSrc.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?Save Application[\s\S]*?<\/button>/);
check(
  Boolean(addAppMatch && !addAppMatch[0].includes("disabled")),
  "Tracker: Confirmed gap - Save Application submit button currently lacks disabled attribute"
);
const saveNotesMatch = trackerSrc.match(/<button[^>]*onClick=\{handleSaveNotes\}[^>]*>[\s\S]*?Save Notes[\s\S]*?<\/button>/);
check(
  Boolean(saveNotesMatch && !saveNotesMatch[0].includes("disabled")),
  "Tracker: Confirmed gap - Save Notes button currently lacks disabled attribute"
);

// 1.6 Audit Documentation Verification
const auditDocPath = path.join(ROOT, "docs/forms-wiring-audit.md");
check(fs.existsSync(auditDocPath), "Audit documentation exists at docs/forms-wiring-audit.md");
const auditDoc = fs.readFileSync(auditDocPath, "utf8");
check(auditDoc.includes("## Form-by-Form Audit Results"), "Audit doc contains Form-by-Form section");
check(auditDoc.includes("src/app/login/page.tsx:204-214"), "Audit doc records Login error banner gap");
check(auditDoc.includes("src/app/signup/page.tsx:198-208"), "Audit doc records Signup error banner gap");
check(auditDoc.includes("src/app/settings/page.tsx:430-437"), "Audit doc records Settings save preferences gap");
check(auditDoc.includes("src/components/resume/ResumeUploadAndConfirm.tsx:417-432"), "Audit doc records ProgressBar gap");
check(auditDoc.includes("src/app/tracker/page.tsx:1009-1014"), "Audit doc records Tracker Add Application gap");

// ---------------------------------------------------------------------------
// Section 2: Negative Control Validation
// ---------------------------------------------------------------------------
console.log("\n--- Section 2: Negative Control Verification ---");
const child = spawnSync("npx", ["tsx", path.resolve(__filename), "--negative-control"], {
  encoding: "utf8",
  shell: true,
});

check(
  child.status === 1,
  `Negative control sub-process exited with code ${child.status} (expected code 1)`
);
check(
  child.stderr.includes("FAIL:") || child.stdout.includes("FAIL:"),
  "Negative control sub-process output reports synthetic failure"
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\ntest-forms-wiring: ${passed} PASS, ${failed} FAIL`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("PASS-LOCAL: All form wiring static verification and gap assertions passed.");
  process.exit(0);
}
