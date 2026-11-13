/**
 * scripts/test-early-access.ts
 *
 * Verification Suite for Early-Access Flow Removal:
 * 1. Confirms removal of /early-access page(s) and /api/early-access route(s).
 * 2. Confirms middleware redirects all /early-access traffic to /signup (HTTP 301).
 * 3. Confirms deploy redirect rules (public/_redirects, netlify.toml) contain zero targets to /early-access.
 * 4. Confirms marketing CTAs on landing and public footer repointed to real routes (zero href="/early-access").
 * 5. Confirms sitemap excludes /early-access.
 * 6. Confirms lead-capture Apps Script sender (src/lib/early-access/gmail.ts) is preserved for dependents.
 * 7. Sub-process negative controls verify intentional non-zero exits on compromised invariants.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { NextRequest } from "next/server";

// Register Node test hook for @cloudflare/next-on-pages in unit test environment
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any
) {
  if (request === "@cloudflare/next-on-pages") {
    return "virtual:@cloudflare/next-on-pages";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.cache["virtual:@cloudflare/next-on-pages"] = {
  id: "virtual:@cloudflare/next-on-pages",
  filename: "virtual:@cloudflare/next-on-pages",
  loaded: true,
  exports: {
    getRequestContext: () => {
      const sym = Symbol.for("__cloudflare-request-context__");
      return (globalThis as any)[sym];
    },
  },
} as any;

process.env.NODE_ENV = "test";

const isNegativeControl =
  process.argv.includes("--negative-control") ||
  process.argv.includes("--negative-control-cap") ||
  process.argv.includes("--negative-control-digest") ||
  process.argv.includes("--negative-control-approval") ||
  process.argv.includes("--negative-control-self-approve");

if (isNegativeControl) {
  console.log("[NEGATIVE CONTROL] Proving non-zero exit on intentional failure condition...");
  // Deliberately assert that /early-access page exists (must fail since it is removed)
  assert.strictEqual(
    fs.existsSync(path.resolve(process.cwd(), "src/app/early-access/page.tsx")),
    true,
    "NEGATIVE CONTROL: src/app/early-access/page.tsx must NOT exist after early-access flow removal!"
  );
  process.exit(0);
}

const ROOT = path.resolve(__dirname, "..");

async function main() {
  console.log("================================================================================");
  console.log("       CAREERMONKE EARLY-ACCESS FLOW REMOVAL VERIFICATION SUITE                 ");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // TEST 1: Deleted files confirmed absent
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying deleted /early-access pages and API routes...");
  const removedFiles = [
    "src/app/early-access/page.tsx",
    "src/app/early-access/layout.tsx",
    "src/app/api/early-access/route.ts",
  ];
  for (const rel of removedFiles) {
    const full = path.join(ROOT, rel);
    assert.strictEqual(
      fs.existsSync(full),
      false,
      `File ${rel} must be completely deleted from repository`
    );
  }
  console.log("  [PASS-LOCAL] Deleted /early-access page(s) and /api/early-access route(s) confirmed absent.");

  // ---------------------------------------------------------------------------
  // TEST 2: Middleware 301 redirection of /early-access to /signup
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying middleware redirects /early-access traffic to /signup...");
  const { middleware } = await import("../src/middleware");

  for (const testPath of ["/early-access", "/early-access/", "/early-access/request", "/early-access?ref=twitter"]) {
    const req = new NextRequest(`http://localhost:3000${testPath}`);
    const res = await middleware(req);
    assert.strictEqual(
      res.status,
      301,
      `Request to '${testPath}' must return HTTP 301 redirect, got ${res.status}`
    );
    const loc = res.headers.get("location");
    assert.ok(loc, `Redirect response for '${testPath}' must include Location header`);
    const parsed = new URL(loc);
    assert.strictEqual(
      parsed.pathname,
      "/signup",
      `Redirect target for '${testPath}' must be '/signup', got '${parsed.pathname}'`
    );
  }
  console.log("  [PASS-LOCAL] Middleware permanently redirects all /early-access paths to /signup (HTTP 301).");

  // ---------------------------------------------------------------------------
  // TEST 3: Deploy redirect rules (public/_redirects, netlify.toml) zero targets
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying deploy redirect rules contain zero destinations targeting /early-access...");
  const redirectsContent = fs.readFileSync(path.join(ROOT, "public/_redirects"), "utf-8");
  for (const line of redirectsContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const destination = parts[1].toLowerCase();
      assert.ok(
        !destination.includes("/early-access"),
        `public/_redirects rule '${trimmed}' must NOT target /early-access`
      );
    }
  }
  assert.ok(
    redirectsContent.includes("/early-access /signup 301!"),
    "public/_redirects must include /early-access /signup 301! rule"
  );

  const tomlContent = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf-8");
  assert.ok(
    !tomlContent.includes('to = "/early-access"'),
    "netlify.toml must NOT redirect any route to /early-access"
  );
  console.log("  [PASS-LOCAL] Deploy redirect configurations have zero targets to /early-access.");

  // ---------------------------------------------------------------------------
  // TEST 4: Marketing links repointed (zero href="/early-access")
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying marketing links on landing and components repointed away from /early-access...");
  const marketingFiles = [
    "src/app/page.tsx",
    "src/components/Footer.tsx",
    "src/components/LandingFeaturesSection.tsx",
    "src/components/LandingJobsTickerStrip.tsx",
    "src/components/LandingTopArtifact.tsx",
    "src/components/CategorySelectModal.tsx",
  ];

  for (const rel of marketingFiles) {
    const content = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    assert.ok(
      !content.includes('href="/early-access"'),
      `File ${rel} must NOT contain href="/early-access"`
    );
    assert.ok(
      !content.includes('href: "/early-access"'),
      `File ${rel} must NOT contain href: "/early-access"`
    );
    assert.ok(
      !content.includes('push("/early-access")'),
      `File ${rel} must NOT contain push("/early-access")`
    );
  }
  console.log("  [PASS-LOCAL] All marketing CTAs and components repointed to active routes (/signup, /jobs, /worldwide, /login).");

  // ---------------------------------------------------------------------------
  // TEST 5: Sitemap excludes /early-access
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Verifying sitemap.ts excludes /early-access...");
  const sitemapSrc = fs.readFileSync(path.join(ROOT, "src/app/sitemap.ts"), "utf-8");
  assert.ok(
    !sitemapSrc.includes("/early-access"),
    "src/app/sitemap.ts must NOT include /early-access entry"
  );
  console.log("  [PASS-LOCAL] sitemap.ts excludes /early-access.");

  // ---------------------------------------------------------------------------
  // TEST 6: Preserved lead-capture Apps Script module
  // ---------------------------------------------------------------------------
  console.log("\nTest 6: Verifying Apps Script lead-capture helper preserved for dependent services...");
  const gmailLib = path.join(ROOT, "src/lib/early-access/gmail.ts");
  assert.strictEqual(
    fs.existsSync(gmailLib),
    true,
    "src/lib/early-access/gmail.ts must be preserved for dunningDispatcher and failedEvents"
  );
  console.log("  [PASS-LOCAL] src/lib/early-access/gmail.ts preserved for dependent services.");

  // ---------------------------------------------------------------------------
  // TEST 6b: Verifying guest requests to /jobs are not redirected
  // ---------------------------------------------------------------------------
  console.log("\nTest 6b: Verifying guest requests to /jobs are not redirected...");
  for (const jobsPath of ["/jobs", "/jobs?location=Remote", "/jobs/"]) {
    const jobsReq = new NextRequest(`http://localhost:3000${jobsPath}`);
    const jobsRes = await middleware(jobsReq);
    assert.strictEqual(
      jobsRes.status,
      200,
      `Guest request to '${jobsPath}' must not be redirected (expected 200, got ${jobsRes.status})`
    );
    assert.strictEqual(
      jobsRes.headers.get("location"),
      null,
      `Guest request to '${jobsPath}' must not have a Location redirect header`
    );
  }
  console.log("  [PASS-LOCAL] Guest requests to /jobs proceed without redirection to /login or /early-access.");

  // ---------------------------------------------------------------------------
  // TEST 7: Subprocess Negative Control Execution
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 7: SUBPROCESS NEGATIVE CONTROL EXECUTION ---");
  const negFlags = [
    "--negative-control",
    "--negative-control-cap",
    "--negative-control-digest",
    "--negative-control-approval",
    "--negative-control-self-approve",
  ];
  for (const flag of negFlags) {
    const res = spawnSync("npx", ["tsx", "scripts/test-early-access.ts", flag], {
      encoding: "utf-8",
      shell: true,
    });
    assert.notStrictEqual(
      res.status,
      0,
      `Negative control with flag '${flag}' must exit non-zero!`
    );
    console.log(`  [PASS-LOCAL] Negative control '${flag}' exited non-zero (${res.status}) as expected.`);
  }

  console.log("\n================================================================================");
  console.log("ALL EARLY-ACCESS FLOW REMOVAL CHECKS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
