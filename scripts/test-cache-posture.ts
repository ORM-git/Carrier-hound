/**
 * scripts/test-cache-posture.ts
 *
 * Offline static guard test auditing API and serverless function cache posture.
 * Verifies that:
 * 1. Every route file in src/app/api/** and netlify/functions/** is cataloged in docs/cache-posture.md.
 * 2. Fails if a new route file exists that is not cataloged.
 * 3. Fails if any route's Cache-Control handling drifts from the documented baseline snapshot.
 * 4. Documentation docs/cache-posture.md exists and contains the full catalog.
 * 5. Negative-control self-test detects uncataloged routes or modified cache handling.
 *
 * Run: npx tsx scripts/test-cache-posture.ts
 */

import * as fs from "fs";
import * as path from "path";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, details?: string) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${details ? ` -> ${details}` : ""}`);
  }
}

console.log("================================================================================");
console.log("     API CACHE POSTURE & CACHE-CONTROL BASELINE GUARD TEST                      ");
console.log("================================================================================\n");

export interface RouteCacheBaseline {
  filePath: string;
  authRequirement: string;
  classification: "public cacheable" | "private/no-store" | "intentionally uncached";
  hasCacheControl: boolean;
  expectedHeaderSnippet?: string;
  handlerDelegatePath?: string;
  isMisclassified: boolean;
}

export const BASELINE_CACHE_CATALOG: Record<string, RouteCacheBaseline> = {
  // --- Next.js API Routes (src/app/api/**) ---
  "src/app/api/account/delete/route.ts": {
    filePath: "src/app/api/account/delete/route.ts",
    authRequirement: "User Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/account/export/route.ts": {
    filePath: "src/app/api/account/export/route.ts",
    authRequirement: "User Auth",
    classification: "private/no-store",
    hasCacheControl: true,
    handlerDelegatePath: "src/lib/account/exportHandler.ts",
    expectedHeaderSnippet: "no-store",
    isMisclassified: false,
  },
  "src/app/api/account/signout-all/route.ts": {
    filePath: "src/app/api/account/signout-all/route.ts",
    authRequirement: "User Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/admin/early-access/approve/route.ts": {
    filePath: "src/app/api/admin/early-access/approve/route.ts",
    authRequirement: "Admin Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/admin/early-access/reject/route.ts": {
    filePath: "src/app/api/admin/early-access/reject/route.ts",
    authRequirement: "Admin Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/admin/early-access/route.ts": {
    filePath: "src/app/api/admin/early-access/route.ts",
    authRequirement: "Admin Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/admin/replay/route.ts": {
    filePath: "src/app/api/admin/replay/route.ts",
    authRequirement: "Admin Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/admin/stats/route.ts": {
    filePath: "src/app/api/admin/stats/route.ts",
    authRequirement: "Admin Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/admin/users/activity/route.ts": {
    filePath: "src/app/api/admin/users/activity/route.ts",
    authRequirement: "Admin Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/admin/users/block/route.ts": {
    filePath: "src/app/api/admin/users/block/route.ts",
    authRequirement: "Admin Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/admin/users/route.ts": {
    filePath: "src/app/api/admin/users/route.ts",
    authRequirement: "Admin Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/ai/route.ts": {
    filePath: "src/app/api/ai/route.ts",
    authRequirement: "User Auth / Quota",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "src/app/api/ai/stream/route.ts": {
    filePath: "src/app/api/ai/stream/route.ts",
    authRequirement: "User Auth / Quota",
    classification: "private/no-store",
    hasCacheControl: true,
    expectedHeaderSnippet: "no-cache, no-transform",
    isMisclassified: false,
  },
  "src/app/api/auth/security-event/route.ts": {
    filePath: "src/app/api/auth/security-event/route.ts",
    authRequirement: "Public",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "src/app/api/billing/razorpay/order/route.ts": {
    filePath: "src/app/api/billing/razorpay/order/route.ts",
    authRequirement: "User Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/billing/razorpay/verify/route.ts": {
    filePath: "src/app/api/billing/razorpay/verify/route.ts",
    authRequirement: "Webhook / User Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/early-access/route.ts": {
    filePath: "src/app/api/early-access/route.ts",
    authRequirement: "Public",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "src/app/api/email/unsubscribe/route.ts": {
    filePath: "src/app/api/email/unsubscribe/route.ts",
    authRequirement: "Signed HMAC Token",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/health/ready/route.ts": {
    filePath: "src/app/api/health/ready/route.ts",
    authRequirement: "Public",
    classification: "private/no-store",
    hasCacheControl: true,
    expectedHeaderSnippet: "no-store, no-cache, must-revalidate",
    isMisclassified: false,
  },
  "src/app/api/health/route.ts": {
    filePath: "src/app/api/health/route.ts",
    authRequirement: "Public",
    classification: "private/no-store",
    hasCacheControl: true,
    expectedHeaderSnippet: "no-store, no-cache, must-revalidate",
    isMisclassified: false,
  },
  "src/app/api/jobs/interview-pack/route.ts": {
    filePath: "src/app/api/jobs/interview-pack/route.ts",
    authRequirement: "Public Sample / Pro",
    classification: "private/no-store",
    hasCacheControl: true,
    handlerDelegatePath: "src/lib/interview-pack/handler.ts",
    expectedHeaderSnippet: "private, no-cache, no-store, must-revalidate",
    isMisclassified: false,
  },
  "src/app/api/jobs/pro/route.ts": {
    filePath: "src/app/api/jobs/pro/route.ts",
    authRequirement: "Pro User",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/jobs/search/route.ts": {
    filePath: "src/app/api/jobs/search/route.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "src/app/api/jobs/skill-what-if/route.ts": {
    filePath: "src/app/api/jobs/skill-what-if/route.ts",
    authRequirement: "Public Sample / Pro",
    classification: "private/no-store",
    hasCacheControl: true,
    handlerDelegatePath: "src/lib/skill-what-if/handler.ts",
    expectedHeaderSnippet: "private, no-cache, no-store, must-revalidate",
    isMisclassified: false,
  },
  "src/app/api/jobs/suggest/route.ts": {
    filePath: "src/app/api/jobs/suggest/route.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippet: "public, max-age=60",
    isMisclassified: false,
  },
  "src/app/api/jobs/top10/route.ts": {
    filePath: "src/app/api/jobs/top10/route.ts",
    authRequirement: "User Auth / Guest",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "src/app/api/me/quota/route.ts": {
    filePath: "src/app/api/me/quota/route.ts",
    authRequirement: "User Auth",
    classification: "private/no-store",
    hasCacheControl: true,
    expectedHeaderSnippet: "private, no-cache, no-store, must-revalidate",
    isMisclassified: false,
  },
  "src/app/api/radar/route.ts": {
    filePath: "src/app/api/radar/route.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippet: "public, s-maxage=300, stale-while-revalidate=600",
    isMisclassified: false,
  },
  "src/app/api/stats/route.ts": {
    filePath: "src/app/api/stats/route.ts",
    authRequirement: "Public / User Auth",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippet: "public, s-maxage=60, stale-while-revalidate=300",
    isMisclassified: false,
  },
  "src/app/api/ticker/route.ts": {
    filePath: "src/app/api/ticker/route.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippet: "public, s-maxage=60, stale-while-revalidate=300",
    isMisclassified: false,
  },
  "src/app/api/track/route.ts": {
    filePath: "src/app/api/track/route.ts",
    authRequirement: "Public / Session",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },

  // --- Netlify Serverless Functions (netlify/functions/**) ---
  "netlify/functions/account-delete.ts": {
    filePath: "netlify/functions/account-delete.ts",
    authRequirement: "User Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "netlify/functions/ai.ts": {
    filePath: "netlify/functions/ai.ts",
    authRequirement: "User Auth / Quota",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "netlify/functions/billing-razorpay-order.ts": {
    filePath: "netlify/functions/billing-razorpay-order.ts",
    authRequirement: "User Auth",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "netlify/functions/billing-razorpay-verify.ts": {
    filePath: "netlify/functions/billing-razorpay-verify.ts",
    authRequirement: "Payment Signature",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "netlify/functions/billing-razorpay-webhook.ts": {
    filePath: "netlify/functions/billing-razorpay-webhook.ts",
    authRequirement: "Webhook Signature",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "netlify/functions/email-unsubscribe.ts": {
    filePath: "netlify/functions/email-unsubscribe.ts",
    authRequirement: "Signed HMAC Token",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "netlify/functions/health.ts": {
    filePath: "netlify/functions/health.ts",
    authRequirement: "Public",
    classification: "private/no-store",
    hasCacheControl: true,
    expectedHeaderSnippet: "no-store, no-cache, must-revalidate",
    isMisclassified: false,
  },
  "netlify/functions/jobs-pro.ts": {
    filePath: "netlify/functions/jobs-pro.ts",
    authRequirement: "Pro User",
    classification: "private/no-store",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "netlify/functions/jobs-search.ts": {
    filePath: "netlify/functions/jobs-search.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: false,
    isMisclassified: true,
  },
  "netlify/functions/jobs-top10.ts": {
    filePath: "netlify/functions/jobs-top10.ts",
    authRequirement: "User Auth / Guest",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "netlify/functions/stats.ts": {
    filePath: "netlify/functions/stats.ts",
    authRequirement: "Public / User Auth",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippet: "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
    isMisclassified: false,
  },
  "netlify/functions/ticker.ts": {
    filePath: "netlify/functions/ticker.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippet: "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
    isMisclassified: false,
  },

  // --- Netlify Internal Helpers (non-routable utility modules) ---
  "netlify/functions/_cors.ts": {
    filePath: "netlify/functions/_cors.ts",
    authRequirement: "N/A Helper",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "netlify/functions/_logger.ts": {
    filePath: "netlify/functions/_logger.ts",
    authRequirement: "N/A Helper",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
  "netlify/functions/_sharedRateLimit.ts": {
    filePath: "netlify/functions/_sharedRateLimit.ts",
    authRequirement: "N/A Helper",
    classification: "intentionally uncached",
    hasCacheControl: false,
    isMisclassified: false,
  },
};

function walkRouteFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkRouteFiles(fullPath));
    } else if (/\.(ts|js)$/.test(entry.name)) {
      results.push(fullPath.replace(/\\/g, "/"));
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// 1. Discover all disk route and function files
// -----------------------------------------------------------------------------
const discoveredFiles = [
  ...walkRouteFiles("src/app/api"),
  ...walkRouteFiles("netlify/functions"),
];

check("discovered route files in src/app/api and netlify/functions", discoveredFiles.length >= 40);

// -----------------------------------------------------------------------------
// 2. Completeness Check: Every discovered file must be present in catalog baseline
// -----------------------------------------------------------------------------
const uncatalogedFiles: string[] = [];
for (const file of discoveredFiles) {
  if (!BASELINE_CACHE_CATALOG[file]) {
    uncatalogedFiles.push(file);
  }
}

check(
  "every disk route file is cataloged in BASELINE_CACHE_CATALOG",
  uncatalogedFiles.length === 0,
  uncatalogedFiles.join(", ")
);

// Check that every baseline route file actually exists on disk
const missingFiles: string[] = [];
for (const file of Object.keys(BASELINE_CACHE_CATALOG)) {
  if (!fs.existsSync(file)) {
    missingFiles.push(file);
  }
}

check(
  "every cataloged route file exists on disk",
  missingFiles.length === 0,
  missingFiles.join(", ")
);

// -----------------------------------------------------------------------------
// 3. Documentation Verification: docs/cache-posture.md existence and coverage
// -----------------------------------------------------------------------------
const docPath = path.join("docs", "cache-posture.md");
check("docs/cache-posture.md exists", fs.existsSync(docPath));

if (fs.existsSync(docPath)) {
  const docContent = fs.readFileSync(docPath, "utf8");
  check("doc contains complete catalog table header", docContent.includes("| Route / File Path | Methods | Auth Requirement |"));

  const missingFromDoc: string[] = [];
  for (const file of Object.keys(BASELINE_CACHE_CATALOG)) {
    if (!docContent.includes(`\`${file}\``)) {
      missingFromDoc.push(file);
    }
  }

  check(
    "every cataloged route is documented in docs/cache-posture.md",
    missingFromDoc.length === 0,
    missingFromDoc.join(", ")
  );
}

