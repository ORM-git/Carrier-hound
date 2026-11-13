// Run: node scripts/check-redirect-rules.cjs
/**
 * scripts/check-redirect-rules.cjs
 *
 * STANDALONE offline checker for deploy-time redirect configurations:
 *   - public/_redirects
 *   - netlify.toml
 *
 * Statically asserts:
 *   1. Comment-aware strict parsing: Full-line comments and inline comments (#)
 *      are stripped before parsing. Commented-out rules are not treated as active.
 *   2. Destination normalization: Normalizes destination paths across queries
 *      (?foo=bar), fragments (#hash), and absolute/protocol-relative URLs.
 *   3. Early-access guard: No rule targets /early-access as a catch-all or
 *      catches /jobs to /early-access.
 *   4. Exact expected 404 target: Fallback must target the exact expected
 *      document '/404.html' (not arbitrary documents containing '404').
 *   5. Rule precedence / shadowing: No preceding catch-all rule (e.g. /* /login 302)
 *      may shadow the 404 fallback rule.
 *   6. Strict shape validation: Incomplete, malformed, or unsupported rule shapes
 *      are rejected explicitly.
 *
 * Usage:
 *   node scripts/check-redirect-rules.cjs
 *   node scripts/check-redirect-rules.cjs --test-negative-controls
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const REDIRECTS_PATH = path.join(ROOT_DIR, "public", "_redirects");
const NETLIFY_TOML_PATH = path.join(ROOT_DIR, "netlify.toml");

const EXPECTED_404_DOCUMENT = "/404.html";

// ============================================================================
// Normalization Helpers
// ============================================================================

/**
 * Normalizes destination path including query strings, fragments, and
 * absolute/protocol-relative URL forms.
 *
 * Examples:
 *   "/early-access?next=jobs"                 -> "/early-access"
 *   "https://careermonke.com/early-access"    -> "/early-access"
 *   "//careermonke.com/early-access#section"  -> "/early-access"
 *   "/404.html"                              -> "/404.html"
 *   "/not-a-404-document"                    -> "/not-a-404-document"
 */
function normalizeDestinationPath(destination) {
  if (!destination || typeof destination !== "string") return "";
  let dest = destination.trim();

  // Strip protocol-relative URLs
  if (dest.startsWith("//")) {
    dest = "https:" + dest;
  }

  // Parse absolute URLs (http:// or https://)
  if (/^https?:\/\//i.test(dest)) {
    try {
      const parsed = new URL(dest);
      dest = parsed.pathname;
    } catch (_) {
      dest = dest.replace(/^https?:\/\/[^\/\?#]+/i, "");
    }
  }

  // Strip fragment (#...) and query string (?...)
  const hashIdx = dest.indexOf("#");
  if (hashIdx !== -1) {
    dest = dest.substring(0, hashIdx);
  }
  const queryIdx = dest.indexOf("?");
  if (queryIdx !== -1) {
    dest = dest.substring(0, queryIdx);
  }

  return dest.trim().toLowerCase();
}

function isCatchAllPattern(pattern) {
  const p = (pattern || "").trim();
  return p === "/*" || p === "*" || p === "/:*";
}

function targetsEarlyAccess(target) {
  const normalized = normalizeDestinationPath(target);
  return (
    normalized === "/early-access" ||
    normalized.startsWith("/early-access/") ||
    normalized === "/early-access.html"
  );
}

function matchesJobsRoute(pattern) {
  const normalized = (pattern || "").trim().toLowerCase();
  return (
    normalized === "/jobs" ||
    normalized === "/jobs/*" ||
    normalized.startsWith("/jobs/")
  );
}

function isExact404Target(target) {
  const normalized = normalizeDestinationPath(target);
  return normalized === EXPECTED_404_DOCUMENT;
}

// ============================================================================
// Comment Stripping
// ============================================================================

/**
 * Strips comments from TOML lines while respecting quoted string literals.
 */
function stripTomlComments(line) {
  let inQuote = false;
  let quoteChar = null;
  let result = "";

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && (i === 0 || line[i - 1] !== "\\")) {
      if (!inQuote) {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === quoteChar) {
        inQuote = false;
        quoteChar = null;
      }
    }
    if (ch === "#" && !inQuote) {
      break; // comment starts here
    }
    result += ch;
  }

  return result.trimEnd();
}

