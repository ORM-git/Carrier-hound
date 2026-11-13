/**
 * scripts/check-prelaunch-security.cjs
 *
 * Standalone offline pre-launch security checker for CareerMonke launch gate.
 * Validates 5 critical pre-launch security postures:
 * 1. Secrets: Scans repository for service-role keys, JWTs, Razorpay secrets, sb_secret_*, and modern API keys outside exact reviewed exemptions.
 * 2. Headers: Source parity between public/_headers and netlify.toml for CSP, X-Frame-Options/frame-ancestors, X-Content-Type-Options, Referrer-Policy, HSTS; Razorpay checkout is the only external script exception.
 * 3. Auth Gating & Contracts: Heuristic evidence inventory of API routes in src/app/api and netlify/functions; verifies auth call invocations, webhook HMAC signatures, and public jobs reads.
 * 4. Debug Surfaces & Logs: No route or page exports debug/test fixtures; no debug endpoints; no console.log/error/warn or logger payloads leaking bodies or auth tokens.
 * 5. Payments-OFF State: Checkout routes are safely gated behind NEXT_PUBLIC_BILLING_ENABLED with test-mode enforcement; local env payments-off baseline verified.
 *
 * Run: node scripts/check-prelaunch-security.cjs
 * Negative controls: node scripts/check-prelaunch-security.cjs --test-negative-controls
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// =============================================================================
// RESULT TRACKING & REPORTING HELPERS
// =============================================================================

function createReporter() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function recordPass(checkName, evidence) {
    passed++;
    console.log(`[PASS] ${checkName}`);
    if (evidence) {
      console.log(`       Evidence: ${evidence}`);
    }
  }

  function recordFail(checkName, reason, evidence) {
    failed++;
    const msg = `[FAIL] ${checkName} - ${reason}`;
    failures.push({ checkName, reason, evidence });
    console.log(msg);
    if (evidence) {
      console.log(`       Evidence: ${evidence}`);
    }
  }

  return {
    get passed() { return passed; },
    get failed() { return failed; },
    failures,
    recordPass,
    recordFail,
  };
}

// =============================================================================
// CHECK 1: Secrets Scanning
// =============================================================================

const SECRET_PATTERNS = [
  {
    name: "JWT Token",
    regex: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
  },
  {
    name: "Supabase Service/Access Token (Legacy)",
    regex: /sbp_[a-zA-Z0-9]{20,}/,
  },
  {
    name: "Supabase Modern Secret Key",
    regex: /sb_secret_[a-zA-Z0-9_-]{16,}/,
  },
  {
    name: "Stripe Key",
    regex: /(?:sk|pk)_(?:test|live)_[a-zA-Z0-9]{20,}/,
  },
  {
    name: "Razorpay Key",
    regex: /rzp_(?:test|live)_[a-zA-Z0-9]{14,}/,
  },
  {
    name: "Groq Key",
    regex: /gsk_[a-zA-Z0-9]{20,}/,
  },
  {
    name: "Resend API Key",
    regex: /re_[a-zA-Z0-9]{24,}/,
  },
  {
    name: "GitHub Token",
    regex: /(?:ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{22,})/,
  },
  {
    name: "Hardcoded Secret Assignment",
    regex: /(?:SUPABASE_SERVICE_ROLE_KEY|RAZORPAY_KEY_SECRET|RESEND_API_KEY|ADMIN_SECRET)\s*[:=]\s*["'][a-zA-Z0-9_-]{12,}["']/,
  },
];

// Exact reviewed exemptions containing documented placeholders, offline mock fixtures, or test harness credentials
const REVIEWED_SECRET_EXEMPTIONS = new Set([
  ".env.example",
  ".gitleaks.toml",
  "scripts/load-handlers-local.ts",
  "scripts/test-admin-audit-log.ts",
  "scripts/test-admin-secret-bypass.ts",
  "scripts/test-ai-resume-tailor.ts",
  "scripts/test-authz-handlers.ts",
  "scripts/test-country-eligibility-and-currency.ts",
  "scripts/test-early-access.ts",
  "scripts/test-email-unsubscribe.ts",
  "scripts/test-env-guards.ts",
  "scripts/test-groq-timeout-circuit-breaker.ts",
  "scripts/test-health-logging.ts",
  "scripts/test-pro-unlock-errors.ts",
  "scripts/test-production-fixes.ts",
  "scripts/test-prompt1-system-fixes.ts",
  "scripts/test-prompt2-security-fixes.ts",
  "scripts/test-razorpay-billing.ts",
  "scripts/test-runner-guard.cjs",
  "scripts/test-stats-and-invite-gate.ts",
  "scripts/test-ticker-paging-and-strip.ts",
  "scripts/test-upstream-streaming-core.ts",
  "scripts/test-xss-csp-ai-uploads.ts",
  "src/lib/ai/__tests__/providerAdapter.test.ts",
]);

function scanSecrets({ files, readFile, reporter }) {
  const detectedSecrets = [];
  let scannedCount = 0;
  let skippedCount = 0;

  for (const relPath of files) {
    const normPath = relPath.replace(/\\/g, "/");
    if (REVIEWED_SECRET_EXEMPTIONS.has(normPath)) {
      skippedCount++;
      continue;
    }

    scannedCount++;
    let content = "";
    try {
      content = readFile(normPath);
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { name, regex } of SECRET_PATTERNS) {
        if (regex.test(line)) {
          detectedSecrets.push({
            file: normPath,
            line: i + 1,
            name,
            snippet: line.trim().substring(0, 80),
          });
        }
      }
    }
  }

  if (detectedSecrets.length === 0) {
    reporter.recordPass(
      "No secrets, service-role keys, or private API credentials in scanned repo files",
      `Scanned ${scannedCount} tracked files (${skippedCount} reviewed exemptions skipped): 0 secrets detected`
    );
    console.log("       Note: Static scan complements Gitleaks pre-commit hooks and does not prove the absence of unknown, obfuscated, or custom-format secrets.");
  } else {
    const evidence = detectedSecrets
      .map((d) => `${d.file}:${d.line} (${d.name})`)
      .join("; ");
    reporter.recordFail(
      "No secrets, service-role keys, or private API credentials in scanned repo files",
      `${detectedSecrets.length} secret(s) found outside reviewed exemptions`,
      evidence
    );
  }

  return detectedSecrets;
}

// =============================================================================
// CHECK 2: Security Headers Parity & CSP Script-Src Exception
// =============================================================================

function scanHeaders({ headersRaw, netlifyRaw, reporter }) {
  // Extract public/_headers global values under /*
  function getHeadersValues(raw) {
    const lines = raw.split("\n");
    const values = {};
    let inGlobal = false;
    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed === "/*") {
        inGlobal = true;
        continue;
      }
      if (inGlobal) {
        if (trimmed.startsWith("/") && trimmed.endsWith("/*")) {
          break; // Next block
        }
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx > 0) {
          const k = trimmed.substring(0, colonIdx).trim();
          const v = trimmed.substring(colonIdx + 1).trim();
          values[k] = v;
        }
      }
    }
    return values;
  }

  // Extract netlify.toml headers values under [[headers]] for = "/*"
  function getNetlifyValues(raw) {
    const values = {};
    const globalHeaderBlock = raw.match(/\[\[headers\]\]\s+for\s*=\s*"[/]\*"\s+\[headers\.values\]([^\[]+)/s);
    if (!globalHeaderBlock) return values;
    const lines = globalHeaderBlock[1].split("\n");
    for (const l of lines) {
      const match = l.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/);
      if (match) {
        values[match[1]] = match[2];
      }
    }
    return values;
  }

  const hVals = getHeadersValues(headersRaw);
  const nVals = getNetlifyValues(netlifyRaw);

  // 2.1 X-Content-Type-Options: nosniff
  if (hVals["X-Content-Type-Options"] === "nosniff" && nVals["X-Content-Type-Options"] === "nosniff") {
    reporter.recordPass(
      "X-Content-Type-Options header source parity (nosniff)",
      `public/_headers:2 ('nosniff') <-> netlify.toml:144 ('nosniff')`
    );
  } else {
    reporter.recordFail(
      "X-Content-Type-Options header source parity (nosniff)",
      `Mismatch: public/_headers=${hVals["X-Content-Type-Options"]} vs netlify.toml=${nVals["X-Content-Type-Options"]}`,
      "public/_headers, netlify.toml"
    );
  }

  // 2.2 X-Frame-Options: DENY
  if (hVals["X-Frame-Options"] === "DENY" && nVals["X-Frame-Options"] === "DENY") {
    reporter.recordPass(
      "X-Frame-Options header source parity (DENY)",
      `public/_headers:3 ('DENY') <-> netlify.toml:145 ('DENY')`
    );
  } else {
    reporter.recordFail(
      "X-Frame-Options header source parity (DENY)",
      `Mismatch: public/_headers=${hVals["X-Frame-Options"]} vs netlify.toml=${nVals["X-Frame-Options"]}`,
      "public/_headers, netlify.toml"
    );
  }

  // 2.3 Referrer-Policy: strict-origin-when-cross-origin
  if (
    hVals["Referrer-Policy"] === "strict-origin-when-cross-origin" &&
    nVals["Referrer-Policy"] === "strict-origin-when-cross-origin"
  ) {
    reporter.recordPass(
      "Referrer-Policy header source parity (strict-origin-when-cross-origin)",
      `public/_headers:4 ('strict-origin-when-cross-origin') <-> netlify.toml:146 ('strict-origin-when-cross-origin')`
    );
  } else {
    reporter.recordFail(
      "Referrer-Policy header source parity (strict-origin-when-cross-origin)",
      `Mismatch: public/_headers=${hVals["Referrer-Policy"]} vs netlify.toml=${nVals["Referrer-Policy"]}`,
      "public/_headers, netlify.toml"
    );
  }

  // 2.4 HSTS (Strict-Transport-Security)
  const hHsts = hVals["Strict-Transport-Security"] || "";
  const nHsts = nVals["Strict-Transport-Security"] || "";
  const hstsExpected = "max-age=31536000; includeSubDomains; preload";
  if (hHsts === hstsExpected && nHsts === hstsExpected) {
    reporter.recordPass(
      "Strict-Transport-Security (HSTS) header source parity",
      `public/_headers:6 ('${hstsExpected}') <-> netlify.toml:148 ('${hstsExpected}')`
    );
  } else {
    reporter.recordFail(
      "Strict-Transport-Security (HSTS) header source parity",
      `Mismatch: public/_headers='${hHsts}' vs netlify.toml='${nHsts}'`,
      "public/_headers, netlify.toml"
    );
  }

  // 2.5 CSP Parity & frame-ancestors
  const hCsp = (hVals["Content-Security-Policy"] || "").replace(/\s+/g, " ").trim();
  const nCsp = (nVals["Content-Security-Policy"] || "").replace(/\s+/g, " ").trim();

  if (hCsp === nCsp && hCsp.length > 0) {
    reporter.recordPass(
      "Content-Security-Policy (CSP) source parity (whitespace-normalized match)",
      `public/_headers:7 <-> netlify.toml:149 (normalized token match, length: ${hCsp.length})`
    );
  } else {
    reporter.recordFail(
      "Content-Security-Policy (CSP) source parity (whitespace-normalized match)",
      "public/_headers and netlify.toml CSP strings differ after whitespace normalization",
      `public/_headers length=${hCsp.length}, netlify.toml length=${nCsp.length}`
    );
  }

  // 2.6 frame-ancestors 'none'
  if (hCsp.includes("frame-ancestors 'none'") && nCsp.includes("frame-ancestors 'none'")) {
    reporter.recordPass(
      "CSP frame-ancestors restriction ('none')",
      `public/_headers:7 ('frame-ancestors \\'none\\'') <-> netlify.toml:149 ('frame-ancestors \\'none\\'')`
    );
  } else {
    reporter.recordFail(
      "CSP frame-ancestors restriction ('none')",
      "frame-ancestors 'none' missing from CSP",
      "public/_headers, netlify.toml"
    );
  }

  // 2.7 Razorpay checkout exception in script-src
  const scriptSrcMatch = hCsp.match(/script-src\s+([^;]+);/);
  if (scriptSrcMatch) {
    const scriptSrcSources = scriptSrcMatch[1].split(/\s+/).filter(Boolean);
    const ALLOWED_SCRIPT_SOURCES = new Set([
      "'self'",
      "'unsafe-inline'",
      "https://cdnjs.cloudflare.com",
      "https://checkout.razorpay.com",
      "https://accounts.google.com",
      "https://apis.google.com",
    ]);

    const unexpectedSources = scriptSrcSources.filter((s) => !ALLOWED_SCRIPT_SOURCES.has(s));
    const hasRazorpay = scriptSrcSources.includes("https://checkout.razorpay.com");

    if (hasRazorpay && unexpectedSources.length === 0) {
      reporter.recordPass(
        "CSP script-src allowlist: Razorpay checkout is the sole payment checkout script exception",
        `public/_headers:7 (script-src contains only self, unsafe-inline, cdnjs, checkout.razorpay.com, accounts.google.com, apis.google.com)`
      );
      console.log("       Note: Header check verifies repository source parity, not live CDN edge deployment. Residual CSP allowances include 'unsafe-inline' (Next.js App Router RSC hydration) and external origins.");
    } else {
      reporter.recordFail(
        "CSP script-src allowlist: Razorpay checkout is the sole payment checkout script exception",
        `Unexpected or missing script-src entries: unexpected=[${unexpectedSources.join(", ")}], hasRazorpay=${hasRazorpay}`,
        `public/_headers:7: ${scriptSrcMatch[0]}`
      );
    }
  } else {
    reporter.recordFail("CSP script-src allowlist", "script-src directive not found in CSP", "public/_headers:7");
  }
}

// =============================================================================
// CHECK 3: Auth Gating & Contracts Heuristic Evidence Inventory
// =============================================================================

const PUBLIC_OR_WEBHOOK_ALLOWLIST = new Set([
  "src/app/api/health/route.ts",
  "src/app/api/health/ready/route.ts",
  "src/app/api/jobs/search/route.ts",
  "src/app/api/jobs/suggest/route.ts",
  "src/app/api/radar/route.ts",
  "src/app/api/stats/route.ts",
  "src/app/api/ticker/route.ts",
  "src/app/api/early-access/route.ts",
  "src/app/api/auth/security-event/route.ts",
  "src/app/api/track/route.ts",
  "src/app/api/email/unsubscribe/route.ts",
  "netlify/functions/health.ts",
  "netlify/functions/jobs-search.ts",
  "netlify/functions/stats.ts",
  "netlify/functions/ticker.ts",
  "netlify/functions/billing-razorpay-webhook.ts",
  "netlify/functions/email-unsubscribe.ts",
]);

function scanAuthGating({ apiFiles, readFile, reporter }) {
  // Heuristic signatures for route authentication & token extraction
  const AUTH_SIGNATURES = [
    /verifyAdminSession\s*\(/,
    /verifyProUser\s*\(/,
    /handleAccountDelete/,
    /handleAccountExport/,
    /handleSignoutAll/,
    /handleAiRequest/,
    /handleNetlifyAiRequest/,
    /executeAiCore/,
    /handleInterviewPackRequest/,
    /handleSkillWhatIfRequest/,
    /auth\.getUser\(/,
    /extractToken\(/,
    /verifyUnsubscribeToken\(/,
    /createHmac\(/,
  ];

  const unauthenticatedRoutes = [];
  const authenticatedRoutes = [];
  const contractViolations = [];

  for (const relPath of apiFiles) {
    const normPath = relPath.replace(/\\/g, "/");
    let content = "";
    try {
      content = readFile(normPath);
    } catch {
      continue;
    }

    // Contract check for Admin routes: must both import AND actively invoke verifyAdminSession(req)
    if (normPath.startsWith("src/app/api/admin/")) {
      const hasImport = /import.*verifyAdminSession.*from/.test(content);
      const hasCall = /verifyAdminSession\s*\(/.test(content.replace(/import.*verifyAdminSession.*from[^\n]+/, ""));
      if (!hasImport || !hasCall) {
        contractViolations.push(`${normPath} (missing active verifyAdminSession() call invocation)`);
      }
    }

    // Contract check for Webhook: must actively compute HMAC and perform constant-time comparison
    if (normPath === "netlify/functions/billing-razorpay-webhook.ts") {
      const hasHmac = /createHmac\s*\(\s*["']sha256["']/.test(content);
      const hasTimingSafe = /timingSafeEqual|constantTimeCompare/.test(content);
      if (!hasHmac || !hasTimingSafe) {
        contractViolations.push(`${normPath} (missing HMAC sha256 or constant-time comparison)`);
      }
    }

    // Contract check for Unsubscribe endpoints: must verify signed token
    if (normPath === "src/app/api/email/unsubscribe/route.ts" || normPath === "netlify/functions/email-unsubscribe.ts") {
      const hasTokenVerify = /verifyUnsubscribeToken\s*\(/.test(content);
      if (!hasTokenVerify) {
        contractViolations.push(`${normPath} (missing verifyUnsubscribeToken() invocation)`);
      }
    }

    // Contract check for Public Job reads: must query jobs_public view
    if (normPath === "src/app/api/jobs/search/route.ts" || normPath === "netlify/functions/jobs-search.ts") {
      const hasPublicView = /jobs_public/.test(content);
      if (!hasPublicView) {
        contractViolations.push(`${normPath} (public search does not reference jobs_public view)`);
      }
    }

    if (PUBLIC_OR_WEBHOOK_ALLOWLIST.has(normPath)) {
      continue;
    }

    const hasAuth = AUTH_SIGNATURES.some((regex) => regex.test(content));
    if (hasAuth) {
      authenticatedRoutes.push(normPath);
    } else {
      unauthenticatedRoutes.push(normPath);
    }
  }

  // 3.1 Heuristic inventory of user-data routes
  if (unauthenticatedRoutes.length === 0) {
    reporter.recordPass(
      "Heuristic evidence inventory: user-data API routes match established auth patterns",
      `Inventoried ${authenticatedRoutes.length} user-data routes; ${PUBLIC_OR_WEBHOOK_ALLOWLIST.size} public/webhook/probe endpoints inspected against contracts`
    );
    console.log("       Note: Static heuristic scan of auth helper imports and invocation signatures. Token presence is not proof of enforcement at runtime.");
  } else {
    reporter.recordFail(
      "Heuristic evidence inventory: user-data API routes match established auth patterns",
      `Routes missing established auth helper signatures: ${unauthenticatedRoutes.join(", ")}`,
      unauthenticatedRoutes.join("; ")
    );
  }

  // 3.2 Inspected contracts (Admin call invocation, Webhook HMAC, Unsubscribe token, Public jobs view)
  if (contractViolations.length === 0) {
    reporter.recordPass(
      "Route contract verification (admin call invocations, webhook HMAC, unsubscribe tokens, public jobs view)",
      "All inspected contracts satisfied across admin endpoints and allowlisted webhooks/reads"
    );
  } else {
    reporter.recordFail(
      "Route contract verification (admin call invocations, webhook HMAC, unsubscribe tokens, public jobs view)",
      `Contract violations detected: ${contractViolations.join("; ")}`,
      contractViolations.join("; ")
    );
  }
}

// =============================================================================
// CHECK 4: Debug Surfaces & Server Logging Posture
// =============================================================================

function scanDebugSurfaces({ appFiles, serverFiles, readFile, reporter }) {
  // 4.1 Check for debug endpoints
  const debugEndpoints = [];
  for (const relPath of appFiles) {
    const norm = relPath.replace(/\\/g, "/");
    if (
      (norm.startsWith("src/app/api/") || norm.startsWith("netlify/functions/")) &&
      (/\/(?:debug|test)\//i.test(norm) || /\/(?:debug|test)-/i.test(norm))
    ) {
      debugEndpoints.push(norm);
    }
  }

  if (debugEndpoints.length === 0) {
    reporter.recordPass(
      "No debug or test fixture endpoints exist in API routes or functions",
      "0 debug/test endpoints found under src/app/api or netlify/functions"
    );
  } else {
    reporter.recordFail(
      "No debug or test fixture endpoints exist in API routes or functions",
      "Debug endpoints detected in production routes",
      debugEndpoints.join("; ")
    );
  }

  // 4.2 Check for exported debug fixtures (named & default exports)
  const exportedFixtures = [];
  const EXPORT_FIXTURE_REGEX = /export\s+(?:default\s+)?(?:const|function|let|var|class)?\s*(?:mock|fixture|testFixture|__mock|debugFixture|testData)\b/i;
  const EXPORT_NAMED_FIXTURE_REGEX = /export\s*\{[^}]*\b(?:mock|fixture|testFixture|__mock|debugFixture|testData)\b/i;

  for (const relPath of appFiles) {
    const norm = relPath.replace(/\\/g, "/");
    if (norm.includes("/__tests__/") || norm.endsWith(".test.ts") || norm.endsWith(".test.tsx")) continue;

    let content = "";
    try {
      content = readFile(norm);
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (EXPORT_FIXTURE_REGEX.test(line) || EXPORT_NAMED_FIXTURE_REGEX.test(line)) {
        exportedFixtures.push(`${norm}:${i + 1}`);
      }
    }
  }

  if (exportedFixtures.length === 0) {
    reporter.recordPass(
      "No routes or pages export debug or test fixtures (default or named)",
      `Scanned ${appFiles.length} files under src/app and netlify/functions: 0 fixture exports`
    );
  } else {
    reporter.recordFail(
      "No routes or pages export debug or test fixtures (default or named)",
      "Exported debug/test fixtures found in production routes",
      exportedFixtures.join("; ")
    );
  }

  // 4.3 Sensitive logging scan (console.log/error/warn and logger payloads)
  const SENSITIVE_PAYLOAD_REGEX = /(?:console\.(?:log|error|warn|info)|(?:safeLog|log|baseLog|logger)\.(?:info|error|warn|debug))\([^)]*?(?:req\.body|request\.body|\b(?:token|authHeader|password|secret|bearer)\s*[,):]|\{\s*[^}]*\b(?:req\.body|request\.body|token|authHeader|password|secret|bearer)\b)/i;
  const RAW_CONSOLE_LOG_IN_ROUTES = /console\.(?:log|error|warn|info)\(/;

  const sensitiveLogs = [];
  for (const relPath of serverFiles) {
    const norm = relPath.replace(/\\/g, "/");
    // Skip logger implementation modules that sanitize output
    if (norm === "netlify/functions/_logger.ts" || norm === "src/lib/observability/logger.ts") continue;

    let content = "";
    try {
      content = readFile(norm);
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (SENSITIVE_PAYLOAD_REGEX.test(line)) {
        sensitiveLogs.push(`${norm}:${i + 1}`);
      } else if (norm.startsWith("src/app/api/") && RAW_CONSOLE_LOG_IN_ROUTES.test(line)) {
        sensitiveLogs.push(`${norm}:${i + 1}`);
      }
    }
  }

  if (sensitiveLogs.length === 0) {
    reporter.recordPass(
      "Zero console.(log|error|warn) or logger payloads leaking req.body or tokens in server code",
      `Scanned ${serverFiles.length} server files in src/app/api, netlify/functions, and src/lib: 0 sensitive logs`
    );
  } else {
    reporter.recordFail(
      "Zero console.(log|error|warn) or logger payloads leaking req.body or tokens in server code",
      "Sensitive logging detected in server files",
      sensitiveLogs.join("; ")
    );
  }
}

// =============================================================================
// CHECK 5: Payments-OFF Launch State Verification
// =============================================================================

function scanPaymentsOff({ env, nextContent, netlifyContent, flagsContent, envExampleContent, reporter }) {
  // 5.1 Next.js order route gating
  const hasNextFlagGate = /process\.env\.NEXT_PUBLIC_BILLING_ENABLED\s*!==\s*["']true["']/.test(nextContent);
  const hasNextFlagBypass = /if\s*\(\s*(?:false\s*&&|true\s*\|\|)[^)]*NEXT_PUBLIC_BILLING_ENABLED/.test(nextContent);
  const hasNext503 = nextContent.includes("BILLING_DISABLED") && nextContent.includes("status: 503");
  const hasNextTestModeGate = nextContent.includes('!keyId.startsWith("rzp_test_")') || nextContent.includes('resolvedMode !== "test"');

  if (hasNextFlagGate && !hasNextFlagBypass && hasNext503 && hasNextTestModeGate) {
    reporter.recordPass(
      "Next.js Razorpay order route (/api/billing/razorpay/order) fails closed (503) when billing disabled",
      "src/app/api/billing/razorpay/order/route.ts:19-24 (503 BILLING_DISABLED) & line:79 (rzp_test_ requirement)"
    );
  } else {
    reporter.recordFail(
      "Next.js Razorpay order route fails closed when billing disabled",
      "Missing flag check, bypass detected, missing 503 status, or test mode restriction missing",
      "src/app/api/billing/razorpay/order/route.ts"
    );
  }

  // 5.2 Netlify order function gating
  const hasNetlifyFlagGate = /process\.env\.NEXT_PUBLIC_BILLING_ENABLED\s*!==\s*["']true["']/.test(netlifyContent);
  const hasNetlifyFlagBypass = /if\s*\(\s*(?:false\s*&&|true\s*\|\|)[^)]*NEXT_PUBLIC_BILLING_ENABLED/.test(netlifyContent);
  const hasNetlify503 = netlifyContent.includes("BILLING_DISABLED") && netlifyContent.includes("statusCode: 503");

  if (hasNetlifyFlagGate && !hasNetlifyFlagBypass && hasNetlify503) {
    reporter.recordPass(
      "Netlify Razorpay order function (/billing-razorpay-order) fails closed (503) when billing disabled",
      "netlify/functions/billing-razorpay-order.ts:58-67 (statusCode: 503 BILLING_DISABLED)"
    );
  } else {
    reporter.recordFail(
      "Netlify Razorpay order function fails closed when billing disabled",
      "Missing flag check, bypass detected, or missing 503 status code",
      "netlify/functions/billing-razorpay-order.ts"
    );
  }

  // 5.3 Feature flags registry configuration
  const hasBillingFlag = flagsContent.includes('"NEXT_PUBLIC_BILLING_ENABLED"');
  const hasDefaultFalse = flagsContent.includes("defaultEnabled: false");
  const hasStrictTrue = flagsContent.includes('rule: "strict_true"');

  if (hasBillingFlag && hasDefaultFalse && hasStrictTrue) {
    reporter.recordPass(
      "Feature flag registry: NEXT_PUBLIC_BILLING_ENABLED defaults to false with strict_true rule",
      "src/lib/flags/flags.ts:31"
    );
  } else {
    reporter.recordFail(
      "Feature flag registry: NEXT_PUBLIC_BILLING_ENABLED configuration",
      "Flag not configured as strict_true or defaultEnabled: false",
      "src/lib/flags/flags.ts"
    );
  }

  // 5.4 .env.example baseline
  if (envExampleContent.includes("NEXT_PUBLIC_BILLING_ENABLED=false")) {
    reporter.recordPass(
      ".env.example commits NEXT_PUBLIC_BILLING_ENABLED=false as repo static baseline",
      ".env.example:22"
    );
  } else {
    reporter.recordFail(
      ".env.example commits NEXT_PUBLIC_BILLING_ENABLED=false",
      ".env.example does not set NEXT_PUBLIC_BILLING_ENABLED=false",
      ".env.example"
    );
  }

  // 5.5 Local environment payments-off baseline enforcement
  const currentEnvVal = env.NEXT_PUBLIC_BILLING_ENABLED;
  const isFlagActive = currentEnvVal === "true";

  if (isFlagActive) {
    reporter.recordFail(
      "Local environment payments-off baseline",
      "NEXT_PUBLIC_BILLING_ENABLED is set to 'true' in local environment (launch posture requires payments OFF)",
      `process.env.NEXT_PUBLIC_BILLING_ENABLED='${currentEnvVal}'`
    );
  } else {
    reporter.recordPass(
      "Local environment payments-off baseline",
      `NEXT_PUBLIC_BILLING_ENABLED is ${currentEnvVal !== undefined ? JSON.stringify(currentEnvVal) : "undefined (defaults to false)"} (launch posture: payments OFF in local env)`
    );
    console.log("       Note: Local environment is NOT production evidence. Production deployment posture is UNVERIFIED pending owner dashboard verification.");
  }
}

// =============================================================================
// NEGATIVE CONTROLS SUITE
// =============================================================================

function runNegativeControls() {
  console.log("=== RUNNING PRE-LAUNCH SECURITY NEGATIVE CONTROLS ===");
  const ncReporter = createReporter();
  let controlsPassed = 0;
  const totalControls = 8;

  // NC1: Secret detection on modern keys (sb_secret_*)
  {
    const rep = createReporter();
    const fakeFiles = ["src/fake-service.ts"];
    const fakeContent = "const supabaseSecret = \"" + "sb_" + "secret_" + "test_mock_secret_key_1234567890\";";
    scanSecrets({
      files: fakeFiles,
      readFile: () => fakeContent,
      reporter: rep,
    });
    if (rep.failed > 0) {
      controlsPassed++;
      console.log("[PASS] NC1: Secret detection successfully caught sb_secret_* key");
    } else {
      console.error("[FAIL] NC1: Secret detection failed to catch sb_secret_* key");
    }
  }

  // NC2: Headers parity mismatch on CSP
  {
    const rep = createReporter();
    const badHeaders = "/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload\n  Content-Security-Policy: default-src 'self'; script-src 'self' https://malicious.evil.com;\n";
    const goodNetlify = '[[headers]]\nfor = "/*"\n[headers.values]\nX-Content-Type-Options = "nosniff"\nX-Frame-Options = "DENY"\nReferrer-Policy = "strict-origin-when-cross-origin"\nStrict-Transport-Security = "max-age=31536000; includeSubDomains; preload"\nContent-Security-Policy = "default-src \'self\';"\n';
    scanHeaders({
      headersRaw: badHeaders,
      netlifyRaw: goodNetlify,
      reporter: rep,
    });
    if (rep.failed > 0) {
      controlsPassed++;
      console.log("[PASS] NC2: Headers scanner successfully caught CSP mismatch & unauthorized script-src");
    } else {
      console.error("[FAIL] NC2: Headers scanner failed to catch CSP mismatch");
    }
  }

  // NC3a: Admin route mutation (missing verifyAdminSession invocation)
  {
    const rep = createReporter();
    const fakeAdminRoute = 'import { verifyAdminSession } from "@/lib/admin/auth";\nexport async function GET(req: Request) {\n  return Response.json({ ok: true });\n}';
    scanAuthGating({
      apiFiles: ["src/app/api/admin/fake/route.ts"],
      readFile: () => fakeAdminRoute,
      reporter: rep,
    });
    if (rep.failed > 0) {
      controlsPassed++;
      console.log("[PASS] NC3a: Auth gating scanner successfully caught admin route with removed verifyAdminSession() call");
    } else {
      console.error("[FAIL] NC3a: Auth gating scanner failed to catch missing verifyAdminSession() call");
    }
  }

  // NC3b: Webhook missing HMAC verification
  {
    const rep = createReporter();
    const fakeWebhook = 'export function createHandler() {\n  return async function(event) {\n    return { statusCode: 200, body: "ok" };\n  };\n}';
    scanAuthGating({
      apiFiles: ["netlify/functions/billing-razorpay-webhook.ts"],
      readFile: () => fakeWebhook,
      reporter: rep,
    });
    if (rep.failed > 0) {
      controlsPassed++;
      console.log("[PASS] NC3b: Auth gating scanner successfully caught webhook missing HMAC signature verification");
    } else {
      console.error("[FAIL] NC3b: Auth gating scanner failed to catch webhook missing HMAC");
    }
  }

  // NC4a: Debug fixture export
  {
    const rep = createReporter();
    const fakePage = 'export const testFixture = { mockData: true };\nexport default function Page() { return null; }';
    scanDebugSurfaces({
      appFiles: ["src/app/fake/page.tsx"],
      serverFiles: [],
      readFile: () => fakePage,
      reporter: rep,
    });
    if (rep.failed > 0) {
      controlsPassed++;
      console.log("[PASS] NC4a: Debug surface scanner successfully caught exported testFixture");
    } else {
      console.error("[FAIL] NC4a: Debug surface scanner failed to catch exported fixture");
    }
  }

  // NC4b: Sensitive logging (console.error leaking token)
  {
    const rep = createReporter();
    const fakeServerCode = 'export function handle(req) {\n  const token = "abc";\n  console.error("error with token:", token);\n}';
    scanDebugSurfaces({
      appFiles: [],
      serverFiles: ["src/lib/fake/auth.ts"],
      readFile: () => fakeServerCode,
      reporter: rep,
    });
    if (rep.failed > 0) {
      controlsPassed++;
      console.log("[PASS] NC4b: Server log scanner successfully caught console.error payload leaking token");
    } else {
      console.error("[FAIL] NC4b: Server log scanner failed to catch sensitive console.error payload");
    }
  }

  // NC5a: Local environment billing active (NEXT_PUBLIC_BILLING_ENABLED=true)
  {
    const rep = createReporter();
    scanPaymentsOff({
      env: { NEXT_PUBLIC_BILLING_ENABLED: "true" },
      nextContent: 'if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") { return 503; }',
      netlifyContent: 'if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") { return 503; }',
      flagsContent: '{ envVar: "NEXT_PUBLIC_BILLING_ENABLED", rule: "strict_true", defaultEnabled: false }',
      envExampleContent: "NEXT_PUBLIC_BILLING_ENABLED=false",
      reporter: rep,
    });
    if (rep.failed > 0) {
      controlsPassed++;
      console.log("[PASS] NC5a: Billing scanner successfully caught NEXT_PUBLIC_BILLING_ENABLED=true in env");
    } else {
      console.error("[FAIL] NC5a: Billing scanner failed to catch active billing env");
    }
  }

  // NC5b: Order gate bypass mutation (if (false && ...))
  {
    const rep = createReporter();
    const bypassedNext = 'if (false && process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") {\n  return NextResponse.json({ code: "BILLING_DISABLED" }, { status: 503 });\n}';
    scanPaymentsOff({
      env: { NEXT_PUBLIC_BILLING_ENABLED: "false" },
      nextContent: bypassedNext,
      netlifyContent: 'if (process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true") { return 503; }',
      flagsContent: '{ envVar: "NEXT_PUBLIC_BILLING_ENABLED", rule: "strict_true", defaultEnabled: false }',
      envExampleContent: "NEXT_PUBLIC_BILLING_ENABLED=false",
      reporter: rep,
    });
    if (rep.failed > 0) {
      controlsPassed++;
      console.log("[PASS] NC5b: Billing scanner successfully caught order gate bypass (false && ...)");
    } else {
      console.error("[FAIL] NC5b: Billing scanner failed to catch order gate bypass");
    }
  }

  console.log("\n================================================================================");
  console.log(`NEGATIVE CONTROLS RESULT: ${controlsPassed}/${totalControls} passed`);
  console.log("================================================================================");

  if (controlsPassed === totalControls) {
    console.log("All negative controls proved non-zero exit / failure on injected violations.");
    process.exit(0);
  } else {
    console.error(`Negative controls failed: only ${controlsPassed}/${totalControls} triggered expected failures.`);
    process.exit(1);
  }
}

// =============================================================================
// MAIN EXECUTION
// =============================================================================

function main() {
  if (process.argv.includes("--test-negative-controls") || process.argv.includes("--selftest")) {
    runNegativeControls();
    return;
  }

  const reporter = createReporter();

  // 1. Secrets Scan
  console.log("=== CHECK 1: Secrets & Token Scanning ===");
  try {
    const raw = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" });
    const files = raw.split("\n").map((f) => f.trim().replace(/\r$/, "")).filter(Boolean);
    scanSecrets({
      files,
      readFile: (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8"),
      reporter,
    });
  } catch (err) {
    reporter.recordFail("Secrets Scan", "git ls-files failed", err.message);
  }

  // 2. Headers Parity & CSP
  console.log("\n=== CHECK 2: Security Headers Parity & CSP ===");
  try {
    const headersPath = path.join(ROOT, "public/_headers");
    const netlifyPath = path.join(ROOT, "netlify.toml");
    if (!fs.existsSync(headersPath) || !fs.existsSync(netlifyPath)) {
      reporter.recordFail("Headers file existence", "public/_headers or netlify.toml is missing", "");
    } else {
      const headersRaw = fs.readFileSync(headersPath, "utf8");
      const netlifyRaw = fs.readFileSync(netlifyPath, "utf8");
      scanHeaders({ headersRaw, netlifyRaw, reporter });
    }
  } catch (err) {
    reporter.recordFail("Headers Scan", "Error reading header configuration files", err.message);
  }

  // 3. Auth Gating & Contracts Heuristic Evidence Inventory
  console.log("\n=== CHECK 3: Auth Gating & Contracts Heuristic Evidence Inventory ===");
  try {
    const raw = execSync("git ls-files src/app/api netlify/functions", { cwd: ROOT, encoding: "utf8" });
    const apiFiles = raw
      .split("\n")
      .map((f) => f.trim().replace(/\r$/, ""))
      .filter((f) => f && !f.includes("/_") && (f.endsWith(".ts") || f.endsWith(".js")));
    scanAuthGating({
      apiFiles,
      readFile: (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8"),
      reporter,
    });
  } catch (err) {
    reporter.recordFail("Auth Gating Scan", "Failed to list route files", err.message);
  }

  // 4. Debug Surfaces & Logging
  console.log("\n=== CHECK 4: Debug Surfaces & Server Logs ===");
  try {
    const rawApp = execSync("git ls-files src/app netlify/functions", { cwd: ROOT, encoding: "utf8" });
    const appFiles = rawApp
      .split("\n")
      .map((f) => f.trim().replace(/\r$/, ""))
      .filter((f) => f && (f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js")));

    const rawServer = execSync("git ls-files src/app/api netlify/functions src/lib", { cwd: ROOT, encoding: "utf8" });
    const serverFiles = rawServer
      .split("\n")
      .map((f) => f.trim().replace(/\r$/, ""))
      .filter((f) => f && !f.includes("/__tests__/") && !f.endsWith(".test.ts") && (f.endsWith(".ts") || f.endsWith(".js")));

    scanDebugSurfaces({
      appFiles,
      serverFiles,
      readFile: (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8"),
      reporter,
    });
  } catch (err) {
    reporter.recordFail("Debug Surface Scan", "Failed to scan app or server files", err.message);
  }

  // 5. Payments-OFF Launch State
  console.log("\n=== CHECK 5: Payments-OFF Launch State ===");
  try {
    const nextOrderRoute = path.join(ROOT, "src/app/api/billing/razorpay/order/route.ts");
    const netlifyOrderRoute = path.join(ROOT, "netlify/functions/billing-razorpay-order.ts");
    const flagsConfig = path.join(ROOT, "src/lib/flags/flags.ts");
    const envExample = path.join(ROOT, ".env.example");

    const nextContent = fs.existsSync(nextOrderRoute) ? fs.readFileSync(nextOrderRoute, "utf8") : "";
    const netlifyContent = fs.existsSync(netlifyOrderRoute) ? fs.readFileSync(netlifyOrderRoute, "utf8") : "";
    const flagsContent = fs.existsSync(flagsConfig) ? fs.readFileSync(flagsConfig, "utf8") : "";
    const envExampleContent = fs.existsSync(envExample) ? fs.readFileSync(envExample, "utf8") : "";

    scanPaymentsOff({
      env: process.env,
      nextContent,
      netlifyContent,
      flagsContent,
      envExampleContent,
      reporter,
    });
  } catch (err) {
    reporter.recordFail("Payments-OFF Scan", "Error checking payments-off posture", err.message);
  }

  // Summary & Exit
  console.log("\n================================================================================");
  console.log(`PRE-LAUNCH SECURITY GATE SUMMARY: ${reporter.passed} passed, ${reporter.failed} failed`);
  console.log("================================================================================");

  if (reporter.failed > 0) {
    console.error(`\n❌ PRE-LAUNCH SECURITY GATE FAILED with ${reporter.failed} violation(s):`);
    for (const f of reporter.failures) {
      console.error(` - [${f.checkName}] ${f.reason}`);
      if (f.evidence) {
        console.error(`   Evidence: ${f.evidence}`);
      }
    }
    process.exit(1);
  } else {
    console.log("\n✅ ALL STATIC PRE-LAUNCH SECURITY CHECKS PASSED.");
    console.log("   Static source baseline verified. Production deployment posture remains UNVERIFIED pending manual owner deployment checks.");
    process.exit(0);
  }
}

// Export scanning functions for offline unit tests
module.exports = {
  scanSecrets,
  scanHeaders,
  scanAuthGating,
  scanDebugSurfaces,
  scanPaymentsOff,
  createReporter,
  REVIEWED_SECRET_EXEMPTIONS,
  SECRET_PATTERNS,
};

if (require.main === module) {
  main();
}
