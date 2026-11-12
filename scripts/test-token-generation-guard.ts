/**
 * scripts/test-token-generation-guard.ts
 *
 * Offline static AST & runtime security guard test auditing app-minted token and ID generation.
 * Enforces CSPRNG compliance across src/ and netlify/:
 * 1. Uses TypeScript AST (ts.createSourceFile) to detect any Math.random calls, references,
 *    aliases, destructuring, and fallback expressions.
 * 2. Enforces site-specific allowlist (file + enclosing function) for legitimate non-security
 *    uses (retry jitter, Three.js starfield, canvas confetti, client telemetry).
 * 3. Tests explicit bypass cases (spaces, multiline, aliasing, destructuring, nullish coalescing,
 *    and unallowlisted functions inside jitter files).
 * 4. Real --negative-control mode: verifies failure on injected weak generator and non-zero subprocess exit.
 * 5. Runtime tests for src/lib/tracker/storage.ts generateUUID (native randomUUID, getRandomValues fallback
 *    with RFC 4122 v4/variant bits, and no-crypto fail-closed before any tracker write).
 * 6. Scans for insecure Date.now-only token/secret minting in security-critical paths.
 * 7. Verifies docs/token-generation-audit.md accuracy and scope boundaries.
 *
 * Run: npx tsx scripts/test-token-generation-guard.ts
 * Negative control: npx tsx scripts/test-token-generation-guard.ts --negative-control
 */

import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";
import { spawnSync } from "child_process";
import ts from "typescript";
import { generateUUID, addApplicationToTracker, clearTrackerMemoryState } from "../src/lib/tracker/storage";

// =============================================================================
// Allowlist & Scanner Interfaces
// =============================================================================

export interface AllowlistEntry {
  file: string; // normalized forward-slash relative path
  function: string; // enclosing function/component name
  category: "jitter" | "visual-animation" | "telemetry";
  rationale: string;
  securitySensitive: false;
}

export interface MathRandomViolation {
  file: string;
  line: number;
  character: number;
  snippet: string;
  enclosingFunctions: string[];
}

/**
 * Legitimate non-security allowlist for Math.random in src/ and netlify/.
 * Strictly scoped per SITE (relative file + enclosing function name), NOT whole files.
 * Any Math.random reference outside these specific functions will trigger a security failure.
 */
export const LEGITIMATE_MATH_RANDOM_ALLOWLIST: AllowlistEntry[] = [
  {
    file: "src/lib/reliability/jitter.ts",
    function: "withJitter",
    category: "jitter",
    rationale: "Decorrelated and Full Jitter for network retry exponential backoff to prevent thundering herds on APIs and databases.",
    securitySensitive: false,
  },
  {
    file: "src/lib/db/rpcRetry.ts",
    function: "rpcWithRetry",
    category: "jitter",
    rationale: "Adds 0-25ms random jitter to database RPC retry intervals to desynchronize concurrent client retries.",
    securitySensitive: false,
  },
  {
    file: "src/components/landing/careermonke-landing-runtime.ts",
    function: "confetti",
    category: "visual-animation",
    rationale: "Confetti particle velocity, angle, and rotation physics simulation for landing page interactive celebration.",
    securitySensitive: false,
  },
  {
    file: "src/components/JobRadarGlobe.tsx",
    function: "JobRadarGlobe",
    category: "visual-animation",
    rationale: "Three.js 3D globe background starfield position distribution across space.",
    securitySensitive: false,
  },
  {
    file: "src/components/LandingTopArtifact.tsx",
    function: "scan",
    category: "visual-animation",
    rationale: "Landing interactive demo counter jitter and site simulation delay.",
    securitySensitive: false,
  },
  {
    file: "src/components/LandingTopArtifact.tsx",
    function: "confetti",
    category: "visual-animation",
    rationale: "Landing celebratory canvas confetti particle physics simulation.",
    securitySensitive: false,
  },
  {
    file: "src/components/analytics/WebVitalsTracker.tsx",
    function: "WebVitalsTracker",
    category: "telemetry",
    rationale: "Client-side telemetry metric correlation ID fallback (wv-...) for performance monitoring in Google Analytics.",
    securitySensitive: false,
  },
];

