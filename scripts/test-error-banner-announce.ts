/**
 * Row 52 (accessible form errors): every inline error banner - a conditional
 * `{someError && (` block rendering a styled message container - must carry
 * role="alert" so screen readers announce it, not only show it visually.
 * Auth banners already comply; this guards the rest against regressions and
 * new banners landing without the attribute.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`PASS: ${label}`); }
  else { failed += 1; console.log(`FAIL: ${label}`); }
}

const BANNERS: Array<{ file: string; marker: string }> = [
  { file: "src/app/login/page.tsx", marker: 'data-testid="auth-error-banner"' },
  { file: "src/app/signup/page.tsx", marker: 'data-testid="auth-error-banner"' },
  { file: "src/components/jobs/JobDetailView.tsx", marker: 'data-testid="pro-unlock-error-banner"' },
  { file: "src/components/dashboard/WhyMatchPanel.tsx", marker: 'data-testid="ai-error-fallback-message"' },
  { file: "src/components/JobRadarGlobe.tsx", marker: 'data-testid="radar-pro-unlock-error-banner"' },
  { file: "src/components/resume/ResumeUploadAndConfirm.tsx", marker: "{parseError && (" },
  { file: "src/app/onboarding/page.tsx", marker: "{processingError && (" },
];

for (const { file, marker } of BANNERS) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const idx = src.indexOf(marker);
  if (idx === -1) {
    check(false, `${file}: banner marker found (${marker})`);
    continue;
  }
  const open = src.lastIndexOf("<div", idx);
  const tag = src.slice(open, idx + marker.length + 200);
  check(/role="alert"/.test(tag), `${file}: ${marker} carries role="alert"`);
}

// Toasts are the other error surface: react-toastify's container defaults to
// role:"alert", so toast.error is announced without any app wiring.
const toastify = fs.readFileSync(
  path.join(ROOT, "node_modules/react-toastify/dist/react-toastify.esm.mjs"),
  "utf8"
);
check(toastify.includes('role:"alert"'), 'react-toastify container defaults to role:"alert" (toast.error announced)');

console.log(`\nerror-banner-announce: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