// ============================================================================
// Parsers
// ============================================================================

/**
 * Parses public/_redirects content with comment-awareness and syntax validation.
 * Format: /from /to [status[!]]
 */
function parseRedirectsFile(content) {
  const lines = content.split(/\r?\n/);
  const rules = [];
  const syntaxErrors = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Split tokens by whitespace, stopping if a token begins with '#' (inline comment)
    const allTokens = trimmed.split(/\s+/);
    const tokens = [];
    for (const t of allTokens) {
      if (t.startsWith("#")) {
        break;
      }
      tokens.push(t);
    }

    if (tokens.length === 0) {
      continue;
    }

    // Explicit check for unsupported / incomplete config shape
    if (tokens.length < 2) {
      syntaxErrors.push(
        `public/_redirects line ${lineNum}: Incomplete rule syntax: expected '<from> <to> [status]', got '${trimmed}'`
      );
      continue;
    }

    const from = tokens[0];
    const to = tokens[1];
    const statusToken = tokens[2] || "301";
    const isForced = statusToken.endsWith("!");
    const cleanStatus = statusToken.replace("!", "");
    const statusCode = parseInt(cleanStatus, 10);

    if (isNaN(statusCode) || statusCode < 100 || statusCode > 599) {
      syntaxErrors.push(
        `public/_redirects line ${lineNum}: Unsupported HTTP status code '${statusToken}' in rule '${trimmed}'`
      );
      continue;
    }

    rules.push({
      line: lineNum,
      raw: trimmed,
      from,
      to,
      status: statusCode,
      forced: isForced,
    });
  }

  return { rules, syntaxErrors };
}

/**
 * Parses netlify.toml [[redirects]] blocks with strict comment-awareness.
 * Ignores commented-out blocks and validates required field shapes.
 */
