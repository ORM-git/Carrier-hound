/**
 * Row 53 (aria-live announcements): every full-page loading state must
 * announce once via role="status" (an implicit aria-live=polite region)
 * with an accessible label, and decorative spinner/skeleton blocks must be
 * aria-hidden so AT does not read partial markup. Attribute-only contract:
 * rendered output is unchanged.
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

// Full-page loading states: file -> spinner/skeleton marker that must sit
// inside a role="status" container.
const LOADING_STATES: Array<{ file: string; marker: RegExp; note: string }> = [
  { file: "src/app/jobs/loading.tsx", marker: /animate-pulse/, note: "jobs route skeleton" },
  { file: "src/app/jobs/[id]/skill-what-if/SkillWhatIfClient.tsx", marker: /animate-spin/, note: "skill what-if auth gate" },
  { file: "src/app/jobs/[id]/interview-pack/InterviewPackClient.tsx", marker: /animate-spin/, note: "interview pack auth gate" },
  { file: "src/app/job-search/all/page.tsx", marker: /animate-spin/, note: "canonical redirect spinner" },
  { file: "src/app/onboarding/page.tsx", marker: /animate-spin/, note: "onboarding auth gate" },
  { file: "src/app/auth/callback/page.tsx", marker: /animate-spin/, note: "auth callback spinner" },
];

for (const { file, marker, note } of LOADING_STATES) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const idx = src.search(marker);
  check(idx !== -1, `${note}: loading indicator still present (${file})`);
  const regionStart = src.lastIndexOf('role="status"', idx);
  check(regionStart !== -1 && regionStart > idx - 800, `${note}: indicator is inside a role="status" container`);
  check(/role="status"[^>]*aria-label="[^"]+"/.test(src.slice(Math.max(0, idx - 800), idx + 200)), `${note}: status container has an aria-label`);
  // Decorative indicator hidden: either on its own tag or on an enclosing
  // wrapper (skeleton sections hide whole regions).
  const window = src.slice(Math.max(0, idx - 800), src.indexOf(">", idx) + 1);
  check(window.includes('aria-hidden="true"'), `${note}: decorative indicator is aria-hidden (tag or wrapper)`);
}

// Shared Skeleton stays decorative; the dashboard loading block wraps its
// skeleton group in one labelled status region.
{
  const sk = fs.readFileSync(path.join(ROOT, "src/components/ui/skeleton.tsx"), "utf8");
  check(sk.includes('aria-hidden="true"'), "shared Skeleton component is aria-hidden (decorative)");
  const dash = fs.readFileSync(path.join(ROOT, "src/app/dashboard/page.tsx"), "utf8");
  check(/role="status"\s+aria-label="Loading your account"/.test(dash), "dashboard skeleton group announces once via labelled role=status");
}

// Toast announcements: react-toastify container renders role="alert" by
// default; guard the dependency and that no override silences it.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  check(Boolean(pkg.dependencies?.["react-toastify"]), "react-toastify present (toasts announce via its default role=alert)");
  const src = fs.readFileSync(path.join(ROOT, "src/app/layout.tsx"), "utf8");
  check(!/ToastContainer[^>]*role=/.test(src), "ToastContainer role not overridden away from alert");
}

console.log(`\nloading-announce: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
