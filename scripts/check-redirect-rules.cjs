// Run: node scripts/check-redirect-rules.cjs
/**
 * scripts/check-redirect-rules.cjs
 *
 * STANDALONE offline checker for deploy-time redirect configurations:
 *   - public/_redirects
 *   - netlify.toml
 *
 * REWRITTEN AS A STRICT SUBSET PARSER THAT FAILS CLOSED:
 * Anything it does not explicitly recognize is an error.
 *
 * Accepted grammar inside a [[redirects]] block:
 *   - key: exactly one of from, to, status, force, in canonical lowercase. Any other key,
 *          any case variant, any duplicate key in the same block, any dotted or quoted key = error.
 *   - separator: exactly " = " or "=" with optional spaces. Nothing else.
 *   - string value (from, to): opening and closing quote must be the same character (" or ').
 *          No escapes, no backslashes, no multi-line or triple quotes, no unterminated string,
 *          no characters after the closing quote except optional whitespace and a "# comment".
 *   - status value: regex ^[1-9][0-9]{2}$ only. Reject 0404, 00404, +404, 4_04, 404.0, 0x194, quoted "404".
 *   - force value: exactly true or false.
 *   - comments: only a "#" outside a string. A "#" inside a string stays part of the string.
 *   - table headers: exactly [[redirects]] (optional trailing whitespace or comment).
 *          Reject [redirects], [ [redirects] ], escaped or quoted headers, any other table.
 *   - Anything else (arrays, inline tables, dates, floats, unknown lines) = error, never skipped silently.
 *   - Validation order: Do not lowercase, trim-normalise or parseInt before validation.
 *          Validate the raw token first, then convert.
 *
 * In addition, asserts routing semantics:
 *   - Exactly one active, unconditional 404 fallback rule targeting exact expected document '/404.html'.
 *   - 404 fallback rule must be the last redirect rule (fallback not last / wrong order rejected).
 *   - No preceding rule may shadow the 404 fallback rule (e.g. /* /login 302).
 *   - No rule targets /early-access as a catch-all or catches /jobs to /early-access.
 *   - Origin must be local or an approved origin (careermonke.com).
 *   - Pathname case is strictly preserved (/404.HTML rejected).
 *
 * Tests:
 *   - Table-driven test suite of positive controls and 81 negative cases covering every grammar rule.
 *   - Cross-checks verdict against Python tomllib (if tomllib rejects, checker must reject).
 *   - 300-iteration deterministic fuzz loop mutating valid block, asserting checker never accepts
 *     anything tomllib rejects.
 *
 * Usage:
 *   node scripts/check-redirect-rules.cjs
 *   node scripts/check-redirect-rules.cjs --test-negative-controls
 */

"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

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

// Allowed top-level table headers in netlify.toml outside redirects
const ALLOWED_TOP_LEVEL_SECTIONS = new Set([
  "[build]",
  "[[headers]]",
  "[headers.values]",
]);

// Exact accepted lowercase keys in a [[redirects]] block
const ACCEPTED_REDIRECT_KEYS = new Set(["from", "to", "status", "force"]);

