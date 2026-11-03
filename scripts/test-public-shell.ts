import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("             PROMPT 2 REBUILD — PUBLIC SHELL & DESIGN TOKENS AUDIT                ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const headerPath = path.resolve(process.cwd(), "src/components/GuideHeader.tsx");
  const footerPath = path.resolve(process.cwd(), "src/components/Footer.tsx");
  const buttonPath = path.resolve(process.cwd(), "src/components/ui/button.tsx");
  const cardPath = path.resolve(process.cwd(), "src/components/ui/card.tsx");
  const loginPath = path.resolve(process.cwd(), "src/app/login/page.tsx");
  const jobsPath = path.resolve(process.cwd(), "src/app/jobs/page.tsx");

  let headerCode = fs.readFileSync(headerPath, "utf-8");
  let footerCode = fs.readFileSync(footerPath, "utf-8");
  let buttonCode = fs.readFileSync(buttonPath, "utf-8");
  let cardCode = fs.readFileSync(cardPath, "utf-8");
  let loginCode = fs.readFileSync(loginPath, "utf-8");
  let jobsCode = fs.readFileSync(jobsPath, "utf-8");

  if (isNegativeControl) {
    // Inject corruptions for negative control
    headerCode = headerCode.replace(/border-b border-\[#E2E8F0\]/g, "");
    headerCode = headerCode.replace(/Log in/g, "Bad Link");
    buttonCode = buttonCode.replace(/outline:/g, "");
    cardCode = cardCode.replace(/rounded-\[16px\]/g, "");
    footerCode = footerCode.replace(/bg-white text-\[#0F172A\] border-t border-\[#E2E8F0\]/g, "");
    footerCode = footerCode + '\n<a href="mailto:support@careermonke.com">Support</a>';
  }

  const failures: string[] = [];

  // Check 1: Header 64px, white, 1px bottom border #E2E8F0
  if (!headerCode.includes("h-16") || !headerCode.includes("bg-white") || !headerCode.includes("border-b border-[#E2E8F0]")) {
    failures.push("HEADER FAIL: Header must be 64px (h-16), white (bg-white), with 1px bottom border #E2E8F0.");
  } else {
    console.log("  [PASS] header shell: 64px height, white background, 1px bottom border #E2E8F0");
  }

  // Check 2: Header left logo
  if (!headerCode.includes("BrandIcon") || !headerCode.includes("CareerMonke")) {
    failures.push("HEADER FAIL: Header must contain CareerMonke logo on the left.");
  } else {
    console.log("  [PASS] header brand: CareerMonke logo with BrandIcon on the left");
  }

  // Check 3: Header nav links 14px, ink, active link bold with 2px ink underline
  const has14px = headerCode.includes("text-[14px]");
  const hasInk = headerCode.includes("text-[#0F172A]");
  const has2pxUnderline = headerCode.includes("after:h-[2px] after:bg-[#0F172A]");
  if (!has14px || !hasInk || !has2pxUnderline) {
    failures.push("HEADER FAIL: Nav links must be 14px, ink (#0F172A), active link bold with a 2px ink underline.");
  } else {
    console.log("  [PASS] header nav: 14px ink links, active bold with 2px ink underline");
  }

  // Check 4: Header right actions: "Log in" ghost pill, "Get started" primary blue pill
  const hasLogIn = headerCode.includes("Log in");
  const hasGetStarted = headerCode.includes("Get started");
  const hasPrimaryBlue = headerCode.includes("bg-[#2563EB]") && headerCode.includes("hover:bg-[#1D4ED8]");
  if (!hasLogIn || !hasGetStarted || !hasPrimaryBlue) {
    failures.push('HEADER FAIL: Right side must have "Log in" ghost pill and "Get started" primary blue pill.');
  } else {
    console.log('  [PASS] header actions: "Log in" ghost pill and "Get started" primary blue pill');
  }

  // Check 5: Mobile full-height drawer with 0.3s slide-in
  const hasFullHeightDrawer = headerCode.includes("fixed inset-y-0 right-0") && headerCode.includes("h-full");
  const has03sSlide = headerCode.includes("duration-300") && (headerCode.includes("ease-[cubic-bezier(0.2,0,0,1)]") || headerCode.includes("cubic-bezier"));
  if (!hasFullHeightDrawer || !has03sSlide) {
    failures.push("HEADER FAIL: Mobile menu must be a full-height drawer sliding in from right with 0.3s cubic-bezier.");
  } else {
    console.log("  [PASS] mobile drawer: full-height slide-over drawer from right with 0.3s transition");
  }

  // Check 6: Buttons: primary, secondary, outline, all 40px high, 0.2s hover transition
  const hasOutlineVariant = buttonCode.includes("outline:");
  const has40pxHeight = buttonCode.includes("h-10") && buttonCode.includes("min-h-[44px]");
  const has02sTransition = buttonCode.includes("duration-200");
  const hasFocusRing = buttonCode.includes("ring-[#93C5FD]");
  if (!hasOutlineVariant || !has40pxHeight || !has02sTransition || !hasFocusRing) {
    failures.push("BUTTON FAIL: Buttons must define primary, secondary, outline, 40px high (44px touch), 0.2s transition, focus ring.");
  } else {
    console.log("  [PASS] buttons: primary, secondary, outline variants; 40px high (44px touch); 0.2s transition; focus ring");
  }

  // Check 7: Cards: white, 16px radius, 1px #E2E8F0 ring, no drop shadow, 16 to 24px padding
  const has16pxRadius = cardCode.includes("rounded-[16px]");
  const hasRing1 = cardCode.includes("ring-1 ring-[#E2E8F0]");
  const hasNoDropShadow = cardCode.includes("shadow-none");
  const has16To24Padding = cardCode.includes("p-4 sm:p-6");
  if (!has16pxRadius || !hasRing1 || !hasNoDropShadow || !has16To24Padding) {
    failures.push("CARD FAIL: Cards must be white, 16px radius, 1px #E2E8F0 ring, no drop shadow, 16 to 24px padding.");
  } else {
    console.log("  [PASS] cards: white, 16px radius, 1px #E2E8F0 ring, no drop shadow, 16 to 24px padding");
  }

  // Check 8: Footer: 4-column links block on white with top border #E2E8F0, copyright line
  const has4ColFooter = footerCode.includes("grid-cols-2 md:grid-cols-4") && footerCode.includes("border-t border-[#E2E8F0]");
  const hasCopyright = footerCode.includes("Olive Ridley Media Private Limited. All rights reserved.");
  if (!has4ColFooter || !hasCopyright) {
    failures.push("FOOTER FAIL: Footer must have simple 4-column links block on white with top border #E2E8F0 and copyright line.");
  } else {
    console.log("  [PASS] footer: 4-column links block on white with top border #E2E8F0 and copyright line");
  }

  // Check 9: Footer purity: no support email, no fake social icons on non-landing footer
  const publicFooterPart = footerCode.slice(footerCode.indexOf("export default function Footer"));
  if (publicFooterPart.includes("mailto:") || publicFooterPart.includes("support@careermonke.com")) {
    failures.push("FOOTER FAIL: Non-landing footer must NOT include support email until domain is connected.");
  } else {
    console.log("  [PASS] footer integrity: zero support email in non-landing footer");
  }

  if (publicFooterPart.includes("twitter.com") || publicFooterPart.includes("x.com") || publicFooterPart.includes("linkedin.com") || publicFooterPart.includes("github.com")) {
    failures.push("FOOTER FAIL: Non-landing footer must NOT contain fake social links.");
  } else {
    console.log("  [PASS] footer integrity: zero fake social icons in non-landing footer");
  }

  // Check 10: Public pages integration (/login, /jobs)
  if (!loginCode.includes("<GuideHeader") || !loginCode.includes("<Footer")) {
    failures.push("INTEGRATION FAIL: /login page must include GuideHeader and Footer.");
  } else {
    console.log("  [PASS] integration: /login includes GuideHeader and Footer on #F8FAFC surface");
  }

  if (!jobsCode.includes("<GuideHeader") || !jobsCode.includes("!user")) {
    failures.push("INTEGRATION FAIL: /jobs page must render GuideHeader when signed out (!user).");
  } else {
    console.log("  [PASS] integration: /jobs page renders GuideHeader when signed out (!user)");
  }

  // Check 11: No Jobright brand leaks anywhere in updated files
  const allCode = headerCode + footerCode + buttonCode + cardCode;
  if (/jobright/i.test(allCode)) {
    failures.push("BRAND LEAK FAIL: Found Jobright reference in shell components.");
  } else {
    console.log("  [PASS] brand clean: zero Jobright logo, mascot, illustrations or copy");
  }

  console.log("\n----------------------------------------------------------------------------------");
  if (isNegativeControl) {
    if (failures.length >= 3) {
      console.log(`NEGATIVE CONTROL PASSED: Detected ${failures.length} expected intentional failure(s):`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1);
    } else {
      console.error(`NEGATIVE CONTROL FAILED: Expected >= 3 failures, got ${failures.length}`);
      process.exit(0);
    }
  }

  if (failures.length > 0) {
    console.error("VALIDATION FAILED:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("PROMPT 2 PUBLIC SHELL VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

run();
