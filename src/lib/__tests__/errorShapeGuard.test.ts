import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// Guard for Backend sheet rank 72 (Uniform Error Shape): every direct
// NextResponse.json({ ... }, { status: 4xx/5xx }) literal in API routes must
// match the canonical rule or a sanctioned variant in docs/error-shape.md,
// use literal `ok: false` whenever `ok` is present, and use a string-valued
// public `error` field (and `message` field when present).
// Unresolved dynamic/helper forms are explicitly reported as `unverified`
// rather than claimed covered. Existing bodies are never rewritten by this
// guard; this is stronger static validation, not universal runtime
// normalization and not completion of the whole audit row.

const ROOT = join(__dirname, "..", "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

// Sanctioned shape key-combos (sorted, comma-joined). Mirrors docs/error-shape.md.
const CANONICAL = new Set([
  "error",
  "code,error",
  "error,retryAfter",
  "error,ok",
]);
const LEGACY = new Set([
  "Forbidden,error",
  "access,error,message",
  "access,error,jobs,message",
  "access,error,jobs,message,total",
  "code,error,isPro",
  "error,jobs",
  "error,jobs,totalCount",
  "error,parameter",
  "error,ok,retryAfter",
]);
// String-aware top-level key aliases for the documented invite-only 403 shapes
// whose `message: "Invite-only access: ..."` string previously contributed `access`
// under naive regex key scanning.
const LEGACY_TOP_LEVEL_ALIASES = new Set([
  "error,message",
  "error,jobs,message",
  "error,jobs,message,total",
]);
// Partial-content payloads (degraded job-list responses), not error bodies.
const PARTIAL_PAYLOAD = new Set([
  "degraded,hasMore,hasNextPage,jobs,nextCursor,totalCount",
  "jobs,totalCount",
]);

export interface Hit {
  file: string;
  line: number;
  keys: string;
  status: string;
}

export interface UnverifiedItem {
  file: string;
  line: number;
  status: string;
  reason: string;
}

export interface ScanAnalysis {
  hits: Hit[];
  verified: Hit[];
  unverified: UnverifiedItem[];
  violations: string[];
}

type ParsedObjectEntry =
  | { kind: "prop"; key: string; value: string }
  | { kind: "spread"; expr: string }
  | { kind: "shorthand"; key: string }
  | { kind: "computed"; raw: string }
  | { kind: "unparsed"; raw: string };

function extractStringConstants(src: string): Set<string> {
  const consts = new Set<string>();
  const re = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"])((?:\\.|(?!\2).)*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[3].trim().length > 0) {
      consts.add(m[1]);
    }
  }
  return consts;
}

function extractCallArgs(
  src: string,
  startIdx: number,
): { args: string[]; endIdx: number } | null {
  const args: string[] = [];
  let i = startIdx;
  const n = src.length;
  let argStart = i;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote: string | null = null;
  const templateBraceDepth: number[] = [];

  while (i < n) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && src[i + 1] === "{") {
        templateBraceDepth.push(depthBrace);
        depthBrace++;
        quote = null;
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i++;
      continue;
    }

    if (ch === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i++;
      continue;
    }

    if (ch === "(") depthParen++;
    else if (ch === ")") {
      if (depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
        const lastArg = src.slice(argStart, i).trim();
        if (lastArg) args.push(lastArg);
        return { args, endIdx: i + 1 };
      }
      depthParen--;
    } else if (ch === "{") {
      depthBrace++;
    } else if (ch === "}") {
      depthBrace--;
      if (
        templateBraceDepth.length > 0 &&
        depthBrace === templateBraceDepth[templateBraceDepth.length - 1]
      ) {
        templateBraceDepth.pop();
        quote = "`";
      }
    } else if (ch === "[") {
      depthBracket++;
    } else if (ch === "]") {
      depthBracket--;
    } else if (
      ch === "," &&
      depthParen === 0 &&
      depthBrace === 0 &&
      depthBracket === 0
    ) {
      args.push(src.slice(argStart, i).trim());
      argStart = i + 1;
    }
    i++;
  }
  return null;
}

