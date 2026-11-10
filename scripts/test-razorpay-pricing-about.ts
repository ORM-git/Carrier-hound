/**
 * Verification Suite for Razorpay Review Frontend Changes (/pricing, /about, Terms, Footers)
 *
 * Usage:
 *   npx tsx scripts/test-razorpay-pricing-about.ts
 *   npx tsx scripts/test-razorpay-pricing-about.ts --negative-control
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { middleware, PUBLIC_ROUTES, PROTECTED_ROUTES } from "../src/middleware";
import { PLANS, ADD_ON_PACKS, ADD_ON_PACKS_NOTE, PLAN_QUOTA_SUMMARY_NOTE, formatPriceINR } from "../src/config/plans";
import { PLAN_DEFINITIONS } from "../src/lib/billing/quota";
import PricingPage from "../src/app/pricing/page";
import AboutUsPage from "../src/app/about/page";
import TermsPage from "../src/app/terms-and-conditions/page";
import PrivacyPolicyPage from "../src/app/privacy-policy/page";
import Footer from "../src/components/Footer";

const mockRouter: any = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
};

function renderWithPathname(element: React.ReactElement, pathname: string): string {
  return renderToStaticMarkup(
    React.createElement(
      AppRouterContext.Provider,
      { value: mockRouter },
      React.createElement(PathnameContext.Provider, { value: pathname }, element)
    )
  );
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function runTests() {
  console.log("================================================================================");
  console.log("   RAZORPAY REVIEW FRONTEND SUITE (/pricing, /about, Terms, Footers)           ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");
  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL] Asserting intentional failure condition...");
    const fakePricingText = "Get early access to Planned add-on packs valid for 60 days";
    assert.strictEqual(
      /early[\s-]*access/i.test(fakePricingText),
      false,
      "Negative control expected failure: 'early access' string detected on pricing page"
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // 1. Auth Gating: Signed-out /pricing and /about load without redirect;
  //    all protected routes still redirect when signed out
  // ---------------------------------------------------------------------------
  console.log("\n1. Verifying middleware auth gating for signed-out visitors...");
  assert.ok(PUBLIC_ROUTES.includes("/pricing"), "PUBLIC_ROUTES must include /pricing");
  assert.ok(PUBLIC_ROUTES.includes("/about"), "PUBLIC_ROUTES must include /about");

  for (const publicRoute of ["/pricing", "/about"]) {
    const req = new NextRequest(`https://careermonke.com${publicRoute}`, { method: "GET" });
    const res = await middleware(req);
    assert.strictEqual(
      res.status,
      200,
      `Signed-out GET ${publicRoute} must return 200 without redirect, got ${res.status}`
    );
    assert.strictEqual(
      res.headers.get("location"),
      null,
      `Signed-out GET ${publicRoute} must have no Location redirect header`
    );
    console.log(`  [PASS-LOCAL] Signed-out ${publicRoute} -> 200 OK (no redirect)`);
  }

  for (const protectedRoute of PROTECTED_ROUTES) {
    const req = new NextRequest(`https://careermonke.com${protectedRoute}`, { method: "GET" });
    const res = await middleware(req);
    assert.strictEqual(
      res.status,
      307,
      `Signed-out GET ${protectedRoute} must still redirect (307), got ${res.status}`
    );
    const location = res.headers.get("location") || "";
    assert.ok(
      location.includes("/early-access") || location.includes("/login"),
      `Signed-out GET ${protectedRoute} must redirect to auth/gate, got ${location}`
    );
    console.log(`  [PASS-LOCAL] Protected route ${protectedRoute} still redirects (307 -> ${location})`);
  }

  // ---------------------------------------------------------------------------
  // 2. Navbar and Footer Links: "Pricing" -> /pricing, "About Us" -> /about
  // ---------------------------------------------------------------------------
  console.log("\n2. Verifying navbar and footer 'Pricing' (/pricing) and 'About Us' (/about) links...");
  const rootDir = path.resolve(__dirname, "..");
  const guideHeaderSrc = fs.readFileSync(path.join(rootDir, "src/components/GuideHeader.tsx"), "utf-8");
  const appTopBarSrc = fs.readFileSync(path.join(rootDir, "src/components/shell/AppTopBar.tsx"), "utf-8");
  const appIconRailSrc = fs.readFileSync(path.join(rootDir, "src/components/shell/AppIconRail.tsx"), "utf-8");
  const footerSrc = fs.readFileSync(path.join(rootDir, "src/components/Footer.tsx"), "utf-8");

  assert.ok(guideHeaderSrc.includes('href="/pricing"'), "GuideHeader must link to /pricing");
  assert.ok(appTopBarSrc.includes('href="/pricing"'), "AppTopBar must link to /pricing");
  assert.ok(appIconRailSrc.includes('href: "/pricing"'), "AppIconRail must link to /pricing");

  const landingFooterHtml = renderWithPathname(React.createElement(Footer), "/");
  const publicFooterHtml = renderWithPathname(React.createElement(Footer), "/pricing");

  assert.ok(
    landingFooterHtml.includes('href="/pricing"') && !footerSrc.includes('href="/early-access" prefetch={false} className={landingFooterLinkClass}>\n                    Pricing & Plans'),
    "Landing footer 'Pricing & Plans' link must go straight to /pricing"
  );
  assert.ok(landingFooterHtml.includes('href="/about"'), "Landing footer must include 'About Us' link (/about)");
  assert.ok(publicFooterHtml.includes('href="/pricing"'), "Public footer must include 'Pricing' link (/pricing)");
  assert.ok(publicFooterHtml.includes('href="/about"'), "Public footer must include 'About Us' link (/about)");

  for (const relFile of [
    "src/app/early-access/page.tsx",
    "src/app/privacy-policy/page.tsx",
    "src/app/terms-and-conditions/page.tsx",
    "src/app/refund-policy/page.tsx",
    "src/app/contact/page.tsx",
    "src/app/about/page.tsx",
  ]) {
    const src = fs.readFileSync(path.join(rootDir, relFile), "utf-8");
    assert.ok(src.includes('href="/about"'), `${relFile} footer must contain href="/about"`);
  }
  console.log("  [PASS-LOCAL] Navbar and footer 'Pricing' and 'About Us' links verified across public pages.");

  // ---------------------------------------------------------------------------
  // 3. /pricing Page: Configured Plans, Prices, Limits, Payments OFF,
  //    No "early access", "Payments will open soon.", Add-on Packs Section
  // ---------------------------------------------------------------------------
  console.log("\n3. Verifying /pricing rendered content, plans, add-on packs, and payments OFF...");
  const pricingSrc = fs.readFileSync(path.join(rootDir, "src/app/pricing/page.tsx"), "utf-8");
  const pricingHtml = renderWithPathname(React.createElement(PricingPage), "/pricing");
  const pricingText = stripTags(pricingHtml);

  // Every configured paid plan name, INR price, and quota subLine
  for (const plan of PLANS) {
    assert.ok(pricingText.includes(plan.name), `/pricing must display plan name '${plan.name}'`);
    assert.ok(
      pricingText.includes(formatPriceINR(plan.price)),
      `/pricing must display configured INR price '${formatPriceINR(plan.price)}' for ${plan.name}`
    );
    assert.ok(
      pricingText.includes(plan.subLine),
      `/pricing must display configured usage limit '${plan.subLine}' for ${plan.name}`
    );
  }
  assert.ok(pricingText.includes("Free Plan"), "/pricing must display 'Free Plan'");
  assert.ok(pricingText.includes("₹0.00"), "/pricing must display '₹0.00' for Free Plan");
  assert.ok(
    pricingText.includes("0 AI application sets"),
    "/pricing must display Free tier usage limit ('0 AI application sets')"
  );

  // Per-feature quota summary derived directly from PLAN_DEFINITIONS in src/lib/billing/quota.ts
  const expectedQuotaSummary = `Separate usage pools per feature: Weekly includes ${PLAN_DEFINITIONS.weekly.resume_quota} AI resume tailorings + ${PLAN_DEFINITIONS.weekly.cover_letter_quota} AI cover letters per ${PLAN_DEFINITIONS.weekly.quota_period_days} days; Monthly (${PLAN_DEFINITIONS.monthly.duration_days} days) and Quarterly (${PLAN_DEFINITIONS.quarterly.duration_days} days) include ${PLAN_DEFINITIONS.monthly.resume_quota} AI resume tailorings + ${PLAN_DEFINITIONS.monthly.cover_letter_quota} AI cover letters per ${PLAN_DEFINITIONS.monthly.quota_period_days} days.`;
  assert.strictEqual(
    PLAN_QUOTA_SUMMARY_NOTE,
    expectedQuotaSummary,
    "PLAN_QUOTA_SUMMARY_NOTE must match exact per-feature quota values in PLAN_DEFINITIONS"
  );
  assert.ok(
    pricingText.includes(expectedQuotaSummary),
    "/pricing must display the exact per-feature quota summary derived from PLAN_DEFINITIONS"
  );
  const plansSrc = fs.readFileSync(path.join(rootDir, "src/config/plans.ts"), "utf-8");
  assert.strictEqual(
    /1\s*set\s*=\s*1\s*job\s*extraction/i.test(pricingSrc) ||
      /1\s*set\s*=\s*1\s*job\s*extraction/i.test(plansSrc) ||
      /1\s*set\s*=\s*1\s*job\s*extraction/i.test(pricingText),
    false,
    "Inaccurate '1 set = 1 job extraction + ...' wording must not appear in pricing page or plans config"
  );

  // Payments strictly OFF: no checkout / Razorpay calls, buttons disabled
  assert.strictEqual(
    pricingSrc.includes("/api/billing/razorpay"),
    false,
    "/pricing source must not call /api/billing/razorpay"
  );
  assert.strictEqual(
    pricingSrc.includes("loadRazorpayScript"),
    false,
    "/pricing source must not reference loadRazorpayScript"
  );
  assert.strictEqual(
    /<a[^>]*>Upgrade<\/a>/.test(pricingHtml),
    false,
    "Plan Upgrade buttons on /pricing must not be anchor links that redirect signed-out users"
  );
  const disabledUpgradeButtons = pricingHtml.match(/<button[^>]*disabled[^>]*>Upgrade<\/button>/g) || [];
  assert.strictEqual(
    disabledUpgradeButtons.length,
    6,
    `Expected 6 disabled Upgrade buttons (3 desktop + 3 mobile), got ${disabledUpgradeButtons.length}`
  );

  // No "early access" wording on /pricing, and "Payments will open soon." present
  assert.strictEqual(
    /early[\s-]*access/i.test(pricingSrc),
    false,
    "src/app/pricing/page.tsx must contain zero 'early access' strings"
  );
  assert.strictEqual(
    /early[\s-]*access/i.test(pricingText),
    false,
    "Rendered /pricing text must contain zero 'early access' strings"
  );
  assert.ok(
    pricingText.includes("Payments will open soon."),
    "/pricing must include the exact note 'Payments will open soon.'"
  );

  // Add-on packs section on /pricing
  assert.ok(pricingText.includes("Add-on Packs"), "/pricing must include 'Add-on Packs' section heading");
  for (const pack of ADD_ON_PACKS) {
    assert.ok(
      pricingText.includes(formatPriceINR(pack.price)) &&
        pricingText.includes(`${pack.sets} extra generations`),
      `/pricing must display add-on pack ${formatPriceINR(pack.price)} for ${pack.sets} extra generations`
    );
  }
  const exactAddonNote =
    "Note: add-on packs can only be added for additional usage on an active subscription.";
  assert.ok(
    ADD_ON_PACKS_NOTE.includes(exactAddonNote),
    `ADD_ON_PACKS_NOTE must contain "${exactAddonNote}"`
  );
  assert.ok(
    pricingText.includes(exactAddonNote),
    `/pricing must include the exact add-on note: "${exactAddonNote}"`
  );
  assert.ok(
    pricingText.includes("expire together with the subscription"),
    "/pricing must state that add-on packs expire together with the subscription"
  );
  assert.strictEqual(
    /planned add-on/i.test(pricingText) || /60[\s-]*day/i.test(pricingText),
    false,
    "/pricing must not contain 'Planned' add-on wording or '60 days' validity"
  );
  console.log("  [PASS-LOCAL] /pricing plans, prices, disabled buttons, notes, and Add-on Packs verified.");

  // ---------------------------------------------------------------------------
  // 4. Terms (/terms-and-conditions): Add-on Wording Updated, Auto-Renewal Untouched
  // ---------------------------------------------------------------------------
  console.log("\n4. Verifying Terms (/terms-and-conditions) add-on wording and auto-renewal preservation...");
  const termsHtml = renderToStaticMarkup(React.createElement(TermsPage));
  const termsText = stripTags(termsHtml);
  const privacyHtml = renderToStaticMarkup(React.createElement(PrivacyPolicyPage));
  const privacyText = stripTags(privacyHtml);

  assert.strictEqual(
    /planned/i.test(termsText),
    false,
    "/terms-and-conditions must not contain the word 'Planned'"
  );
  assert.strictEqual(
    /60 days after purchase/i.test(termsText),
    false,
    "/terms-and-conditions must no longer say '60 days after purchase'"
  );
  assert.ok(
    termsText.includes("expire together with the subscription"),
    "/terms-and-conditions must state that add-on packs expire together with the subscription"
  );
  assert.ok(
    termsText.includes("all plans are prepaid for a fixed duration and do not renew automatically"),
    "/terms-and-conditions auto-renewal wording must remain unchanged"
  );
  assert.ok(
    privacyText.includes("Privacy Policy"),
    "/privacy-policy must render cleanly with auto-renewal/policy wording unchanged"
  );
  console.log("  [PASS-LOCAL] /terms-and-conditions add-on wording updated; auto-renewal untouched.");

  // ---------------------------------------------------------------------------
  // 5. /about (About Us) Public Page Content & Prohibited Terms Check
  // ---------------------------------------------------------------------------
  console.log("\n5. Verifying /about (About Us) content and prohibited terms...");
  const aboutHtml = renderToStaticMarkup(React.createElement(AboutUsPage));
  const aboutText = stripTags(aboutHtml);

  assert.ok(aboutText.includes("About Us"), "/about must render 'About Us' heading");
  assert.ok(
    aboutText.includes("small team building an AI job-search tool for job seekers"),
    "/about must describe a small team building an AI job-search tool for job seekers"
  );
  assert.ok(/find jobs/i.test(aboutText), "/about must mention helping find jobs");
  assert.ok(/tailor resumes per job/i.test(aboutText), "/about must mention tailoring resumes per job");
  assert.ok(/track applications/i.test(aboutText), "/about must mention tracking applications");
  assert.ok(
    aboutHtml.includes("mailto:support@careermonke.com") &&
      aboutText.includes("support@careermonke.com"),
    "/about must include a contact email line using support@careermonke.com"
  );

  const bannedAboutPatterns: Array<[string, RegExp]> = [
    ["backend", /\bbackend\b/i],
    ["scraper/scrapers", /\bscrapers?\b/i],
    ["crawler/crawling", /\bcrawl(?:er|ing)?\b/i],
    ["job sources (Greenhouse/Lever/Ashby/Workday)", /\b(?:greenhouse|lever|ashby|workday)\b/i],
    ["tech stack (Next.js/React/Supabase/Postgres/Groq/TypeScript)", /\b(?:next\.?js|react|supabase|postgres(?:ql)?|groq|typescript|tailwind|netlify)\b/i],
    ["investors/funding", /\b(?:investors?|venture|funded|seed round|series [a-z])\b/i],
    ["testimonials", /\btestimonials?\b/i],
    ["No.1 / #1 claims", /\b(?:no\.?\s*1|#1)\b/i],
  ];
  for (const [label, pattern] of bannedAboutPatterns) {
    assert.strictEqual(
      pattern.test(aboutText),
      false,
      `/about must NOT mention ${label} (matched ${pattern} in "${aboutText}")`
    );
  }
  console.log("  [PASS-LOCAL] /about copy and prohibited terms verified.");

  // ---------------------------------------------------------------------------
  // 6. Negative Control Subprocess Verification
  // ---------------------------------------------------------------------------
  console.log("\n6. Running negative control subprocess check...");
  const negRes = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });
  assert.notStrictEqual(
    negRes.status,
    0,
    "Negative control subprocess must exit with a non-zero status code"
  );
  console.log(`  [PASS-LOCAL] Negative control exited non-zero (${negRes.status}) as expected.`);

  console.log("\n================================================================================");
  console.log("   ALL RAZORPAY REVIEW FRONTEND TESTS PASSED [PASS-LOCAL]                      ");
  console.log("================================================================================");
}

runTests().catch((err) => {
  console.error("\n[FAIL] Razorpay Review Frontend Suite Error:\n", err);
  process.exit(1);
});
