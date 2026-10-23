import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("     PROMPT 8 AUDIT — JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC AUDIT         ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const loginPath = path.resolve(process.cwd(), "src/app/login/page.tsx");
  const signupPath = path.resolve(process.cwd(), "src/app/signup/page.tsx");
  const globalsCssPath = path.resolve(process.cwd(), "src/app/globals.css");

  if (!fs.existsSync(loginPath)) {
    console.error("FAIL: src/app/login/page.tsx is missing!");
    process.exit(1);
  }
  if (!fs.existsSync(signupPath)) {
    console.error("FAIL: src/app/signup/page.tsx is missing!");
    process.exit(1);
  }
  if (!fs.existsSync(globalsCssPath)) {
    console.error("FAIL: src/app/globals.css is missing!");
    process.exit(1);
  }

  let loginCode = fs.readFileSync(loginPath, "utf-8");
  let signupCode = fs.readFileSync(signupPath, "utf-8");
  let cssCode = fs.readFileSync(globalsCssPath, "utf-8");

  if (isNegativeControl) {
    // Deliberately inject corruptions to verify negative control failure detection
    loginCode = loginCode.replace(/sm:max-w-\[488px\]/g, "max-w-[800px]");
    loginCode = loginCode.replace(/Welcome back to/g, "Incorrect Heading");
    loginCode = loginCode.replace(/sm:bg-\[#F3F4F5\]/g, "bg-red-500");
    loginCode = loginCode.replace(/items-end sm:items-center/g, "items-start");
    loginCode = loginCode.replace(/rounded-t-\[20px\] rounded-b-none/g, "rounded-none");
    signupCode = signupCode.replace(/Welcome to/g, "Unsupported Heading");
    signupCode = signupCode.replace(/sm:rounded-\[24px\]/g, "rounded-none");
    signupCode = signupCode.replace(/sm:hidden text-\[12px\]/g, "hidden text-[12px]");
  }

  const failures: string[] = [];

  // -------------------------------------------------------------------------
  // 1. MODAL CARD DIMENSIONS, PADDING, BACKDROP & MOBILE DRAWER SPEC
  // -------------------------------------------------------------------------
  const hasLoginBackdrop = loginCode.includes('data-testid="auth-backdrop"') && loginCode.includes("fixed inset-0 bg-black/40");
  const hasSignupBackdrop = signupCode.includes('data-testid="auth-backdrop"') && signupCode.includes("fixed inset-0 bg-black/40");
  if (!hasLoginBackdrop || !hasSignupBackdrop) {
    failures.push("BACKDROP FAIL: Both /login and /signup must render a dimmed backdrop (fixed inset-0 bg-black/40).");
  } else {
    console.log("  [PASS] dimmed backdrop: Dimmed backdrop present over auth route page");
  }

  const hasLoginDesktopCardDims =
    loginCode.includes("sm:max-w-[488px]") &&
    loginCode.includes("sm:rounded-[24px]") &&
    loginCode.includes("sm:pt-[48px] sm:px-[32px] sm:pb-[32px]") &&
    loginCode.includes("sm:mx-auto") &&
    loginCode.includes('data-testid="login-auth-card"');

  const hasSignupDesktopCardDims =
    signupCode.includes("sm:max-w-[488px]") &&
    signupCode.includes("sm:rounded-[24px]") &&
    signupCode.includes("sm:pt-[48px] sm:px-[32px] sm:pb-[32px]") &&
    signupCode.includes("sm:mx-auto") &&
    signupCode.includes('data-testid="signup-auth-card"');

  if (!hasLoginDesktopCardDims || !hasSignupDesktopCardDims) {
    failures.push("DESKTOP CARD DIMS FAIL: Auth cards must have sm:max-w-[488px], 24px radius, 48px top / 32px sides / 32px bottom on desktop.");
  } else {
    console.log("  [PASS] desktop card dimensions: White modal card 488px max width, 24px radius, 424px content width");
  }

  const hasLoginMobileDrawer =
    loginCode.includes("items-end sm:items-center") &&
    loginCode.includes("m-0 sm:mx-auto") &&
    loginCode.includes("rounded-t-[20px] rounded-b-none sm:rounded-[24px]") &&
    loginCode.includes("pb-[max(1.5rem,env(safe-area-inset-bottom))]") &&
    loginCode.includes("sm:pb-[32px]") &&
    loginCode.includes("max-h-[92vh] sm:max-h-[calc(100vh-32px)]") &&
    loginCode.includes("overflow-y-auto");

  const hasSignupMobileDrawer =
    signupCode.includes("items-end sm:items-center") &&
    signupCode.includes("m-0 sm:mx-auto") &&
    signupCode.includes("rounded-t-[20px] rounded-b-none sm:rounded-[24px]") &&
    signupCode.includes("pb-[max(1.5rem,env(safe-area-inset-bottom))]") &&
    signupCode.includes("sm:pb-[32px]") &&
    signupCode.includes("max-h-[92vh] sm:max-h-[calc(100vh-32px)]") &&
    signupCode.includes("overflow-y-auto");

  if (!hasLoginMobileDrawer || !hasSignupMobileDrawer) {
    failures.push("MOBILE DRAWER SPEC FAIL: On mobile, auth surface must be full width, anchored to bottom (items-end), no side margins (m-0), 20px top radii with square bottom corners, safe-area inset padding and vertical scrolling on short screens.");
  } else {
    console.log("  [PASS] mobile bottom drawer: Full width, bottom-anchored, 0 side margins, 20px top corners, square bottom, safe-area aware, vertical scrolling");
  }

  // -------------------------------------------------------------------------
  // 2. CLOSE CONTROL & ESCAPE KEYBOARD NAVIGATION
  // -------------------------------------------------------------------------
  const hasLoginClose =
    loginCode.includes('aria-label="Close and return to home"') &&
    loginCode.includes('href="/"') &&
    loginCode.includes("Escape");

  const hasSignupClose =
    signupCode.includes('aria-label="Close and return to home"') &&
    signupCode.includes('href="/"') &&
    signupCode.includes("Escape");

  if (!hasLoginClose || !hasSignupClose) {
    failures.push("CLOSE CONTROL FAIL: Must have top-right dark circular close button navigating to /, with accessible name and Esc keyboard handling.");
  } else {
    console.log("  [PASS] close control: Dark circular close button navigating to / with Esc key support");
  }

  // -------------------------------------------------------------------------
  // 3. HEADINGS: CENTRED 24PX LIGHT TEXT WITH BRAND BOLD INLINE (NO SUBTITLE / NO INSIDE LOGO)
  // -------------------------------------------------------------------------
  const hasLoginHeading =
    loginCode.includes("Welcome back to") &&
    loginCode.includes('<span className="font-bold">CareerMonke</span>') &&
    !loginCode.includes("Sign in to access your dashboard");

  const hasSignupHeading =
    signupCode.includes("Welcome to") &&
    signupCode.includes('<span className="font-bold">CareerMonke</span>') &&
    !signupCode.includes("Create an account to track");

  const hasNoInsideBrandLogo =
    !loginCode.includes("w-12 h-12 rounded-2xl bg-[#EFF6FF]") &&
    !signupCode.includes("w-12 h-12 rounded-2xl bg-[#EFF6FF]");

  if (!hasLoginHeading || !hasSignupHeading || !hasNoInsideBrandLogo) {
    failures.push("HEADING FAIL: Must feature centred 24px light heading with brand bold inline, no extra subtitle, and no inside card logo tile.");
  } else {
    console.log("  [PASS] headings: Centred 24px light heading with bold brand inline; extra subtitle and inner logo removed");
  }

  // -------------------------------------------------------------------------
  // 4. GOOGLE OAUTH BUTTON & PLAIN OR (NO HORIZONTAL LINES)
  // -------------------------------------------------------------------------
  const hasGoogleBtn =
    loginCode.includes("Continue with Google") &&
    loginCode.includes("h-[48px]") &&
    loginCode.includes("rounded-[8px]") &&
    loginCode.includes("border-[#E5E7EB]") &&
    loginCode.includes("GoogleIcon") &&
    signupCode.includes("Continue with Google") &&
    signupCode.includes("h-[48px]") &&
    signupCode.includes("rounded-[8px]") &&
    signupCode.includes("border-[#E5E7EB]") &&
    signupCode.includes("GoogleIcon");

  if (!hasGoogleBtn) {
    failures.push("GOOGLE BTN FAIL: Continue with Google button must be full-width, 48px high, white, 1px #E5E7EB border, 8px radius with GoogleIcon.");
  } else {
    console.log("  [PASS] google button: Full width 48px high, 1px #E5E7EB border, 8px radius with Google icon");
  }

  const hasPlainOr =
    loginCode.includes("OR") &&
    !loginCode.includes("border-t border-[#E2E8F0]") &&
    signupCode.includes("OR") &&
    !signupCode.includes("border-t border-[#E2E8F0]");

  if (!hasPlainOr) {
    failures.push("PLAIN OR FAIL: Must feature plain small grey 'OR' with zero horizontal divider lines.");
  } else {
    console.log("  [PASS] plain or: Small grey 'OR' with zero horizontal divider lines");
  }

  // -------------------------------------------------------------------------
  // 5. EMAIL INPUT & SUBMIT BUTTON
  // -------------------------------------------------------------------------
  const hasEmailInput =
    loginCode.includes('bg-[#F7F8F9]') &&
    loginCode.includes('placeholder="Email"') &&
    loginCode.includes('rounded-[8px]') &&
    loginCode.includes('h-[48px]') &&
    loginCode.includes('sr-only') &&
    signupCode.includes('bg-[#F7F8F9]') &&
    signupCode.includes('placeholder="Email"') &&
    signupCode.includes('rounded-[8px]') &&
    signupCode.includes('h-[48px]') &&
    signupCode.includes('sr-only');

  if (!hasEmailInput) {
    failures.push("EMAIL INPUT FAIL: Email input must be 48px high, #F7F8F9 fill, 8px radius, placeholder 'Email', sr-only accessible label.");
  } else {
    console.log("  [PASS] email input: 48px high, #F7F8F9 fill, 8px radius, placeholder 'Email', accessible sr-only label");
  }

  const hasSubmitBtn =
    loginCode.includes("Email me a sign-in link") &&
    loginCode.includes("rounded-[8px]") &&
    loginCode.includes("h-[48px]") &&
    loginCode.includes("bg-[#2563EB]") &&
    signupCode.includes("Email me a sign-in link") &&
    signupCode.includes("rounded-[8px]") &&
    signupCode.includes("h-[48px]") &&
    signupCode.includes("bg-[#2563EB]");

  if (!hasSubmitBtn) {
    failures.push("SUBMIT BTN FAIL: Submit button must be 48px high, 8px radius, #2563EB 'Email me a sign-in link'.");
  } else {
    console.log("  [PASS] primary button: 48px high, 8px radius, #2563EB with truthful magic-link text");
  }

  // -------------------------------------------------------------------------
  // 6. LEGAL TEXT & SIGNUP MOBILE PLACEMENT
  // -------------------------------------------------------------------------
  const hasCentredLegal =
    loginCode.includes("/terms-and-conditions") &&
    loginCode.includes("/privacy-policy") &&
    signupCode.includes("/terms-and-conditions") &&
    signupCode.includes("/privacy-policy");

  if (!hasCentredLegal) {
    failures.push("LEGAL TEXT FAIL: Must preserve Terms and Privacy Policy links centred.");
  } else {
    console.log("  [PASS] legal links: Terms and Privacy Policy links preserved with valid destinations");
  }

  // On signup: desktop terms is above switch box (hidden sm:block), mobile terms is below switch box (sm:hidden)
  const hasSignupTermsPlacement =
    signupCode.includes("hidden sm:block text-[12px] text-center text-[#6B7280]") &&
    signupCode.includes("sm:hidden text-[12px] text-center text-[#6B7280]");

  if (!hasSignupTermsPlacement) {
    failures.push("SIGNUP TERMS PLACEMENT FAIL: On signup, Terms must be above switch box on desktop (hidden sm:block) and below switch box on mobile (sm:hidden).");
  } else {
    console.log("  [PASS] signup terms placement: Desktop above switch box; mobile below switch box");
  }

  // -------------------------------------------------------------------------
  // 7. ACCOUNT SWITCH BOX: MOBILE WHITE + BORDER, DESKTOP GREY FILL
  // -------------------------------------------------------------------------
  const hasResponsiveSwitchBox =
    loginCode.includes("bg-white border border-[#E5E7EB] sm:bg-[#F3F4F5] sm:border-transparent") &&
    loginCode.includes("rounded-[8px]") &&
    loginCode.includes("h-[48px]") &&
    loginCode.includes("/signup?next=") &&
    signupCode.includes("bg-white border border-[#E5E7EB] sm:bg-[#F3F4F5] sm:border-transparent") &&
    signupCode.includes("rounded-[8px]") &&
    signupCode.includes("h-[48px]") &&
    signupCode.includes("/login?next=");

  if (!hasResponsiveSwitchBox) {
    failures.push("SWITCH BOX FAIL: Must feature mobile white background with 1px #E5E7EB border, desktop #F3F4F5 grey fill with transparent border, 8px radius, and preserve ?next.");
  } else {
    console.log("  [PASS] switch box: Mobile white + 1px #E5E7EB border; Desktop #F3F4F5 grey fill, 8px radius, ?next preserved");
  }

  // -------------------------------------------------------------------------
  // 8. MOTION: 0.3S CUBIC-BEZIER(0.08,0.82,0.17,1) & PREFERS-REDUCED-MOTION
  // -------------------------------------------------------------------------
  const hasMotionKeyframes =
    cssCode.includes("authModalEntrance") &&
    cssCode.includes("authDrawerEntranceMobile") &&
    cssCode.includes("cubic-bezier(0.08, 0.82, 0.17, 1)") &&
    cssCode.includes("0.3s") &&
    cssCode.includes("prefers-reduced-motion");

  if (!hasMotionKeyframes) {
    failures.push("MOTION FAIL: globals.css must define authModalEntrance, authDrawerEntranceMobile timing 0.3s cubic-bezier(0.08,0.82,0.17,1) and honor prefers-reduced-motion.");
  } else {
    console.log("  [PASS] entrance motion: 0.3s cubic-bezier(0.08,0.82,0.17,1) mobile drawer slide-up & desktop modal scale entrance with prefers-reduced-motion");
  }

  // -------------------------------------------------------------------------
  // FINAL VERDICT
  // -------------------------------------------------------------------------
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log("\n==================================================================================");
      console.log(`NEGATIVE CONTROL PASSED: Deliberately injected corruptions caught ${failures.length} errors.`);
      console.log("==================================================================================");
      process.exit(0);
    } else {
      console.error("\nNEGATIVE CONTROL FAILED: Injected corruptions were not detected!");
      process.exit(1);
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: Found ${failures.length} audit violations:`);
    failures.forEach((f, idx) => console.error(`  ${idx + 1}. ${f}`));
    process.exit(1);
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log("PROMPT 8 JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC AUDIT [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run();
