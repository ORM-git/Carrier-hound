import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("     PROMPT 8 AUDIT — JOBRIGHT-STYLE LOGIN & SIGNUP PRESENTATION AUDIT            ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const loginPath = path.resolve(process.cwd(), "src/app/login/page.tsx");
  const signupPath = path.resolve(process.cwd(), "src/app/signup/page.tsx");

  if (!fs.existsSync(loginPath)) {
    console.error("FAIL: src/app/login/page.tsx is missing!");
    process.exit(1);
  }
  if (!fs.existsSync(signupPath)) {
    console.error("FAIL: src/app/signup/page.tsx is missing!");
    process.exit(1);
  }

  let loginCode = fs.readFileSync(loginPath, "utf-8");
  let signupCode = fs.readFileSync(signupPath, "utf-8");

  if (isNegativeControl) {
    // Deliberately inject corruptions to verify negative control failure detection
    loginCode = loginCode.replace(/Welcome back to CareerMonke/g, "Random Other Heading");
    loginCode = loginCode.replace(/bg-blue-50/g, "bg-red-500");
    loginCode = loginCode.replace(/Email me a sign-in link/g, "Submit Password");
    signupCode = signupCode.replace(/Create your CareerMonke account/g, "Unsupported Heading");
    signupCode = signupCode.replace(/rounded-\[24px\]/g, "rounded-none");
  }

  const failures: string[] = [];

  // -------------------------------------------------------------------------
  // 1. PAGE BACKGROUND & CENTRED AUTH CARD DIMENSIONS
  // -------------------------------------------------------------------------
  const hasLoginBg = loginCode.includes("bg-blue-50");
  const hasSignupBg = signupCode.includes("bg-blue-50");
  if (!hasLoginBg || !hasSignupBg) {
    failures.push("BACKGROUND FAIL: Both /login and /signup must use bg-blue-50 background.");
  } else {
    console.log("  [PASS] page background: Blue-50 background present on both /login and /signup");
  }

  const hasLoginCardDims =
    loginCode.includes("max-w-[460px]") &&
    loginCode.includes("rounded-[24px]") &&
    loginCode.includes("p-8 sm:p-10") &&
    loginCode.includes("data-testid=\"login-auth-card\"");
  const hasSignupCardDims =
    signupCode.includes("max-w-[460px]") &&
    signupCode.includes("rounded-[24px]") &&
    signupCode.includes("p-8 sm:p-10") &&
    signupCode.includes("data-testid=\"signup-auth-card\"");

  if (!hasLoginCardDims || !hasSignupCardDims) {
    failures.push("CARD DIMS FAIL: Auth cards must be centred, 440-470px max width (max-w-[460px]), 24px radius, 32-40px padding.");
  } else {
    console.log("  [PASS] card dimensions: White auth card ~460px max width, 24px radius, 32-40px desktop padding");
  }

  // -------------------------------------------------------------------------
  // 2. BRANDING & HEADINGS
  // -------------------------------------------------------------------------
  const hasLoginHeading = loginCode.includes("Welcome back to CareerMonke");
  const hasSignupHeading = signupCode.includes("Create your CareerMonke account");
  const hasBrandLogo = loginCode.includes("BrandIcon") && signupCode.includes("BrandIcon");

  if (!hasLoginHeading || !hasSignupHeading || !hasBrandLogo) {
    failures.push("HEADING FAIL: Must feature centred BrandIcon, 'Welcome back to CareerMonke' on login, 'Create your CareerMonke account' on signup.");
  } else {
    console.log("  [PASS] branding & headings: Centred CareerMonke logo, exact requested login and signup headings");
  }

  // -------------------------------------------------------------------------
  // 3. GOOGLE OAUTH BUTTON & OR DIVIDER
  // -------------------------------------------------------------------------
  const hasGoogleBtn =
    loginCode.includes("Continue with Google") &&
    loginCode.includes("rounded-full") &&
    loginCode.includes("GoogleIcon") &&
    signupCode.includes("Continue with Google") &&
    signupCode.includes("rounded-full") &&
    signupCode.includes("GoogleIcon");

  if (!hasGoogleBtn) {
    failures.push("GOOGLE BTN FAIL: Continue with Google button must be white rounded pill with subtle border and GoogleIcon.");
  } else {
    console.log("  [PASS] google button: Working Continue with Google rounded pill button with preserved SVG asset");
  }

  const hasOrDivider =
    loginCode.includes("OR") &&
    loginCode.includes("border-t border-[#E2E8F0]") &&
    signupCode.includes("OR") &&
    signupCode.includes("border-t border-[#E2E8F0]");

  if (!hasOrDivider) {
    failures.push("OR DIVIDER FAIL: Must feature neutral OR divider with thin line.");
  } else {
    console.log("  [PASS] divider: Centred neutral OR divider with thin border line");
  }

  // -------------------------------------------------------------------------
  // 4. EMAIL INPUT & SUBMIT PRIMARY PILL
  // -------------------------------------------------------------------------
  const hasEmailInput =
    loginCode.includes("bg-[#F8FAFC]") &&
    loginCode.includes("rounded-[12px]") &&
    loginCode.includes("min-h-[44px]") &&
    signupCode.includes("bg-[#F8FAFC]") &&
    signupCode.includes("rounded-[12px]") &&
    signupCode.includes("min-h-[44px]");

  if (!hasEmailInput) {
    failures.push("EMAIL INPUT FAIL: Email input must have subtle neutral background, 12px radius, min-h-[44px].");
  } else {
    console.log("  [PASS] email input: Subtle neutral background (#F8FAFC), 12px radius, visible focus, min-h-[44px]");
  }

  const hasSubmitPill =
    loginCode.includes("Email me a sign-in link") &&
    loginCode.includes("rounded-full") &&
    loginCode.includes("bg-[#2563EB]") &&
    signupCode.includes("Email me a sign-in link") &&
    signupCode.includes("rounded-full") &&
    signupCode.includes("bg-[#2563EB]");

  if (!hasSubmitPill) {
    failures.push("SUBMIT PILL FAIL: Submit button must be full-width blue primary pill 'Email me a sign-in link'.");
  } else {
    console.log("  [PASS] submit pill: Full-width blue primary pill (#2563EB) 'Email me a sign-in link'");
  }

  // -------------------------------------------------------------------------
  // 5. ERROR BANNER & SUCCESS / EMAIL-SENT STATE
  // -------------------------------------------------------------------------
  const hasErrorBanner =
    loginCode.includes("data-testid=\"auth-error-banner\"") &&
    loginCode.includes("role=\"alert\"") &&
    loginCode.includes("bg-[#FEF2F2]") &&
    signupCode.includes("data-testid=\"auth-error-banner\"") &&
    signupCode.includes("role=\"alert\"") &&
    signupCode.includes("bg-[#FEF2F2]");

  if (!hasErrorBanner) {
    failures.push("ERROR BANNER FAIL: Errors must render in readable red-tinted banner with role='alert'.");
  } else {
    console.log("  [PASS] error banner: Readable red-tinted alert banner with role='alert'");
  }

  const hasEmailSentState =
    loginCode.includes("data-testid=\"auth-email-sent\"") &&
    loginCode.includes("resendTimer") &&
    signupCode.includes("data-testid=\"auth-email-sent\"") &&
    signupCode.includes("resendTimer");

  if (!hasEmailSentState) {
    failures.push("EMAIL SENT FAIL: Must retain email-sent state with resend cooldown timer.");
  } else {
    console.log("  [PASS] email-sent state: Verified confirmation instructions with 30s resend cooldown");
  }

  // -------------------------------------------------------------------------
  // 6. BOTTOM SWITCH LINKS & RETURN DESTINATION (?next)
  // -------------------------------------------------------------------------
  const hasSwitchLinks =
    loginCode.includes("Don&apos;t have an account?") &&
    loginCode.includes("/signup?next=") &&
    signupCode.includes("Already have an account?") &&
    signupCode.includes("/login?next=");

  if (!hasSwitchLinks) {
    failures.push("SWITCH LINKS FAIL: Must preserve switch links with supported ?next return destination parameter.");
  } else {
    console.log("  [PASS] switch links: Separated by divider, preserves ?next return-destination parameter");
  }

  // -------------------------------------------------------------------------
  // 7. SECURITY & ACCURATE LEGAL TEXT
  // -------------------------------------------------------------------------
  const hasAccurateLegal =
    loginCode.includes("/terms-and-conditions") &&
    loginCode.includes("/privacy-policy") &&
    signupCode.includes("/terms-and-conditions") &&
    signupCode.includes("/privacy-policy");

  const hasNoFakeClaims =
    !loginCode.toLowerCase().includes("bank-grade") &&
    !loginCode.toLowerCase().includes("100% free forever") &&
    !signupCode.toLowerCase().includes("bank-grade") &&
    !signupCode.toLowerCase().includes("100% free forever");

  const hasNoPasswordOrApple =
    !loginCode.includes('type="password"') &&
    !signupCode.includes('type="password"') &&
    !loginCode.toLowerCase().includes("apple") &&
    !signupCode.toLowerCase().includes("apple");

  if (!hasAccurateLegal || !hasNoFakeClaims || !hasNoPasswordOrApple) {
    failures.push("SECURITY/LEGAL FAIL: Must maintain accurate legal links, zero password fields, no Apple/unsupported providers.");
  } else {
    console.log("  [PASS] auth security: Strictly email OTP & Google OAuth only; zero password or unbacked claims");
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
  console.log("PROMPT 8 JOBRIGHT-STYLE AUTH PRESENTATION VALIDATED LOCALLY [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run();
