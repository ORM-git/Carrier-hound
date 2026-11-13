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
 *   2. Strict full-token validation: Non-numeric status values (e.g. '404garbage')
 *      are rejected immediately; partial parseInt behavior is strictly forbidden.
 *   3. Unconditional fallback guard: Fallback rules targeting 404 must be unconditional;
 *      conditional shapes (e.g. Country=US in _redirects or conditions in TOML) are rejected.
 *   4. Subtable fail-closed guard: ANY [redirects.*] subtable (e.g. [redirects.conditions])
 *      is explicitly rejected rather than silently chopped off.
 *   5. Selector keys guard: query = {...}, headers = {...}, or any modifier key on a
 *      404 fallback is treated as conditional/unsupported and rejected.
 *   6. Approved-origin & exact target: Fallback destination must target the exact expected
 *      document '/404.html' on a local path or an approved origin (e.g. careermonke.com).
 *      External or unapproved origins (e.g. https://wrong.invalid) are rejected.
 *   7. Pathname case preservation: Pathnames are strictly case-sensitive ('/404.HTML' is
 *      rejected), while host origins remain case-insensitive.
 *   8. Destination normalization: Normalizes destination paths across queries
 *      (?foo=bar), fragments (#hash), and absolute/protocol-relative URLs for routing checks.
 *   9. Early-access guard: No rule targets /early-access as a catch-all or
 *      catches /jobs to /early-access.
 *   10. Rule precedence / shadowing: No preceding catch-all rule (e.g. /* /login 302)
 *      may shadow the 404 fallback rule.
 *   11. Strict shape validation: Incomplete, malformed, or unsupported rule shapes
 *      are rejected explicitly instead of being silently ignored.
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

const APPROVED_ORIGINS = new Set([
  "https://careermonke.com",
  "https://www.careermonke.com",
  "http://careermonke.com",
  "http://www.careermonke.com",
]);

// ============================================================================
// Destination & Origin Normalization
// ============================================================================

/**
 * Parses and dissects a destination string into structured URL components.
 * Distinguishes local paths from absolute URLs and protocol-relative URLs.
 * NOTE: Origin/host is lowercased (case-insensitive), but pathname case is
 * STRICTLY PRESERVED (case-sensitive) for exact fallback verification.
 */
function parseDestination(destination) {
  if (!destination || typeof destination !== "string") {
    return {
      raw: "",
      isLocal: false,
      origin: null,
      pathname: "",
      query: "",
      hash: "",
    };
  }

  let raw = destination.trim();
  let dest = raw;

  // Strip protocol-relative URLs (e.g. "//careermonke.com/404.html")
  if (dest.startsWith("//")) {
    dest = "https:" + dest;
  }

  if (/^https?:\/\//i.test(dest)) {
    try {
      const parsed = new URL(dest);
      return {
        raw,
        isLocal: false,
        origin: parsed.origin.toLowerCase(), // Host stays case-insensitive
        pathname: parsed.pathname, // Pathname case PRESERVED
        query: parsed.search,
        hash: parsed.hash,
      };
    } catch (_) {
      return {
        raw,
        isLocal: false,
        origin: "invalid-origin",
        pathname: raw,
        query: "",
        hash: "",
      };
    }
  }

  // Local path: must start with "/" and not "//"
  const hashIdx = dest.indexOf("#");
  let withoutHash = hashIdx !== -1 ? dest.substring(0, hashIdx) : dest;
  const hash = hashIdx !== -1 ? dest.substring(hashIdx) : "";

  const queryIdx = withoutHash.indexOf("?");
  let withoutQuery = queryIdx !== -1 ? withoutHash.substring(0, queryIdx) : withoutHash;
  const query = queryIdx !== -1 ? withoutHash.substring(queryIdx) : "";

  return {
    raw,
    isLocal: true,
    origin: null,
    pathname: withoutQuery.trim(), // Pathname case PRESERVED
    query: query.trim(),
    hash: hash.trim(),
  };
}

/**
 * Normalizes destination path including query strings, fragments, and
 * absolute/protocol-relative URL forms for route matching.
 */
function normalizeDestinationPath(destination) {
  const parsed = parseDestination(destination);
  return parsed.pathname;
}

/**
 * Asserts that the destination for a 404 fallback rule is an exact local document
 * or an approved-origin document targeting EXPECTED_404_DOCUMENT (/404.html),
 * with NO query strings, NO hash fragments, approved or local origin,
 * and STRICT CASE MATCHING (e.g. '/404.HTML' is invalid).
 */
function isValid404FallbackDestination(destination) {
  const parsed = parseDestination(destination);
  if (!parsed.raw) {
    return { valid: false, reason: "Destination is empty" };
  }

  if (parsed.query || parsed.hash) {
    return {
      valid: false,
      reason: `Fallback target cannot have query parameters or fragments; got '${destination}'`,
    };
  }

  if (!parsed.isLocal) {
    if (!APPROVED_ORIGINS.has(parsed.origin)) {
      return {
        valid: false,
        reason: `Target '${destination}' has unapproved origin '${parsed.origin}'; fallback origin must be local or an approved origin (${Array.from(APPROVED_ORIGINS).join(", ")})`,
      };
    }
  }

  // Exact case-sensitive match requirement
  if (parsed.pathname !== EXPECTED_404_DOCUMENT) {
    return {
      valid: false,
      reason: `Target path '${parsed.pathname}' does not match exact expected document '${EXPECTED_404_DOCUMENT}' (case-sensitive exact match required)`,
    };
  }

  return { valid: true, parsed };
}

function isCatchAllPattern(pattern) {
  const p = (pattern || "").trim();
  return p === "/*" || p === "*" || p === "/:*";
}

function targetsEarlyAccess(target) {
  const normalized = normalizeDestinationPath(target).toLowerCase();
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
  const check = isValid404FallbackDestination(target);
  return check.valid;
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
 * Parses public/_redirects content with comment-awareness, strict full-token
 * validation, condition tracking, and syntax validation.
 * Format: /from /to [status[!]] [conditions/parameters...]
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

    // Status token validation (strict full-token: reject partial parseInt like '404garbage')
    let isForced = false;
    let statusCode = 301;
    let statusToken = "301";

    if (tokens.length >= 3) {
      statusToken = tokens[2];
      isForced = statusToken.endsWith("!");
      const cleanStatus = isForced ? statusToken.slice(0, -1) : statusToken;

      // Full-token check: MUST be strictly numeric digits
      if (!/^\d+$/.test(cleanStatus)) {
        syntaxErrors.push(
          `public/_redirects line ${lineNum}: Malformed HTTP status code '${statusToken}' in rule '${trimmed}' (partial parseInt rejected: status code must be strictly numeric)`
        );
        continue;
      }

      const parsedCode = parseInt(cleanStatus, 10);
      if (parsedCode < 100 || parsedCode > 599) {
        syntaxErrors.push(
          `public/_redirects line ${lineNum}: Unsupported HTTP status code '${statusToken}' in rule '${trimmed}' (must be 100-599)`
        );
        continue;
      }
      statusCode = parsedCode;
    }

    // Extra tokens (e.g. Country=US, Language=en, Role=admin, Cookie=foo, etc.)
    const extraTokens = tokens.slice(3);
    const hasConditions = extraTokens.length > 0;
    const conditions = [];

    let hasMalformedToken = false;
    for (const extra of extraTokens) {
      // In Netlify _redirects, extra tokens are key=value conditions, parameters, or headers
      if (!/^!?[a-zA-Z0-9_-]+(=.*)?$/.test(extra)) {
        syntaxErrors.push(
          `public/_redirects line ${lineNum}: Malformed or unsupported parameter token '${extra}' in rule '${trimmed}'`
        );
        hasMalformedToken = true;
        break;
      }
      conditions.push(extra);
    }

    if (hasMalformedToken) {
      continue;
    }

    rules.push({
      line: lineNum,
      raw: trimmed,
      from,
      to,
      status: statusCode,
      forced: isForced,
      hasConditions,
      conditions,
    });
  }

  return { rules, syntaxErrors };
}

/**
 * Parses netlify.toml [[redirects]] blocks with strict comment-awareness,
 * full-token status validation, subtable detection, selector key detection,
 * and required field checks.
 */
function parseNetlifyTomlRedirects(content) {
  // First, strip all TOML comments line by line while preserving quotes
  const rawLines = content.split(/\r?\n/);
  const cleanLines = rawLines.map(stripTomlComments);
  const cleanContent = cleanLines.join("\n");

  const redirectBlocks = cleanContent.split("[[redirects]]").slice(1);
  const rules = [];
  const syntaxErrors = [];

  const KNOWN_TOML_KEYS = new Set([
    "from",
    "to",
    "status",
    "force",
    "conditions",
    "headers",
    "query",
    "edge_handler",
    "sign",
  ]);

  for (let i = 0; i < redirectBlocks.length; i++) {
    const blockIndex = i + 1;
    const rawBlock = redirectBlocks[i];

    // Detect ANY [redirects.*] or [[redirects.*]] subtable before section chopping.
    // Fail closed: the checker does not model subtable shapes.
    const subtableMatches = rawBlock.match(/^\s*(\[+redirects\.[^\]]+\]+)/gim);
    let hasSubtable = false;
    if (subtableMatches && subtableMatches.length > 0) {
      hasSubtable = true;
      for (const st of subtableMatches) {
        syntaxErrors.push(
          `netlify.toml [[redirects]] block #${blockIndex}: Unsupported subtable '${st.trim()}' detected; subtable shapes are not modeled and must be rejected fail-closed`
        );
      }
    }

    // Split on next foreign section header that is NOT a redirects subtable
    const sectionSplit = rawBlock.split(/\n\s*\[+(?!\s*redirects\.)/i);
    const blockContent = sectionSplit[0].trim();

    if (!blockContent) {
      // Entire block body was commented out or empty
      syntaxErrors.push(
        `netlify.toml [[redirects]] block #${blockIndex}: Incomplete or empty block (body is commented out or missing)`
      );
      continue;
    }

    const lines = blockContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let from = null;
    let to = null;
    let status = null;
    let force = false;
    let hasConditions = false;
    let conditionsRaw = null;
    let hasQuery = false;
    let queryRaw = null;
    let hasHeaders = false;
    let headersRaw = null;
    let hasEdgeHandler = false;
    let edgeHandlerRaw = null;
    let hasSign = false;
    let signRaw = null;
    let hasMalformedLine = hasSubtable; // subtable automatically invalidates block shape

    for (const line of lines) {
      // Detect subtable or section header lines inside block body
      if (/^\s*\[/i.test(line)) {
        // Already recorded via subtableMatches or foreign header
        hasMalformedLine = true;
        continue;
      }

      const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
      if (!kvMatch) {
        syntaxErrors.push(
          `netlify.toml [[redirects]] block #${blockIndex}: Malformed line '${line}' (expected 'key = value')`
        );
        hasMalformedLine = true;
        continue;
      }

      const key = kvMatch[1].toLowerCase();
      const val = kvMatch[2].trim();

      if (!KNOWN_TOML_KEYS.has(key)) {
        syntaxErrors.push(
          `netlify.toml [[redirects]] block #${blockIndex}: Unsupported or unrecognized redirect key '${key}'`
        );
        hasMalformedLine = true;
        continue;
      }

      if (key === "from") {
        const strMatch = val.match(/^["']([^"']+)["']$/);
        if (!strMatch) {
          syntaxErrors.push(
            `netlify.toml [[redirects]] block #${blockIndex}: Malformed 'from' value '${val}' (expected quoted string)`
          );
          hasMalformedLine = true;
        } else {
          from = strMatch[1];
        }
      } else if (key === "to") {
        const strMatch = val.match(/^["']([^"']+)["']$/);
        if (!strMatch) {
          syntaxErrors.push(
            `netlify.toml [[redirects]] block #${blockIndex}: Malformed 'to' value '${val}' (expected quoted string)`
          );
          hasMalformedLine = true;
        } else {
          to = strMatch[1];
        }
      } else if (key === "status") {
        // Strict full-token validation: must be strictly numeric digits
        if (!/^\d+$/.test(val)) {
          syntaxErrors.push(
            `netlify.toml [[redirects]] block #${blockIndex}: Malformed status code '${val}' (expected numeric HTTP status code, partial parseInt rejected)`
          );
          hasMalformedLine = true;
        } else {
          const s = parseInt(val, 10);
          if (s < 100 || s > 599) {
            syntaxErrors.push(
              `netlify.toml [[redirects]] block #${blockIndex}: Unsupported HTTP status code '${val}' (must be 100-599)`
            );
            hasMalformedLine = true;
          } else {
            status = s;
          }
        }
      } else if (key === "force") {
        if (val !== "true" && val !== "false") {
          syntaxErrors.push(
            `netlify.toml [[redirects]] block #${blockIndex}: Malformed 'force' value '${val}' (expected true or false)`
          );
          hasMalformedLine = true;
        } else {
          force = val === "true";
        }
      } else if (key === "conditions") {
        hasConditions = true;
        conditionsRaw = val;
      } else if (key === "query") {
        hasQuery = true;
        queryRaw = val;
      } else if (key === "headers") {
        hasHeaders = true;
        headersRaw = val;
      } else if (key === "edge_handler") {
        hasEdgeHandler = true;
        edgeHandlerRaw = val;
      } else if (key === "sign") {
        hasSign = true;
        signRaw = val;
      }
    }

    if (hasMalformedLine) {
      continue;
    }

    if (!from || !to) {
      syntaxErrors.push(
        `netlify.toml [[redirects]] block #${blockIndex}: Malformed block missing required 'from' or 'to' fields (from: ${from ? "ok" : "missing"}, to: ${to ? "ok" : "missing"})`
      );
      continue;
    }

    rules.push({
      blockIndex,
      from,
      to,
      status: status !== null ? status : 301,
      forced: force,
      hasConditions,
      conditionsRaw,
      hasQuery,
      queryRaw,
      hasHeaders,
      headersRaw,
      hasEdgeHandler,
      edgeHandlerRaw,
      hasSign,
      signRaw,
      raw: blockContent,
    });
  }

  return { rules, syntaxErrors };
}

// ============================================================================
// Rule Validators (Precedence, Shadowing, Early-Access, 404 Target, Conditions)
// ============================================================================

/**
 * Validates redirect rules with precedence, shadowing, unconditional fallback,
 * selector key restrictions, approved origin, and case-sensitive document checks.
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
      // Check if this rule is intended as a 404 fallback
      if (rule.status === 404) {
        // Fallback MUST be unconditional
        if (rule.hasConditions) {
          const condDesc =
            rule.conditionsRaw ||
            (rule.conditions && rule.conditions.join(" ")) ||
            "present";
          violations.push(
            `${ruleLabel}: 404 fallback rule must be unconditional; found conditions '${condDesc}' (conditional rule cannot serve as global fallback)`
          );
        }

        // Selector keys: query, headers, edge_handler, sign on fallback are forbidden
        if (rule.hasQuery) {
          violations.push(
            `${ruleLabel}: 404 fallback rule must be unconditional; found query selector '${rule.queryRaw}' (fallback cannot have query selectors)`
          );
        }

        if (rule.hasHeaders) {
          violations.push(
            `${ruleLabel}: 404 fallback rule must be unconditional; found headers selector '${rule.headersRaw}' (fallback cannot have header selectors)`
          );
        }

        if (rule.hasEdgeHandler) {
          violations.push(
            `${ruleLabel}: 404 fallback rule must be unconditional; found edge_handler modifier '${rule.edgeHandlerRaw}' (fallback cannot use edge handlers)`
          );
        }

        if (rule.hasSign) {
          violations.push(
            `${ruleLabel}: 404 fallback rule must be unconditional; found sign modifier '${rule.signRaw}' (fallback cannot use signing)`
          );
        }

        const isConditionalOrUnsupported =
          rule.hasConditions ||
          rule.hasQuery ||
          rule.hasHeaders ||
          rule.hasEdgeHandler ||
          rule.hasSign;

        // Destination MUST be an exact local document or approved origin targeting /404.html (exact case)
        const destCheck = isValid404FallbackDestination(rule.to);
        if (!destCheck.valid) {
          violations.push(
            `${ruleLabel}: 404 fallback rule invalid: ${destCheck.reason}`
          );
        }

        // If unconditional AND valid destination
        if (!isConditionalOrUnsupported && destCheck.valid) {
          if (!found404Fallback) {
            found404Fallback = true;
            fallbackRuleIndex = idx;
          } else {
            violations.push(
              `${ruleLabel}: Duplicate 404 fallback rule '${rule.from} -> ${rule.to}' detected`
            );
          }
        }
      } else {
        // This is a catch-all rule that does NOT serve status 404
        if (!found404Fallback) {
          // Precedes any 404 fallback: Shadows unknown path 404s!
          violations.push(
            `${ruleLabel}: Catch-all rule '${rule.from} -> ${rule.to}' (status: ${rule.status}) precedes and shadows the 404 fallback rule; unknown paths will never reach '${EXPECTED_404_DOCUMENT}'`
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
    // ------------------------------------------------------------------------
    // Core Controls: Full-Token, Conditional, Origin, Subtables, Selectors, Case
    // ------------------------------------------------------------------------
    {
      name: "1. Negative Control: '/* /404.html 404garbage' (partial parseInt rejected)",
      fn: () => {
        const { rules, syntaxErrors } = parseRedirectsFile(
          "/* /404.html 404garbage"
        );
        const res = validateRedirectRules(rules, "public/_redirects");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "Malformed HTTP status code '404garbage'",
        "partial parseInt rejected",
      ],
    },
    {
      name: "2. Negative Control: '/* /404.html 404 Country=US' (conditional rule rejected for fallback)",
      fn: () => {
        const { rules, syntaxErrors } = parseRedirectsFile(
          "/* /404.html 404 Country=US"
        );
        const res = validateRedirectRules(rules, "public/_redirects");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "404 fallback rule must be unconditional",
        "Country=US",
      ],
    },
    {
      name: "3. Negative Control: TOML fallback with conditions = {Country = [\"US\"]} (unconditional requirement)",
      fn: () => {
        const toml = `
[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
  conditions = {Country = ["US"]}
`;
        const { rules, syntaxErrors } = parseNetlifyTomlRedirects(toml);
        const res = validateRedirectRules(rules, "netlify.toml");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "404 fallback rule must be unconditional",
        "Country",
      ],
    },
    {
      name: "4. Negative Control: '/* https://wrong.invalid/404.html 404' (origin must be local or approved)",
      fn: () => {
        const { rules, syntaxErrors } = parseRedirectsFile(
          "/* https://wrong.invalid/404.html 404"
        );
        const res = validateRedirectRules(rules, "public/_redirects");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "unapproved origin 'https://wrong.invalid'",
        "must be local or an approved origin",
      ],
    },
    {
      name: "5. Negative Control: TOML status = 404garbage (partial parseInt rejected)",
      fn: () => {
        const toml = `
[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404garbage
`;
        const { rules, syntaxErrors } = parseNetlifyTomlRedirects(toml);
        const res = validateRedirectRules(rules, "netlify.toml");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "Malformed status code '404garbage'",
        "partial parseInt rejected",
      ],
    },
    {
      name: "6. Negative Control: TOML fallback with [redirects.conditions] subtable is rejected fail-closed",
      fn: () => {
        const toml = `
[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404

  [redirects.conditions]
    Country = ["US"]
`;
        const { rules, syntaxErrors } = parseNetlifyTomlRedirects(toml);
        const res = validateRedirectRules(rules, "netlify.toml");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "Unsupported subtable '[redirects.conditions]'",
        "Missing required active 404 fallback rule",
      ],
    },
    {
      name: "7. Negative Control: TOML fallback with query = {country = \"US\"} selector is rejected",
      fn: () => {
        const toml = `
[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
  query = {country = "US"}
`;
        const { rules, syntaxErrors } = parseNetlifyTomlRedirects(toml);
        const res = validateRedirectRules(rules, "netlify.toml");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "404 fallback rule must be unconditional",
        "query selector '{country = \"US\"}'",
      ],
    },
    {
      name: "8. Negative Control: '/404.HTML' pathname case mismatch fails (host stays case-insensitive)",
      fn: () => {
        const { rules, syntaxErrors } = parseRedirectsFile(
          "/* https://CAREERMONKE.COM/404.HTML 404"
        );
        const res = validateRedirectRules(rules, "public/_redirects");
        return {
          violations: [...syntaxErrors, ...res.violations],
        };
      },
      expectedSubstrings: [
        "Target path '/404.HTML' does not match exact expected document '/404.html'",
        "case-sensitive exact match required",
        "Missing required active 404 fallback rule",
      ],
    },

    // ------------------------------------------------------------------------
    // Additional Comprehensive Controls (9 - 18)
    // ------------------------------------------------------------------------
    {
      name: "9. Negative Control: Query string '/jobs /early-access?next=jobs 307' followed by fallback fails",
      fn: () => {
        const { rules } = parseRedirectsFile(
          "/jobs /early-access?next=jobs 307\n/* /404.html 404"
        );
        return validateRedirectRules(rules, "public/_redirects");
      },
      expectedSubstrings: ["Jobs route '/jobs' redirects to early-access"],
    },
    {
      name: "10. Negative Control: Absolute URL '/* https://careermonke.com/early-access 302' followed by fallback fails",
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
      name: "11. Negative Control: Shadowing '/* /login 302' before the fallback fails",
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
      name: "12. Negative Control: Exact target '/* /not-a-404-document 404' fails",
      fn: () => {
        const { rules } = parseRedirectsFile(
          "/* /not-a-404-document 404"
        );
        return validateRedirectRules(rules, "public/_redirects");
      },
      expectedSubstrings: [
        "does not match exact expected document '/404.html'",
        "Missing required active 404 fallback rule",
      ],
    },
    {
      name: "13. Negative Control: Commented TOML fallback block fails",
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
      name: "14. Negative Control: TOML Shadowing 'from = /*, to = /login, status = 302' before fallback fails",
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
      name: "15. Negative Control: TOML Query & Jobs 'from = /jobs, to = /early-access?ref=jobs' fails",
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
      name: "16. Negative Control: Unsupported shape (public/_redirects incomplete rule missing destination) fails",
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
      name: "17. Negative Control: Unsupported shape (netlify.toml block missing 'to' field) fails",
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
      name: "18. Negative Control: TOML Incomplete Commented Body ([[redirects]] with all fields commented out) fails",
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
    console.error(
      `\nNegative controls verification FAILED: ${passedControls}/${testCases.length} passed.`
    );
    return false;
  }

  console.log(
    `All ${passedControls}/${testCases.length} negative controls verified successfully.`
  );
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
      console.log(`  [PASS] Unshadowed, unconditional 404 fallback verified targeting exact '${EXPECTED_404_DOCUMENT}'.`);
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
      console.log(`  [PASS] Unshadowed, unconditional 404 fallback verified targeting exact '${EXPECTED_404_DOCUMENT}'.`);
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
  APPROVED_ORIGINS,
  parseDestination,
  normalizeDestinationPath,
  isValid404FallbackDestination,
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