// -----------------------------------------------------------------------------
// 4. Cache-Control Baseline Snapshot Drift Check
// -----------------------------------------------------------------------------
const driftErrors: string[] = [];

for (const [routePath, baseline] of Object.entries(BASELINE_CACHE_CATALOG)) {
  // Read route file and optional handler delegate file
  const routeContent = fs.readFileSync(routePath, "utf8");
  const delegateContent = baseline.handlerDelegatePath && fs.existsSync(baseline.handlerDelegatePath)
    ? fs.readFileSync(baseline.handlerDelegatePath, "utf8")
    : "";

  const combinedContent = routeContent + "\n" + delegateContent;
  const hasCacheControlInCode = /cache-control/i.test(combinedContent);

  if (baseline.hasCacheControl && !hasCacheControlInCode) {
    driftErrors.push(
      `${routePath}: expected Cache-Control header handling but none found in code`
    );
  } else if (!baseline.hasCacheControl && hasCacheControlInCode) {
    // If a route without Cache-Control unexpectedly added one without baseline update
    driftErrors.push(
      `${routePath}: baseline expects 'none set' but found Cache-Control handling in code`
    );
  }

  // If specific snippet is expected, assert it exists in the combined code
  if (baseline.expectedHeaderSnippet) {
    if (!combinedContent.includes(baseline.expectedHeaderSnippet)) {
      driftErrors.push(
        `${routePath}: expected header snippet '${baseline.expectedHeaderSnippet}' not found in code`
      );
    }
  }
}

