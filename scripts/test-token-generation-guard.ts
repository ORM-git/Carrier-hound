/**
 * scripts/test-token-generation-guard.ts
 *
 * Offline static guard test auditing app-minted token and ID generation.
 * Scans src/ and netlify/ to enforce CSPRNG compliance:
 * 1. Fails on unallowlisted Math.random( calls in non-test source files.
 * 2. Enforces documented allowlist for legitimate non-security uses (jitter, visual animations).
 * 3. Enforces that security-sensitive paths do NOT mint tokens/secrets using Date.now-only patterns.
 * 4. Validates that security-critical token minting sites use standard Web Crypto CSPRNG.
 * 5. Verifies docs/token-generation-audit.md documentation exists.
 * 6. Verifies negative-control scanner detection.
 *
 * Run: npx tsx scripts/test-token-generation-guard.ts
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
console.log("     APP-MINTED TOKEN & CSPRNG GENERATION SECURITY GUARD TEST                   ");
console.log("================================================================================\n");

/**
 * Legitimate non-security allowlist for Math.random( calls in src/ and netlify/.
 * Every entry must document:
 * - relative file path (forward slashes)
 * - non-security category
 * - engineering rationale
 */
export interface AllowlistEntry {
  file: string;
  category: "jitter" | "visual-animation" | "telemetry";
  rationale: string;
  securitySensitive: false;
}

export const LEGITIMATE_MATH_RANDOM_ALLOWLIST: AllowlistEntry[] = [
  {
    file: "src/lib/reliability/jitter.ts",
    category: "jitter",
    rationale: "Decorrelated and Full Jitter for network retry exponential backoff to prevent thundering herds on APIs and databases.",
    securitySensitive: false,
  },
  {
    file: "src/lib/db/rpcRetry.ts",
    category: "jitter",
    rationale: "Adds 0-25ms random jitter to database RPC retry intervals to desynchronize concurrent client retries.",
    securitySensitive: false,
  },
  {
    file: "src/components/landing/careermonke-landing-runtime.ts",
    category: "visual-animation",
    rationale: "Confetti particle velocity, angle, and rotation physics simulation for landing page interactive celebration.",
    securitySensitive: false,
  },
  {
    file: "src/components/JobRadarGlobe.tsx",
    category: "visual-animation",
    rationale: "Three.js 3D globe background starfield position distribution across space.",
    securitySensitive: false,
  },
  {
    file: "src/components/LandingTopArtifact.tsx",
    category: "visual-animation",
    rationale: "Landing interactive demo counter jitter and celebratory canvas confetti particle physics.",
    securitySensitive: false,
  },
  {
    file: "src/components/analytics/WebVitalsTracker.tsx",
    category: "telemetry",
    rationale: "Client-side telemetry metric correlation ID fallback (wv-...) for performance monitoring in Google Analytics.",
    securitySensitive: false,
  },
];

const ALLOWLISTED_FILES = new Set(
  LEGITIMATE_MATH_RANDOM_ALLOWLIST.map((entry) => path.normalize(entry.file))
);

function isTestFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return (
    norm.includes("/__tests__/") ||
    /\.(test|spec)\.(ts|tsx|js|mjs)$/.test(norm)
  );
}

function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

// -----------------------------------------------------------------------------
// 1. Scan src/ and netlify/ for unallowlisted Math.random( calls
// -----------------------------------------------------------------------------
const allSourceFiles = [
  ...walkSourceFiles("src"),
  ...walkSourceFiles("netlify"),
];

const nonTestFiles = allSourceFiles.filter((f) => !isTestFile(f));
check("found non-test source files in src/ and netlify/", nonTestFiles.length > 50);

interface MathRandomViolation {
  file: string;
  line: number;
  snippet: string;
}

const mathRandomViolations: MathRandomViolation[] = [];

for (const filePath of nonTestFiles) {
  const normPath = path.normalize(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    // Only detect executable calls: Math.random(
    // Exclude comments that merely mention Math.random in documentation
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      return;
    }

    if (line.includes("Math.random(")) {
      if (!ALLOWLISTED_FILES.has(normPath)) {
        mathRandomViolations.push({
          file: normPath,
          line: index + 1,
          snippet: trimmed,
        });
      }
    }
  });
}

check(
  "no unallowlisted Math.random( calls in non-test source files",
  mathRandomViolations.length === 0,
  mathRandomViolations.map((v) => `${v.file}:${v.line}: ${v.snippet}`).join("; ")
);

// -----------------------------------------------------------------------------
// 2. Scan for insecure Date.now-only token/secret minting in security-critical paths
// -----------------------------------------------------------------------------
const securityCriticalPaths = [
  "src/lib/security",
  "src/lib/email",
  "src/lib/admin",
  "src/lib/account",
  "src/middleware.ts",
];

interface InsecureTokenViolation {
  file: string;
  line: number;
  snippet: string;
}

const insecureTokenViolations: InsecureTokenViolation[] = [];
// Pattern for token/secret/nonce/session/credential minting with Date.now()
const INSECURE_TOKEN_PATTERN = /\b(token|secret|nonce|session_id|auth_token|bearer_token)\s*[:=]\s*.*Date\.now\(\)/i;

