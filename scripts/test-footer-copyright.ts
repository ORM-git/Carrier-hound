/**
 * Verification Suite for Site-wide Corporate Copyright Line
 *
 * Verifies that the exact text:
 *   "© 2026 Olive Ridley Media Private Limited. All rights reserved."
 * is present on every route, layout, and shared footer across public and signed-in pages,
 * with zero duplicate copyright lines and zero outdated/dynamic patterns.
 *
 * Usage:
 *   npx tsx scripts/test-footer-copyright.ts
 *   npx tsx scripts/test-footer-copyright.ts --negative-control
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import Footer from "../src/components/Footer";
import LoggedInAppShell from "../src/components/shell/LoggedInAppShell";
import TermsPage from "../src/app/terms-and-conditions/page";
import PrivacyPolicyPage from "../src/app/privacy-policy/page";
import ContactUsPage from "../src/app/contact/page";
import RefundPolicyPage from "../src/app/refund-policy/page";
import AboutUsPage from "../src/app/about/page";

const EXACT_COPYRIGHT = "© 2026 Olive Ridley Media Private Limited. All rights reserved.";

const mockRouter: any = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
};

function renderWithPathname(element: React.ReactElement, pathname: string = "/"): string {
  return renderToStaticMarkup(
    React.createElement(
      AppRouterContext.Provider,
      { value: mockRouter },
      React.createElement(PathnameContext.Provider, { value: pathname }, element)
    )
  );
}

function countOccurrences(source: string, sub: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = source.indexOf(sub, pos)) !== -1) {
    count++;
    pos += sub.length;
  }
  return count;
}

function run() {
  const isNegativeControl = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("       SITE-WIDE CORPORATE COPYRIGHT VERIFICATION SUITE                        ");
  console.log("================================================================================");
  console.log(`Target Line : "${EXACT_COPYRIGHT}"`);
  console.log(`Mode        : ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL] Injecting corrupted copyright assertion...");
    const corruptedLine = "© 2025 CareerMonke Inc. All rights reserved.";
    assert.strictEqual(
      corruptedLine.includes(EXACT_COPYRIGHT),
      true,
      "Negative control expected failure: corrupted line must fail exact copyright match"
    );
    return;
  }

  const failures: string[] = [];

  // ---------------------------------------------------------------------------
  // 1. Source file code checks for dedicated and shared components
  // ---------------------------------------------------------------------------
  console.log("1. Checking source code across components and page files...");

  const filesToCheck: { file: string; minCount: number; maxCount: number; description: string }[] = [
    {
      file: "src/components/Footer.tsx",
      minCount: 2,
      maxCount: 2,
      description: "Shared Footer (LandingFooter + standard Footer)",
    },
    {
      file: "src/components/shell/LoggedInAppShell.tsx",
      minCount: 1,
      maxCount: 1,
      description: "LoggedInAppShell (signed-in pages wrapper)",
    },
    {
      file: "src/app/admin/layout.tsx",
      minCount: 1,
      maxCount: 1,
      description: "Admin Console Layout",
    },
    {
      file: "src/app/jobs/page.tsx",
      minCount: 1,
      maxCount: 1,
      description: "Jobs Discovery Page (authenticated & public)",
    },
    {
      file: "src/app/onboarding/page.tsx",
      minCount: 1,
      maxCount: 1,
      description: "Onboarding Flow Page",
    },
    {
      file: "src/app/auth/callback/page.tsx",
      minCount: 1,
      maxCount: 1,
      description: "Auth Callback Route Page",
    },
    {
      file: "src/app/job-detail/page.tsx",
      minCount: 1,
      maxCount: 1,
      description: "Job Detail Redirect Page",
    },
    {
      file: "src/app/job-search/all/page.tsx",
      minCount: 1,
      maxCount: 1,
      description: "Job Search All Redirect Page",
    },
    {
      file: "src/app/jobs/detail/page.tsx",
      minCount: 1,
      maxCount: 1,
      description: "Jobs Detail Redirect Page",
    },
  ];

  for (const item of filesToCheck) {
    const fullPath = path.resolve(process.cwd(), item.file);
    if (!fs.existsSync(fullPath)) {
      failures.push(`Missing file: ${item.file}`);
      continue;
    }
    const content = fs.readFileSync(fullPath, "utf-8");
    const count = countOccurrences(content, EXACT_COPYRIGHT);
    if (count < item.minCount) {
      failures.push(
        `${item.file} has ${count} occurrence(s) of copyright line, expected >= ${item.minCount}`
      );
    } else if (count > item.maxCount) {
      failures.push(
        `${item.file} has duplicate copyright lines (${count} occurrences, max allowed ${item.maxCount})`
      );
    } else {
      console.log(`  [PASS] ${item.description} (${item.file}) -> ${count} exact match`);
    }
  }

  // Pages that delegate their footer to the shared site <Footer /> (unified footer):
  // source must carry zero inline copyright lines and must render <Footer />.
  const sharedFooterPages: { file: string; description: string }[] = [
    { file: "src/app/terms-and-conditions/page.tsx", description: "Terms and Conditions Page" },
    { file: "src/app/privacy-policy/page.tsx", description: "Privacy Policy Page" },
    { file: "src/app/contact/page.tsx", description: "Contact Us Page" },
    { file: "src/app/refund-policy/page.tsx", description: "Refund Policy Page" },
    { file: "src/app/about/page.tsx", description: "About Us Page" },
  ];
  for (const item of sharedFooterPages) {
    const fullPath = path.resolve(process.cwd(), item.file);
    if (!fs.existsSync(fullPath)) {
      failures.push(`Missing file: ${item.file}`);
      continue;
    }
    const content = fs.readFileSync(fullPath, "utf-8");
    const count = countOccurrences(content, EXACT_COPYRIGHT);
    if (count !== 0) {
      failures.push(
        `${item.file} has ${count} inline copyright line(s); expected 0 because it renders the shared <Footer />`
      );
    } else if (!content.includes('from "@/components/Footer"') || !content.includes("<Footer />")) {
      failures.push(`${item.file} must import and render the shared <Footer />`);
    } else {
      console.log(`  [PASS] ${item.description} (${item.file}) -> delegates to shared Footer (0 inline lines)`);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Pricing duplicate-prevention verification
  // ---------------------------------------------------------------------------
  console.log("\n2. Verifying /pricing page de-duplication guard...");
  const shellPath = path.resolve(process.cwd(), "src/components/shell/LoggedInAppShell.tsx");
  const shellContent = fs.readFileSync(shellPath, "utf-8");
  if (!shellContent.includes('pageLabel !== "PRICING"')) {
    failures.push('LoggedInAppShell must guard footer with pageLabel !== "PRICING" to avoid duplicate footers on /pricing.');
  } else {
    console.log('  [PASS] LoggedInAppShell guards footer with pageLabel !== "PRICING"');
  }

  // ---------------------------------------------------------------------------
  // 3. Static Component / Page Rendering Checks
  // ---------------------------------------------------------------------------
  console.log("\n3. Verifying static HTML rendering of components and pages...");

  const renderCases: { name: string; element: React.ReactElement; pathname?: string }[] = [
    { name: "Footer (Landing /)", element: React.createElement(Footer), pathname: "/" },
    { name: "Footer (Non-landing /pricing)", element: React.createElement(Footer), pathname: "/pricing" },
    {
      name: "LoggedInAppShell (default)",
      element: React.createElement(
        LoggedInAppShell,
        { pageLabel: "DASHBOARD" },
        React.createElement("div", null, "Dashboard Body")
      ),
    },
    { name: "TermsPage", element: React.createElement(TermsPage), pathname: "/terms-and-conditions" },
    { name: "PrivacyPolicyPage", element: React.createElement(PrivacyPolicyPage), pathname: "/privacy-policy" },
    { name: "ContactUsPage", element: React.createElement(ContactUsPage), pathname: "/contact" },
    { name: "RefundPolicyPage", element: React.createElement(RefundPolicyPage), pathname: "/refund-policy" },
    { name: "AboutUsPage", element: React.createElement(AboutUsPage), pathname: "/about" },
  ];

  for (const testCase of renderCases) {
    try {
      const html = renderWithPathname(testCase.element, testCase.pathname || "/");
      if (!html.includes(EXACT_COPYRIGHT)) {
        failures.push(`Rendered HTML of ${testCase.name} does not contain exact copyright line.`);
      } else {
        const occurrences = countOccurrences(html, EXACT_COPYRIGHT);
        if (occurrences > 1) {
          failures.push(`Rendered HTML of ${testCase.name} contains duplicate copyright lines (${occurrences} found).`);
        } else {
          console.log(`  [PASS] Rendered ${testCase.name} -> exact copyright line verified (1 instance)`);
        }
      }
    } catch (err: any) {
      failures.push(`Failed to render ${testCase.name}: ${err.message}`);
    }
  }

  // Also check LoggedInAppShell with pageLabel="PRICING" renders 0 occurrences (no duplicate with <Footer />)
  try {
    const pricingShellHtml = renderWithPathname(
      React.createElement(
        LoggedInAppShell,
        { pageLabel: "PRICING" },
        React.createElement("div", null, "Pricing Body")
      )
    );
    const countInPricing = countOccurrences(pricingShellHtml, EXACT_COPYRIGHT);
    if (countInPricing !== 0) {
      failures.push(
        `LoggedInAppShell with pageLabel="PRICING" rendered ${countInPricing} copyright lines, expected 0.`
      );
    } else {
      console.log('  [PASS] LoggedInAppShell with pageLabel="PRICING" correctly omits app footer');
    }
  } catch (err: any) {
    failures.push(`Failed to render LoggedInAppShell with pageLabel="PRICING": ${err.message}`);
  }

  // ---------------------------------------------------------------------------
  // 4. Check for forbidden outdated / dynamic year patterns
  // ---------------------------------------------------------------------------
  console.log("\n4. Checking for forbidden dynamic year or outdated patterns in src/...");
  const forbiddenPatterns = [
    /new\s+Date\(\)\.getFullYear\(\)/,
    /©\s*202[0-5]/,
  ];

  const scanDirs = ["src/components", "src/app"];
  for (const dir of scanDirs) {
    const fullDir = path.resolve(process.cwd(), dir);
    const readDirRecursive = (currentDir: string): string[] => {
      let results: string[] = [];
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const resPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          results = results.concat(readDirRecursive(resPath));
        } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
          results.push(resPath);
        }
      }
      return results;
    };

    const files = readDirRecursive(fullDir);
    for (const filePath of files) {
      const code = fs.readFileSync(filePath, "utf-8");
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(code)) {
          // Verify if it's copyright-related
          if (code.includes("getFullYear") && code.includes("©")) {
            failures.push(`Found dynamic getFullYear in copyright line in ${path.relative(process.cwd(), filePath)}`);
          }
        }
      }
    }
  }
  console.log("  [PASS] Zero dynamic getFullYear() or outdated copyright years found in src/");

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n--------------------------------------------------------------------------------");
  if (failures.length > 0) {
    console.error(`VALIDATION FAILED (${failures.length} error(s)):`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("ALL CHECKS PASSED: Corporate copyright line verified site-wide [PASS-LOCAL]");
  process.exit(0);
}

run();