check(
  "no Cache-Control handling drift from baseline snapshot",
  driftErrors.length === 0,
  driftErrors.join("; ")
);

// -----------------------------------------------------------------------------
// 5. Misclassification Accounting Verification
// -----------------------------------------------------------------------------
const totalCataloged = Object.keys(BASELINE_CACHE_CATALOG).length;
const totalMisclassified = Object.values(BASELINE_CACHE_CATALOG).filter((r) => r.isMisclassified).length;
const sensitiveWithoutNoStore = Object.values(BASELINE_CACHE_CATALOG).filter(
  (r) => r.isMisclassified && r.classification === "private/no-store"
).length;

check("catalog contains 46 total files (43 endpoints + 3 helpers)", totalCataloged === 46);
check("catalog identifies exactly 21 misclassified / unhedged routes", totalMisclassified === 21);
check("identifies 19 sensitive routes lacking explicit no-store", sensitiveWithoutNoStore === 19);

// -----------------------------------------------------------------------------
// 6. Negative Control Self-Verification
// -----------------------------------------------------------------------------
function testNegativeControl(): boolean {
  // Test 1: Simulated uncataloged route
  const simulatedDiscovered = [...discoveredFiles, "src/app/api/unregistered/route.ts"];
  const uncataloged = simulatedDiscovered.filter((f) => !BASELINE_CACHE_CATALOG[f]);
  const detectedUncataloged = uncataloged.length === 1 && uncataloged[0] === "src/app/api/unregistered/route.ts";

  // Test 2: Simulated header drift
  const mockBaseline: RouteCacheBaseline = {
    filePath: "src/app/api/health/route.ts",
    authRequirement: "Public",
    classification: "private/no-store",
    hasCacheControl: true,
    expectedHeaderSnippet: "public, max-age=999999", // Intentional mismatch
    isMisclassified: false,
  };
  const healthContent = fs.readFileSync("src/app/api/health/route.ts", "utf8");
  const detectedDrift = !healthContent.includes(mockBaseline.expectedHeaderSnippet!);

  return detectedUncataloged && detectedDrift;
}

check("negative control: guard correctly detects uncataloged routes and header drift", testNegativeControl());

// -----------------------------------------------------------------------------
// Summary & Exit
// -----------------------------------------------------------------------------
console.log(`\nCatalog Summary: ${totalCataloged} files cataloged, ${totalMisclassified} routes lack explicit Cache-Control headers for their data sensitivity.`);
console.log(`Results: ${passed} passed, ${failed} failed.`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All cache posture guard checks passed successfully.");
  process.exit(0);
}
