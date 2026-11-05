/**
 * scripts/test-error-boundaries.ts
 *
 * Verifies Frontend Error Boundaries:
 * 1. File existence: app/error.tsx, app/global-error.tsx, app/jobs/error.tsx, app/dashboard/error.tsx, and app/not-found.tsx.
 * 2. Client directive: all error boundaries have "use client".
 * 3. Fallback rendering: each error boundary renders branded UI with "Try again" (reset) and link home.
 * 4. Zero stack trace leakage: ensures error.stack and raw traces are never exposed in markup.
 * 5. Sentry reporting logic: reports to Sentry only when DSN and cookie consent allow it.
 * 6. Negative control proving non-zero exit on invalid conditions.
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import React from "react";
import ReactDOMServer from "react-dom/server";

// Negative control check
if (process.argv.includes("--negative-control")) {
  console.log("Running negative control mode (expected non-zero exit)...");
  assert.strictEqual(true, false, "Negative control intentional failure");
  process.exit(0);
}

// Helper to mock localStorage for consent checking
class MockLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.get(key) || null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("       FRONTEND ERROR BOUNDARIES VERIFICATION SUITE [PASS-LOCAL]                ");
  console.log("================================================================================\n");

  let passed = 0;
  const rootDir = process.cwd();

  // ---------------------------------------------------------------------------
  // TEST 1: File Existence
  // ---------------------------------------------------------------------------
  console.log("[TEST 1] Verifying all required error boundary files exist...");
  const requiredFiles = [
    "src/app/error.tsx",
    "src/app/global-error.tsx",
    "src/app/jobs/error.tsx",
    "src/app/dashboard/error.tsx",
    "src/app/not-found.tsx",
  ];

  for (const relPath of requiredFiles) {
    const fullPath = path.join(rootDir, relPath);
    assert.strictEqual(fs.existsSync(fullPath), true, `File must exist: ${relPath}`);
    console.log(`  -> [PASS-LOCAL] Exists: ${relPath}`);
  }
  passed++;

  // ---------------------------------------------------------------------------
  // TEST 2: Client Component Directive & HTML Structure
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Verifying 'use client' directives and boundary constraints...");
  const clientFiles = [
    "src/app/error.tsx",
    "src/app/global-error.tsx",
    "src/app/jobs/error.tsx",
    "src/app/dashboard/error.tsx",
  ];

  for (const relPath of clientFiles) {
    const content = fs.readFileSync(path.join(rootDir, relPath), "utf8");
    assert.ok(
      content.startsWith('"use client"') || content.startsWith("'use client'"),
      `${relPath} must have 'use client' directive at the top`
    );
    // Ensure no accidental stack trace rendering in code
    assert.ok(
      !content.includes("error.stack"),
      `${relPath} must NEVER render error.stack`
    );
  }

  // Global error boundary must define <html> and <body>
  const globalErrorContent = fs.readFileSync(path.join(rootDir, "src/app/global-error.tsx"), "utf8");
  assert.ok(globalErrorContent.includes("<html"), "global-error.tsx must define <html> tag");
  assert.ok(globalErrorContent.includes("<body"), "global-error.tsx must define <body> tag");

  console.log("  -> [PASS-LOCAL] All error boundaries use 'use client' and global-error defines <html>/<body>.");
  passed++;

  // ---------------------------------------------------------------------------
  // TEST 3: Component Rendering & Fallback UI
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] Rendering each error boundary fallback component...");

  // Import error components
  const { default: RootError } = await import("../src/app/error");
  const { default: GlobalError } = await import("../src/app/global-error");
  const { default: JobsError } = await import("../src/app/jobs/error");
  const { default: DashboardError } = await import("../src/app/dashboard/error");

  const mockError = new Error("Simulated runtime component failure");
  (mockError as any).digest = "ERR_TEST_12345";
  mockError.stack = "Error: Simulated runtime failure\n    at Component.render (secret-internal.ts:42:15)";

  let resetInvoked = 0;
  const mockReset = () => {
    resetInvoked++;
  };

  // 3A. RootError (app/error.tsx)
  const rootMarkup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(RootError, { error: mockError, reset: mockReset })
  );
  assert.ok(rootMarkup.includes("Something went wrong"), "Root error must show title");
  assert.ok(rootMarkup.includes("Try again"), "Root error must include 'Try again' button");
  assert.ok(rootMarkup.includes("Back to Homepage"), "Root error must include home link");
  assert.ok(rootMarkup.includes("CareerMonke"), "Root error must display CareerMonke branding");
  assert.ok(!rootMarkup.includes("secret-internal.ts"), "Root error MUST NOT leak stack trace");
  assert.ok(!rootMarkup.includes("Component.render"), "Root error MUST NOT leak stack trace frames");
  console.log("  -> [PASS-LOCAL] app/error.tsx renders branded fallback without stack traces.");

  // 3B. GlobalError (app/global-error.tsx)
  const globalMarkup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(GlobalError, { error: mockError, reset: mockReset })
  );
  assert.ok(globalMarkup.includes("<html"), "Global error must render <html>");
  assert.ok(globalMarkup.includes("<body"), "Global error must render <body>");
  assert.ok(globalMarkup.includes("Something went wrong"), "Global error must show title");
  assert.ok(globalMarkup.includes("Try again"), "Global error must include 'Try again' button");
  assert.ok(globalMarkup.includes("Back to Homepage"), "Global error must include home link");
  assert.ok(globalMarkup.includes("CareerMonke"), "Global error must display CareerMonke branding");
  assert.ok(!globalMarkup.includes("secret-internal.ts"), "Global error MUST NOT leak stack trace");
  console.log("  -> [PASS-LOCAL] app/global-error.tsx renders <html>/<body> branded fallback without stack traces.");

  // 3C. JobsError (app/jobs/error.tsx)
  const jobsMarkup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(JobsError, { error: mockError, reset: mockReset })
  );
  assert.ok(jobsMarkup.includes("Unable to load jobs"), "Jobs error must show segment title");
  assert.ok(jobsMarkup.includes("Try again"), "Jobs error must include 'Try again' button");
  assert.ok(jobsMarkup.includes("Back to Homepage"), "Jobs error must include home link");
  assert.ok(jobsMarkup.includes("CareerMonke"), "Jobs error must display CareerMonke branding");
  assert.ok(!jobsMarkup.includes("secret-internal.ts"), "Jobs error MUST NOT leak stack trace");
  console.log("  -> [PASS-LOCAL] app/jobs/error.tsx renders segment-level fallback without stack traces.");

  // 3D. DashboardError (app/dashboard/error.tsx)
  const dashboardMarkup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(DashboardError, { error: mockError, reset: mockReset })
  );
  assert.ok(dashboardMarkup.includes("Unable to load dashboard"), "Dashboard error must show segment title");
  assert.ok(dashboardMarkup.includes("Try again"), "Dashboard error must include 'Try again' button");
  assert.ok(dashboardMarkup.includes("Back to Homepage"), "Dashboard error must include home link");
  assert.ok(dashboardMarkup.includes("CareerMonke"), "Dashboard error must display CareerMonke branding");
  assert.ok(!dashboardMarkup.includes("secret-internal.ts"), "Dashboard error MUST NOT leak stack trace");
  console.log("  -> [PASS-LOCAL] app/dashboard/error.tsx renders segment-level fallback without stack traces.");
  passed++;

  // ---------------------------------------------------------------------------
  // TEST 4: Sentry Reporting & Consent / DSN Gating Logic
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Verifying Sentry error reporting consent and DSN gating...");
  const { shouldReportToSentry, reportErrorToSentry } = await import(
    "../src/lib/monitoring/sentryErrorReporter"
  );

  // Setup DOM / localStorage environment for testing
  const originalEnv = { ...process.env };
  const originalWindow = (globalThis as any).window;
  const originalLocalStorage = (globalThis as any).localStorage;

  try {
    const mockStorage = new MockLocalStorage();
    (globalThis as any).window = {};
    (globalThis as any).localStorage = mockStorage;

    // Case 4A: No DSN set, no mock -> should NOT report
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    delete (globalThis as any).__mockSentry;
    mockStorage.clear();

    assert.strictEqual(shouldReportToSentry(), false, "Must not report when DSN is absent");

    // Case 4B: DSN is set BUT cookie consent is absent -> should NOT report
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";
    mockStorage.clear(); // No consent

    assert.strictEqual(shouldReportToSentry(), false, "Must not report when cookie consent is absent");

    // Case 4C: DSN is set AND cookie consent is granted -> SHOULD report
    mockStorage.setItem("cm_cookie_notice", "true");
    assert.strictEqual(shouldReportToSentry(), true, "Must report when DSN and consent are both present");

    // Case 4D: Mock Sentry dispatch test
    let capturedErrors: any[] = [];
    (globalThis as any).__mockSentry = {
      captureException: (err: any) => {
        capturedErrors.push(err);
      },
    };

    reportErrorToSentry(mockError);
    assert.strictEqual(capturedErrors.length, 1, "Mock Sentry captureException must be called exactly once");
    assert.strictEqual(capturedErrors[0], mockError, "Dispatched error must match the passed error");

    // Case 4E: Error dispatch should never throw on failures
    (globalThis as any).__mockSentry = {
      captureException: () => {
        throw new Error("Sentry transport boom");
      },
    };
    assert.doesNotThrow(() => {
      reportErrorToSentry(new Error("Another test"));
    }, "reportErrorToSentry must never throw even if Sentry fails");

    console.log("  -> [PASS-LOCAL] Sentry reporting strictly respects DSN presence and cookie consent.");
    passed++;
  } finally {
    process.env = originalEnv;
    (globalThis as any).window = originalWindow;
    (globalThis as any).localStorage = originalLocalStorage;
    delete (globalThis as any).__mockSentry;
  }

  // ---------------------------------------------------------------------------
  // TEST 5: not-found.tsx untouched confirmation
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Confirming app/not-found.tsx remains unchanged...");
  const notFoundContent = fs.readFileSync(path.join(rootDir, "src/app/not-found.tsx"), "utf8");
  assert.ok(notFoundContent.includes("404"), "not-found.tsx must preserve 404 status");
  assert.ok(notFoundContent.includes("Lost in the jungle?"), "not-found.tsx must preserve copy");
  console.log("  -> [PASS-LOCAL] app/not-found.tsx remains intact.");
  passed++;

  console.log("\n================================================================================");
  console.log(` ALL ${passed} TEST SUITES PASSED LOCALLY: [PASS-LOCAL]`);
  console.log("================================================================================\n");
}

runTestSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