function parseNetlifyTomlRedirects(content) {
  // First, strip all TOML comments line by line
  const rawLines = content.split(/\r?\n/);
  const cleanLines = rawLines.map(stripTomlComments);
  const cleanContent = cleanLines.join("\n");

  const redirectBlocks = cleanContent.split("[[redirects]]").slice(1);
  const rules = [];
  const syntaxErrors = [];

  for (let i = 0; i < redirectBlocks.length; i++) {
    const blockIndex = i + 1;
    const rawBlock = redirectBlocks[i];
    // Split on next section header if present (e.g. [[headers]] or [build])
    const sectionSplit = rawBlock.split(/\n\s*\[/);
    const blockContent = sectionSplit[0].trim();

    if (!blockContent) {
      // Entire block body was commented out
      syntaxErrors.push(
        `netlify.toml [[redirects]] block #${blockIndex}: Incomplete or empty block (body is commented out or missing)`
      );
      continue;
    }

    const fromMatch = blockContent.match(/from\s*=\s*["']([^"']+)["']/);
    const toMatch = blockContent.match(/to\s*=\s*["']([^"']+)["']/);
    const statusMatch = blockContent.match(/status\s*=\s*(\d+)/);
    const forceMatch = blockContent.match(/force\s*=\s*(true|false)/);

    if (!fromMatch || !toMatch) {
      syntaxErrors.push(
        `netlify.toml [[redirects]] block #${blockIndex}: Malformed block missing required 'from' or 'to' fields`
      );
      continue;
    }

    const statusVal = statusMatch ? parseInt(statusMatch[1], 10) : 301;
    if (isNaN(statusVal) || statusVal < 100 || statusVal > 599) {
      syntaxErrors.push(
        `netlify.toml [[redirects]] block #${blockIndex}: Unsupported HTTP status code in block`
      );
      continue;
    }

    rules.push({
      blockIndex,
      from: fromMatch[1],
      to: toMatch[1],
      status: statusVal,
      forced: forceMatch ? forceMatch[1] === "true" : false,
      raw: blockContent,
    });
  }

  return { rules, syntaxErrors };
}

// ============================================================================
// Rule Validators (Precedence, Shadowing, Early-Access, 404 Target)
// ============================================================================

/**
 * Validates redirect rules with precedence and shadowing checks.
 */
function validateRedirectRules(rules, sourceLabel) {
  const violations = [];
  let found404Fallback = false;
  let fallbackRuleIndex = -1;

  for (let idx = 0; idx < rules.length; idx++) {
    const rule = rules[idx];
    const ruleLabel = rule.line
      ? `${sourceLabel} line ${rule.line}`
      : `${sourceLabel} block #${rule.blockIndex}`;

    // 1. Guard against any route catching /jobs and sending to /early-access
    if (matchesJobsRoute(rule.from) && targetsEarlyAccess(rule.to)) {
      violations.push(
        `${ruleLabel}: Jobs route '${rule.from}' redirects to early-access '${rule.to}' (status: ${rule.status})`
      );
    }

    // 2. Guard against any catch-all targeting /early-access
    if (isCatchAllPattern(rule.from) && targetsEarlyAccess(rule.to)) {
      violations.push(
        `${ruleLabel}: Catch-all '${rule.from}' targets early-access '${rule.to}' (status: ${rule.status})`
      );
    }

    // 3. Catch-all rule handling & shadowing analysis
    if (isCatchAllPattern(rule.from)) {
      const isExpected404 = isExact404Target(rule.to) && rule.status === 404;

      if (isExpected404) {
        if (!found404Fallback) {
          found404Fallback = true;
          fallbackRuleIndex = idx;
        } else {
          violations.push(
            `${ruleLabel}: Duplicate 404 fallback rule '${rule.from} -> ${rule.to}' detected`
          );
        }
      } else {
        // This is a catch-all rule that does NOT serve the exact 404 document with status 404
        if (!found404Fallback) {
          // Precedes any 404 fallback: Shadows unknown path 404s!
          violations.push(
            `${ruleLabel}: Catch-all rule '${rule.from} -> ${rule.to}' (status: ${rule.status}) precedes and shadows the 404 fallback rule; unknown paths will never reach '${EXPECTED_404_DOCUMENT}'`
          );
        }

        // If it attempted to serve a non-exact 404 target with status 404
        if (rule.status === 404 && !isExact404Target(rule.to)) {
          violations.push(
            `${ruleLabel}: 404 fallback rule targets '${rule.to}' instead of exact expected document '${EXPECTED_404_DOCUMENT}'`
          );
        }
      }
    }
  }

  // 4. Require an active 404 fallback rule
  if (!found404Fallback) {
    violations.push(
      `${sourceLabel}: Missing required active 404 fallback rule targeting exact document '${EXPECTED_404_DOCUMENT}' with status 404 (e.g. '/* ${EXPECTED_404_DOCUMENT} 404')`
    );
  }

  return { violations, found404Fallback, fallbackRuleIndex };
}

// ============================================================================
// Negative Controls Self-Test
// ============================================================================

function runNegativeControls() {
  console.log("\n--- RUNNING NEGATIVE CONTROLS VERIFICATION ---");
  const testCases = [
    {
      name: "1. Query string: '/jobs /early-access?next=jobs 307' followed by fallback fails",
      fn: () => {
        const { rules } = parseRedirectsFile(
          "/jobs /early-access?next=jobs 307\n/* /404.html 404"
        );
        return validateRedirectRules(rules, "public/_redirects");
      },
      expectedSubstrings: ["Jobs route '/jobs' redirects to early-access"],
    },
    {
      name: "2. Absolute URL: '/* https://careermonke.com/early-access 302' followed by fallback fails",
      fn: () => {
        const { rules } = parseRedirectsFile(
          "/* https://careermonke.com/early-access 302\n/* /404.html 404"
        );
        return validateRedirectRules(rules, "public/_redirects");
      },
      expectedSubstrings: [
        "Catch-all '/*' targets early-access",
        "precedes and shadows the 404 fallback rule",
      ],
    },
    {
      name: "3. Shadowing: '/* /login 302' before the fallback (shadows unknown-path 404) fails",
      fn: () => {
        const { rules } = parseRedirectsFile(
          "/* /login 302\n/* /404.html 404"
        );
        return validateRedirectRules(rules, "public/_redirects");
      },
      expectedSubstrings: [
        "precedes and shadows the 404 fallback rule; unknown paths will never reach '/404.html'",
      ],
    },
    {
      name: "4. Exact target: '/* /not-a-404-document 404' (must target exact expected document) fails",
      fn: () => {
        const { rules } = parseRedirectsFile(
          "/* /not-a-404-document 404"
        );
        return validateRedirectRules(rules, "public/_redirects");
      },
      expectedSubstrings: [
        "targets '/not-a-404-document' instead of exact expected document '/404.html'",
        "Missing required active 404 fallback rule",
      ],
    },
    {
      name: "5. Commented TOML: A fully commented-out TOML fallback block fails",
      fn: () => {
        const toml = `
# [[redirects]]
#   from = "/*"
#   to = "/404.html"
#   status = 404
#   force = false
`;
        const { rules, syntaxErrors } = parseNetlifyTomlRedirects(toml);
        const res = validateRedirectRules(rules, "netlify.toml");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "Missing required active 404 fallback rule targeting exact document '/404.html'",
      ],
    },
    {
      name: "6. TOML Shadowing: 'from = /*, to = /login, status = 302' before fallback fails",
      fn: () => {
        const toml = `
[[redirects]]
  from = "/*"
  to = "/login"
  status = 302
  force = true

[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
  force = false
`;
        const { rules, syntaxErrors } = parseNetlifyTomlRedirects(toml);
        const res = validateRedirectRules(rules, "netlify.toml");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "precedes and shadows the 404 fallback rule",
      ],
    },
    {
      name: "7. TOML Query & Jobs: 'from = /jobs, to = /early-access?ref=jobs' fails",
      fn: () => {
        const toml = `
[[redirects]]
  from = "/jobs"
  to = "/early-access?ref=jobs"
  status = 307
  force = true

[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
  force = false
`;
        const { rules } = parseNetlifyTomlRedirects(toml);
        return validateRedirectRules(rules, "netlify.toml");
      },
      expectedSubstrings: [
        "Jobs route '/jobs' redirects to early-access",
      ],
    },
    {
      name: "8. Unsupported shape: public/_redirects incomplete rule missing destination fails",
      fn: () => {
        const { rules, syntaxErrors } = parseRedirectsFile(
          "/jobs\n/* /404.html 404"
        );
        const res = validateRedirectRules(rules, "public/_redirects");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "Incomplete rule syntax: expected '<from> <to> [status]'",
      ],
    },
    {
      name: "9. Unsupported shape: netlify.toml block missing 'to' field fails",
      fn: () => {
        const toml = `
[[redirects]]
  from = "/jobs"
  status = 301

[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
`;
        const { rules, syntaxErrors } = parseNetlifyTomlRedirects(toml);
        const res = validateRedirectRules(rules, "netlify.toml");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "Malformed block missing required 'from' or 'to' fields",
      ],
    },
    {
      name: "10. TOML Incomplete Commented Body: [[redirects]] with all fields commented out fails",
      fn: () => {
        const toml = `
[[redirects]]
  # from = "/*"
  # to = "/404.html"
  # status = 404
`;
        const { rules, syntaxErrors } = parseNetlifyTomlRedirects(toml);
        const res = validateRedirectRules(rules, "netlify.toml");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "Incomplete or empty block (body is commented out or missing)",
      ],
    },
  ];

  let passedControls = 0;

  for (const tc of testCases) {
    const result = tc.fn();
    const allMatches = tc.expectedSubstrings.every((sub) =>
      result.violations.some((v) => v.includes(sub))
    );

    if (allMatches) {
      console.log(`  [PASS] ${tc.name}`);
      passedControls++;
    } else {
      console.error(`  [FAIL] ${tc.name}`);
      console.error(`         Expected substring(s):`, tc.expectedSubstrings);
      console.error(`         Actual violations:`, result.violations);
    }
  }

  if (passedControls !== testCases.length) {
    console.error(`\nNegative controls verification FAILED: ${passedControls}/${testCases.length} passed.`);
    return false;
  }

  console.log(`All ${passedControls}/${testCases.length} negative controls verified successfully.`);
  return true;
}

// ============================================================================
// Main Execution
// ============================================================================

function main() {
  console.log("================================================================================");
  console.log("  CAREERMONKE DEPLOY REDIRECT RULES VERIFIER (STANDALONE CHECKER)              ");
  console.log("================================================================================");

  let hasErrors = false;
  const allViolations = [];

  // 1. Check public/_redirects
  console.log(`\n1. Checking public/_redirects: ${path.relative(ROOT_DIR, REDIRECTS_PATH)}`);
  if (!fs.existsSync(REDIRECTS_PATH)) {
    console.error(`  [FAIL] File does not exist: ${REDIRECTS_PATH}`);
    hasErrors = true;
    allViolations.push("public/_redirects file missing");
  } else {
    const rawRedirects = fs.readFileSync(REDIRECTS_PATH, "utf-8");
    const { rules, syntaxErrors } = parseRedirectsFile(rawRedirects);
    console.log(`  Found ${rules.length} valid redirect rules in public/_redirects.`);

    if (syntaxErrors.length > 0) {
      hasErrors = true;
      for (const err of syntaxErrors) {
        console.error(`  [FAIL] ${err}`);
        allViolations.push(err);
      }
    }

    const { violations } = validateRedirectRules(rules, "public/_redirects");
    if (violations.length > 0) {
      hasErrors = true;
      for (const v of violations) {
        console.error(`  [FAIL] ${v}`);
        allViolations.push(v);
      }
    } else {
      console.log("  [PASS] Comment-aware syntax and tokens parsed cleanly.");
      console.log("  [PASS] No rule targets /early-access (query/fragment/absolute URLs normalized).");
      console.log("  [PASS] No rule catches /jobs to /early-access.");
      console.log(`  [PASS] Unshadowed 404 fallback verified targeting exact '${EXPECTED_404_DOCUMENT}'.`);
    }
  }

  // 2. Check netlify.toml
  console.log(`\n2. Checking netlify.toml: ${path.relative(ROOT_DIR, NETLIFY_TOML_PATH)}`);
  if (!fs.existsSync(NETLIFY_TOML_PATH)) {
    console.error(`  [FAIL] File does not exist: ${NETLIFY_TOML_PATH}`);
    hasErrors = true;
    allViolations.push("netlify.toml file missing");
  } else {
    const rawToml = fs.readFileSync(NETLIFY_TOML_PATH, "utf-8");
    const { rules, syntaxErrors } = parseNetlifyTomlRedirects(rawToml);
    console.log(`  Found ${rules.length} valid [[redirects]] blocks in netlify.toml.`);

    if (syntaxErrors.length > 0) {
      hasErrors = true;
      for (const err of syntaxErrors) {
        console.error(`  [FAIL] ${err}`);
        allViolations.push(err);
      }
    }

    const { violations } = validateRedirectRules(rules, "netlify.toml");
    if (violations.length > 0) {
      hasErrors = true;
      for (const v of violations) {
        console.error(`  [FAIL] ${v}`);
        allViolations.push(v);
      }
    } else {
      console.log("  [PASS] Comment-aware TOML blocks parsed cleanly (comments stripped).");
      console.log("  [PASS] No [[redirects]] block targets /early-access as a catch-all.");
      console.log("  [PASS] No [[redirects]] block catches /jobs to /early-access.");
      console.log(`  [PASS] Unshadowed 404 fallback verified targeting exact '${EXPECTED_404_DOCUMENT}'.`);
    }
  }

  // 3. Run negative controls verification
  const controlsPassed = runNegativeControls();
  if (!controlsPassed) {
    hasErrors = true;
    allViolations.push("Negative controls self-test failed");
  }

  // 4. Final Verdict
  console.log("\n--------------------------------------------------------------------------------");
  if (hasErrors) {
    console.error("VERDICT: FAIL - Deploy redirect rules violations detected:");
    for (const v of allViolations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  } else {
    console.log("VERDICT: PASS (All deploy redirect rules and negative controls verified)");
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  EXPECTED_404_DOCUMENT,
  normalizeDestinationPath,
  isCatchAllPattern,
  targetsEarlyAccess,
  matchesJobsRoute,
  isExact404Target,
  stripTomlComments,
  parseRedirectsFile,
  parseNetlifyTomlRedirects,
  validateRedirectRules,
  runNegativeControls,
};