function parseObjectLiteralProps(objLiteral: string): ParsedObjectEntry[] {
  const trimmed = objLiteral.trim();
  const inner = trimmed.slice(1, -1);
  const entries: ParsedObjectEntry[] = [];
  let i = 0;
  const n = inner.length;

  function skipWsAndComments(): void {
    while (i < n) {
      if (/\s/.test(inner[i])) {
        i++;
      } else if (inner[i] === "/" && inner[i + 1] === "/") {
        while (i < n && inner[i] !== "\n") i++;
      } else if (inner[i] === "/" && inner[i + 1] === "*") {
        i += 2;
        while (i < n && !(inner[i] === "*" && inner[i + 1] === "/")) i++;
        i += 2;
      } else {
        break;
      }
    }
  }

  function readUntilTopLevelComma(): string {
    const start = i;
    let depthParen = 0;
    let depthBrace = 0;
    let depthBracket = 0;
    let quote: string | null = null;
    const templateBraceDepth: number[] = [];
    while (i < n) {
      const ch = inner[i];
      if (quote) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (quote === "`" && ch === "$" && inner[i + 1] === "{") {
          templateBraceDepth.push(depthBrace);
          depthBrace++;
          quote = null;
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i++;
        continue;
      }
      if (ch === "/" && inner[i + 1] === "/") {
        while (i < n && inner[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && inner[i + 1] === "*") {
        i += 2;
        while (i < n && !(inner[i] === "*" && inner[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        i++;
        continue;
      }
      if (ch === "(") depthParen++;
      else if (ch === ")") depthParen--;
      else if (ch === "{") depthBrace++;
      else if (ch === "}") {
        depthBrace--;
        if (
          templateBraceDepth.length > 0 &&
          depthBrace === templateBraceDepth[templateBraceDepth.length - 1]
        ) {
          templateBraceDepth.pop();
          quote = "`";
        }
      } else if (ch === "[") depthBracket++;
      else if (ch === "]") depthBracket--;
      else if (
        ch === "," &&
        depthParen === 0 &&
        depthBrace === 0 &&
        depthBracket === 0
      ) {
        break;
      }
      i++;
    }
    return inner.slice(start, i).trim();
  }

  while (i < n) {
    skipWsAndComments();
    if (i >= n) break;
    if (inner[i] === ",") {
      i++;
      continue;
    }

    if (inner.startsWith("...", i)) {
      i += 3;
      const expr = readUntilTopLevelComma();
      entries.push({ kind: "spread", expr });
      if (i < n && inner[i] === ",") i++;
      continue;
    }

    if (inner[i] === "[") {
      const raw = readUntilTopLevelComma();
      entries.push({ kind: "computed", raw });
      if (i < n && inner[i] === ",") i++;
      continue;
    }

    let key: string | null = null;
    const keyStart = i;
    if (inner[i] === '"' || inner[i] === "'") {
      const q = inner[i];
      i++;
      const sStart = i;
      while (i < n && inner[i] !== q) {
        if (inner[i] === "\\") i += 2;
        else i++;
      }
      key = inner.slice(sStart, i);
      if (i < n && inner[i] === q) i++;
    } else if (/[A-Za-z_$]/.test(inner[i])) {
      while (i < n && /[A-Za-z0-9_$]/.test(inner[i])) i++;
      key = inner.slice(keyStart, i);
    }

    if (key !== null) {
      skipWsAndComments();
      if (i < n && inner[i] === ":") {
        i++;
        skipWsAndComments();
        const value = readUntilTopLevelComma();
        entries.push({ kind: "prop", key, value });
        if (i < n && inner[i] === ",") i++;
        continue;
      }
      if (i >= n || inner[i] === ",") {
        entries.push({ kind: "shorthand", key });
        if (i < n && inner[i] === ",") i++;
        continue;
      }
    }

    i = keyStart;
    const raw = readUntilTopLevelComma();
    entries.push({ kind: "unparsed", raw });
    if (i < n && inner[i] === ",") i++;
  }

  return entries;
}

type FieldCheckResult =
  | { kind: "valid_static_string" }
  | { kind: "dynamic_unverified"; reason: string }
  | { kind: "invalid"; reason: string };

function classifyErrorFieldValue(
  rawVal: string,
  stringConstants: Set<string>,
): FieldCheckResult {
  const val = rawVal.trim();
  if (!val) {
    return { kind: "invalid", reason: "empty error value expression" };
  }

  // 1. Single- or double-quoted string literal
  if (
    (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
    (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
  ) {
    const q = val[0];
    let i = 1;
    while (i < val.length - 1) {
      if (val[i] === "\\") {
        i += 2;
        continue;
      }
      if (val[i] === q) break;
      i++;
    }
    if (i === val.length - 1) {
      const inner = val.slice(1, -1).trim();
      if (inner.length === 0) {
        return { kind: "invalid", reason: `empty string literal ${val}` };
      }
      return { kind: "valid_static_string" };
    }
  }

  // 2. Template literal
  if (val.startsWith("`") && val.endsWith("`") && val.length >= 2) {
    const inner = val.slice(1, -1);
    if (inner.trim().length === 0) {
      return { kind: "invalid", reason: "empty template literal" };
    }
    if (!inner.includes("${")) {
      return { kind: "valid_static_string" };
    }
    const stripped = inner.replace(/\$\{[^}]*\}/g, "").trim();
    if (stripped.length > 0) {
      return {
        kind: "dynamic_unverified",
        reason: `template literal with runtime interpolation (${val})`,
      };
    }
    return {
      kind: "invalid",
      reason: `template literal without static message text (${val})`,
    };
  }

  // 3. Identifier: boolean/null/undefined/NaN vs same-file string constant vs bare identifier
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(val)) {
    if (val === "true" || val === "false") {
      return { kind: "invalid", reason: `non-string boolean literal '${val}'` };
    }
    if (val === "null" || val === "undefined" || val === "NaN") {
      return { kind: "invalid", reason: `non-string '${val}' literal` };
    }
    if (stringConstants.has(val)) {
      return { kind: "valid_static_string" };
    }
    return {
      kind: "invalid",
      reason: `bare identifier '${val}' is not a static string literal`,
    };
  }

  // 4. Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(val)) {
    return { kind: "invalid", reason: `non-string numeric literal '${val}'` };
  }

  // 5. Object or array literal
  if (val.startsWith("{")) {
    return { kind: "invalid", reason: `non-string object literal '${val}'` };
  }
  if (val.startsWith("[")) {
    return { kind: "invalid", reason: `non-string array literal '${val}'` };
  }

  // 6. Existing dynamic member fallback: <chain>.(error|message) || "<non-empty string>"
  const fallbackMatch = val.match(
    /^([A-Za-z_$][A-Za-z0-9_$]*(?:\?\.[A-Za-z_$][A-Za-z0-9_$]*|\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\?\.|\.)(?:error|message))\s*\|\|\s*(['"])((?:\\.|(?!\2).)*)\2$/,
  );
  if (fallbackMatch) {
    if (fallbackMatch[3].trim().length === 0) {
      return {
        kind: "invalid",
        reason: `empty fallback string literal in '${val}'`,
      };
    }
    return {
      kind: "dynamic_unverified",
      reason: `dynamic member fallback '${fallbackMatch[1]}' cannot be statically proven string-valued`,
    };
  }

  // 7. Existing bare .message on error objects: (err|error|creditErr|subError).message
  if (/^(?:err|error|creditErr|subError)\.message$/.test(val)) {
    return {
      kind: "dynamic_unverified",
      reason: `dynamic member '${val}' cannot be statically proven safe/string-valued`,
    };
  }

  return {
    kind: "invalid",
    reason: `non-string or unanalyzable error expression '${val}'`,
  };
}

export function analyzeSource(
  src: string,
  fileLabel = "fixture.ts",
): ScanAnalysis {
  const stringConstants = extractStringConstants(src);
  const hits: Hit[] = [];
  const verified: Hit[] = [];
  const unverified: UnverifiedItem[] = [];
  const violations: string[] = [];

  const callRe = /NextResponse\.json\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) {
    const line = src.slice(0, m.index).split("\n").length;
    const parsed = extractCallArgs(src, m.index + m[0].length);
    if (!parsed) {
      violations.push(
        `${fileLabel}:${line} (unknown) malformed NextResponse.json call syntax`,
      );
      unverified.push({
        file: fileLabel,
        line,
        status: "unknown",
        reason: "malformed NextResponse.json call syntax",
      });
      continue;
    }
    if (parsed.args.length < 2) continue;

    const [bodyArg, optionsArg] = parsed.args;
    if (!optionsArg.startsWith("{") || !optionsArg.endsWith("}")) {
      unverified.push({
        file: fileLabel,
        line,
        status: "dynamic",
        reason: `non-literal options argument '${optionsArg}'`,
      });
      continue;
    }

    const optProps = parseObjectLiteralProps(optionsArg);
    const statusProp = optProps.find(
      (p): p is Extract<ParsedObjectEntry, { kind: "prop" }> =>
        p.kind === "prop" && p.key === "status",
    );
    const statusShorthand = optProps.find(
      (p) => p.kind === "shorthand" && p.key === "status",
    );
    if (statusShorthand) {
      unverified.push({
        file: fileLabel,
        line,
        status: "status",
        reason: "shorthand dynamic status property",
      });
      continue;
    }
    if (!statusProp) continue;

    const statusVal = statusProp.value.trim();
    if (/^(2\d\d|3\d\d)$/.test(statusVal)) continue;

    if (!/^(4\d\d|5\d\d)$/.test(statusVal)) {
      unverified.push({
        file: fileLabel,
        line,
        status: statusVal,
        reason: `dynamic status expression '${statusVal}'`,
      });
      continue;
    }

    const status = statusVal;
    if (!bodyArg.startsWith("{") || !bodyArg.endsWith("}")) {
      unverified.push({
        file: fileLabel,
        line,
        status,
        reason: `non-literal response body '${bodyArg}'`,
      });
      continue;
    }

    const entries = parseObjectLiteralProps(bodyArg);
    const propEntries = entries.filter(
      (e): e is Extract<ParsedObjectEntry, { kind: "prop" }> =>
        e.kind === "prop",
    );
    const nonPropEntries = entries.filter((e) => e.kind !== "prop");
    const keys = propEntries
      .map((p) => p.key)
      .sort()
      .join(",");

    hits.push({ file: fileLabel, line, keys, status });

    if (nonPropEntries.length > 0) {
      const onlySpread = nonPropEntries.every((e) => e.kind === "spread");
      if (onlySpread && PARTIAL_PAYLOAD.has(keys)) {
        unverified.push({
          file: fileLabel,
          line,
          status,
          reason: `spread '${nonPropEntries
            .map((e) => (e.kind === "spread" ? "..." + e.expr : ""))
            .join(", ")}' in partial-content payload`,
        });
        continue;
      }
      const desc = nonPropEntries
        .map((e) =>
          e.kind === "spread"
            ? `spread '...${e.expr}'`
            : e.kind === "shorthand"
              ? `shorthand '${e.key}'`
              : e.kind === "computed"
                ? `computed '${e.raw}'`
                : `unparsed '${e.raw}'`,
        )
        .join(", ");
      violations.push(
        `${fileLabel}:${line} (${status}) unanalyzable object literal syntax: ${desc}`,
      );
      unverified.push({
        file: fileLabel,
        line,
        status,
        reason: `unanalyzable object literal syntax: ${desc}`,
      });
      continue;
    }

    const seenKeys = new Set<string>();
    let hasDuplicateKey = false;
    for (let i = 0; i < propEntries.length; i++) {
      const p = propEntries[i];
      if (seenKeys.has(p.key)) {
        violations.push(
          `${fileLabel}:${line} (${status}) duplicate property key '${p.key}'`,
        );
        hasDuplicateKey = true;
      }
      seenKeys.add(p.key);
    }
    if (hasDuplicateKey) continue;

    const isCanonical = CANONICAL.has(keys);
    const isLegacy = LEGACY.has(keys) || LEGACY_TOP_LEVEL_ALIASES.has(keys);
    const isPartial = PARTIAL_PAYLOAD.has(keys);

    if (!isCanonical && !isLegacy && !isPartial) {
      violations.push(`${fileLabel}:${line} (${status}) keys=[${keys}]`);
      continue;
    }

    if (isPartial) {
      verified.push({ file: fileLabel, line, keys, status });
      continue;
    }

    let hitHasViolation = false;
    let hitUnverifiedReason: string | null = null;

    const okProp = propEntries.find((p) => p.key === "ok");
    if (okProp && okProp.value !== "false") {
      violations.push(
        `${fileLabel}:${line} (${status}) invalid ok value: expected literal false, got ${okProp.value}`,
      );
      hitHasViolation = true;
    }

    const errorProp = propEntries.find((p) => p.key === "error");
    if (!errorProp) {
      violations.push(
        `${fileLabel}:${line} (${status}) missing required error key in keys=[${keys}]`,
      );
      hitHasViolation = true;
    } else {
      const errCheck = classifyErrorFieldValue(
        errorProp.value,
        stringConstants,
      );
      if (errCheck.kind === "invalid") {
        violations.push(
          `${fileLabel}:${line} (${status}) invalid error value: ${errCheck.reason}`,
        );
        hitHasViolation = true;
      } else if (errCheck.kind === "dynamic_unverified") {
        hitUnverifiedReason = errCheck.reason;
      }
    }

    const messageProp = propEntries.find((p) => p.key === "message");
    if (messageProp) {
      const msgCheck = classifyErrorFieldValue(
        messageProp.value,
        stringConstants,
      );
      if (msgCheck.kind === "invalid") {
        violations.push(
          `${fileLabel}:${line} (${status}) invalid message value: ${msgCheck.reason}`,
        );
        hitHasViolation = true;
      } else if (msgCheck.kind === "dynamic_unverified" && !hitUnverifiedReason) {
        hitUnverifiedReason = msgCheck.reason;
      }
    }

    if (hitHasViolation) continue;

    if (hitUnverifiedReason) {
      unverified.push({
        file: fileLabel,
        line,
        status,
        reason: hitUnverifiedReason,
      });
    } else {
      verified.push({ file: fileLabel, line, keys, status });
    }
  }

  return { hits, verified, unverified, violations };
}

function analyzeFile(file: string): ScanAnalysis {
  const rel = relative(ROOT, file).split("\\").join("/");
  const src = readFileSync(file, "utf8");
  return analyzeSource(src, rel);
}

describe("uniform error shape guard (Backend sheet rank 72)", () => {
  it("every error-body literal matches the canonical rule or a sanctioned variant, with ok=false and string-valued error fields", () => {
    const bad: string[] = [];
    walk(join(ROOT, "src", "app", "api")).forEach((file) => {
      const res = analyzeFile(file);
      bad.push(...res.violations);
    });
    expect(
      bad,
      `error-shape guard violation(s):\n${bad.join("\n")}\n` +
        `use { error: "<non-empty string>" } (+ sanctioned extras with literal ok: false) or record a variant in docs/error-shape.md and this allowlist`,
    ).toEqual([]);
  });

  it("finds the documented baseline and reports unresolved dynamic/helper forms as unverified", () => {
    let totalHits = 0;
    let totalVerified = 0;
    const allUnverified: UnverifiedItem[] = [];

    walk(join(ROOT, "src", "app", "api")).forEach((file) => {
      const res = analyzeFile(file);
      totalHits += res.hits.length;
      totalVerified += res.verified.length;
      allUnverified.push(...res.unverified);
    });

    // 115+ direct literals following retirement of /api/early-access and invite-only gates.
    // At least 90 are fully statically verified (static string error + ok: false where present).
    expect(totalHits).toBeGreaterThanOrEqual(115);
    expect(totalVerified).toBeGreaterThanOrEqual(90);

    // Unresolved dynamic/helper/spread forms are surfaced as unverified, never claimed in verified.
    expect(allUnverified.length).toBeGreaterThan(0);
    allUnverified.forEach((item) => {
      expect(item.file).toMatch(/^src\/app\/api\/.+\/route\.tsx?$/);
      expect(item.line).toBeGreaterThan(0);
      expect(item.reason.length).toBeGreaterThan(0);
    });
  });

  it("the doc records every sanctioned variant and documents static validation boundaries", () => {
    const doc = readFileSync(join(ROOT, "docs", "error-shape.md"), "utf8");
    const docOrder = [
      "error, Forbidden",
      "error, message, access",
      "error, message, access, jobs",
      "error, message, access, jobs, total",
      "error, isPro, code",
      "error, jobs",
      "error, jobs, totalCount",
      "error, parameter",
      "ok, error, retryAfter",
    ];
    expect(docOrder.length).toBe(LEGACY.size);
    docOrder.forEach((human) => {
      expect(doc.includes(human), `${human} missing from docs/error-shape.md`).toBe(true);
    });
    expect(doc).toContain("ok: false");
    expect(doc).toContain("unverified");
  });

  describe("offline positive and negative fixtures", () => {
    it("accepts all documented canonical, legacy, and partial-payload variants with valid ok=false and string error values", () => {
      const fixture = `
        const GENERIC_TRY_AGAIN_MESSAGE = "Something went wrong. Please try again.";
        export function demo() {
          // Canonical variants
          NextResponse.json({ error: "Unauthorized" }, { status: 401 });
          NextResponse.json({ error: 'Supabase credentials not configured' }, { status: 500 });
          NextResponse.json({ error: \`Service temporarily unavailable\` }, { status: 503 });
          NextResponse.json({ error: "Billing is currently unavailable", code: "BILLING_DISABLED" }, { status: 503 });
          NextResponse.json({ error: "Rate limit exceeded.", retryAfter: 60 }, { status: 429 });
          NextResponse.json({ ok: false, error: "Invalid request payload." }, { status: 400 });
          NextResponse.json({ ok: false, error: GENERIC_TRY_AGAIN_MESSAGE }, { status: 500 });

          // Sanctioned legacy variants (and colon-in-string forms)
          NextResponse.json({ error: "Forbidden: Admin access only." }, { status: 403 });
          NextResponse.json({ error: "Forbidden", Forbidden: true }, { status: 403 });
          NextResponse.json({ error: "Early access only", message: "Invite-only access: your account is pending approval." }, { status: 403 });
          NextResponse.json({ error: "Early access only", message: "Pending approval", access: "invite_only" }, { status: 403 });
          NextResponse.json({ error: "Early access only", message: "Pending approval", access: "invite_only", jobs: [] }, { status: 403 });
          NextResponse.json({ error: "Early access only", message: "Pending approval", access: "invite_only", jobs: [], total: 0 }, { status: 403 });
          NextResponse.json({ error: "Pro required", isPro: false, code: "PRO_REQUIRED" }, { status: 403 });
          NextResponse.json({ error: "Missing candidate profile.", jobs: [] }, { status: 400 });
          NextResponse.json({ error: "Internal server error", jobs: [], totalCount: 0 }, { status: 500 });
          NextResponse.json({ error: "Missing required query parameter: id" }, { status: 400 });
          NextResponse.json({ error: "Invalid parameter", parameter: "id" }, { status: 400 });
          NextResponse.json({ ok: false, error: "Too many attempts.", retryAfter: 30 }, { status: 429 });

          // Documented partial-content payloads (not error bodies)
          NextResponse.json({ degraded: true, jobs: [], totalCount: 0, hasNextPage: false, hasMore: false, nextCursor: null }, { status: 503 });
          NextResponse.json({ jobs: [], totalCount: 0 }, { status: 500 });

          // 2xx responses are ignored
          NextResponse.json({ ok: true, data: [] }, { status: 200 });
          NextResponse.json({ ok: true });
        }
      `;
      const res = analyzeSource(fixture, "positive-fixture.ts");
      expect(res.violations).toEqual([]);
      expect(res.unverified).toEqual([]);
      expect(res.verified.length).toBe(21);
    });

    it("rejects unlisted key combinations with file:line diagnostics", () => {
      const fixture = [
        'NextResponse.json({ error: "Bad request", unexpectedKey: true }, { status: 400 });',
        'NextResponse.json({ message: "Missing error key" }, { status: 500 });',
      ].join("\n");

      const res = analyzeSource(fixture, "unlisted-keys.ts");
      expect(res.verified).toEqual([]);
      expect(res.violations).toEqual([
        "unlisted-keys.ts:1 (400) keys=[error,unexpectedKey]",
        "unlisted-keys.ts:2 (500) keys=[message]",
      ]);
    });

    it("rejects invalid ok values (non-false literals and dynamic ok expressions) with file:line diagnostics", () => {
      const fixture = [
        'NextResponse.json({ ok: true, error: "Should not be ok: true" }, { status: 400 });',
        'NextResponse.json({ ok: "false", error: "String false is invalid" }, { status: 400 });',
        'NextResponse.json({ ok: 0, error: "Number zero is invalid" }, { status: 400 });',
        'NextResponse.json({ ok: 1, error: "Rate limited", retryAfter: 30 }, { status: 429 });',
        'NextResponse.json({ ok: null, error: "Null ok is invalid" }, { status: 500 });',
        'NextResponse.json({ ok: undefined, error: "Undefined ok is invalid" }, { status: 500 });',
        'NextResponse.json({ ok: isOk, error: "Dynamic ok is invalid" }, { status: 500 });',
        'NextResponse.json({ ok: true, error: err?.message || "Fallback" }, { status: 500 });',
      ].join("\n");

      const res = analyzeSource(fixture, "invalid-ok.ts");
      expect(res.verified).toEqual([]);
      expect(res.violations).toEqual([
        "invalid-ok.ts:1 (400) invalid ok value: expected literal false, got true",
        'invalid-ok.ts:2 (400) invalid ok value: expected literal false, got "false"',
        "invalid-ok.ts:3 (400) invalid ok value: expected literal false, got 0",
        "invalid-ok.ts:4 (429) invalid ok value: expected literal false, got 1",
        "invalid-ok.ts:5 (500) invalid ok value: expected literal false, got null",
        "invalid-ok.ts:6 (500) invalid ok value: expected literal false, got undefined",
        "invalid-ok.ts:7 (500) invalid ok value: expected literal false, got isOk",
        "invalid-ok.ts:8 (500) invalid ok value: expected literal false, got true",
      ]);
    });

    it("rejects non-string, empty-string, and raw-object error/message values with file:line diagnostics", () => {
      const fixture = [
        "NextResponse.json({ error: 500 }, { status: 500 });",
        "NextResponse.json({ error: false }, { status: 400 });",
        "NextResponse.json({ error: true }, { status: 400 });",
        "NextResponse.json({ error: null }, { status: 500 });",
        "NextResponse.json({ error: undefined }, { status: 500 });",
        'NextResponse.json({ error: { message: "nested object" } }, { status: 500 });',
        'NextResponse.json({ error: ["array error"] }, { status: 400 });',
        'NextResponse.json({ error: "" }, { status: 400 });',
        'NextResponse.json({ error: "   " }, { status: 400 });',
        "NextResponse.json({ error: `   ` }, { status: 400 });",
        "NextResponse.json({ error: err }, { status: 500 });",
        "NextResponse.json({ error: err.stack }, { status: 500 });",
        "NextResponse.json({ error: err.code }, { status: 500 });",
        "NextResponse.json({ error: err?.message || 500 }, { status: 500 });",
        'NextResponse.json({ error: err?.message || "" }, { status: 500 });',
        'NextResponse.json({ error: err || "Fallback" }, { status: 500 });',
        'NextResponse.json({ error: "Early access only", message: 123, access: "denied" }, { status: 403 });',
      ].join("\n");

      const res = analyzeSource(fixture, "invalid-error-type.ts");
      expect(res.verified).toEqual([]);
      expect(res.violations).toEqual([
        "invalid-error-type.ts:1 (500) invalid error value: non-string numeric literal '500'",
        "invalid-error-type.ts:2 (400) invalid error value: non-string boolean literal 'false'",
        "invalid-error-type.ts:3 (400) invalid error value: non-string boolean literal 'true'",
        "invalid-error-type.ts:4 (500) invalid error value: non-string 'null' literal",
        "invalid-error-type.ts:5 (500) invalid error value: non-string 'undefined' literal",
        'invalid-error-type.ts:6 (500) invalid error value: non-string object literal \'{ message: "nested object" }\'',
        'invalid-error-type.ts:7 (400) invalid error value: non-string array literal \'["array error"]\'',
        'invalid-error-type.ts:8 (400) invalid error value: empty string literal ""',
        'invalid-error-type.ts:9 (400) invalid error value: empty string literal "   "',
        "invalid-error-type.ts:10 (400) invalid error value: empty template literal",
        "invalid-error-type.ts:11 (500) invalid error value: bare identifier 'err' is not a static string literal",
        "invalid-error-type.ts:12 (500) invalid error value: non-string or unanalyzable error expression 'err.stack'",
        "invalid-error-type.ts:13 (500) invalid error value: non-string or unanalyzable error expression 'err.code'",
        "invalid-error-type.ts:14 (500) invalid error value: non-string or unanalyzable error expression 'err?.message || 500'",
        'invalid-error-type.ts:15 (500) invalid error value: empty fallback string literal in \'err?.message || ""\'',
        'invalid-error-type.ts:16 (500) invalid error value: non-string or unanalyzable error expression \'err || "Fallback"\'',
        "invalid-error-type.ts:17 (403) invalid message value: non-string numeric literal '123'",
      ]);
    });

    it("rejects syntax inside error literals that the scanner cannot safely analyze and marks it unverified", () => {
      const fixture = [
        'NextResponse.json({ ...extra, error: "Spread in error body" }, { status: 400 });',
        "NextResponse.json({ error }, { status: 500 });",
        'NextResponse.json({ ok, error: "Shorthand ok" }, { status: 400 });',
        'NextResponse.json({ [dynamicKey]: "Bad request" }, { status: 400 });',
        'NextResponse.json({ get error() { return "Bad"; } }, { status: 500 });',
        'NextResponse.json({ error: formatError(err) }, { status: 500 });',
        'NextResponse.json({ error: "First", error: "Duplicate" }, { status: 400 });',
      ].join("\n");

      const res = analyzeSource(fixture, "unanalyzable-syntax.ts");
      expect(res.verified).toEqual([]);
      expect(res.violations).toEqual([
        "unanalyzable-syntax.ts:1 (400) unanalyzable object literal syntax: spread '...extra'",
        "unanalyzable-syntax.ts:2 (500) unanalyzable object literal syntax: shorthand 'error'",
        "unanalyzable-syntax.ts:3 (400) unanalyzable object literal syntax: shorthand 'ok'",
        "unanalyzable-syntax.ts:4 (400) unanalyzable object literal syntax: computed '[dynamicKey]: \"Bad request\"'",
        "unanalyzable-syntax.ts:5 (500) unanalyzable object literal syntax: unparsed 'get error() { return \"Bad\"; }'",
        "unanalyzable-syntax.ts:6 (500) invalid error value: non-string or unanalyzable error expression 'formatError(err)'",
        "unanalyzable-syntax.ts:7 (400) duplicate property key 'error'",
      ]);
      // Unanalyzable object syntax entries are also surfaced in unverified and never counted in verified
      expect(res.unverified.map((u) => `${u.file}:${u.line}`)).toEqual([
        "unanalyzable-syntax.ts:1",
        "unanalyzable-syntax.ts:2",
        "unanalyzable-syntax.ts:3",
        "unanalyzable-syntax.ts:4",
        "unanalyzable-syntax.ts:5",
      ]);
    });

    it("reports unresolved dynamic/helper forms as unverified rather than claiming them covered", () => {
      const fixture = [
        "NextResponse.json(parsed, { status: 500 });",
        'NextResponse.json(buildErrorPayload("bad"), { status: 400 });',
        'NextResponse.json({ error: "Unauthorized" }, { status: authCheck.status });',
        'NextResponse.json({ error: "Unavailable" }, { status: isDown ? 503 : 403 });',
        'NextResponse.json({ error: "Custom init" }, responseInit);',
        "NextResponse.json({ ...parsed, jobs: [], totalCount: 0 }, { status: 500 });",
        'NextResponse.json({ error: err?.message || "Internal server error" }, { status: 500 });',
        "NextResponse.json({ error: err.message }, { status: 500 });",
      ].join("\n");

      const res = analyzeSource(fixture, "unverified-dynamic.ts");
      // None of these may be claimed as statically verified
      expect(res.verified).toEqual([]);
      expect(res.violations).toEqual([]);
      expect(res.unverified).toEqual([
        {
          file: "unverified-dynamic.ts",
          line: 1,
          status: "500",
          reason: "non-literal response body 'parsed'",
        },
        {
          file: "unverified-dynamic.ts",
          line: 2,
          status: "400",
          reason: "non-literal response body 'buildErrorPayload(\"bad\")'",
        },
        {
          file: "unverified-dynamic.ts",
          line: 3,
          status: "authCheck.status",
          reason: "dynamic status expression 'authCheck.status'",
        },
        {
          file: "unverified-dynamic.ts",
          line: 4,
          status: "isDown ? 503 : 403",
          reason: "dynamic status expression 'isDown ? 503 : 403'",
        },
        {
          file: "unverified-dynamic.ts",
          line: 5,
          status: "dynamic",
          reason: "non-literal options argument 'responseInit'",
        },
        {
          file: "unverified-dynamic.ts",
          line: 6,
          status: "500",
          reason: "spread '...parsed' in partial-content payload",
        },
        {
          file: "unverified-dynamic.ts",
          line: 7,
          status: "500",
          reason: "dynamic member fallback 'err?.message' cannot be statically proven string-valued",
        },
        {
          file: "unverified-dynamic.ts",
          line: 8,
          status: "500",
          reason: "dynamic member 'err.message' cannot be statically proven safe/string-valued",
        },
      ]);
    });
  });
});