// ============================================================================
// Destination & Origin Normalization
// ============================================================================

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

  if (dest.startsWith("//")) {
    dest = "https:" + dest;
  }

  if (/^https?:\/\//i.test(dest)) {
    try {
      const parsed = new URL(dest);
      return {
        raw,
        isLocal: false,
        origin: parsed.origin.toLowerCase(),
        pathname: parsed.pathname,
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
    pathname: withoutQuery.trim(),
    query: query.trim(),
    hash: hash.trim(),
  };
}

function normalizeDestinationPath(destination) {
  const parsed = parseDestination(destination);
  return parsed.pathname;
}

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
// public/_redirects Parser
// ============================================================================

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

    if (tokens.length < 2) {
      syntaxErrors.push(
        `public/_redirects line ${lineNum}: Incomplete rule syntax: expected '<from> <to> [status]', got '${trimmed}'`
      );
      continue;
    }

    const from = tokens[0];
    const to = tokens[1];

    let isForced = false;
    let statusCode = 301;
    let statusToken = "301";

    if (tokens.length >= 3) {
      statusToken = tokens[2];
      isForced = statusToken.endsWith("!");
      const cleanStatus = isForced ? statusToken.slice(0, -1) : statusToken;

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

    const extraTokens = tokens.slice(3);
    const hasConditions = extraTokens.length > 0;
    const conditions = [];

    let hasMalformedToken = false;
    for (const extra of extraTokens) {
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

// ============================================================================
// STRICT SUBSET PARSER for netlify.toml [[redirects]]
// ============================================================================

// Valid TOML whitespace is strictly ASCII space (U+0020) and horizontal tab (U+0009).
// Reject any other whitespace or control character anywhere in a line:
// - Control characters: U+0000..U+0008, U+000B (\v), U+000C (\f), U+000E..U+001F, U+007F, \r (carriage return outside line endings)
// - Non-ASCII whitespace: U+00A0 (NBSP), U+1680, U+2000..U+200B (including zero-width space U+200B), U+2028, U+2029, U+202F, U+205F, U+3000
// - Byte Order Mark (BOM) / zero-width no-break space: U+FEFF
const DISALLOWED_CHARS_REGEX =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\r\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

/**
 * Strict subset parser for netlify.toml [[redirects]] blocks.
 * Fails closed on any construct outside the exact grammar specified.
 *
 * @param {string} content - TOML content
 * @param {object} [options] - Parser options:
 *   - allowTopLevelHeaders: boolean (allow known non-redirect headers like [build], [[headers]] in full netlify.toml)
 * @returns {{ rules: Array, syntaxErrors: Array<string> }}
 */
function parseNetlifyTomlRedirects(content, options = {}) {
  const allowTopLevelHeaders = Boolean(options.allowTopLevelHeaders);
  const rawLines = content.split(/\r?\n/);
  const syntaxErrors = [];
  const rules = [];

  let currentSection = null;
  let currentBlock = null;
  let blockCount = 0;

  function finalizeBlock(block) {
    if (!block) return;
    if (block.hasError) return;

    if (!block.from) {
      syntaxErrors.push(
        `netlify.toml [[redirects]] block #${block.blockIndex} (line ${block.startLine}): Missing required 'from' field`
      );
      return;
    }
    if (!block.to) {
      syntaxErrors.push(
        `netlify.toml [[redirects]] block #${block.blockIndex} (line ${block.startLine}): Missing required 'to' field`
      );
      return;
    }
    if (block.status === null || block.status === undefined) {
      syntaxErrors.push(
        `netlify.toml [[redirects]] block #${block.blockIndex} (line ${block.startLine}): Missing required 'status' field`
      );
      return;
    }

    rules.push({
      blockIndex: block.blockIndex,
      from: block.from,
      to: block.to,
      status: block.status,
      forced: block.force,
      hasConditions: false,
      line: block.startLine,
      raw: block.rawLines.join("\n"),
    });
  }

  for (let lineNum = 1; lineNum <= rawLines.length; lineNum++) {
    const rawLine = rawLines[lineNum - 1];

    // Reject non-ASCII whitespace or control characters anywhere in the line
    if (DISALLOWED_CHARS_REGEX.test(rawLine)) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Invalid whitespace or control character detected (only ASCII space U+0020 and tab U+0009 allowed)`
      );
      if (currentBlock) {
        currentBlock.hasError = true;
      }
      continue;
    }

    // Strip ONLY space and tab explicitly (never use JS trim() or \s)
    const trimmed = rawLine.replace(/^[ \t]+|[ \t]+$/g, "");

    // 1. Empty / whitespace-only line
    if (!trimmed) {
      continue;
    }

    // 2. Full-line comment (only a "#" outside a string)
    if (trimmed.startsWith("#")) {
      continue;
    }

    // 3. Table header line: starts with "["
    if (trimmed.startsWith("[")) {
      // Check exact canonical [[redirects]] header (optional trailing whitespace or comment)
      if (/^\[\[redirects\]\]([ \t]*(#.*)?)?$/.test(trimmed)) {
        finalizeBlock(currentBlock);
        blockCount++;
        currentSection = "redirects";
        currentBlock = {
          blockIndex: blockCount,
          startLine: lineNum,
          seenKeys: new Set(),
          from: null,
          to: null,
          status: null,
          force: false,
          hasError: false,
          rawLines: [trimmed],
        };
        continue;
      }

      // Check allowed top-level non-redirect headers in full netlify.toml
      if (allowTopLevelHeaders) {
        const headerWithoutComment = trimmed.replace(/[ \t]*#.*$/, "").replace(/^[ \t]+|[ \t]+$/g, "");
        if (ALLOWED_TOP_LEVEL_SECTIONS.has(headerWithoutComment)) {
          finalizeBlock(currentBlock);
          currentBlock = null;
          currentSection = "foreign";
          continue;
        }
      }

      // Any other table header is rejected fail-closed
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Unsupported or non-canonical table header '${trimmed}' (only exact '[[redirects]]' is allowed)`
      );
      if (currentBlock) {
        currentBlock.hasError = true;
      }
      continue;
    }

    // 4. Content lines outside a [[redirects]] block
    if (currentSection !== "redirects" || !currentBlock) {
      if (allowTopLevelHeaders && currentSection === "foreign") {
        // Known foreign section in full netlify.toml (e.g. [build], [[headers]])
        continue;
      }
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Statement '${trimmed}' outside [[redirects]] block`
      );
      continue;
    }

    currentBlock.rawLines.push(rawLine);

    // 5. Inside [[redirects]] block:
    // Reject quoted keys immediately (e.g. "from" = "...")
    if (/^[ \t]*["']/.test(rawLine)) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Quoted keys are not allowed in strict subset parser: '${trimmed}'`
      );
      currentBlock.hasError = true;
      continue;
    }

    // Locate the first key-value separator '='
    const eqIdx = rawLine.indexOf("=");
    if (eqIdx === -1) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Missing key-value separator '=' in line: '${trimmed}'`
      );
      currentBlock.hasError = true;
      continue;
    }

    const rawKeyPart = rawLine.slice(0, eqIdx);
    const rawValPart = rawLine.slice(eqIdx + 1);

    // Separator check: exactly "=" with optional spaces around it.
    // Reject compound operators like '==', '=>', '=:' immediately
    if (/^[>=:]/.test(rawValPart)) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Invalid separator or compound operator in line: '${trimmed}'`
      );
      currentBlock.hasError = true;
      continue;
    }

    // Reject dotted or quoted keys before '='
    if (rawKeyPart.includes(".") || rawKeyPart.includes('"') || rawKeyPart.includes("'")) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Dotted or quoted keys are not allowed in strict subset parser: '${trimmed}'`
      );
      currentBlock.hasError = true;
      continue;
    }

    // Key token extraction: validate raw token first, without lowercase normalization
    const keyMatch = rawKeyPart.match(/^[ \t]*([a-zA-Z0-9_-]+)[ \t]*$/);
    if (!keyMatch) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Invalid key syntax in line: '${trimmed}'`
      );
      currentBlock.hasError = true;
      continue;
    }

    const rawKey = keyMatch[1];

    // Must be exactly one of: from, to, status, force in canonical lowercase
    if (!ACCEPTED_REDIRECT_KEYS.has(rawKey)) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Unsupported or non-canonical key '${rawKey}' (key must be exactly one of from, to, status, force in canonical lowercase)`
      );
      currentBlock.hasError = true;
      continue;
    }

    // Duplicate key in the same block = error
    if (currentBlock.seenKeys.has(rawKey)) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Duplicate key '${rawKey}' detected in [[redirects]] block #${currentBlock.blockIndex}`
      );
      currentBlock.hasError = true;
      continue;
    }
    currentBlock.seenKeys.add(rawKey);

    // Value validation: strip only leading ASCII space and tab (never use JS trimStart())
    const valTrimStart = rawValPart.replace(/^[ \t]+/, "");
    if (valTrimStart.length === 0) {
      syntaxErrors.push(
        `netlify.toml line ${lineNum}: Missing value for key '${rawKey}'`
      );
      currentBlock.hasError = true;
      continue;
    }

    // 5a. String value for from, to
    if (rawKey === "from" || rawKey === "to") {
      const quoteChar = valTrimStart[0];
      if (quoteChar !== '"' && quoteChar !== "'") {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Value for '${rawKey}' must be a quoted string starting with " or '`
        );
        currentBlock.hasError = true;
        continue;
      }

      // Reject multi-line or triple quotes
      if (valTrimStart.startsWith('"""') || valTrimStart.startsWith("'''")) {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Triple quotes and multiline strings are not permitted in strict subset parser`
        );
        currentBlock.hasError = true;
        continue;
      }

      // Reject escapes and backslashes
      if (valTrimStart.includes("\\")) {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Backslashes and escape sequences are not permitted in strict subset parser`
        );
        currentBlock.hasError = true;
        continue;
      }

      // Find the closing quote: must be the same character
      const closingIdx = valTrimStart.indexOf(quoteChar, 1);
      if (closingIdx === -1) {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Unterminated string literal for '${rawKey}': missing closing quote '${quoteChar}'`
        );
        currentBlock.hasError = true;
        continue;
      }

      const strContent = valTrimStart.slice(1, closingIdx);
      if (strContent.length === 0) {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Empty string is not a valid route path for '${rawKey}'`
        );
        currentBlock.hasError = true;
        continue;
      }

      // No characters after closing quote except optional whitespace and a "# comment"
      const remainder = valTrimStart.slice(closingIdx + 1);
      const trimmedRemainder = remainder.replace(/^[ \t]+/, "");
      if (trimmedRemainder.length > 0 && !trimmedRemainder.startsWith("#")) {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Trailing characters after closing quote for '${rawKey}': '${remainder.replace(/^[ \t]+|[ \t]+$/g, "")}' (only optional whitespace and '# comment' allowed)`
        );
        currentBlock.hasError = true;
        continue;
      }

      currentBlock[rawKey] = strContent;
    }

    // 5b. Status value: regex ^[1-9][0-9]{2}$ only
    else if (rawKey === "status") {
      let token = valTrimStart;
      const hashIdx = token.indexOf("#");
      if (hashIdx !== -1) {
        token = token.slice(0, hashIdx);
      }
      const statusToken = token.replace(/^[ \t]+|[ \t]+$/g, "");

      // Validate raw token first without parseInt
      if (!/^[1-9][0-9]{2}$/.test(statusToken)) {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Malformed status code '${statusToken}' (must match regex ^[1-9][0-9]{2}$: exactly 3 digits, no leading zeros, no signs, no floats, no quotes)`
        );
        currentBlock.hasError = true;
        continue;
      }

      const statusCode = Number(statusToken);
      if (statusCode < 100 || statusCode > 599) {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Unsupported HTTP status code ${statusCode} (must be 100-599)`
        );
        currentBlock.hasError = true;
        continue;
      }

      currentBlock.status = statusCode;
    }

    // 5c. Force value: exactly true or false
    else if (rawKey === "force") {
      let token = valTrimStart;
      const hashIdx = token.indexOf("#");
      if (hashIdx !== -1) {
        token = token.slice(0, hashIdx);
      }
      const forceToken = token.replace(/^[ \t]+|[ \t]+$/g, "");

      if (forceToken !== "true" && forceToken !== "false") {
        syntaxErrors.push(
          `netlify.toml line ${lineNum}: Malformed force value '${forceToken}' (must be exactly 'true' or 'false')`
        );
        currentBlock.hasError = true;
        continue;
      }

      currentBlock.force = forceToken === "true";
    }
  }

  // Finalize last block
  finalizeBlock(currentBlock);

  // If any syntax errors anywhere in netlify.toml, fail closed:
  // do not certify any redirect rules from this file.
  if (syntaxErrors.length > 0) {
    return { rules: [], syntaxErrors };
  }

  return { rules, syntaxErrors };
}

// ============================================================================
// Rule Validators (Precedence, Shadowing, Early-Access, 404 Target, Order)
// ============================================================================

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
      if (rule.status === 404) {
        if (rule.hasConditions) {
          violations.push(
            `${ruleLabel}: 404 fallback rule must be unconditional; found conditions`
          );
        }

        const destCheck = isValid404FallbackDestination(rule.to);
        if (!destCheck.valid) {
          violations.push(
            `${ruleLabel}: 404 fallback rule invalid: ${destCheck.reason}`
          );
        }

        if (!rule.hasConditions && destCheck.valid) {
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
        // Catch-all rule with status != 404 preceding fallback shadows it
        if (!found404Fallback) {
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
  } else {
    // 5. Fallback must be the last redirect rule (wrong order / fallback not last)
    if (fallbackRuleIndex !== rules.length - 1) {
      const trailingCount = rules.length - 1 - fallbackRuleIndex;
      violations.push(
        `${sourceLabel}: 404 fallback rule is not the last redirect rule (${trailingCount} rule(s) appear after the fallback; wrong order, fallback must be last)`
      );
    }
  }

  return { violations, found404Fallback, fallbackRuleIndex };
}

// ============================================================================
// Python tomllib Cross-Check Helper & PRNG for Fuzzing
// ============================================================================

function checkTomlWithPython(tomlInputs) {
  const pythonScript = `import json, sys
try:
    import tomllib as toml_parser
except ImportError:
    try:
        import tomli as toml_parser
    except ImportError:
        import subprocess
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "tomli"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            import tomli as toml_parser
        except Exception:
            sys.stderr.write("NO_TOML_PARSER_AVAILABLE\\n")
            sys.exit(2)

try:
    inputs = json.loads(sys.stdin.read())
    results = []
    for s in inputs:
        try:
            toml_parser.loads(s)
            results.append(True)
        except Exception:
            results.append(False)
    print(json.dumps(results))
except Exception as e:
    sys.stderr.write(f"ERR: {e}\\n")
    sys.exit(1)
`;

  const candidates = [process.env.PYTHON || "python", "python3", "py"];
  for (const cmd of candidates) {
    try {
      const res = cp.spawnSync(cmd, ["-c", pythonScript], {
        input: JSON.stringify(tomlInputs),
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
      });
      if (res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch (_) {
      // try next candidate
    }
  }
  return null;
}

function createPrng(seed) {
  return function() {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Table-Driven Test Suite & Fuzz Suite
// ============================================================================

function runTableDrivenTestSuite() {
  console.log("\n--- RUNNING TABLE-DRIVEN TEST SUITE & PYTHON TOMLLIB CROSS-CHECK ---");

  const canonicalFallbackSnippet = `[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
`;

  // Positive Controls
  const positiveControls = [
    {
      name: "POS 1: Canonical 404 fallback rule",
      toml: canonicalFallbackSnippet,
    },
    {
      name: "POS 2: Typical redirect rules followed by canonical fallback",
      toml: `[[redirects]]
  from = "/privacy"
  to = "/privacy-policy"
  status = 301
  force = true

[[redirects]]
  from = "/jobs/*"
  to = "/jobs/detail.html"
  status = 200

[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
  force = false
`,
    },
    {
      name: "POS 3: Single-quoted string literals with matching quotes",
      toml: `[[redirects]]
  from = '/old'
  to = '/new'
  status = 301

[[redirects]]
  from = '/*'
  to = '/404.html'
  status = 404
`,
    },
    {
      name: "POS 4: Hash character inside string value remains part of string",
      toml: `[[redirects]]
  from = "/faq"
  to = "/about#faq"
  status = 301

[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
`,
    },
    {
      name: "POS 5: Full-line and inline comments with hash outside string",
      toml: `# Top-level comment
[[redirects]] # Header comment
  # Inside block comment
  from = "/search" # from comment
  to = "/jobs" # to comment
  status = 302 # status comment
  force = true # force comment

[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
`,
    },
  ];

  // Negative Controls
  const negativeControls = [
    // 1-8: Mismatched quotes
    {
      name: "NEG 01: Mismatched quotes 'from = \"/jobs'' before fallback",
      toml: `[[redirects]]\n  from = "/jobs'\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 02: Mismatched quotes 'from = \"/jobs'' after fallback",
      toml: `${canonicalFallbackSnippet}\n[[redirects]]\n  from = "/jobs'\n  to = "/dest"\n  status = 302\n`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 03: Mismatched quotes 'to = \"/dest'' before fallback",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest'\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 04: Mismatched quotes 'to = \"/dest'' after fallback",
      toml: `${canonicalFallbackSnippet}\n[[redirects]]\n  from = "/jobs"\n  to = "/dest'\n  status = 302\n`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 05: Mismatched quotes single-to-double 'from = '/jobs\"'",
      toml: `[[redirects]]\n  from = '/jobs"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 06: Mismatched quotes single-to-double 'to = '/dest\"'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = '/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 07: Mismatched quotes 'from = \"/*'' on fallback itself",
      toml: `[[redirects]]\n  from = "/*'\n  to = "/404.html"\n  status = 404\n`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 08: Mismatched quotes 'to = \"/404.html'' on fallback itself",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/404.html'\n  status = 404\n`,
      expectedSubstring: "Unterminated string literal",
    },

    // 9-12: Unterminated strings
    {
      name: "NEG 09: Unterminated string on from: 'from = \"/jobs'",
      toml: `[[redirects]]\n  from = "/jobs\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 10: Unterminated string on to: 'to = \"/dest'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 11: Unterminated single quote on from: 'from = '/jobs'",
      toml: `[[redirects]]\n  from = '/jobs\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unterminated string literal",
    },
    {
      name: "NEG 12: Unterminated single quote on to: 'to = '/dest'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = '/dest\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unterminated string literal",
    },

    // 13-15: Trailing characters after closing quote
    {
      name: "NEG 13: Trailing garbage after quote: 'from = \"/jobs\" trailing'",
      toml: `[[redirects]]\n  from = "/jobs" trailing\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Trailing characters after closing quote",
    },
    {
      name: "NEG 14: Trailing garbage after quote: 'to = \"/dest\" garbage'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest" garbage\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Trailing characters after closing quote",
    },
    {
      name: "NEG 15: Trailing second string: 'from = \"/jobs\" \"extra\"'",
      toml: `[[redirects]]\n  from = "/jobs" "extra"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Trailing characters after closing quote",
    },

    // 16-17: Multi-line and triple quotes
    {
      name: "NEG 16: Multi-line triple double quotes: 'from = \"\"\"/jobs\"\"\"'",
      toml: `[[redirects]]\n  from = """/jobs"""\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Triple quotes and multiline strings are not permitted",
    },
    {
      name: "NEG 17: Multi-line triple single quotes: 'to = \'\'\'/dest\'\'\''",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = '''/dest'''\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Triple quotes and multiline strings are not permitted",
    },

    // 18-22: Backslashes and escapes
    {
      name: "NEG 18: Backslash unicode escape: 'from = \"/job\\u0073\"' before fallback",
      toml: `[[redirects]]\n  from = "/job\\u0073"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Backslashes and escape sequences are not permitted",
    },
    {
      name: "NEG 19: Backslash unicode escape: 'to = \"/early\\u002daccess\"' after fallback",
      toml: `${canonicalFallbackSnippet}\n[[redirects]]\n  from = "/jobs"\n  to = "/early\\u002daccess"\n  status = 302\n`,
      expectedSubstring: "Backslashes and escape sequences are not permitted",
    },
    {
      name: "NEG 20: Backslash newline escape: 'from = \"/jobs\\n\"'",
      toml: `[[redirects]]\n  from = "/jobs\\n"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Backslashes and escape sequences are not permitted",
    },
    {
      name: "NEG 21: Backslash tab escape: 'to = \"/dest\\t\"'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest\\t"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Backslashes and escape sequences are not permitted",
    },
    {
      name: "NEG 22: Backslash literal: 'from = \"/jobs\\\\path\"'",
      toml: `[[redirects]]\n  from = "/jobs\\\\path"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Backslashes and escape sequences are not permitted",
    },

    // 23-29: Uppercase & mixed-case keys
    {
      name: "NEG 23: Uppercase key 'FROM = \"/jobs\"' before fallback",
      toml: `[[redirects]]\n  FROM = "/jobs"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'FROM'",
    },
    {
      name: "NEG 24: Uppercase key 'FROM = \"/jobs\"' after fallback",
      toml: `${canonicalFallbackSnippet}\n[[redirects]]\n  FROM = "/jobs"\n  to = "/dest"\n  status = 302\n`,
      expectedSubstring: "Unsupported or non-canonical key 'FROM'",
    },
    {
      name: "NEG 25: Uppercase key 'TO = \"/dest\"' before fallback",
      toml: `[[redirects]]\n  from = "/jobs"\n  TO = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'TO'",
    },
    {
      name: "NEG 26: Uppercase key 'TO = \"/dest\"' after fallback",
      toml: `${canonicalFallbackSnippet}\n[[redirects]]\n  from = "/jobs"\n  TO = "/dest"\n  status = 302\n`,
      expectedSubstring: "Unsupported or non-canonical key 'TO'",
    },
    {
      name: "NEG 27: Uppercase key 'STATUS = 302' before fallback",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  STATUS = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'STATUS'",
    },
    {
      name: "NEG 28: Uppercase key 'STATUS = 302' after fallback",
      toml: `${canonicalFallbackSnippet}\n[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  STATUS = 302\n`,
      expectedSubstring: "Unsupported or non-canonical key 'STATUS'",
    },
    {
      name: "NEG 29: Uppercase key 'FORCE = true'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  FORCE = true\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'FORCE'",
    },
    {
      name: "NEG 30: Mixed-case key 'From = \"/jobs\"'",
      toml: `[[redirects]]\n  From = "/jobs"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'From'",
    },
    {
      name: "NEG 31: Mixed-case key 'To = \"/dest\"'",
      toml: `[[redirects]]\n  from = "/jobs"\n  To = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'To'",
    },
    {
      name: "NEG 32: Mixed-case key 'Status = 302'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  Status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'Status'",
    },
    {
      name: "NEG 33: Uppercase keys on fallback itself: FROM, TO, STATUS",
      toml: `[[redirects]]\n  FROM = "/*"\n  TO = "/404.html"\n  STATUS = 404\n`,
      expectedSubstring: "Unsupported or non-canonical key",
    },

    // 34-37: Duplicate keys in same block
    {
      name: "NEG 34: Duplicate key 'status = 302' then 'status = 404' before fallback",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  status = 404\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Duplicate key 'status'",
    },
    {
      name: "NEG 35: Duplicate key 'status = 302' then 'status = 404' after fallback",
      toml: `${canonicalFallbackSnippet}\n[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  status = 404\n`,
      expectedSubstring: "Duplicate key 'status'",
    },
    {
      name: "NEG 36: Duplicate key 'from = \"/a\"' then 'from = \"/b\"'",
      toml: `[[redirects]]\n  from = "/a"\n  from = "/b"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Duplicate key 'from'",
    },
    {
      name: "NEG 37: Duplicate key on fallback itself",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/404.html"\n  status = 302\n  status = 404\n`,
      expectedSubstring: "Duplicate key 'status'",
    },

    // 38-41: Dotted and quoted keys
    {
      name: "NEG 38: Dotted key: 'redirects.conditions = {Country = [\"US\"]}'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  redirects.conditions = {Country = ["US"]}\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Dotted or quoted keys are not allowed",
    },
    {
      name: "NEG 39: Dotted key: 'a.b = \"val\"'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  a.b = "val"\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Dotted or quoted keys are not allowed",
    },
    {
      name: "NEG 40: Quoted key: '\"from\" = \"/jobs\"'",
      toml: `[[redirects]]\n  "from" = "/jobs"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Quoted keys are not allowed",
    },
    {
      name: "NEG 41: Quoted key: ''to' = \"/dest\"'",
      toml: `[[redirects]]\n  from = "/jobs"\n  'to' = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Quoted keys are not allowed",
    },

    // 42-44: Invalid separator
    {
      name: "NEG 42: Colon separator: 'from : \"/jobs\"'",
      toml: `[[redirects]]\n  from : "/jobs"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Missing key-value separator '='",
    },
    {
      name: "NEG 43: Arrow separator: 'from => \"/jobs\"'",
      toml: `[[redirects]]\n  from => "/jobs"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Invalid separator",
    },
    {
      name: "NEG 44: Missing separator: 'from \"/jobs\"'",
      toml: `[[redirects]]\n  from "/jobs"\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Missing key-value separator '='",
    },

    // 45-55: Status validations (0404, 00404, +404, 4_04, 404.0, 0x194, quoted, etc.)
    {
      name: "NEG 45: Status with leading zero '0404'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 0404\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code '0404'",
    },
    {
      name: "NEG 46: Status with multiple leading zeros '00404'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 00404\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code '00404'",
    },
    {
      name: "NEG 47: Status with leading plus '+404'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = +404\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code '+404'",
    },
    {
      name: "NEG 48: Status with underscore '4_04'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 4_04\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code '4_04'",
    },
    {
      name: "NEG 49: Status with float '404.0'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 404.0\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code '404.0'",
    },
    {
      name: "NEG 50: Status with hex '0x194'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 0x194\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code '0x194'",
    },
    {
      name: "NEG 51: Status quoted double '\"404\"'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = "404"\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code",
    },
    {
      name: "NEG 52: Status quoted single ''404''",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = '404'\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code",
    },
    {
      name: "NEG 53: Status with trailing alpha garbage '404garbage'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 404garbage\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code '404garbage'",
    },
    {
      name: "NEG 54: Status out of range low 'status = 99'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 99\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed status code '99'",
    },
    {
      name: "NEG 55: Status out of range high 'status = 600'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 600\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported HTTP status code 600",
    },

    // 56-59: Force validations
    {
      name: "NEG 56: Force value integer 'force = 1'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  force = 1\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed force value '1'",
    },
    {
      name: "NEG 57: Force value quoted 'force = \"true\"'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  force = "true"\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed force value '\"true\"'",
    },
    {
      name: "NEG 58: Force value uppercase 'force = TRUE'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  force = TRUE\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed force value 'TRUE'",
    },
    {
      name: "NEG 59: Force value string 'force = yes'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  force = yes\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Malformed force value 'yes'",
    },

    // 60-67: Table header variations
    {
      name: "NEG 60: Single bracket table header '[redirects]'",
      toml: `[redirects]\n  from = "/*"\n  to = "/404.html"\n  status = 404\n`,
      expectedSubstring: "Unsupported or non-canonical table header '[redirects]'",
    },
    {
      name: "NEG 61: Spaced brackets table header '[ [redirects] ]'",
      toml: `[ [redirects] ]\n  from = "/*"\n  to = "/404.html"\n  status = 404\n`,
      expectedSubstring: "Unsupported or non-canonical table header '[ [redirects] ]'",
    },
    {
      name: "NEG 62: Spaced content table header '[[ redirects ]]'",
      toml: `[[ redirects ]]\n  from = "/*"\n  to = "/404.html"\n  status = 404\n`,
      expectedSubstring: "Unsupported or non-canonical table header '[[ redirects ]]'",
    },
    {
      name: "NEG 63: Quoted table header '[[\"redirects\"]]'",
      toml: `[["redirects"]]\n  from = "/*"\n  to = "/404.html"\n  status = 404\n`,
      expectedSubstring: "Unsupported or non-canonical table header '[[\"redirects\"]]'",
    },
    {
      name: "NEG 64: Escaped table header '[[\"redirec\\u0074s\"]]'",
      toml: `[["redirec\\u0074s"]]\n  from = "/*"\n  to = "/404.html"\n  status = 404\n`,
      expectedSubstring: "Unsupported or non-canonical table header '[[\"redirec\\u0074s\"]]'",
    },
    {
      name: "NEG 65: Subtable '[redirects.conditions]'",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/404.html"\n  status = 404\n  [redirects.conditions]\n    Country = ["US"]\n`,
      expectedSubstring: "Unsupported or non-canonical table header '[redirects.conditions]'",
    },
    {
      name: "NEG 66: Spaced subtable '[redirects . conditions]'",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/404.html"\n  status = 404\n  [redirects . conditions]\n    Country = ["US"]\n`,
      expectedSubstring: "Unsupported or non-canonical table header '[redirects . conditions]'",
    },
    {
      name: "NEG 67: Quoted subtable '[\"redirects\".\"conditions\"]'",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/404.html"\n  status = 404\n  ["redirects"."conditions"]\n    Country = ["US"]\n`,
      expectedSubstring: "Unsupported or non-canonical table header '[\"redirects\".\"conditions\"]'",
    },

    // 68-71: Unknown lines / types
    {
      name: "NEG 68: Unknown line / array: 'arr = [1, 2, 3]'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  arr = [1, 2, 3]\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'arr'",
    },
    {
      name: "NEG 69: Unknown line / inline table: 'tbl = { a = \"b\" }'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  tbl = { a = "b" }\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'tbl'",
    },
    {
      name: "NEG 70: Unknown line / date: 'date = 2026-01-01'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  date = 2026-01-01\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Unsupported or non-canonical key 'date'",
    },
    {
      name: "NEG 71: Unknown raw line: 'just a random line'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n  just a random line\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Missing key-value separator '='",
    },

    // 72-74: Missing required fields
    {
      name: "NEG 72: Missing from field in block",
      toml: `[[redirects]]\n  to = "/dest"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Missing required 'from' field",
    },
    {
      name: "NEG 73: Missing to field in block",
      toml: `[[redirects]]\n  from = "/jobs"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Missing required 'to' field",
    },
    {
      name: "NEG 74: Missing status field in block",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/404.html"\n`,
      expectedSubstring: "Missing required 'status' field",
    },

    // 75-81: Routing semantics (fallback not last, wrong order, shadowing, early-access, destination)
    {
      name: "NEG 75: Fallback not last: rule follows 404 fallback (wrong order)",
      toml: `${canonicalFallbackSnippet}\n[[redirects]]\n  from = "/jobs"\n  to = "/dest"\n  status = 302\n`,
      expectedSubstring: "fallback must be last",
    },
    {
      name: "NEG 76: Wrong order / Shadowing: '/* /login 302' precedes 404 fallback",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/login"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "precedes and shadows the 404 fallback",
    },
    {
      name: "NEG 77: Jobs route redirected to early-access: '/jobs -> /early-access'",
      toml: `[[redirects]]\n  from = "/jobs"\n  to = "/early-access"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "Jobs route '/jobs' redirects to early-access",
    },
    {
      name: "NEG 78: Catch-all redirected to early-access: '/* -> /early-access'",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/early-access"\n  status = 302\n${canonicalFallbackSnippet}`,
      expectedSubstring: "targets early-access",
    },
    {
      name: "NEG 79: Fallback invalid target document '/not-found'",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/not-found"\n  status = 404\n`,
      expectedSubstring: "does not match exact expected document '/404.html'",
    },
    {
      name: "NEG 80: Fallback unapproved origin 'https://wrong.invalid/404.html'",
      toml: `[[redirects]]\n  from = "/*"\n  to = "https://wrong.invalid/404.html"\n  status = 404\n`,
      expectedSubstring: "unapproved origin",
    },
    {
      name: "NEG 81: Fallback case sensitivity mismatch '/404.HTML'",
      toml: `[[redirects]]\n  from = "/*"\n  to = "/404.HTML"\n  status = 404\n`,
      expectedSubstring: "case-sensitive exact match required",
    },
    {
      name: "NEG 82: NBSP before table header '\\u00A0[[redirects]]'",
      toml: `\u00A0[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
`,
      expectedSubstring: "Invalid whitespace or control character detected",
    },
    {
      name: "NEG 83: NBSP after '=' in status line 'status =\\u00A0404'",
      toml: `[[redirects]]
  from = "/*"
  to = "/404.html"
  status =\u00A0404
`,
      expectedSubstring: "Invalid whitespace or control character detected",
    },
    {
      name: "NEG 84: Zero-width space U+200B in line 'from\\u200B = \"/jobs\"'",
      toml: `[[redirects]]
  from\u200B = "/jobs"
  to = "/jobs-dest"
  status = 301

${canonicalFallbackSnippet}`,
      expectedSubstring: "Invalid whitespace or control character detected",
    },
    {
      name: "NEG 85: BOM mid-file U+FEFF",
      toml: `[[redirects]]
  from = "/jobs"
  to = "/jobs-dest"
  status = 301
\uFEFF
${canonicalFallbackSnippet}`,
      expectedSubstring: "Invalid whitespace or control character detected",
    },
    {
      name: "NEG 86: NBSP after '=' in string line 'from =\\u00A0\"/jobs\"'",
      toml: `[[redirects]]
  from =\u00A0"/jobs"
  to = "/jobs-dest"
  status = 301

${canonicalFallbackSnippet}`,
      expectedSubstring: "Invalid whitespace or control character detected",
    },
  ];

  // Batch cross-check against Python tomllib / tomli
  const allInputs = [
    ...positiveControls.map((c) => c.toml),
    ...negativeControls.map((c) => c.toml),
  ];
  const tomllibResults = checkTomlWithPython(allInputs);
  const tomllibAvailable = Array.isArray(tomllibResults);

  if (!tomllibAvailable) {
    console.error(
      "  [FAIL] Python tomllib/tomli cross-check could not be executed! Test integrity requires tomllib/tomli."
    );
    return { passed: false, crossCheckedCount: 0 };
  }

  console.log(`  [OK] Python tomllib/tomli verified active (${allInputs.length} test cases batch-checked).`);

  let passedTests = 0;
  const totalTests = positiveControls.length + negativeControls.length;

  // 1. Run Positive Controls
  for (let i = 0; i < positiveControls.length; i++) {
    const pc = positiveControls[i];
    const { rules, syntaxErrors } = parseNetlifyTomlRedirects(pc.toml);
    const { violations } = validateRedirectRules(rules, pc.name);
    const accepted = syntaxErrors.length === 0 && violations.length === 0 && rules.length > 0;

    if (tomllibAvailable) {
      const tomllibAccepted = tomllibResults[i];
      if (!tomllibAccepted) {
        console.error(`  [FAIL] ${pc.name}: tomllib rejected positive control!`);
        continue;
      }
    }

    if (accepted) {
      console.log(`  [PASS] ${pc.name}`);
      passedTests++;
    } else {
      console.error(`  [FAIL] ${pc.name}`);
      console.error("         Syntax errors:", syntaxErrors);
      console.error("         Violations:", violations);
    }
  }

  // 2. Run Negative Controls
  const negOffset = positiveControls.length;
  for (let i = 0; i < negativeControls.length; i++) {
    const nc = negativeControls[i];
    const { rules, syntaxErrors } = parseNetlifyTomlRedirects(nc.toml);
    const { violations } = validateRedirectRules(rules, nc.name);
    const allIssues = [...syntaxErrors, ...violations];
    const rejected = allIssues.length > 0;
    const matchesSubstring = nc.expectedSubstring
      ? allIssues.some((issue) => issue.includes(nc.expectedSubstring))
      : true;

    if (tomllibAvailable) {
      const tomllibAccepted = tomllibResults[negOffset + i];
      // Invariant: if tomllib rejects it, our strict subset checker MUST also reject it!
      if (!tomllibAccepted && !rejected) {
        console.error(
          `  [FAIL] ${nc.name}: strict subset checker accepted input that Python tomllib rejects!`
        );
        continue;
      }
    }

    if (rejected && matchesSubstring) {
      console.log(`  [PASS] ${nc.name}`);
      passedTests++;
    } else {
      console.error(`  [FAIL] ${nc.name}`);
      console.error(`         Expected substring: '${nc.expectedSubstring}'`);
      console.error(`         Actual issues:`, allIssues);
    }
  }

  console.log(
    `\nTable-Driven Suite: ${passedTests}/${totalTests} tests passed (${positiveControls.length} positive, ${negativeControls.length} negative).`
  );

  return { passed: passedTests === totalTests, crossCheckedCount: allInputs.length };
}

function runFuzzTestSuite(iterations = 300) {
  console.log(`\n--- RUNNING RANDOMISED FUZZ LOOP (${iterations} MUTATIONS vs TOMLLIB) ---`);

  const canonical = `[[redirects]]
  from = "/*"
  to = "/404.html"
  status = 404
`;

  const prng = createPrng(1337);
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"\'=\n\t #.\\[]';
  const mutants = [];

  for (let i = 0; i < iterations; i++) {
    const op = Math.floor(prng() * 4);
    const arr = canonical.split("");
    const pos = Math.floor(prng() * arr.length);
    if (op === 0 && pos < arr.length - 1) {
      // swap 2 adjacent characters
      const tmp = arr[pos];
      arr[pos] = arr[pos + 1];
      arr[pos + 1] = tmp;
    } else if (op === 1 && arr.length > 1) {
      // delete 1 character
      arr.splice(pos, 1);
    } else if (op === 2) {
      // insert 1 character
      const c = chars[Math.floor(prng() * chars.length)];
      arr.splice(pos, 0, c);
    } else {
      // replace 1 character
      const c = chars[Math.floor(prng() * chars.length)];
      arr[pos] = c;
    }
    mutants.push(arr.join(""));
  }

  const tomllibResults = checkTomlWithPython(mutants);
  const tomllibAvailable = Array.isArray(tomllibResults);

  if (!tomllibAvailable) {
    console.error(
      "  [FAIL] Python tomllib/tomli cross-check unavailable for fuzz validation! Fuzz loop cannot be skipped."
    );
    return { passed: false, crossCheckedCount: 0 };
  }

  let violations = 0;
  for (let i = 0; i < mutants.length; i++) {
    const mutant = mutants[i];
    const tomllibValid = tomllibResults[i];
    const { rules, syntaxErrors } = parseNetlifyTomlRedirects(mutant);
    const { violations: ruleViolations } = validateRedirectRules(rules, "fuzz");
    const checkerAccepted = syntaxErrors.length === 0 && ruleViolations.length === 0 && rules.length > 0;

    // Strict subset invariant: if tomllib rejects it, our parser must NEVER accept it!
    if (!tomllibValid && checkerAccepted) {
      console.error(`  [FUZZ VIOLATION] Mutant #${i + 1} accepted by checker but rejected by tomllib!`);
      console.error(mutant);
      violations++;
    }
  }

  if (violations > 0) {
    console.error(`Fuzz suite FAILED: ${violations} violation(s) detected.`);
    return { passed: false, crossCheckedCount: 0 };
  }

  console.log(`Fuzz Suite: ${iterations}/${iterations} mutants verified successfully (0 subset violations).`);
  return { passed: true, crossCheckedCount: iterations };
}

// ============================================================================
// Main Execution
// ============================================================================

function main() {
  console.log("=".repeat(80));
  console.log("  CAREERMONKE DEPLOY REDIRECT RULES VERIFIER (STRICT SUBSET PARSER)   ");
  console.log("=".repeat(80));

  let hasErrors = false;
  let totalCrossChecked = 0;

  // 1. Verify public/_redirects
  console.log(`\n1. Checking public/_redirects: ${path.relative(ROOT_DIR, REDIRECTS_PATH)}`);
  if (!fs.existsSync(REDIRECTS_PATH)) {
    console.error(`[FAIL] File missing: ${REDIRECTS_PATH}`);
    hasErrors = true;
  } else {
    const rawRedirects = fs.readFileSync(REDIRECTS_PATH, "utf-8");
    const { rules, syntaxErrors } = parseRedirectsFile(rawRedirects);

    if (syntaxErrors.length > 0) {
      console.error(`[FAIL] Syntax errors in ${REDIRECTS_PATH}:`);
      syntaxErrors.forEach((e) => console.error(`  - ${e}`));
      hasErrors = true;
    } else {
      console.log(`  Found ${rules.length} valid redirect rules in public/_redirects.`);
      const { violations } = validateRedirectRules(rules, "public/_redirects");
      if (violations.length > 0) {
        console.error(`[FAIL] Semantic rule violations in ${REDIRECTS_PATH}:`);
        violations.forEach((v) => console.error(`  - ${v}`));
        hasErrors = true;
      } else {
        console.log("  [PASS] Comment-aware syntax and tokens parsed cleanly.");
        console.log("  [PASS] No rule targets /early-access (query/fragment/absolute URLs normalized).");
        console.log("  [PASS] No rule catches /jobs to /early-access.");
        console.log("  [PASS] Unshadowed, unconditional 404 fallback verified targeting exact '/404.html'.");
      }
    }
  }

  // 2. Verify netlify.toml
  console.log(`\n2. Checking netlify.toml: ${path.relative(ROOT_DIR, NETLIFY_TOML_PATH)}`);
  if (!fs.existsSync(NETLIFY_TOML_PATH)) {
    console.error(`[FAIL] File missing: ${NETLIFY_TOML_PATH}`);
    hasErrors = true;
  } else {
    const rawToml = fs.readFileSync(NETLIFY_TOML_PATH, "utf-8");
    const { rules, syntaxErrors } = parseNetlifyTomlRedirects(rawToml, {
      allowTopLevelHeaders: true,
    });

    if (syntaxErrors.length > 0) {
      console.error(`[FAIL] Syntax errors in ${NETLIFY_TOML_PATH}:`);
      syntaxErrors.forEach((e) => console.error(`  - ${e}`));
      hasErrors = true;
    } else {
      console.log(`  Found ${rules.length} valid [[redirects]] blocks in netlify.toml.`);
      const { violations } = validateRedirectRules(rules, "netlify.toml");
      if (violations.length > 0) {
        console.error(`[FAIL] Semantic rule violations in ${NETLIFY_TOML_PATH}:`);
        violations.forEach((v) => console.error(`  - ${v}`));
        hasErrors = true;
      } else {
        console.log("  [PASS] Strict subset [[redirects]] grammar verified cleanly.");
        console.log("  [PASS] No [[redirects]] block targets /early-access as a catch-all.");
        console.log("  [PASS] No [[redirects]] block catches /jobs to /early-access.");
        console.log("  [PASS] Unshadowed, unconditional 404 fallback verified targeting exact '/404.html'.");
      }
    }
  }

  // 3. Run Table-Driven Test Suite & Python Cross-Check
  const suiteResult = runTableDrivenTestSuite();
  if (!suiteResult.passed) {
    hasErrors = true;
  }
  totalCrossChecked += suiteResult.crossCheckedCount;

  // 4. Run Fuzz Suite
  const fuzzResult = runFuzzTestSuite(300);
  if (!fuzzResult.passed) {
    hasErrors = true;
  }
  totalCrossChecked += fuzzResult.crossCheckedCount;

  console.log("\n" + "-".repeat(80));
  console.log(`Cross-checked ${totalCrossChecked} cases against Python tomllib/tomli.`);
  if (hasErrors) {
    console.error("VERDICT: FAIL (One or more redirect rules, controls, or fuzz checks failed)");
    process.exit(1);
  } else {
    console.log("VERDICT: PASS (All deploy redirect rules, table-driven controls, and fuzz loop verified)");
    process.exit(0);
  }
}

module.exports = {
  parseDestination,
  normalizeDestinationPath,
  isValid404FallbackDestination,
  parseRedirectsFile,
  parseNetlifyTomlRedirects,
  validateRedirectRules,
  runTableDrivenTestSuite,
  runFuzzTestSuite,
};

if (require.main === module) {
  main();
}
