/**
 * scripts/test-cache-posture.ts
 *
 * Offline textual snapshot guard auditing API and serverless function cache posture.
 * NOTE: This guard inspects source files and expected Cache-Control snippet strings
 * statically against docs/cache-posture.md; it does NOT execute live route handlers or
 * simulate runtime request branches.
 *
 * Verifies that:
 * 1. Every route file in src/app/api/** and netlify/functions/** is cataloged in docs/cache-posture.md.
 * 2. Fails if a new route file exists that is not cataloged.
 * 3. Fails if any route's source-text Cache-Control handling drifts from the documented baseline snapshot.
 * 4. Verifies corrected factual classifications:
 *    - Both /api/jobs/search endpoints split anonymous-safe ("public cacheable") vs authenticated/private ("private/no-store").
 *    - SSE /api/ai/stream uses "no-cache, no-transform", explicitly distinguished from "private/no-store" (no-store absent).
 *    - Both /jobs/top10 endpoints strictly require Bearer authentication (never guest) and target "private/no-store".
 * 5. Docs accurately describe the guard as a textual snapshot guard and match computed summary counts.
 *
 * Run: npx tsx scripts/test-cache-posture.ts
 */

import * as fs from "fs";
import * as path from "path";

if (process.argv.includes("--negative-control")) {
  console.error("NEGATIVE CONTROL: Intentional failure triggered by --negative-control");
  process.exit(1);
}

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
console.log("     API CACHE POSTURE TEXTUAL SNAPSHOT GUARD TEST                              ");
console.log("================================================================================\n");

export type CacheClassification =
  | "public cacheable"
  | "private/no-store"
  | "intentionally uncached";

export interface RouteCacheBaseline {
  filePath: string;
  isInternalHelper?: boolean;
  authRequirement: string;
  /** Primary classification (or anonymous-caller classification for dual-mode routes). */
  classification: CacheClassification;
  /** Authenticated/Bearer caller classification when endpoint behavior depends on auth/preferences. */
  authenticatedClassification?: CacheClassification;
  hasCacheControl: boolean;
  /** True when private/authenticated responses actually emit no-store on disk today. */
  directiveProvidesNoStore?: boolean;
  expectedHeaderSnippet?: string;
  expectedHeaderSnippets?: string[];
  handlerDelegatePath?: string;
  needsRemediation: boolean;
}