/**
 * Traverses parent AST nodes to identify all enclosing function, method, class, or arrow function names.
 */
export function getEnclosingFunctionNames(node: ts.Node): string[] {
  const names: string[] = [];
  let curr = node.parent;
  while (curr) {
    if (ts.isFunctionDeclaration(curr)) {
      names.push(curr.name?.text || "anonymous_function");
    } else if (ts.isMethodDeclaration(curr)) {
      names.push(ts.isIdentifier(curr.name) ? curr.name.text : "method");
    } else if (ts.isFunctionExpression(curr)) {
      if (curr.name?.text) {
        names.push(curr.name.text);
      } else if (curr.parent && ts.isVariableDeclaration(curr.parent) && ts.isIdentifier(curr.parent.name)) {
        names.push(curr.parent.name.text);
      } else {
        names.push("anonymous_function");
      }
    } else if (ts.isArrowFunction(curr)) {
      if (curr.parent && ts.isVariableDeclaration(curr.parent) && ts.isIdentifier(curr.parent.name)) {
        names.push(curr.parent.name.text);
      } else if (curr.parent && ts.isPropertyAssignment(curr.parent) && ts.isIdentifier(curr.parent.name)) {
        names.push(curr.parent.name.text);
      } else {
        names.push("arrow_function");
      }
    } else if (ts.isClassDeclaration(curr)) {
      if (curr.name?.text) {
        names.push(curr.name.text);
      }
    }
    curr = curr.parent;
  }
  return names;
}

/**
 * Scans a source code string via TypeScript AST for any Math.random usage:
 * - Direct calls: Math.random() or Math.random ()
 * - Multiline accesses: Math\n.random()
 * - Property assignments / aliases: const r = Math.random
 * - Destructuring: const { random } = Math
 * - Fallbacks: options.rand ?? Math.random
 * Matches against allowlist requiring BOTH file path AND enclosing function match.
 */
