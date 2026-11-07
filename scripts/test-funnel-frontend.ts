/**
 * Row test: funnel frontend emitters (Funnel Tracking row, frontend half).
 * Static checks: allowlist parity across emitter / route / migration,
 * consent gating, fail-open, and the six wiring points.
 * Run: npx tsx scripts/test-funnel-frontend.ts
 */
import * as fs from "fs";
import * as path from "path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const emitter = fs.readFileSync("src/lib/analytics/funnel.ts", "utf8");
const route = fs.readFileSync("src/app/api/track/route.ts", "utf8");
const migration = fs.readFileSync("supabase/migrations/20261106e_funnel_events.sql", "utf8");

const STAGES = [
  "signup_started",
  "signup_completed",
  "onboarding_started",
  "onboarding_completed",
  "apply_started",
  "apply_completed",
];

// 1. allowlist parity: every stage present in all three artifacts
for (const s of STAGES) {
  check(`emitter allowlists ${s}`, emitter.includes(`"${s}"`));
  check(`route allowlists ${s}`, route.includes(`"${s}"`));
  check(`migration CHECK allowlists ${s}`, migration.includes(`'${s}'`));
}

// 2. consent gating (same key as PageViewTracker / UTM capture)
check("emitter gates through the shared readCookieConsent reader", emitter.includes("readCookieConsent") && emitter.includes("hasAnalyticsConsent"));
function readFileSafe(p: string): string {
  return fs.readFileSync(path.resolve(p), "utf8");
}
const consentReader = readFileSafe("src/lib/analytics/cookieConsent.ts");
check("shared reader gates on COOKIE_CONSENT_KEY via readVersioned", consentReader.includes("COOKIE_CONSENT_KEY") && consentReader.includes("readVersioned"));
check("no-consent -> no fetch (gate precedes fetch)", emitter.indexOf("hasAnalyticsConsent()") < emitter.indexOf('fetch("/api/track"'));

// 3. fail-open contract
check("fetch failure swallowed", emitter.includes('.catch(() =>'));
check("server-side no-op (reader chain guards window)", readFileSafe("src/lib/storage/versioned.ts").includes('typeof window === "undefined"'));

// 4. posts to the existing funnel branch of /api/track
check("posts eventType funnel to /api/track", emitter.includes('eventType: "funnel"') && emitter.includes('"/api/track"'));

// 5. wiring points
const signup = fs.readFileSync("src/app/signup/page.tsx", "utf8");
check("signup_started on email submit", signup.includes('trackFunnelEvent("signup_started", { path: "/signup" })'));
check("signup_started on Google signup", signup.includes('method: "google"'));

const callback = fs.readFileSync("src/app/auth/callback/page.tsx", "utf8");
check("signup_completed on fresh SIGNED_IN only", callback.includes('event === "SIGNED_IN"') && callback.includes('trackFunnelEvent("signup_completed"'));

const onboarding = fs.readFileSync("src/app/onboarding/page.tsx", "utf8");
check("onboarding_started on mount", onboarding.includes('trackFunnelEvent("onboarding_started", { path: "/onboarding" })'));
check("onboarding_completed after preferences persist", onboarding.includes('trackFunnelEvent("onboarding_completed", { path: "/onboarding" })'));

const jobs = fs.readFileSync("src/app/jobs/page.tsx", "utf8");
check("apply_started on Apply click", jobs.includes('trackFunnelEvent("apply_started", { path: "/jobs" })'));
const completedCount = (jobs.match(/trackFunnelEvent\("apply_completed"/g) || []).length;
check("apply_completed on both mark-applied paths", completedCount === 2);

// 6. no user-facing copy changed by the wiring (toasts/buttons untouched)
check("no toast copy touched", jobs.includes('Marked "${job.title}" as applied! Added to Tracker.') && jobs.includes('Moved to Tracker Applied tab.'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