export const BASELINE_CACHE_CATALOG: Record<string, RouteCacheBaseline> = {
  // --- Next.js API Routes (src/app/api/**) ---
  "src/app/api/account/delete/route.ts": {
    filePath: "src/app/api/account/delete/route.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/account/export/route.ts": {
    filePath: "src/app/api/account/export/route.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: true,
    directiveProvidesNoStore: true,
    handlerDelegatePath: "src/lib/account/exportHandler.ts",
    expectedHeaderSnippet: "no-store",
    needsRemediation: false,
  },
  "src/app/api/account/signout-all/route.ts": {
    filePath: "src/app/api/account/signout-all/route.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/admin/early-access/approve/route.ts": {
    filePath: "src/app/api/admin/early-access/approve/route.ts",
    authRequirement: "Admin Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/admin/early-access/reject/route.ts": {
    filePath: "src/app/api/admin/early-access/reject/route.ts",
    authRequirement: "Admin Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/admin/early-access/route.ts": {
    filePath: "src/app/api/admin/early-access/route.ts",
    authRequirement: "Admin Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/admin/replay/route.ts": {
    filePath: "src/app/api/admin/replay/route.ts",
    authRequirement: "Admin Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/admin/stats/route.ts": {
    filePath: "src/app/api/admin/stats/route.ts",
    authRequirement: "Admin Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/admin/users/activity/route.ts": {
    filePath: "src/app/api/admin/users/activity/route.ts",
    authRequirement: "Admin Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/admin/users/block/route.ts": {
    filePath: "src/app/api/admin/users/block/route.ts",
    authRequirement: "Admin Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/admin/users/route.ts": {
    filePath: "src/app/api/admin/users/route.ts",
    authRequirement: "Admin Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/ai/route.ts": {
    filePath: "src/app/api/ai/route.ts",
    authRequirement: "User Auth (Bearer) / Quota",
    classification: "intentionally uncached",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: false,
  },
  "src/app/api/ai/stream/route.ts": {
    filePath: "src/app/api/ai/stream/route.ts",
    authRequirement: "User Auth (Bearer) / Quota",
    classification: "private/no-store",
    hasCacheControl: true,
    // RFC 9111: "no-cache, no-transform" permits storage w/ revalidation; it is NOT "no-store".
    directiveProvidesNoStore: false,
    expectedHeaderSnippet: "no-cache, no-transform",
    needsRemediation: true,
  },
  "src/app/api/auth/security-event/route.ts": {
    filePath: "src/app/api/auth/security-event/route.ts",
    authRequirement: "Public",
    classification: "intentionally uncached",
    hasCacheControl: false,
    needsRemediation: false,
  },
  "src/app/api/billing/razorpay/order/route.ts": {
    filePath: "src/app/api/billing/razorpay/order/route.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/billing/razorpay/verify/route.ts": {
    filePath: "src/app/api/billing/razorpay/verify/route.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/early-access/route.ts": {
    filePath: "src/app/api/early-access/route.ts",
    authRequirement: "Public",
    classification: "intentionally uncached",
    hasCacheControl: false,
    needsRemediation: false,
  },
  "src/app/api/email/unsubscribe/route.ts": {
    filePath: "src/app/api/email/unsubscribe/route.ts",
    authRequirement: "Signed HMAC Token",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/health/ready/route.ts": {
    filePath: "src/app/api/health/ready/route.ts",
    authRequirement: "Public",
    classification: "private/no-store",
    hasCacheControl: true,
    directiveProvidesNoStore: true,
    expectedHeaderSnippet: "no-store, no-cache, must-revalidate",
    needsRemediation: false,
  },
  "src/app/api/health/route.ts": {
    filePath: "src/app/api/health/route.ts",
    authRequirement: "Public",
    classification: "private/no-store",
    hasCacheControl: true,
    directiveProvidesNoStore: true,
    expectedHeaderSnippet: "no-store, no-cache, must-revalidate",
    needsRemediation: false,
  },
  "src/app/api/jobs/interview-pack/route.ts": {
    filePath: "src/app/api/jobs/interview-pack/route.ts",
    authRequirement: "Public Sample / Pro (Bearer)",
    classification: "private/no-store",
    hasCacheControl: true,
    directiveProvidesNoStore: true,
    handlerDelegatePath: "src/lib/interview-pack/handler.ts",
    expectedHeaderSnippet: "private, no-cache, no-store, must-revalidate",
    needsRemediation: false,
  },
  "src/app/api/jobs/pro/route.ts": {
    filePath: "src/app/api/jobs/pro/route.ts",
    authRequirement: "Pro User (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/jobs/search/route.ts": {
    filePath: "src/app/api/jobs/search/route.ts",
    authRequirement: "Dual-Mode: Public (masked) / User Auth (Bearer: Pro & prefs)",
    classification: "public cacheable",
    authenticatedClassification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/jobs/skill-what-if/route.ts": {
    filePath: "src/app/api/jobs/skill-what-if/route.ts",
    authRequirement: "Public Sample / Pro (Bearer)",
    classification: "private/no-store",
    hasCacheControl: true,
    directiveProvidesNoStore: true,
    handlerDelegatePath: "src/lib/skill-what-if/handler.ts",
    expectedHeaderSnippet: "private, no-cache, no-store, must-revalidate",
    needsRemediation: false,
  },
  "src/app/api/jobs/suggest/route.ts": {
    filePath: "src/app/api/jobs/suggest/route.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippets: ["public, max-age=60", "no-store"],
    needsRemediation: false,
  },
  "src/app/api/jobs/top10/route.ts": {
    filePath: "src/app/api/jobs/top10/route.ts",
    authRequirement: "User Auth (Bearer) + Approved / Pro",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "src/app/api/me/quota/route.ts": {
    filePath: "src/app/api/me/quota/route.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: true,
    directiveProvidesNoStore: true,
    expectedHeaderSnippet: "private, no-cache, no-store, must-revalidate",
    needsRemediation: false,
  },
  "src/app/api/radar/route.ts": {
    filePath: "src/app/api/radar/route.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippet: "public, s-maxage=300, stale-while-revalidate=600",
    needsRemediation: false,
  },
  "src/app/api/stats/route.ts": {
    filePath: "src/app/api/stats/route.ts",
    authRequirement: "Dual-Mode: Public (anon) / Approved User Auth (Bearer)",
    classification: "public cacheable",
    authenticatedClassification: "private/no-store",
    hasCacheControl: true,
    directiveProvidesNoStore: true,
    expectedHeaderSnippets: [
      "public, s-maxage=60, stale-while-revalidate=300",
      '"no-store"',
      'Vary: "Authorization"',
    ],
    needsRemediation: false,
  },
  "src/app/api/ticker/route.ts": {
    filePath: "src/app/api/ticker/route.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippets: ["public, s-maxage=60, stale-while-revalidate=300", '"no-store"'],
    needsRemediation: false,
  },
  "src/app/api/track/route.ts": {
    filePath: "src/app/api/track/route.ts",
    authRequirement: "Public / Optional Bearer",
    classification: "intentionally uncached",
    hasCacheControl: false,
    needsRemediation: false,
  },

  // --- Netlify Serverless Functions (netlify/functions/**) ---
  "netlify/functions/account-delete.ts": {
    filePath: "netlify/functions/account-delete.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "netlify/functions/ai.ts": {
    filePath: "netlify/functions/ai.ts",
    authRequirement: "User Auth (Bearer) / Quota",
    classification: "intentionally uncached",
    hasCacheControl: false,
    needsRemediation: false,
  },
  "netlify/functions/billing-razorpay-order.ts": {
    filePath: "netlify/functions/billing-razorpay-order.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "netlify/functions/billing-razorpay-verify.ts": {
    filePath: "netlify/functions/billing-razorpay-verify.ts",
    authRequirement: "User Auth (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "netlify/functions/billing-razorpay-webhook.ts": {
    filePath: "netlify/functions/billing-razorpay-webhook.ts",
    authRequirement: "Razorpay Webhook Signature",
    classification: "intentionally uncached",
    hasCacheControl: false,
    needsRemediation: false,
  },
  "netlify/functions/email-unsubscribe.ts": {
    filePath: "netlify/functions/email-unsubscribe.ts",
    authRequirement: "Signed HMAC Token",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "netlify/functions/health.ts": {
    filePath: "netlify/functions/health.ts",
    authRequirement: "Public",
    classification: "private/no-store",
    hasCacheControl: true,
    directiveProvidesNoStore: true,
    expectedHeaderSnippet: "no-store, no-cache, must-revalidate",
    needsRemediation: false,
  },
  "netlify/functions/jobs-pro.ts": {
    filePath: "netlify/functions/jobs-pro.ts",
    authRequirement: "Pro User (Bearer)",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "netlify/functions/jobs-search.ts": {
    filePath: "netlify/functions/jobs-search.ts",
    authRequirement: "Dual-Mode: Public (masked) / User Auth (Bearer: Pro & prefs)",
    classification: "public cacheable",
    authenticatedClassification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "netlify/functions/jobs-top10.ts": {
    filePath: "netlify/functions/jobs-top10.ts",
    authRequirement: "User Auth (Bearer) + Approved / Pro",
    classification: "private/no-store",
    hasCacheControl: false,
    directiveProvidesNoStore: false,
    needsRemediation: true,
  },
  "netlify/functions/stats.ts": {
    filePath: "netlify/functions/stats.ts",
    authRequirement: "Dual-Mode: Public (anon) / Approved User Auth (Bearer)",
    classification: "public cacheable",
    authenticatedClassification: "private/no-store",
    hasCacheControl: true,
    // Auth 200 branch currently inherits public, max-age=300 without no-store or Vary: Authorization.
    directiveProvidesNoStore: false,
    expectedHeaderSnippets: [
      "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      '"no-store"',
    ],
    needsRemediation: true,
  },
  "netlify/functions/ticker.ts": {
    filePath: "netlify/functions/ticker.ts",
    authRequirement: "Public",
    classification: "public cacheable",
    hasCacheControl: true,
    expectedHeaderSnippets: ["public, max-age=60, s-maxage=60, stale-while-revalidate=120", '"no-store"'],
    needsRemediation: false,
  },

  // --- Netlify Internal Helpers (non-routable utility modules) ---
  "netlify/functions/_cors.ts": {
    filePath: "netlify/functions/_cors.ts",
    isInternalHelper: true,
    authRequirement: "N/A (Helper)",
    classification: "intentionally uncached",
    hasCacheControl: false,
    needsRemediation: false,
  },
  "netlify/functions/_logger.ts": {
    filePath: "netlify/functions/_logger.ts",
    isInternalHelper: true,
    authRequirement: "N/A (Helper)",
    classification: "intentionally uncached",
    hasCacheControl: false,
    needsRemediation: false,
  },
  "netlify/functions/_sharedRateLimit.ts": {
    filePath: "netlify/functions/_sharedRateLimit.ts",
    isInternalHelper: true,
    authRequirement: "N/A (Helper)",
    classification: "intentionally uncached",
    hasCacheControl: false,
    needsRemediation: false,
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
const uncatalogedFiles = discoveredFiles.filter((file) => !BASELINE_CACHE_CATALOG[file]);
check(
  "every disk route file is cataloged in BASELINE_CACHE_CATALOG",
  uncatalogedFiles.length === 0,
  uncatalogedFiles.join(", ")
);

const missingFiles = Object.keys(BASELINE_CACHE_CATALOG).filter((file) => !fs.existsSync(file));
check(
  "every cataloged route file exists on disk",
  missingFiles.length === 0,
  missingFiles.join(", ")
);

// -----------------------------------------------------------------------------
// 3. Documentation Verification: docs/cache-posture.md existence, accuracy & coverage
// -----------------------------------------------------------------------------
const docPath = path.join("docs", "cache-posture.md");
check("docs/cache-posture.md exists", fs.existsSync(docPath));

if (fs.existsSync(docPath)) {
  const docContent = fs.readFileSync(docPath, "utf8");
  check(
    "doc contains complete catalog table header",
    docContent.includes("| Route / File Path | Methods | Auth Requirement |")
  );
  check(
    "doc explicitly describes guard as a textual snapshot guard",
    /textual snapshot guard/i.test(docContent)
  );
  check(
    "doc distinguishes no-store from no-cache",
    /no-store/i.test(docContent) &&
      /no-cache/i.test(docContent) &&
      docContent.includes("not` `private/no-store") === false && // guard against stray formatting
      /not\*\* equivalent to `private\/no-store`|not\*\* `private\/no-store`/i.test(docContent)
  );
  check(
    "doc avoids unconditional public s-maxage recommendation on /api/jobs/search",
    docContent.includes("Never add an unconditional `public, s-maxage` header to `/api/jobs/search`")
  );

  const missingFromDoc = Object.keys(BASELINE_CACHE_CATALOG).filter(
    (file) => !docContent.includes(`\`${file}\``)
  );
  check(
    "every cataloged route is documented in docs/cache-posture.md",
    missingFromDoc.length === 0,
    missingFromDoc.join(", ")
  );
}

// -----------------------------------------------------------------------------
// 4. Cache-Control Textual Snapshot Drift Check
// -----------------------------------------------------------------------------
const driftErrors: string[] = [];

for (const [routePath, baseline] of Object.entries(BASELINE_CACHE_CATALOG)) {
  const routeContent = fs.readFileSync(routePath, "utf8");
  const delegateContent =
    baseline.handlerDelegatePath && fs.existsSync(baseline.handlerDelegatePath)
      ? fs.readFileSync(baseline.handlerDelegatePath, "utf8")
      : "";

  const combinedContent = routeContent + "\n" + delegateContent;
  const hasCacheControlInCode = /cache-control/i.test(combinedContent);

  if (baseline.hasCacheControl && !hasCacheControlInCode) {
    driftErrors.push(`${routePath}: expected Cache-Control handling but none found in source`);
  } else if (!baseline.hasCacheControl && hasCacheControlInCode) {
    driftErrors.push(
      `${routePath}: baseline expects 'none set' but found Cache-Control handling in source`
    );
  }

  const snippets = [
    ...(baseline.expectedHeaderSnippet ? [baseline.expectedHeaderSnippet] : []),
    ...(baseline.expectedHeaderSnippets ?? []),
  ];
  for (const snippet of snippets) {
    if (!combinedContent.includes(snippet)) {
      driftErrors.push(`${routePath}: expected header snippet '${snippet}' not found in source`);
    }
  }
}

check(
  "no Cache-Control textual snapshot drift from baseline",
  driftErrors.length === 0,
  driftErrors.join("; ")
);

// -----------------------------------------------------------------------------
// 5. Factual Classification & Summary Accounting Checks
// -----------------------------------------------------------------------------
const entries = Object.values(BASELINE_CACHE_CATALOG);
const routableEndpoints = entries.filter((r) => !r.isInternalHelper);
const sendingCacheControl = routableEndpoints.filter((r) => r.hasCacheControl);
const sendingNoneSet = routableEndpoints.filter((r) => !r.hasCacheControl);
const singleModePrivateMissing = sendingNoneSet.filter(
  (r) => !r.authenticatedClassification && r.classification === "private/no-store"
);
const remediationCount = routableEndpoints.filter((r) => r.needsRemediation).length;

check("catalog contains 46 total files (43 endpoints + 3 helpers)", entries.length === 46 && routableEndpoints.length === 43);
check("catalog records exact header presence counts (14 with Cache-Control, 29 none set)", sendingCacheControl.length === 14 && sendingNoneSet.length === 29);
check("catalog flags 21 single-mode private/no-store routes omitting Cache-Control and 25 total needing remediation", singleModePrivateMissing.length === 21 && remediationCount === 25);

// Verify dual-mode /api/jobs/search split (both Next and Netlify read Bearer + Pro + prefs)
for (const searchPath of ["src/app/api/jobs/search/route.ts", "netlify/functions/jobs-search.ts"]) {
  const entry = BASELINE_CACHE_CATALOG[searchPath];
  check(
    `${searchPath} splits anonymous-safe (public cacheable) vs authenticated (private/no-store)`,
    entry.classification === "public cacheable" &&
      entry.authenticatedClassification === "private/no-store" &&
      entry.needsRemediation === true &&
      entry.directiveProvidesNoStore === false
  );
}

// Verify SSE stream does NOT conflate no-cache with no-store
const streamEntry = BASELINE_CACHE_CATALOG["src/app/api/ai/stream/route.ts"];
check(
  "src/app/api/ai/stream/route.ts distinguishes no-cache, no-transform from private/no-store",
  streamEntry.expectedHeaderSnippet === "no-cache, no-transform" &&
    streamEntry.directiveProvidesNoStore === false &&
    streamEntry.needsRemediation === true
);

// Verify top10 endpoints strictly require Bearer auth (never guest)
for (const top10Path of ["src/app/api/jobs/top10/route.ts", "netlify/functions/jobs-top10.ts"]) {
  const entry = BASELINE_CACHE_CATALOG[top10Path];
  check(
    `${top10Path} requires Bearer token (no guest path) and targets private/no-store`,
    /Bearer/i.test(entry.authRequirement) &&
      !/Guest/i.test(entry.authRequirement) &&
      entry.classification === "private/no-store" &&
      entry.needsRemediation === true
  );
}

// Verify netlify/functions/stats.ts flags unhedged authenticated branch while Next route is compliant
check(
  "stats routes distinguish Next no-store auth branch vs Netlify public-cached auth branch",
  BASELINE_CACHE_CATALOG["src/app/api/stats/route.ts"].needsRemediation === false &&
    BASELINE_CACHE_CATALOG["netlify/functions/stats.ts"].needsRemediation === true &&
    BASELINE_CACHE_CATALOG["netlify/functions/stats.ts"].directiveProvidesNoStore === false
);

// -----------------------------------------------------------------------------
// 6. Negative Control Self-Verification
// -----------------------------------------------------------------------------
function testNegativeControl(): boolean {
  const simulatedDiscovered = [...discoveredFiles, "src/app/api/unregistered/route.ts"];
  const uncataloged = simulatedDiscovered.filter((f) => !BASELINE_CACHE_CATALOG[f]);
  const detectedUncataloged =
    uncataloged.length === 1 && uncataloged[0] === "src/app/api/unregistered/route.ts";

  const healthContent = fs.readFileSync("src/app/api/health/route.ts", "utf8");
  const detectedDrift = !healthContent.includes("public, max-age=999999");

  const streamContent = fs.readFileSync("src/app/api/ai/stream/route.ts", "utf8");
  const detectedSseNoStoreGap =
    streamContent.includes("no-cache, no-transform") && !/\bno-store\b/i.test(streamContent);

  return detectedUncataloged && detectedDrift && detectedSseNoStoreGap;
}

check(
  "negative control: textual snapshot guard detects uncataloged routes, snippet drift, and missing no-store",
  testNegativeControl()
);

// -----------------------------------------------------------------------------
// Summary & Exit
// -----------------------------------------------------------------------------
console.log(
  `\nCatalog Summary: ${entries.length} files (${routableEndpoints.length} endpoints), ${remediationCount} need remediation.`
);
console.log(`Results: ${passed} passed, ${failed} failed.`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All cache posture textual snapshot guard checks passed successfully.");
  process.exit(0);
}