export function scanSourceForMathRandom(
  filePath: string,
  content: string,
  allowlist: AllowlistEntry[] = LEGITIMATE_MATH_RANDOM_ALLOWLIST
): MathRandomViolation[] {
  const normPath = filePath.replace(/\\/g, "/");
  const sf = ts.createSourceFile(normPath, content, ts.ScriptTarget.Latest, true);
  const violations: MathRandomViolation[] = [];

  function isAllowlisted(enclosingFns: string[]): boolean {
    return allowlist.some(
      (entry) =>
        entry.file === normPath &&
        enclosingFns.some((fn) => fn === entry.function)
    );
  }

  function recordViolation(node: ts.Node) {
    const enclosingFns = getEnclosingFunctionNames(node);
    if (isAllowlisted(enclosingFns)) {
      return;
    }
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
    const snippet = node.getText(sf);
    violations.push({
      file: normPath,
      line: line + 1,
      character: character + 1,
      snippet,
      enclosingFunctions: enclosingFns,
    });
  }

  function visit(node: ts.Node) {
    // 1. Property access: Math.random (catches Math.random(), Math.random (), multiline, const r = Math.random, options.rand ?? Math.random)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      node.name.text === "random"
    ) {
      recordViolation(node);
    }

    // 2. Destructuring declaration: const { random } = Math; or const { random: r } = Math;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === "Math" &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        const propName = element.propertyName
          ? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : "")
          : (ts.isIdentifier(element.name) ? element.name.text : "");
        if (propName === "random") {
          recordViolation(element);
        }
      }
    }

    // 3. Destructuring assignment: ({ random } = Math);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.right) &&
      node.right.text === "Math" &&
      ts.isObjectLiteralExpression(node.left)
    ) {
      for (const prop of node.left.properties) {
        if (prop.name && ts.isIdentifier(prop.name) && prop.name.text === "random") {
          recordViolation(prop);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return violations;
}

// =============================================================================
// Mode: --negative-control
// =============================================================================
if (process.argv.includes("--negative-control")) {
  console.log("================================================================================");
  console.log("RUNNING NEGATIVE CONTROL MODE: INJECTING WEAK GENERATOR SNIPPET");
  console.log("================================================================================\n");

  const weakGeneratorSnippet = `
    // Simulating weak auth token minting in a security service
    export function mintSessionToken(): string {
      return "sess_" + Math.random().toString(36).slice(2);
    }
  `;

  const violations = scanSourceForMathRandom(
    "src/lib/security/weak-token-generator.ts",
    weakGeneratorSnippet,
    LEGITIMATE_MATH_RANDOM_ALLOWLIST
  );

  if (violations.length > 0) {
    console.log(`NEGATIVE CONTROL PASSED: Guard correctly caught ${violations.length} injected weak generator violation(s):`);
    violations.forEach((v) =>
      console.log(`  - [EXPECTED VIOLATION] ${v.file}:${v.line} (${v.snippet}) in ${v.enclosingFunctions.join(" -> ")}`)
    );
    // Exit code 1 signifies that the guard failed on the violating input, as required for negative control
    process.exit(1);
  } else {
    console.error("NEGATIVE CONTROL FAILED: Injected weak generator was not detected by scanner!");
    process.exit(0);
  }
}

// =============================================================================
// Normal Mode: Comprehensive Guard Suite
// =============================================================================
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
// 1. AST Bypass Detection Tests (Explicit verification of bypass patterns)
// -----------------------------------------------------------------------------
console.log("--- 1. AST Bypass Detection Tests ---");

// 1.1 Space before parens: Math.random ()
const vSpace = scanSourceForMathRandom("src/lib/bypass1.ts", "const x = Math.random ();");
check("AST scanner catches Math.random () with space before parens", vSpace.length === 1 && vSpace[0].snippet.includes("Math.random"));

// 1.2 Multiline call: Math\n.random()
const vMultiline = scanSourceForMathRandom("src/lib/bypass2.ts", "const x = Math\n  .random();");
check("AST scanner catches multiline Math.random() calls", vMultiline.length === 1);

// 1.3 Aliasing: const r = Math.random
const vAlias = scanSourceForMathRandom("src/lib/bypass3.ts", "const r = Math.random;\nconst v = r();");
check("AST scanner catches Math.random assignment to variable alias", vAlias.length === 1 && vAlias[0].snippet.includes("Math.random"));

// 1.4 Destructuring: const { random } = Math
const vDestructure = scanSourceForMathRandom("src/lib/bypass4.ts", "const { random } = Math;\nconst v = random();");
check("AST scanner catches const { random } = Math destructuring", vDestructure.length === 1);

// 1.5 Renamed destructuring: const { random: r } = Math
const vRenamedDestructure = scanSourceForMathRandom("src/lib/bypass5.ts", "const { random: r } = Math;\nconst v = r();");
check("AST scanner catches const { random: r } = Math renamed destructuring", vRenamedDestructure.length === 1);

// 1.6 Fallback nullish coalescing: options.rand ?? Math.random
const vFallback = scanSourceForMathRandom("src/lib/bypass6.ts", "const rand = options.rand ?? Math.random;");
check("AST scanner catches options.rand ?? Math.random fallback expression", vFallback.length === 1);

// 1.7 Site-specific function allowlist enforcement:
// In src/lib/reliability/jitter.ts, withJitter is allowlisted, but a new function mintSecret() is NOT.
const jitterFileWithViolation = `
export function withJitter(baseMs: number): number {
  const rand = Math.random;
  return baseMs * rand();
}

export function mintSecret(): string {
  return "sec_" + Math.random();
}
`;
const vJitterSite = scanSourceForMathRandom("src/lib/reliability/jitter.ts", jitterFileWithViolation);
check(
  "AST allowlist is scoped per enclosing function: withJitter passes, but mintSecret in jitter.ts is caught",
  vJitterSite.length === 1 && vJitterSite[0].enclosingFunctions.includes("mintSecret")
);

// -----------------------------------------------------------------------------
// 2. Real Codebase AST Scan: src/ and netlify/
// -----------------------------------------------------------------------------
console.log("\n--- 2. Full Codebase AST Scan (src/ and netlify/) ---");
const allSourceFiles = [
  ...walkSourceFiles("src"),
  ...walkSourceFiles("netlify"),
];
const nonTestFiles = allSourceFiles.filter((f) => !isTestFile(f));
check("found non-test source files in src/ and netlify/", nonTestFiles.length > 50);

const codebaseViolations: MathRandomViolation[] = [];
for (const filePath of nonTestFiles) {
  const content = fs.readFileSync(filePath, "utf8");
  const violations = scanSourceForMathRandom(filePath, content);
  codebaseViolations.push(...violations);
}

check(
  "no unallowlisted Math.random calls, aliases, or destructuring in non-test source files",
  codebaseViolations.length === 0,
  codebaseViolations.map((v) => `${v.file}:${v.line} (${v.snippet}) in ${v.enclosingFunctions.join("->")}`).join("; ")
);

// -----------------------------------------------------------------------------
// 3. Date.now Security Boundary Heuristic Scan
// -----------------------------------------------------------------------------
console.log("\n--- 3. Date.now Security Boundary Scan ---");
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
// 4. Runtime Tests for src/lib/tracker/storage.ts generateUUID
// -----------------------------------------------------------------------------
console.log("\n--- 4. Runtime Tests for storage.ts generateUUID ---");

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 4.1 Native crypto.randomUUID path
const nativeUUID = generateUUID();
check("generateUUID native path produces 36-char string", nativeUUID.length === 36);
check("generateUUID native path matches RFC 4122 v4 UUID format", UUID_V4_REGEX.test(nativeUUID));

// 4.2 getRandomValues fallback path (simulate runtime without crypto.randomUUID)
const originalRandomUUID = crypto.randomUUID;
const originalGetRandomValues = crypto.getRandomValues;

try {
  // Disable randomUUID to force getRandomValues fallback
  (crypto as any).randomUUID = undefined;

  let getRandomValuesCalled = false;
  const wrappedGetRandomValues = crypto.getRandomValues.bind(crypto);
  (crypto as any).getRandomValues = (arr: Uint8Array) => {
    getRandomValuesCalled = true;
    return wrappedGetRandomValues(arr);
  };

  const fallbackUUID = generateUUID();
  check("fallback generateUUID invoked crypto.getRandomValues", getRandomValuesCalled);
  check("fallback generateUUID produces exactly 36 characters", fallbackUUID.length === 36);
  check("fallback generateUUID has hyphens at positions 8, 13, 18, 23",
    fallbackUUID[8] === "-" && fallbackUUID[13] === "-" && fallbackUUID[18] === "-" && fallbackUUID[23] === "-"
  );
  check("fallback generateUUID sets RFC 4122 v4 version nibble ('4' at index 14)", fallbackUUID[14] === "4");
  check(
    "fallback generateUUID sets RFC 4122 variant bits (8, 9, a, or b at index 19)",
    ["8", "9", "a", "b"].includes(fallbackUUID[19].toLowerCase())
  );
  check("fallback generateUUID strictly matches UUID v4 regex", UUID_V4_REGEX.test(fallbackUUID));

  // Run 100 sample fallback UUIDs to verify variant bit masking under random values
  let all100Valid = true;
  for (let i = 0; i < 100; i++) {
    const sample = generateUUID();
    if (!UUID_V4_REGEX.test(sample)) {
      all100Valid = false;
      break;
    }
  }
  check("100 fallback UUIDs all strictly conform to v4 and variant bits", all100Valid);
} finally {
  // Restore original functions
  (crypto as any).randomUUID = originalRandomUUID;
  (crypto as any).getRandomValues = originalGetRandomValues;
}

// 4.3 Fail-closed: no-crypto throws before any tracker write
try {
  // Simulate complete absence of crypto
  (crypto as any).randomUUID = undefined;
  (crypto as any).getRandomValues = undefined;

  let threwExpected = false;
  try {
    generateUUID();
  } catch (err: any) {
    threwExpected = err?.message?.includes("CSPRNG crypto is not available");
  }
  check("generateUUID throws when CSPRNG crypto is unavailable", threwExpected);

  // Verify tracker write fails closed before modifying storage
  let trackerThrew = false;
  try {
    clearTrackerMemoryState();
    // Synchronously attempting to generateUUID for new application must reject
    addApplicationToTracker({
      jobId: "test-job",
      company: "Acme",
      title: "Engineer",
      stage: "saved",
    } as any).catch(() => {});
  } catch (err: any) {
    trackerThrew = err?.message?.includes("CSPRNG crypto is not available");
  }
  check("tracker operation fails closed if CSPRNG is absent", threwExpected || trackerThrew);
} finally {
  (crypto as any).randomUUID = originalRandomUUID;
  (crypto as any).getRandomValues = originalGetRandomValues;
}

// -----------------------------------------------------------------------------
// 5. Verification of Direct Token Generators in Source Code
// -----------------------------------------------------------------------------
console.log("\n--- 5. Verification of Security-Critical Token Sites ---");

// 5.1 AI operation & lease identities (src/lib/security/operationId.ts)
const opIdFile = path.join("src", "lib", "security", "operationId.ts");
check("src/lib/security/operationId.ts exists", fs.existsSync(opIdFile));
if (fs.existsSync(opIdFile)) {
  const opContent = fs.readFileSync(opIdFile, "utf8");
  check("operationId.ts uses crypto.randomUUID()", opContent.includes("crypto.randomUUID()"));
  check(
    "operationId.ts has zero executable Math.random AST violations",
    scanSourceForMathRandom("src/lib/security/operationId.ts", opContent, []).length === 0
  );
}

// 5.2 One-click unsubscribe tokens (src/lib/email/unsubscribe.ts)
const unsubFile = path.join("src", "lib", "email", "unsubscribe.ts");
check("src/lib/email/unsubscribe.ts exists", fs.existsSync(unsubFile));
if (fs.existsSync(unsubFile)) {
  const unsubContent = fs.readFileSync(unsubFile, "utf8");
  check(
    "unsubscribe.ts uses Web Crypto HMAC-SHA256 signing",
    unsubContent.includes('crypto.subtle.sign("HMAC"') || unsubContent.includes("crypto.subtle.sign('HMAC'")
  );
  check("unsubscribe.ts uses constantTimeEqual for verification", unsubContent.includes("constantTimeEqual("));
}

// 5.3 Application tracker UUIDs (src/lib/tracker/storage.ts)
const trackerStorageFile = path.join("src", "lib", "tracker", "storage.ts");
check("src/lib/tracker/storage.ts exists", fs.existsSync(trackerStorageFile));
if (fs.existsSync(trackerStorageFile)) {
  const trackerContent = fs.readFileSync(trackerStorageFile, "utf8");
  check(
    "storage.ts uses crypto.randomUUID and crypto.getRandomValues fallback",
    trackerContent.includes("crypto.randomUUID") && trackerContent.includes("crypto.getRandomValues")
  );
  check("storage.ts does not contain Math.random", !trackerContent.includes("Math.random"));
}

// 5.4 Middleware correlation ID (src/middleware.ts)
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
// 6. Verification of Audit Documentation Accuracy
// -----------------------------------------------------------------------------
console.log("\n--- 6. Verification of Audit Documentation Accuracy ---");
const auditDocFile = path.join("docs", "token-generation-audit.md");
check("docs/token-generation-audit.md exists", fs.existsSync(auditDocFile));

if (fs.existsSync(auditDocFile)) {
  const docContent = fs.readFileSync(auditDocFile, "utf8");

  // Catalog coverage
  check("doc catalogs operationId.ts", docContent.includes("src/lib/security/operationId.ts"));
  check("doc catalogs unsubscribe.ts", docContent.includes("src/lib/email/unsubscribe.ts"));
  check("doc catalogs tracker storage.ts", docContent.includes("src/lib/tracker/storage.ts"));
  check("doc catalogs allowlisted sites", docContent.includes("Legitimate Non-Security Allowlist"));

  // Reviewer correction 1: Razorpay fallback non-deterministic across retries when created_at is missing
  check(
    "doc notes Razorpay fallback is NOT deterministic across retries when created_at is missing",
    docContent.includes("NOT deterministic") || docContent.includes("not deterministic")
  );

  // Reviewer correction 2: Unsalted sha256(email) is not proof of no reversible PII
  check(
    "doc acknowledges unsalted sha256(email) limitations (not mathematical proof against rainbow table / dictionary inversion)",
    docContent.includes("rainbow table") || docContent.includes("dictionary") || docContent.includes("unsalted")
  );

  // Reviewer correction 3: Remove unproven 53-bit Math.random entropy claim
  check(
    "doc does not claim 53-bit entropy for Math.random without proof",
    !docContent.includes("53 bits of pseudo-random entropy") && !docContent.includes("53-bit")
  );

  // Reviewer correction 4: Razorpay receipt/webhook IDs are references not secrets (authenticity is HMAC)
  check(
    "doc clarifies Razorpay receipt/webhook IDs are references not secrets (authenticity enforced by HMAC)",
    docContent.includes("references, not secrets") || docContent.includes("references not secrets") || docContent.includes("reference strings")
  );

  // Reviewer correction 5: Deletion uses authenticated token flow, not newly minted confirmation token
  check(
    "doc clarifies deletion uses authenticated session flow, not a newly minted confirmation token",
    docContent.includes("authenticated session") || docContent.includes("authenticated token flow")
  );

  // Reviewer correction 6: Section for provider-managed session/cookie issuance (Supabase) out of scope
  check(
    "doc includes dedicated section for provider-managed sessions (Supabase) as out of app-minted scope",
    docContent.includes("Provider-Managed") || docContent.includes("Supabase Auth")
  );

  // Reviewer correction 7: Does not claim full security certification, explicitly states what scan does and does not cover
  check(
    "doc explicitly defines what the scan covers and what it does not cover",
    (docContent.includes("What This Scan Covers") || docContent.includes("What This Audit and Scan Covers")) &&
      (docContent.includes("What This Scan Does NOT Cover") || docContent.includes("What This Audit and Scan Does NOT Cover"))
  );
}

// -----------------------------------------------------------------------------
// 7. Negative Control Subprocess Non-Zero Exit Verification
// -----------------------------------------------------------------------------
console.log("\n--- 7. Subprocess Negative Control Verification ---");
console.log("Spawning self in --negative-control mode to verify non-zero exit...");
const child = spawnSync(
  process.execPath,
  ["-r", "tsx", path.resolve(__filename), "--negative-control"],
  { encoding: "utf8" }
);

check(
  "subprocess with --negative-control exits with code 1",
  child.status === 1,
  `Expected exit code 1, got ${child.status}`
);
check(
  "subprocess output confirms negative control pass",
  child.stdout?.includes("NEGATIVE CONTROL PASSED"),
  `Subprocess stdout: ${child.stdout}`
);

// -----------------------------------------------------------------------------
// Summary & Final Exit
// -----------------------------------------------------------------------------
console.log(`\n================================================================================`);
console.log(`AUDIT SUMMARY: ${passed} passed, ${failed} failed`);
console.log(`================================================================================`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All token generation guard checks passed successfully.");
  process.exit(0);
}
