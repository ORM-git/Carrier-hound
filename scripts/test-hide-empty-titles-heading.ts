import assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Next.js App Router context providers for server-rendering client components in test harness
// @ts-ignore
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
// @ts-ignore
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import RoleTitlesPage, {
  generateMetadata,
  generateStaticParams,
} from "../src/app/remote/[slug]/titles/page";
import { ROLE_GUIDES } from "../src/data/guides/roles";

const mockRouter = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

function renderWithRouter(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(
      AppRouterContext.Provider,
      { value: mockRouter },
      React.createElement(
        PathnameContext.Provider,
        { value: "/remote/devops-engineer/titles" },
        node
      )
    )
  );
}

async function runHideEmptyTitlesHeadingSuite() {
  console.log("================================================================================");
  console.log("   CAREERMONKE HIDE EMPTY TITLES HEADING TEST SUITE VERIFICATION [PASS-LOCAL]    ");
  console.log("================================================================================");

  const isNegativeControl = process.argv.includes("--negative-control");

  if (isNegativeControl) {
    console.log("\n[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition (heading MUST exist when empty)...\n");
    const markup = renderWithRouter(
      React.createElement(RoleTitlesPage, {
        params: { slug: "devops-engineer" },
      })
    );
    // Deliberately assert that empty jobs renders the ATS Snapshot heading and description
    assert.ok(
      markup.includes("ATS Snapshot") &&
        markup.includes("Recent openings captured directly from employer applicant tracking systems"),
      "Negative control expected mismatch: Empty jobs array MUST hide heading and description."
    );
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: RoleTitlesPage DOM Markup when roleJobs is empty -> Heading & Sentence HIDDEN
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying /remote/[slug]/titles completely hides heading and sentence when no jobs...");
  const devopsMarkup = renderWithRouter(
    React.createElement(RoleTitlesPage, {
      params: { slug: "devops-engineer" },
    })
  );

  assert.strictEqual(
    devopsMarkup.includes("ATS Snapshot"),
    false,
    "Heading 'Live [role] ATS Snapshot' must NOT be rendered when jobs list is empty"
  );
  assert.strictEqual(
    devopsMarkup.includes("Recent openings captured directly from employer applicant tracking systems before public syndication."),
    false,
    "Sentence 'Recent openings captured directly...' must NOT be rendered when jobs list is empty"
  );
  assert.strictEqual(
    devopsMarkup.includes("Live DevOps &amp; Cloud Platform Engineer Openings"),
    false,
    "JobPreview heading must NOT be rendered when jobs list is empty"
  );

  // Verify other core guide content remains fully rendered
  assert.ok(
    devopsMarkup.includes("Seniority Ladder"),
    "Career ladder section must remain intact"
  );
  assert.ok(
    devopsMarkup.includes("Title Nomenclature Bands"),
    "Title bands section must remain intact"
  );
  assert.ok(
    devopsMarkup.includes("Certification Route Map"),
    "Certification route map section must remain intact"
  );
  console.log("  -> [PASS-LOCAL] Empty jobs: Heading, sentence, and preview completely hidden; guide content intact.");

  // ---------------------------------------------------------------------------
  // TEST 2: SEO metadata and Page Title remain untouched and correct
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying generateMetadata returns valid SEO title and lede for all role guides...");
  const slugs = Object.keys(ROLE_GUIDES);
  assert.ok(slugs.length > 0, "ROLE_GUIDES must contain role definitions");

  for (const slug of slugs) {
    const guide = ROLE_GUIDES[slug];
    const meta = generateMetadata({ params: { slug } });
    assert.strictEqual(
      meta.title,
      `${guide.hero.title} | CareerMonke`,
      `SEO Title mismatch for slug '${slug}'`
    );
    assert.strictEqual(
      meta.description,
      guide.hero.lede,
      `SEO Description mismatch for slug '${slug}'`
    );
  }
  console.log(`  -> [PASS-LOCAL] SEO metadata and page titles validated across ${slugs.length} role guides.`);

  // ---------------------------------------------------------------------------
  // TEST 3: Static params and routes remain unchanged
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying generateStaticParams generates valid route slugs...");
  const staticParams = generateStaticParams();
  assert.strictEqual(
    staticParams.length,
    slugs.length,
    "Static params count must match role guides count"
  );
  for (const item of staticParams) {
    assert.ok(item.slug in ROLE_GUIDES, `Generated param slug '${item.slug}' must exist in ROLE_GUIDES`);
  }
  console.log(`  -> [PASS-LOCAL] generateStaticParams verified (${staticParams.length} static routes).`);

  // ---------------------------------------------------------------------------
  // TEST 4: Source code guard validation in src/app/remote/[slug]/titles/page.tsx
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying source code wraps ATS Snapshot section with roleJobs guard...");
  const pagePath = path.resolve(process.cwd(), "src/app/remote/[slug]/titles/page.tsx");
  const source = fs.readFileSync(pagePath, "utf-8");

  // Verify that the section is wrapped with roleJobs condition
  const hasGuard =
    source.includes("roleJobs && roleJobs.length > 0 && (\n            <section className=\"space-y-4\">") ||
    source.includes("roleJobs && roleJobs.length > 0 && (\r\n            <section className=\"space-y-4\">");
  assert.ok(
    hasGuard,
    "ATS Snapshot section must be conditionally guarded with `roleJobs && roleJobs.length > 0 && (`"
  );

  // Verify no new placeholder copy was introduced
  assert.ok(
    !source.includes("No openings right now"),
    "Titles page must NOT introduce placeholder copy"
  );
  assert.ok(
    !source.includes("No live jobs available"),
    "Titles page must NOT introduce alternative empty copy"
  );
  console.log("  -> [PASS-LOCAL] Source code guard verified; 0 unintended placeholder copy.");

  // ---------------------------------------------------------------------------
  // TEST 5: Subprocess Negative Control Verification
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Confirming negative control fails with non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST exit with non-zero exit code when invalid condition is asserted!"
  );
  console.log(`  -> [PASS-LOCAL] Negative control exited non-zero (${negResult.status}) as expected.`);

  console.log("\n================================================================================");
  console.log("   ALL HIDE EMPTY TITLES HEADING TESTS PASSED SUCCESSFULLY [PASS-LOCAL]         ");
  console.log("================================================================================");
}

runHideEmptyTitlesHeadingSuite().catch((err) => {
  console.error("\n[FAIL] Hide Empty Titles Heading Suite Error:\n", err);
  process.exit(1);
});