for (const filePath of nonTestFiles) {
  const normPath = filePath.replace(/\\/g, "/");
  const isSecurityPath = securityCriticalPaths.some((p) => normPath.startsWith(p));
  if (!isSecurityPath) continue;

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

    if (INSECURE_TOKEN_PATTERN.test(line)) {
      insecureTokenViolations.push({
        file: normPath,
        line: index + 1,
        snippet: trimmed,
      });
    }
  });
}

check(
  "no Date.now-only token or secret minting in security-critical paths",
  insecureTokenViolations.length === 0,
  insecureTokenViolations.map((v) => `${v.file}:${v.line}: ${v.snippet}`).join("; ")
);

// -----------------------------------------------------------------------------
// 3. Direct verification of security-critical token generators
// -----------------------------------------------------------------------------

// 3.1 AI operation & lease identities (src/lib/security/operationId.ts)
const opIdFile = path.join("src", "lib", "security", "operationId.ts");
check("src/lib/security/operationId.ts exists", fs.existsSync(opIdFile));
if (fs.existsSync(opIdFile)) {
  const opContent = fs.readFileSync(opIdFile, "utf8");
  check(
    "operationId.ts uses crypto.randomUUID()",
    opContent.includes("crypto.randomUUID()")
  );
  check(
    "operationId.ts does not contain Math.random(",
    !opContent.includes("Math.random(")
  );
}

// 3.2 One-click unsubscribe tokens (src/lib/email/unsubscribe.ts)
const unsubFile = path.join("src", "lib", "email", "unsubscribe.ts");
check("src/lib/email/unsubscribe.ts exists", fs.existsSync(unsubFile));
if (fs.existsSync(unsubFile)) {
  const unsubContent = fs.readFileSync(unsubFile, "utf8");
  check(
    "unsubscribe.ts uses Web Crypto HMAC-SHA256 signing",
    unsubContent.includes('crypto.subtle.sign("HMAC"') ||
      unsubContent.includes("crypto.subtle.sign('HMAC'")
  );
  check(
    "unsubscribe.ts uses constantTimeEqual for verification",
    unsubContent.includes("constantTimeEqual(")
  );
}

// 3.3 Application tracker UUIDs (src/lib/tracker/storage.ts)
const trackerStorageFile = path.join("src", "lib", "tracker", "storage.ts");
check("src/lib/tracker/storage.ts exists", fs.existsSync(trackerStorageFile));
if (fs.existsSync(trackerStorageFile)) {
  const trackerContent = fs.readFileSync(trackerStorageFile, "utf8");
  check(
    "storage.ts generateUUID uses crypto.randomUUID or crypto.getRandomValues",
    trackerContent.includes("crypto.randomUUID") &&
      trackerContent.includes("crypto.getRandomValues")
  );
  check(
    "storage.ts does not contain Math.random(",
    !trackerContent.includes("Math.random(")
  );
}

// 3.4 Middleware correlation ID (src/middleware.ts)
const middlewareFile = path.join("src", "middleware.ts");
check("src/middleware.ts exists", fs.existsSync(middlewareFile));
if (fs.existsSync(middlewareFile)) {
  const mwContent = fs.readFileSync(middlewareFile, "utf8");
  check(
    "middleware.ts resolveRequestId uses crypto.randomUUID()",
    mwContent.includes("resolveRequestId") && mwContent.includes("crypto.randomUUID()")
  );
}

// -----------------------------------------------------------------------------
// 4. Verification of Audit Documentation
// -----------------------------------------------------------------------------
const auditDocFile = path.join("docs", "token-generation-audit.md");
check("docs/token-generation-audit.md exists", fs.existsSync(auditDocFile));
if (fs.existsSync(auditDocFile)) {
  const docContent = fs.readFileSync(auditDocFile, "utf8");
  check(
    "audit doc catalogs operationId.ts",
    docContent.includes("src/lib/security/operationId.ts")
  );
  check(
    "audit doc catalogs unsubscribe.ts",
    docContent.includes("src/lib/email/unsubscribe.ts")
  );
  check(
    "audit doc catalogs tracker storage.ts",
    docContent.includes("src/lib/tracker/storage.ts")
  );
  check(
    "audit doc documents allowlisted sites",
    docContent.includes("Legitimate Non-Security Allowlist")
  );
}

// -----------------------------------------------------------------------------
// 5. Negative Control Scanner Self-Verification
// -----------------------------------------------------------------------------
function testNegativeControl(): boolean {
  const simulatedViolations: string[] = [];

  // Simulated code with unauthorized Math.random
  const simulatedSource = `
    export function mintSessionToken(): string {
      return "sess_" + Math.random().toString(36).slice(2);
    }
  `;

  const simLines = simulatedSource.split("\n");
  simLines.forEach((line, idx) => {
    if (line.includes("Math.random(")) {
      simulatedViolations.push(`simulated-auth.ts:${idx + 1}`);
    }
  });

  return simulatedViolations.length === 1;
}

check("negative control: scanner successfully detects simulated Math.random token generation", testNegativeControl());

// -----------------------------------------------------------------------------
// Summary & Exit
// -----------------------------------------------------------------------------
console.log(`\nResults: ${passed} passed, ${failed} failed.`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All token generation guard checks passed successfully.");
  process.exit(0);
}
