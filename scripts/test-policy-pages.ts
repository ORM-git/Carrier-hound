/**
 * scripts/test-policy-pages.ts
 *
 * Verification suite for the 5 CareerMonke legal & policy routes:
 * 1. /terms-and-conditions (Google Doc Tab 1)
 * 2. /privacy-policy and /privacy (Google Doc Tab 2)
 * 3. /contact (Google Doc Tab 3)
 * 4. /refund-policy ("Cancellation & Refund Policy")
 * 5. /shipping-and-delivery ("Shipping & Delivery Policy")
 *
 * Strict negative control included per permanent rules.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spawnSync } from "child_process";

import TermsPage from "../src/app/terms-and-conditions/page";
import PrivacyPolicyPage from "../src/app/privacy-policy/page";
import ContactUsPage from "../src/app/contact/page";
import RefundPolicyPage from "../src/app/refund-policy/page";
import ShippingAndDeliveryPage from "../src/app/shipping-and-delivery/page";
import sitemap from "../src/app/sitemap";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

async function main() {
  console.log("================================================================================");
  console.log("       CAREERMONKE 5 LEGAL & POLICY ROUTES COMPLIANCE VERIFICATION SUITE       ");
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

  // 1. Render All 5 Target Policy Pages via react-dom/server
  console.log("1. Rendering all 5 policy pages to static markup via react-dom/server...");

  const termsHtml = renderToStaticMarkup(React.createElement(TermsPage));
  assert.ok(termsHtml && termsHtml.length > 500, "TermsPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /terms-and-conditions rendered successfully (${termsHtml.length} bytes)`);

  const privacyHtml = renderToStaticMarkup(React.createElement(PrivacyPolicyPage));
  assert.ok(privacyHtml && privacyHtml.length > 500, "PrivacyPolicyPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /privacy-policy rendered successfully (${privacyHtml.length} bytes)`);

  const contactHtml = renderToStaticMarkup(React.createElement(ContactUsPage));
  assert.ok(contactHtml && contactHtml.length > 200, "ContactUsPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /contact rendered successfully (${contactHtml.length} bytes)`);

  const refundHtml = renderToStaticMarkup(React.createElement(RefundPolicyPage));
  assert.ok(refundHtml && refundHtml.length > 200, "RefundPolicyPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /refund-policy rendered successfully (${refundHtml.length} bytes)`);

  const shippingHtml = renderToStaticMarkup(React.createElement(ShippingAndDeliveryPage));
  assert.ok(shippingHtml && shippingHtml.length > 200, "ShippingAndDeliveryPage must render non-empty HTML");
  console.log(`  [PASS-LOCAL] /shipping-and-delivery rendered successfully (${shippingHtml.length} bytes)`);

  // 2. /terms-and-conditions Key Phrases (Google Doc Tab 1)
  console.log("\n2. Verifying /terms-and-conditions key phrases (Google Doc Tab 1)...");
  const termsPhrases = [
    "Terms and Conditions",
    "Olive Ridley Media Private Limited",
    "CareerMonke",
    "1. Services Provided",
    "2. Eligibility and User Accounts",
    "3. Billing, Pricing, and Subscriptions",
    "weekly, monthly and quarterly",
    "plans are prepaid for a fixed duration and do not auto-renew; renew or upgrade extends your period",
    "Razorpay",
    "4. Cancellation and Account Rules",
    "Cancellation &amp; Refund Policy",
    "5. Intellectual Property &amp; Acceptable Use",
    "6. Limitation of Liability &amp; Disclaimer",
    "7. Governing Law and Jurisdiction",
    "Bhubaneswar, India",
  ];
  for (const phrase of termsPhrases) {
    assert.ok(termsHtml.includes(phrase), `/terms-and-conditions must contain "${phrase}"`);
    console.log(`  [PASS-LOCAL] /terms-and-conditions contains: "${phrase}"`);
  }
  assert.ok(!termsHtml.includes("Stripe"), "/terms-and-conditions must NOT contain Stripe (Razorpay only)");
  console.log('  [PASS-LOCAL] /terms-and-conditions excludes Stripe (Razorpay only)');

  // 3. /privacy-policy Key Phrases (Google Doc Tab 2)
  console.log("\n3. Verifying /privacy-policy key phrases (Google Doc Tab 2)...");
  const privacyPhrases = [
    "Privacy Policy",
    "Olive Ridley Media Private Limited",
    "1. Information We Collect",
    "2. Legal Basis and How We Use Your Data",
    "Razorpay Software Private Limited",
    "Stripe, Inc.",
    "3. Data Sharing and International Transfers",
    "4. Global Privacy Rights &amp; Compliance",
    "Indian Users (DPDP Act Compliance)",
    "European Union Users (GDPR Compliance)",
    "California Users (CCPA Compliance)",
    "support@careermonke.com",
    "5. Data Retention Boundaries",
    "6. Cookies and Tracking Mechanisms",
  ];
  for (const phrase of privacyPhrases) {
    assert.ok(privacyHtml.includes(phrase), `/privacy-policy must contain "${phrase}"`);
    console.log(`  [PASS-LOCAL] /privacy-policy contains: "${phrase}"`);
  }

  // 4. /contact Key Details (Google Doc Tab 3)
  console.log("\n4. Verifying /contact key details (Google Doc Tab 3)...");
  const contactPhrases = [
    "Contact Us",
    "Brand Platform",
    "CareerMonke",
    "Corporate Legal Entity",
    "Olive Ridley Media Private Limited",
    "Registered Office / Corporate Address",
    "BLOCK-C2, 7TH FLOOR, FLAT NO-712, BALAJI COMPLEX, BLOCK-C2, JHARPADA, BHUBANESWAR, Khordha, Odisha, 751006",
    "Primary Support Email",
    "support@careermonke.com",
    "Grievance Officer / Customer Support Helpline",
    "+91-9124618200",
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
    "all sales final",
    "duplicate or failed-but-debited payment",
    "5-7 business days",
    "support@careermonke.com",
    "order id",
    "Olive Ridley Media Private Limited",
  ];
  for (const phrase of refundPhrases) {
    assert.ok(refundHtml.includes(phrase), `/refund-policy must contain "${phrase}"`);
    console.log(`  [PASS-LOCAL] /refund-policy contains: "${phrase}"`);
  }

  // 6. /shipping-and-delivery Key Phrases
  console.log("\n6. Verifying /shipping-and-delivery key phrases...");
  const shippingPhrases = [
    "Shipping &amp; Delivery Policy",
    "electronic SaaS",
    "no physical shipping",
    "access and credits activated instantly after payment confirmation",
    "support@careermonke.com",
    "order id",
    "Olive Ridley Media Private Limited",
  ];
  for (const phrase of shippingPhrases) {
    assert.ok(shippingHtml.includes(phrase), `/shipping-and-delivery must contain "${phrase}"`);
    console.log(`  [PASS-LOCAL] /shipping-and-delivery contains: "${phrase}"`);
  }

  // 7. Footer Legal Links and Corporate Legal Line
  console.log("\n7. Verifying Footer legal links and corporate legal line...");
  const footerContent = fs.readFileSync(path.resolve(__dirname, "../src/components/Footer.tsx"), "utf8");
  assert.ok(footerContent.includes('href="/refund-policy"'), "Footer must link to /refund-policy");
  assert.ok(footerContent.includes('href="/contact"'), "Footer must link to /contact");
  assert.ok(footerContent.includes('href="/shipping-and-delivery"'), "Footer must link to /shipping-and-delivery");
  assert.ok(
    footerContent.includes("Olive Ridley Media Private Limited. All rights reserved."),
    "Footer legal line must feature Olive Ridley Media Private Limited"
  );
  assert.ok(
    !footerContent.includes("CareerMonke Inc. All rights reserved."),
    "Footer legal line must NOT feature CareerMonke Inc."
  );
  console.log("  [PASS-LOCAL] Footer contains links to /refund-policy, /contact, and /shipping-and-delivery");
  console.log("  [PASS-LOCAL] Footer legal line features Olive Ridley Media Private Limited");

  // 8. Sitemap Verification
  console.log("\n8. Verifying sitemap entries...");
  const sitemapEntries = sitemap();
  const sitemapUrls = sitemapEntries.map((e) => e.url);
  assert.ok(sitemapUrls.some((u) => u.endsWith("/refund-policy")), "Sitemap must contain /refund-policy");
  assert.ok(sitemapUrls.some((u) => u.endsWith("/contact")), "Sitemap must contain /contact");
  assert.ok(sitemapUrls.some((u) => u.endsWith("/shipping-and-delivery")), "Sitemap must contain /shipping-and-delivery");
  console.log("  [PASS-LOCAL] Sitemap contains all 3 new policy routes (5 total entries)");

  console.log("\n================================================================================");
  console.log("ALL 5 POLICY PAGES & LEGAL COMPLIANCE TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
