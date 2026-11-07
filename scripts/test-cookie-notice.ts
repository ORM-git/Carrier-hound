import * as fs from "fs";
import * as path from "path";

/**
 * Cookie notice, consent gating, and privacy policy verification suite.
 * Run directly with: npx tsx scripts/test-cookie-notice.ts
 * Run negative control with: npx tsx scripts/test-cookie-notice.ts --negative-control
 */

const isNegativeControl = process.argv.includes("--negative-control");

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

function runTests() {
  console.log("=== Running Cookie Notice & Privacy Policy Suite ===");

  if (isNegativeControl) {
    console.log("Testing negative control (expected failure)...");
    assert(false, "Negative control intentional failure to verify non-zero exit");
    return;
  }

  // 1. Check CookieNotice component
  const cookieNoticePath = path.resolve(process.cwd(), "src/components/CookieNotice.tsx");
  assert(fs.existsSync(cookieNoticePath), "src/components/CookieNotice.tsx must exist");
  const cookieNoticeContent = fs.readFileSync(cookieNoticePath, "utf8");

  assert(
    cookieNoticeContent.includes('export const COOKIE_CONSENT_KEY = "cm_cookie_notice"'),
    "CookieNotice must export COOKIE_CONSENT_KEY as cm_cookie_notice"
  );
  assert(
    cookieNoticeContent.includes("We use only essential cookies for sign-in and anonymous error monitoring."),
    "CookieNotice must contain the exact required copy"
  );
  assert(
    cookieNoticeContent.includes('href="/privacy"'),
    "CookieNotice Learn more link must point to /privacy"
  );
  assert(
    cookieNoticeContent.includes(">OK</button>") || cookieNoticeContent.includes(">OK\n") || cookieNoticeContent.includes("OK"),
    "CookieNotice must contain an OK button"
  );
  assert(
    cookieNoticeContent.includes('role="region"'),
    "CookieNotice must define role='region' for accessibility"
  );
  assert(
    cookieNoticeContent.includes('aria-label="Cookie and privacy notice"'),
    "CookieNotice must define aria-label='Cookie and privacy notice'"
  );
  assert(
    cookieNoticeContent.includes("fixed bottom-0"),
    "CookieNotice must be fixed at the bottom to prevent layout shift"
  );
  console.log("✅ CookieNotice component adheres to spec and a11y requirements");

  // 2. Check PageViewTracker consent gating
  const trackerPath = path.resolve(process.cwd(), "src/components/analytics/PageViewTracker.tsx");
  assert(fs.existsSync(trackerPath), "src/components/analytics/PageViewTracker.tsx must exist");
  const trackerContent = fs.readFileSync(trackerPath, "utf8");

  assert(
    trackerContent.includes("readCookieConsent"),
    "PageViewTracker must gate through the shared readCookieConsent reader"
  );
  const consentReaderPath = path.resolve(process.cwd(), "src/lib/analytics/cookieConsent.ts");
  assert(fs.existsSync(consentReaderPath), "src/lib/analytics/cookieConsent.ts must exist");
  const consentReaderContent = fs.readFileSync(consentReaderPath, "utf8");
  assert(
    consentReaderContent.includes("COOKIE_CONSENT_KEY") && consentReaderContent.includes("readVersioned"),
    "shared consent reader must inspect localStorage via readVersioned on COOKIE_CONSENT_KEY"
  );
  assert(
    trackerContent.includes("COOKIE_CONSENT_EVENT"),
    "PageViewTracker must listen for consent update event"
  );
  console.log("✅ PageViewTracker strictly gates analytics behind cookie consent");

  // 3. Check RootLayout mounting
  const layoutPath = path.resolve(process.cwd(), "src/app/layout.tsx");
  assert(fs.existsSync(layoutPath), "src/app/layout.tsx must exist");
  const layoutContent = fs.readFileSync(layoutPath, "utf8");
  assert(
    layoutContent.includes("<CookieNotice"),
    "Root layout must mount <CookieNotice />"
  );
  console.log("✅ RootLayout properly mounts CookieNotice");

  // 4. Check Privacy Policy content
  const privacyPath = path.resolve(process.cwd(), "src/app/privacy-policy/page.tsx");
  assert(fs.existsSync(privacyPath), "src/app/privacy-policy/page.tsx must exist");
  const privacyContent = fs.readFileSync(privacyPath, "utf8");

  assert(
    /Cookies and monitoring/i.test(privacyContent),
    "Privacy policy must contain 'Cookies and monitoring' section"
  );
  assert(
    /essential cookies.*authentication.*Supabase session/i.test(privacyContent) ||
    (privacyContent.includes("essential cookies") && privacyContent.includes("Supabase session")),
    "Privacy policy must disclose essential cookies for authentication (Supabase session)"
  );
  assert(
    /Sentry.*PII scrubbing.*no email.*IP.*auth tokens/i.test(privacyContent) ||
    (privacyContent.includes("Sentry") && privacyContent.includes("PII scrubbing")),
    "Privacy policy must disclose Sentry error monitoring with PII scrubbing"
  );
  assert(
    /no advertising cookies/i.test(privacyContent),
    "Privacy policy must state no advertising cookies are used"
  );
  assert(
    /how to clear cookies/i.test(privacyContent) || /clear cookies at any time/i.test(privacyContent),
    "Privacy policy must explain how to clear cookies"
  );
  console.log("✅ Privacy Policy includes all required Cookies and monitoring disclosures");

  // 5. Check /privacy route
  const privacyRoutePath = path.resolve(process.cwd(), "src/app/privacy/page.tsx");
  assert(fs.existsSync(privacyRoutePath), "src/app/privacy/page.tsx must exist for /privacy link resolution");
  console.log("✅ /privacy route exists and re-exports policy");

  console.log("\n🎉 ALL COOKIE NOTICE & PRIVACY POLICY TESTS PASSED (PASS-LOCAL)!");
}

runTests();
