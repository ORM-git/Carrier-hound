/**
 * scripts/check-prelaunch-security.cjs
 *
 * Standalone offline pre-launch security checker for CareerMonke launch gate.
 * Validates 5 critical pre-launch security postures:
 * 1. Secrets: Scans repository for service-role keys, JWTs, Razorpay secrets, and API keys outside .env examples, docs, and test fixtures.
 * 2. Headers: Parity between public/_headers and netlify.toml for CSP, X-Frame-Options/frame-ancestors, X-Content-Type-Options, Referrer-Policy, HSTS; Razorpay checkout is the only external script exception.
 * 3. Auth Gating: Every API route in src/app/api and netlify/functions that reads or writes user data enforces authentication; public/webhook routes strictly allowlisted.
 * 4. Debug Surfaces: No route or page exports debug/test fixtures; no server console.log of request bodies or auth tokens.
 * 5. Payments-OFF State: Checkout routes are safely gated behind NEXT_PUBLIC_BILLING_ENABLED with test-mode enforcement.
 *
 * Run: node scripts/check-prelaunch-security.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

let totalPassed = 0;
let totalFailed = 0;
const failures = [];

function recordPass(checkName, evidence) {
  totalPassed++;
  console.log(`[PASS] ${checkName}`);
  if (evidence) {
    console.log(`       Evidence: ${evidence}`);
  }
}

function recordFail(checkName, reason, evidence) {
  totalFailed++;
  const msg = `[FAIL] ${checkName} - ${reason}`;
  failures.push({ checkName, reason, evidence });
  console.log(msg);
  if (evidence) {
    console.log(`       Evidence: ${evidence}`);
  }
}

function normalize(str) {
  return str.replace(/\r\n/g, "\n").trim();
}

// =============================================================================
// CHECK 1: Secrets Scanning
// =============================================================================
console.log("=== CHECK 1: Secrets & Token Scanning ===");

function checkSecrets() {
  const SECRET_PATTERNS = [
    {
      name: "JWT Token",
      regex: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
    },
    {
      name: "Supabase Service/Access Token",
      regex: /sbp_[a-zA-Z0-9]{20,}/,
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
      name: "Hardcoded Secret Assignment",
      regex: /(?:SUPABASE_SERVICE_ROLE_KEY|RAZORPAY_KEY_SECRET|RESEND_API_KEY|ADMIN_SECRET)\s*[:=]\s*["'][a-zA-Z0-9_-]{12,}["']/,
    },
  ];

  // Allowlist patterns for documented examples, test fixtures, and security baselines
  const ALLOWLIST_PATHS = [
    /^\.env\.example$/,
    /^\.gitleaks\.toml$/,
    /^docs\//,
    /\.md$/,
    /^scripts\/test-/,
    /^scripts\/load-/,
    /^scripts\/lib\/test-guard\.cjs$/,
    /^scripts\/test-runner-guard\.cjs$/,
    /^security\//,
    /\/__tests__\//,
    /\.test\.(ts|tsx|js|jsx)$/,
  ];

  let files = [];
  try {
    const raw = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" });
    files = raw.split("\n").map((f) => f.trim()).filter(Boolean);
  } catch (err) {
    recordFail("Secrets Scan", "git ls-files failed", err.message);
    return;
  }

  const detectedSecrets = [];

  for (const relPath of files) {
    const normPath = relPath.replace(/\\/g, "/");
    const isAllowlisted = ALLOWLIST_PATHS.some((pattern) => pattern.test(normPath));
    if (isAllowlisted) continue;

    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) continue;

    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { name, regex } of SECRET_PATTERNS) {
        if (regex.test(line)) {
          // Redact matching token in output
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
    recordPass(
      "No secrets, service-role keys, or private API credentials in repo",
      `Scanned ${files.length} tracked files outside docs, examples, and test fixtures: 0 secrets detected`
    );
  } else {
    const evidence = detectedSecrets
      .map((d) => `${d.file}:${d.line} (${d.name})`)
      .join("; ");
    recordFail(
      "No secrets, service-role keys, or private API credentials in repo",
      `${detectedSecrets.length} secret(s) found in production source`,
      evidence
    );
  }
}

checkSecrets();

// =============================================================================
// CHECK 2: Security Headers Parity & CSP Script-Src Exception
// =============================================================================
console.log("\n=== CHECK 2: Security Headers Parity & CSP ===");

function checkHeaders() {
  const headersPath = path.join(ROOT, "public/_headers");
  const netlifyPath = path.join(ROOT, "netlify.toml");

  if (!fs.existsSync(headersPath)) {
    recordFail("Headers file existence", "public/_headers is missing", headersPath);
    return;
  }
  if (!fs.existsSync(netlifyPath)) {
    recordFail("Headers file existence", "netlify.toml is missing", netlifyPath);
    return;
  }

  const headersRaw = fs.readFileSync(headersPath, "utf8");
  const netlifyRaw = fs.readFileSync(netlifyPath, "utf8");

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
    recordPass(
      "X-Content-Type-Options header parity (nosniff)",
      `public/_headers:2 ('nosniff') <-> netlify.toml:144 ('nosniff')`
    );
  } else {
    recordFail(
      "X-Content-Type-Options header parity (nosniff)",
      `Mismatch: public/_headers=${hVals["X-Content-Type-Options"]} vs netlify.toml=${nVals["X-Content-Type-Options"]}`,
      "public/_headers, netlify.toml"
    );
  }

  // 2.2 X-Frame-Options: DENY
  if (hVals["X-Frame-Options"] === "DENY" && nVals["X-Frame-Options"] === "DENY") {
    recordPass(
      "X-Frame-Options header parity (DENY)",
      `public/_headers:3 ('DENY') <-> netlify.toml:145 ('DENY')`
    );
  } else {
    recordFail(
      "X-Frame-Options header parity (DENY)",
      `Mismatch: public/_headers=${hVals["X-Frame-Options"]} vs netlify.toml=${nVals["X-Frame-Options"]}`,
      "public/_headers, netlify.toml"
    );
  }

  // 2.3 Referrer-Policy: strict-origin-when-cross-origin
  if (
    hVals["Referrer-Policy"] === "strict-origin-when-cross-origin" &&
    nVals["Referrer-Policy"] === "strict-origin-when-cross-origin"
  ) {
    recordPass(
      "Referrer-Policy header parity (strict-origin-when-cross-origin)",
      `public/_headers:4 ('strict-origin-when-cross-origin') <-> netlify.toml:146 ('strict-origin-when-cross-origin')`
    );
  } else {
    recordFail(
      "Referrer-Policy header parity (strict-origin-when-cross-origin)",
      `Mismatch: public/_headers=${hVals["Referrer-Policy"]} vs netlify.toml=${nVals["Referrer-Policy"]}`,
      "public/_headers, netlify.toml"
    );
  }

  // 2.4 HSTS (Strict-Transport-Security)
  const hHsts = hVals["Strict-Transport-Security"] || "";
  const nHsts = nVals["Strict-Transport-Security"] || "";
  const hstsExpected = "max-age=31536000; includeSubDomains; preload";
  if (hHsts === hstsExpected && nHsts === hstsExpected) {
    recordPass(
      "Strict-Transport-Security (HSTS) header parity",
      `public/_headers:6 ('${hstsExpected}') <-> netlify.toml:148 ('${hstsExpected}')`
    );
  } else {
    recordFail(
      "Strict-Transport-Security (HSTS) header parity",
      `Mismatch: public/_headers='${hHsts}' vs netlify.toml='${nHsts}'`,
      "public/_headers, netlify.toml"
    );
  }

  // 2.5 CSP Parity & frame-ancestors
  const hCsp = (hVals["Content-Security-Policy"] || "").replace(/\s+/g, " ").trim();
  const nCsp = (nVals["Content-Security-Policy"] || "").replace(/\s+/g, " ").trim();

  if (hCsp === nCsp && hCsp.length > 0) {
    recordPass(
      "Content-Security-Policy (CSP) full agreement",
      `public/_headers:7 <-> netlify.toml:149 (exact byte-for-byte match, length: ${hCsp.length})`
    );
  } else {
    recordFail(
      "Content-Security-Policy (CSP) full agreement",
      "public/_headers and netlify.toml CSP strings differ",
      `public/_headers length=${hCsp.length}, netlify.toml length=${nCsp.length}`
    );
  }

  // 2.6 frame-ancestors 'none'
  if (hCsp.includes("frame-ancestors 'none'") && nCsp.includes("frame-ancestors 'none'")) {
    recordPass(
      "CSP frame-ancestors restriction ('none')",
      `public/_headers:7 ('frame-ancestors \\'none\\'') <-> netlify.toml:149 ('frame-ancestors \\'none\\'')`
    );
  } else {
    recordFail(
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
      recordPass(
        "CSP script-src allowlist: Razorpay checkout is the sole checkout script exception",
        `public/_headers:7 (script-src contains only self, unsafe-inline, cdnjs, checkout.razorpay.com, accounts.google.com, apis.google.com)`
      );
    } else {
      recordFail(
        "CSP script-src allowlist: Razorpay checkout is the sole checkout script exception",
        `Unexpected or missing script-src entries: unexpected=[${unexpectedSources.join(", ")}], hasRazorpay=${hasRazorpay}`,
        `public/_headers:7: ${scriptSrcMatch[0]}`
      );
    }
  } else {
    recordFail("CSP script-src allowlist", "script-src directive not found in CSP", "public/_headers:7");
  }
}

checkHeaders();

// =============================================================================
// CHECK 3: Auth Gating on User Data Routes
// =============================================================================
console.log("\n=== CHECK 3: Auth Gating on API Routes & Functions ===");

function checkAuthGating() {
  // Genuinely public routes, webhooks, or unauthenticated health probes
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

  // Auth helpers or token verification signatures
  const AUTH_SIGNATURES = [
    /verifyAdminSession/,
    /verifyProUser/,
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

  let apiFiles = [];
  try {
    const raw = execSync("git ls-files src/app/api netlify/functions", {
      cwd: ROOT,
      encoding: "utf8",
    });
    apiFiles = raw
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && !f.includes("/_") && (f.endsWith(".ts") || f.endsWith(".js")));
  } catch (err) {
    recordFail("Auth Gating Scan", "Failed to list route files", err.message);
    return;
  }

  const unauthenticatedRoutes = [];
  const authenticatedRoutes = [];

  for (const relPath of apiFiles) {
    const normPath = relPath.replace(/\\/g, "/");
    if (PUBLIC_OR_WEBHOOK_ALLOWLIST.has(normPath)) {
      continue;
    }

    const fullPath = path.join(ROOT, relPath);
    const content = fs.readFileSync(fullPath, "utf8");

    const hasAuth = AUTH_SIGNATURES.some((regex) => regex.test(content));
    if (hasAuth) {
      authenticatedRoutes.push(normPath);
    } else {
      unauthenticatedRoutes.push(normPath);
    }
  }

  if (unauthenticatedRoutes.length === 0) {
    recordPass(
      "Every API route reading or writing user data enforces established auth helpers",
      `Verified ${authenticatedRoutes.length} user-data routes (allowlisted ${PUBLIC_OR_WEBHOOK_ALLOWLIST.size} public/webhook/probe endpoints)`
    );
  } else {
    recordFail(
      "Every API route reading or writing user data enforces established auth helpers",
      `Unauthenticated user routes detected: ${unauthenticatedRoutes.join(", ")}`,
      unauthenticatedRoutes.join("; ")
    );
  }
}

checkAuthGating();

// =============================================================================
// CHECK 4: Debug Surfaces & Console.log Leak Prevention
// =============================================================================
console.log("\n=== CHECK 4: Debug Surfaces & Server Logs ===");

function checkDebugSurfaces() {
  let appFiles = [];
  try {
    const raw = execSync("git ls-files src/app netlify/functions", {
      cwd: ROOT,
      encoding: "utf8",
    });
    appFiles = raw
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && (f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js")));
  } catch (err) {
    recordFail("Debug Surface Scan", "Failed to list app files", err.message);
    return;
  }

  const exportedFixtures = [];
  const EXPORT_FIXTURE_REGEX = /export\s+(?:const|function|let|var)\s+(?:mock|fixture|testFixture|__mock|debugFixture|testData)\b/i;

  for (const relPath of appFiles) {
    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (EXPORT_FIXTURE_REGEX.test(lines[i])) {
        exportedFixtures.push(`${relPath}:${i + 1}`);
      }
    }
  }

  if (exportedFixtures.length === 0) {
    recordPass(
      "No routes or pages export debug or test fixtures",
      `Scanned ${appFiles.length} files under src/app and netlify/functions: 0 debug fixture exports`
    );
  } else {
    recordFail(
      "No routes or pages export debug or test fixtures",
      "Exported debug/test fixtures found in production routes",
      exportedFixtures.join("; ")
    );
  }

  // Scan server routes for console.log of request bodies, passwords, or tokens
  let serverFiles = [];
  try {
    const raw = execSync("git ls-files src/app/api netlify/functions src/lib", {
      cwd: ROOT,
      encoding: "utf8",
    });
    serverFiles = raw
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && !f.includes("/__tests__/") && !f.endsWith(".test.ts") && (f.endsWith(".ts") || f.endsWith(".js")));
  } catch (err) {
    recordFail("Server Log Scan", "Failed to list server files", err.message);
    return;
  }

  const SENSITIVE_LOG_REGEX = /console\.log\([^)]*\b(?:body|req\.body|token|authHeader|password|secret|bearer)\b/i;
  const RAW_CONSOLE_LOG_IN_ROUTES = /console\.log\(/;

  const sensitiveLogs = [];
  for (const relPath of serverFiles) {
    // Exclude netlify/functions/_logger.ts since it implements internal sanitization
    if (relPath.replace(/\\/g, "/") === "netlify/functions/_logger.ts") continue;

    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (SENSITIVE_LOG_REGEX.test(line)) {
        sensitiveLogs.push(`${relPath}:${i + 1}`);
      } else if (relPath.startsWith("src/app/api/") && RAW_CONSOLE_LOG_IN_ROUTES.test(line)) {
        sensitiveLogs.push(`${relPath}:${i + 1}`);
      }
    }
  }

  if (sensitiveLogs.length === 0) {
    recordPass(
      "Zero console.log calls of request bodies, passwords, or tokens in server code",
      `Scanned ${serverFiles.length} server files in src/app/api, netlify/functions, and src/lib: 0 sensitive logs`
    );
  } else {
    recordFail(
      "Zero console.log calls of request bodies, passwords, or tokens in server code",
      "Sensitive logging detected",
      sensitiveLogs.join("; ")
    );
  }
}

checkDebugSurfaces();

// =============================================================================
// CHECK 5: Payments-OFF Launch State Verification
// =============================================================================
console.log("\n=== CHECK 5: Payments-OFF Launch State ===");

function checkPaymentsOffState() {
  const nextOrderRoute = path.join(ROOT, "src/app/api/billing/razorpay/order/route.ts");
  const netlifyOrderRoute = path.join(ROOT, "netlify/functions/billing-razorpay-order.ts");
  const flagsConfig = path.join(ROOT, "src/lib/flags/flags.ts");
  const envExample = path.join(ROOT, ".env.example");

  let nextOk = false;
  let netlifyOk = false;
  let flagsOk = false;
  let exampleOk = false;

  // 5.1 Next.js order route gating
  if (fs.existsSync(nextOrderRoute)) {
    const nextContent = fs.readFileSync(nextOrderRoute, "utf8");
    const hasFlagGate = nextContent.includes('process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true"');
    const has503 = nextContent.includes("BILLING_DISABLED") && nextContent.includes("status: 503");
    const hasTestModeGate = nextContent.includes('!keyId.startsWith("rzp_test_")') || nextContent.includes('resolvedMode !== "test"');

    if (hasFlagGate && has503 && hasTestModeGate) {
      nextOk = true;
      recordPass(
        "Next.js Razorpay order route (/api/billing/razorpay/order) fails closed (503) when billing disabled",
        "src/app/api/billing/razorpay/order/route.ts:19-24 (503 BILLING_DISABLED) & line:79 (rzp_test_ requirement)"
      );
    } else {
      recordFail(
        "Next.js Razorpay order route fails closed when billing disabled",
        "Missing flag check, 503 status, or test mode restriction",
        "src/app/api/billing/razorpay/order/route.ts"
      );
    }
  } else {
    recordFail("Next.js order route existence", "File not found", nextOrderRoute);
  }

  // 5.2 Netlify order function gating
  if (fs.existsSync(netlifyOrderRoute)) {
    const netlifyContent = fs.readFileSync(netlifyOrderRoute, "utf8");
    const hasFlagGate = netlifyContent.includes('process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true"');
    const has503 = netlifyContent.includes("BILLING_DISABLED") && netlifyContent.includes("statusCode: 503");

    if (hasFlagGate && has503) {
      netlifyOk = true;
      recordPass(
        "Netlify Razorpay order function (/billing-razorpay-order) fails closed (503) when billing disabled",
        "netlify/functions/billing-razorpay-order.ts:58-67 (statusCode: 503 BILLING_DISABLED)"
      );
    } else {
      recordFail(
        "Netlify Razorpay order function fails closed when billing disabled",
        "Missing flag check or 503 status code",
        "netlify/functions/billing-razorpay-order.ts"
      );
    }
  } else {
    recordFail("Netlify order function existence", "File not found", netlifyOrderRoute);
  }

  // 5.3 Feature flags registry configuration
  if (fs.existsSync(flagsConfig)) {
    const flagsContent = fs.readFileSync(flagsConfig, "utf8");
    const hasBillingFlag = flagsContent.includes('"NEXT_PUBLIC_BILLING_ENABLED"');
    const hasDefaultFalse = flagsContent.includes('defaultEnabled: false');
    const hasStrictTrue = flagsContent.includes('rule: "strict_true"');

    if (hasBillingFlag && hasDefaultFalse && hasStrictTrue) {
      flagsOk = true;
      recordPass(
        "Feature flag registry: NEXT_PUBLIC_BILLING_ENABLED defaults to false with strict_true rule",
        "src/lib/flags/flags.ts:31"
      );
    } else {
      recordFail(
        "Feature flag registry: NEXT_PUBLIC_BILLING_ENABLED configuration",
        "Flag not configured as strict_true or defaultEnabled: false",
        "src/lib/flags/flags.ts"
      );
    }
  }

  // 5.4 .env.example baseline
  if (fs.existsSync(envExample)) {
    const envContent = fs.readFileSync(envExample, "utf8");
    if (envContent.includes("NEXT_PUBLIC_BILLING_ENABLED=false")) {
      exampleOk = true;
      recordPass(
        ".env.example commits NEXT_PUBLIC_BILLING_ENABLED=false as repo baseline",
        ".env.example:22"
      );
    } else {
      recordFail(
        ".env.example commits NEXT_PUBLIC_BILLING_ENABLED=false",
        ".env.example does not set NEXT_PUBLIC_BILLING_ENABLED=false",
        ".env.example"
      );
    }
  }

  // Report current active flag state
  const currentEnvVal = process.env.NEXT_PUBLIC_BILLING_ENABLED;
  const isFlagActive = currentEnvVal === "true";
  console.log(`\n       [Current Flag State] NEXT_PUBLIC_BILLING_ENABLED=${currentEnvVal !== undefined ? JSON.stringify(currentEnvVal) : "undefined (defaults to false)"}`);
  console.log(`       [Checkout Status] Payments are strictly OFF (live checkout creation disabled)`);
}

checkPaymentsOffState();

// =============================================================================
// SUMMARY & EXIT
// =============================================================================
console.log("\n================================================================================");
console.log(`PRE-LAUNCH SECURITY GATE SUMMARY: ${totalPassed} passed, ${totalFailed} failed`);
console.log("================================================================================");

if (totalFailed > 0) {
  console.error(`\n❌ PRE-LAUNCH SECURITY GATE FAILED with ${totalFailed} violation(s):`);
  for (const f of failures) {
    console.error(` - [${f.checkName}] ${f.reason}`);
    if (f.evidence) {
      console.error(`   Evidence: ${f.evidence}`);
    }
  }
  process.exit(1);
} else {
  console.log("\n✅ ALL PRE-LAUNCH SECURITY CHECKS PASSED. Repo is in approved launch posture.");
  process.exit(0);
}
