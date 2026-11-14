/**
 * scripts/test-policy-pages.ts
 *
 * Verification suite for the 4 CareerMonke legal & policy routes:
 * 1. /terms-and-conditions (Google Doc Tab 1)
 * 2. /privacy-policy and /privacy (Google Doc Tab 2)
 * 3. /contact (Google Doc Tab 3)
 * 4. /refund-policy ("Cancellation & Refund Policy")
 *
 * Phrase lists updated 2026-11-06 for the Razorpay-review copy (PR #350).
 * NOTE: the source Google Doc tabs still carry the old copy and need the
 * same update owner-side; this suite now asserts the revised pages.
 *
 * Strict negative control included per permanent rules.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spawnSync } from "child_process";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import TermsPage from "../src/app/terms-and-conditions/page";
import PrivacyPolicyPage from "../src/app/privacy-policy/page";
import ContactUsPage from "../src/app/contact/page";
import RefundPolicyPage from "../src/app/refund-policy/page";
import sitemap from "../src/app/sitemap";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

const mockRouter: any = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
};

// Policy pages render the shared <Footer />, which needs the App Router pathname context.
function renderWithPathname(element: React.ReactElement, pathname: string): string {
  return renderToStaticMarkup(
    React.createElement(
      AppRouterContext.Provider,
      { value: mockRouter },
      React.createElement(PathnameContext.Provider, { value: pathname }, element)
    )
  );
}

async function main() {
  console.log("================================================================================");
  console.log("       CAREERMONKE 4 LEGAL & POLICY ROUTES COMPLIANCE VERIFICATION SUITE       ");
  console.log("================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("[NEGATIVE CONTROL MODE] Intentionally testing negative control assertion...");
    assert.strictEqual(
      "expected phrase",
      "non-existent phrase",
      "Negative control triggered intentional mismatch to prove non-zero exit."
    );
    return;
  }

  // 0. Negative Control Verification via Subprocess
  console.log("0. Spawning negative control child process to verify non-zero exit on failure...");
  const tsxNeg = spawnSync("npx", ["tsx", "scripts/test-policy-pages.ts", "--negative-control"], {
    encoding: "utf8",
    shell: true,
  });
  assert.strictEqual(tsxNeg.status, 1, `Negative control must exit with code 1 (got ${tsxNeg.status})`);
  console.log("  [PASS-LOCAL] Negative control exited with code 1\n");

  // 1. Render All 4 Target Policy Pages via react-dom/server
  console.log("1. Rendering all 4 policy pages to static markup via react-dom/server...");

  const termsHtml = renderWithPathname(React.createElement(TermsPage), "/terms-and-conditions");
  assert.ok(termsHtml && termsHtml.length > 500, "TermsPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /terms-and-conditions rendered successfully (${termsHtml.length} bytes)`);

  const privacyHtml = renderWithPathname(React.createElement(PrivacyPolicyPage), "/privacy-policy");
  assert.ok(privacyHtml && privacyHtml.length > 500, "PrivacyPolicyPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /privacy-policy rendered successfully (${privacyHtml.length} bytes)`);

  const contactHtml = renderWithPathname(React.createElement(ContactUsPage), "/contact");
  assert.ok(contactHtml && contactHtml.length > 200, "ContactUsPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /contact rendered successfully (${contactHtml.length} bytes)`);

  const refundHtml = renderWithPathname(React.createElement(RefundPolicyPage), "/refund-policy");
  assert.ok(refundHtml && refundHtml.length > 200, "RefundPolicyPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /refund-policy rendered successfully (${refundHtml.length} bytes)`);

  // 2. /terms-and-conditions Key Phrases (Google Doc Tab 1)
  console.log("\n2. Verifying /terms-and-conditions key phrases (Google Doc Tab 1)...");
  const termsPhrases = [
    "Terms and Conditions",
    "Olive Ridley Media Private Limited",
    "CareerMonke",
    "1. Services Provided",
    "2. Eligibility and User Accounts",
    "3. Plans, Pricing, and Add-ons",
    "proprietary ingestion tools",
    "Current prices are shown on the",
    "Pricing page",
    "plans are prepaid for a fixed period and do not renew automatically",
    "Add-on packs:",
    "expire together with the subscription",
    "Razorpay",
    "4. Cancellation, Renewal, and Access After Cancellation",
    "Cancellation &amp; Refund Policy",
    "5. Intellectual Property &amp; Acceptable Use",
    "6. Limitation of Liability &amp; Disclaimer",
    "7. Governing Law and Jurisdiction",
    "Bhubaneswar, India",
    "© 2026 Olive Ridley Media Private Limited. All rights reserved.",
  ];
  for (const phrase of termsPhrases) {
    assert.ok(termsHtml.includes(phrase), `/terms-and-conditions must contain "${phrase}"`);
    console.log(`  [PASS-LOCAL] /terms-and-conditions contains: "${phrase}"`);
  }
  assert.ok(!termsHtml.includes("Stripe"), "/terms-and-conditions must NOT contain Stripe (Razorpay only)");
  console.log('  [PASS-LOCAL] /terms-and-conditions excludes Stripe (Razorpay only)');
  for (const hardcodedPrice of ["₹692", "₹1,499", "₹3,999", "₹149", "₹399", "₹699"]) {
    assert.ok(!termsHtml.includes(hardcodedPrice), `/terms-and-conditions must NOT hard-code price "${hardcodedPrice}" (prices live on /pricing; final prices pending founders)`);
  }
  console.log('  [PASS-LOCAL] /terms-and-conditions hard-codes no INR amounts (prices live on /pricing)');

  // 3. /privacy-policy Key Phrases (Google Doc Tab 2)
  console.log("\n3. Verifying /privacy-policy key phrases (Google Doc Tab 2)...");
  const privacyPhrases = [
    "Privacy Policy",
    "Olive Ridley Media Private Limited",
    "1. Information We Collect",
    "2. Legal Basis and How We Use Your Data",
    "Razorpay Software Private Limited",
    "3. How Our AI Features Process Your Resume Data",
    "Groq, Inc.",
    "4. Data Sharing and Service Providers",
    "5. Your Privacy Rights and How to Exercise Them",
    "Digital Personal Data Protection (DPDP) Act",
    "support@careermonke.com",
    "6. Data Retention",
    "7. Security Practices",
    "8. Grievance Officer",
    "Binit Kumar",
    "9. Cookies and Tracking Mechanisms",
    "© 2026 Olive Ridley Media Private Limited. All rights reserved.",
  ];
  for (const phrase of privacyPhrases) {
    assert.ok(privacyHtml.includes(phrase), `/privacy-policy must contain "${phrase}"`);
    console.log(`  [PASS-LOCAL] /privacy-policy contains: "${phrase}"`);
  }
  for (const banned of ["Stripe", "GDPR Compliance", "CCPA Compliance", "absolute right to be forgotten"]) {
    assert.ok(!privacyHtml.includes(banned), `/privacy-policy must NOT contain "${banned}"`);
  }
  console.log('  [PASS-LOCAL] /privacy-policy excludes Stripe and blanket GDPR/CCPA/"absolute erasure" claims');

  // 4. /contact Key Details (Google Doc Tab 3)
  console.log("\n4. Verifying /contact key details (Google Doc Tab 3)...");
  const contactPhrases = [
    "Contact Us",
    "Brand Platform",
    "CareerMonke",
    "Corporate Legal Entity",
    "Olive Ridley Media Private Limited",
    "Registered Office:",
    "Flat No. 712, 7th Floor, Block C-2, Balaji Complex, Jharpada, Bhubaneswar, Khordha, Odisha 751006, India",
    "Support Email:",
    "support@careermonke.com",
    "Grievance Officer",
    "Binit Kumar",
    "+91-9124618200",
    "5-7 working days",
    "© 2026 Olive Ridley Media Private Limited. All rights reserved.",
  ];
  for (const phrase of contactPhrases) {
    assert.ok(contactHtml.includes(phrase), `/contact must contain "${phrase}"`);
    console.log(`  [PASS-LOCAL] /contact contains: "${phrase}"`);
  }

  // 5. /refund-policy Key Phrases
  console.log("\n5. Verifying /refund-policy key phrases...");
  const refundPhrases = [
    "Cancellation &amp; Refund Policy",
    "prepaid fixed-duration plans and add-on packs",
    "all sales are final",
    "no recurring charges",
    "when offered, are valid for 60 days from purchase",
    "duplicate or failed-but-debited payment",
    "5-7 business days",
    "5-7 working days",
    "support@careermonke.com",
    "order id",
    "Olive Ridley Media Private Limited",
    "© 2026 Olive Ridley Media Private Limited. All rights reserved.",
  ];
  for (const phrase of refundPhrases) {
    assert.ok(refundHtml.includes(phrase), `/refund-policy must contain "${phrase}"`);
    console.log(`  [PASS-LOCAL] /refund-policy contains: "${phrase}"`);
  }

  // 7. Footer Legal Links and Corporate Legal Line
  console.log("\n7. Verifying Footer legal links and corporate legal line...");
  const footerContent = fs.readFileSync(path.resolve(__dirname, "../src/components/Footer.tsx"), "utf8");
  assert.ok(footerContent.includes('href="/refund-policy"'), "Footer must link to /refund-policy");
  assert.ok(footerContent.includes('href="/contact"'), "Footer must link to /contact");
  assert.ok(!footerContent.includes('href="/shipping-and-delivery"'), "Footer must NOT link to /shipping-and-delivery (digital SaaS, no physical shipping)");
  assert.ok(
    footerContent.includes("© 2026 Olive Ridley Media Private Limited. All rights reserved."),
    "Footer legal line must feature exact line '© 2026 Olive Ridley Media Private Limited. All rights reserved.'"
  );
  assert.ok(
    !footerContent.includes("CareerMonke Inc. All rights reserved."),
    "Footer legal line must NOT feature CareerMonke Inc."
  );
  console.log("  [PASS-LOCAL] Footer contains links to /refund-policy and /contact, and excludes /shipping-and-delivery");
  console.log("  [PASS-LOCAL] Footer legal line features Olive Ridley Media Private Limited");

  // 8. Sitemap Verification
  console.log("\n8. Verifying sitemap entries...");
  const sitemapEntries = sitemap();
  const sitemapUrls = sitemapEntries.map((e) => e.url);
  assert.ok(sitemapUrls.some((u) => u.endsWith("/refund-policy")), "Sitemap must contain /refund-policy");
  assert.ok(sitemapUrls.some((u) => u.endsWith("/contact")), "Sitemap must contain /contact");
  assert.ok(!sitemapUrls.some((u) => u.endsWith("/shipping-and-delivery")), "Sitemap must NOT contain /shipping-and-delivery (digital SaaS, no physical shipping)");
  console.log("  [PASS-LOCAL] Sitemap contains the policy routes and excludes /shipping-and-delivery");

  console.log("\n================================================================================");
  console.log("ALL 4 POLICY PAGES & LEGAL COMPLIANCE TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
