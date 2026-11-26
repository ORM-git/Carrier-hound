/**
 * Static route-resolution audit: checks internal navigation targets in source
 * against the Next.js app tree, public/ files and Netlify redirect rules on disk.
 * It never makes a network request. A resolved link means a matching file or a
 * redirect chain ending in one exists, not that the page loads, authorises
 * correctly or works live.
 */
import fs from "fs";
import path from "path";
import ts from "typescript";

export type Segment =
  | { kind: "static"; value: string }
  | { kind: "dynamic" }
  | { kind: "catchAll" }
  | { kind: "optionalCatchAll" };

export interface RoutePattern {
  pattern: string;
  segments: Segment[];
  source: string;
}

type RuleSegment = { kind: "static"; value: string } | { kind: "param"; name: string } | { kind: "splat" };

export interface HostRule {
  from: string;
  to: string;
  status: number;
  force: boolean;
  /** Set when the rule depends on request conditions (country, role, query, signed...) or uses unmodelled syntax. */
  unmodelled: string | null;
  segments: RuleSegment[];
  source: string;
}

/**
 * page/asset: resolves directly. alias: a redirect/rewrite chain ends at a page or asset.
 * external: off-site link or redirect (not verified). dynamic: expression, not resolvable statically.
 * unresolved: a conditional or unmodelled rule applies, so no verdict. invalid: confirmed not resolvable.
 */
export type LinkStatus = "page" | "alias" | "asset" | "external" | "dynamic" | "unresolved" | "invalid";

export interface Resolution {
  status: LinkStatus;
  reason: string;
}

export interface LinkFinding extends Resolution {
  file: string;
  line: number;
  raw: string;
}

export interface AuditResult {
  routes: RoutePattern[];
  rules: HostRule[];
  boundaries: string[];
  findings: LinkFinding[];
  scannedFiles: number;
  skippedTestFiles: number;
}

const ENTRY_FILE = /^(page|route)\.(tsx|ts|jsx|js|mdx)$/;
// Next metadata files that serve fixed URLs without a page/route file.
const METADATA_FILES: Record<string, string> = {
  "robots.ts": "/robots.txt",
  "sitemap.ts": "/sitemap.xml",
  "manifest.ts": "/manifest.webmanifest",
};
const SOURCE_EXT = /\.(tsx|ts|jsx|js)$/;
const TEST_FILE = /(^|[\\/])(__tests__|__fixtures__|__mocks__)[\\/]|\.(test|spec)\.(tsx?|jsx?)$/;
const EXTERNAL = /^(mailto:|tel:|sms:|[a-z][a-z0-9+.-]*:\/\/|\/\/)/i;
const REDIRECT_STATUSES = new Set([200, 301, 302, 303, 307, 308]);
const MAX_CHAIN = 10;

function rel(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function parseAppSegment(name: string): Segment | null | "skip" {
  if (/^\(.*\)$/.test(name)) return null; // route group: no URL segment
  if (name.startsWith("@") || name.startsWith("_")) return "skip"; // parallel slot / private folder
  if (/^\[\[\.\.\..+\]\]$/.test(name)) return { kind: "optionalCatchAll" };
  if (/^\[\.\.\..+\]$/.test(name)) return { kind: "catchAll" };
  if (/^\[.+\]$/.test(name)) return { kind: "dynamic" };
  return { kind: "static", value: name };
}

function toPattern(segments: Segment[]): string {
  const parts = segments.map((s) =>
    s.kind === "static" ? s.value : s.kind === "dynamic" ? "[param]" : s.kind === "catchAll" ? "[...rest]" : "[[...rest]]",
  );
  return "/" + parts.join("/");
}

/** Page and route-handler URL patterns derived from the files under appDir. */
export function collectAppRoutes(root: string, appDir: string, boundaries: string[]): RoutePattern[] {
  const routes: RoutePattern[] = [];
  for (const file of walk(appDir)) {
    const base = path.basename(file);
    const dirs = path.relative(appDir, path.dirname(file)).split(path.sep).filter(Boolean);
    if (dirs.some((d) => d.startsWith("(."))) {
      boundaries.push(`intercepting route not modelled: ${rel(root, file)}`);
      continue;
    }
    const segments: Segment[] = [];
    let skip = false;
    for (const d of dirs) {
      const seg = parseAppSegment(d);
      if (seg === "skip") skip = true;
      else if (seg) segments.push(seg);
    }
    if (skip) continue;
    if (ENTRY_FILE.test(base)) {
      routes.push({ pattern: toPattern(segments), segments, source: rel(root, file) });
    } else if (dirs.length === 0 && METADATA_FILES[base]) {
      const url = METADATA_FILES[base];
      routes.push({ pattern: url, segments: [{ kind: "static", value: url.slice(1) }], source: rel(root, file) });
    }
  }
  return routes;
}

function ruleSegments(from: string): { segments: RuleSegment[]; unsupported: string | null } {
  const parts = from.split("/").filter(Boolean);
  const segments = parts.map((p): RuleSegment =>
    p === "*" ? { kind: "splat" } : p.startsWith(":") ? { kind: "param", name: p.slice(1) } : { kind: "static", value: p },
  );
  const splatAt = parts.indexOf("*");
  return { segments, unsupported: splatAt >= 0 && splatAt < parts.length - 1 ? "mid-path splat" : null };
}

function makeRule(from: string, to: string, status: number, force: boolean, condition: string | null, source: string): HostRule {
  const { segments, unsupported } = ruleSegments(from);
  return { from, to, status, force, unmodelled: condition ?? unsupported, segments, source };
}

/** netlify.toml [[redirects]] blocks, read as text (never executed). */
function parseNetlifyToml(text: string): HostRule[] {
  const rules: HostRule[] = [];
  for (const block of text.split(/^\s*\[\[redirects\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\s*\[\[/m)[0];
    const from = body.match(/^\s*from\s*=\s*"([^"]+)"/m)?.[1];
    const to = body.match(/^\s*to\s*=\s*"([^"]+)"/m)?.[1];
    if (!from || !to) continue;
    const status = Number(body.match(/^\s*status\s*=\s*(\d+)/m)?.[1] ?? 301);
    const force = /^\s*force\s*=\s*true\b/m.test(body);
    const cond = body.match(/^\s*(conditions|query|signed|headers)\s*=|^\s*\[redirects\.(conditions|query|headers)\]/m);
    rules.push(makeRule(from, to, status, force, cond ? `condition '${cond[1] ?? cond[2]}'` : null, "netlify.toml"));
  }
  return rules;
}

/** public/_redirects lines: `from [query=:p ...] to [status][!] [Condition=value ...]`. */
function parseUnderscoreRedirects(text: string): HostRule[] {
  const rules: HostRule[] = [];
  for (const raw of text.split("\n")) {
    const tokens = raw.replace(/#.*/, "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const [from, ...rest] = tokens;
    const toAt = rest.findIndex((t) => !t.includes("="));
    if (toAt < 0) continue;
    const to = rest[toAt];
    const after = rest.slice(toAt + 1);
    const statusToken = after.find((t) => /^\d{3}!?$/.test(t));
    const conditions = [...rest.slice(0, toAt), ...after.filter((t) => t !== statusToken)];
    rules.push(
      makeRule(
        from,
        to,
        Number(statusToken?.replace("!", "") ?? 301),
        statusToken?.endsWith("!") ?? false,
        conditions.length > 0 ? `condition '${conditions.join(" ")}'` : null,
        "public/_redirects",
      ),
    );
  }
  return rules;
}

/**
 * Netlify rules in evaluation order: public/_redirects first, then netlify.toml; first match wins.
 * Rules whose `from` is a full domain URL never apply to an internal path and are reported as boundaries.
 */
export function collectHostRules(root: string, boundaries: string[]): HostRule[] {
  const rules: HostRule[] = [];
  const underscore = path.join(root, "public", "_redirects");
  if (fs.existsSync(underscore)) rules.push(...parseUnderscoreRedirects(fs.readFileSync(underscore, "utf8")));
  const toml = path.join(root, "netlify.toml");
  if (fs.existsSync(toml)) rules.push(...parseNetlifyToml(fs.readFileSync(toml, "utf8")));
  for (const r of rules) {
    if (r.unmodelled) boundaries.push(`${r.source}: ${r.from} -> ${r.to} not modelled (${r.unmodelled}); matching links are unresolved`);
  }
  const internal = rules.filter((r) => r.from.startsWith("/"));
  rules.filter((r) => !r.from.startsWith("/")).forEach((r) => boundaries.push(`${r.source}: domain rule ${r.from} ignored`));
  for (const name of ["src/middleware.ts", "middleware.ts"]) {
    if (fs.existsSync(path.join(root, name))) boundaries.push(`${name} runtime redirects (auth/returnTo) are not evaluated`);
  }
  for (const name of ["next.config.mjs", "next.config.js", "next.config.ts"]) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && /\b(redirects|rewrites)\s*[:(]/.test(fs.readFileSync(file, "utf8"))) {
      boundaries.push(`${name} declares redirects/rewrites; not executed, so its aliases are not applied`);
    }
  }
  return internal;
}

export function matchSegments(segments: Segment[], parts: string[]): boolean {
  if (segments.length === 0) return parts.length === 0;
  const [head, ...rest] = segments;
  if (head.kind === "catchAll") return parts.length >= 1;
  if (head.kind === "optionalCatchAll") return true;
  if (parts.length === 0) return false;
  if (head.kind === "static" && head.value !== parts[0]) return false;
  return matchSegments(rest, parts.slice(1));
}

// shortcut: a trailing `*` must match at least one segment; Netlify edge cases (e.g. bare prefix) are not modelled.
function matchRule(segments: RuleSegment[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === "splat") {
      if (i === segments.length - 1) {
        if (parts.length <= i) return null;
        params.splat = parts.slice(i).join("/");
        return params;
      }
      if (parts[i] === undefined) return null; // mid-path splat: one segment, rule is flagged unmodelled anyway
      continue;
    }
    if (parts[i] === undefined) return null;
    if (seg.kind === "static" && seg.value !== parts[i]) return null;
    if (seg.kind === "param") params[seg.name] = parts[i];
  }
  return parts.length === segments.length ? params : null;
}

/** Path without query/hash or trailing slash, split into decoded segments. */
export function pathParts(target: string): string[] {
  const clean = target.split(/[?#]/)[0];
  return clean.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
}

export interface ResolveContext {
  root: string;
  routes: RoutePattern[];
  rules: HostRule[];
}

function directMatch(parts: string[], ctx: ResolveContext): "page" | "asset" | null {
  if (ctx.routes.some((r) => matchSegments(r.segments, parts))) return "page";
  // Static export writes each page as <route>.html (index.html for /).
  const last = parts[parts.length - 1];
  if (last?.endsWith(".html")) {
    const stem = last.slice(0, -5);
    const htmlParts = stem === "index" ? parts.slice(0, -1) : [...parts.slice(0, -1), stem];
    if (ctx.routes.some((r) => matchSegments(r.segments, htmlParts))) return "page";
  }
  const publicFile = path.join(ctx.root, "public", ...parts);
  if (parts.length > 0 && fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) return "asset";
  return null;
}

function netlifyFunctionExists(root: string, name: string): boolean {
  const dir = path.join(root, "netlify", "functions");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f === name || f.replace(/\.(m|c)?[jt]s$/, "") === name);
}

/** Resolves an internal path through app routes, public files and redirect chains, offline. */
export function resolvePath(target: string, ctx: ResolveContext, visited: string[] = []): Resolution {
  const parts = pathParts(target);
  const key = "/" + parts.join("/");
  if (visited.includes(key)) return { status: "invalid", reason: `redirect loop ${[...visited, key].join(" -> ")}` };
  if (visited.length > MAX_CHAIN) return { status: "invalid", reason: `redirect chain longer than ${MAX_CHAIN}` };
  const chain = [...visited, key];
  if (/^\/(_next|\.netlify\/(?!functions\/))/.test(key + "/")) return { status: "asset", reason: "build/platform path" };
  if (key.startsWith("/.netlify/functions/")) {
    return netlifyFunctionExists(ctx.root, parts[2] ?? "")
      ? { status: "asset", reason: `netlify function ${parts[2]}` }
      : { status: "invalid", reason: `netlify function ${parts[2]} not found` };
  }
  const direct = directMatch(parts, ctx);
  let rule: HostRule | undefined;
  let params: Record<string, string> | null = null;
  for (const r of ctx.rules) {
    params = matchRule(r.segments, parts);
    if (params && (r.force || !direct)) {
      rule = r;
      break;
    }
  }
  if (!rule || !params) {
    return direct
      ? { status: direct, reason: direct === "page" ? "app route" : "public file" }
      : { status: "invalid", reason: "no app route, public file or redirect rule" };
  }
  const via = `${rule.from} -> ${rule.to} ${rule.status} (${rule.source})`;
  if (rule.unmodelled) return { status: "unresolved", reason: `${via}: ${rule.unmodelled}` };
  if (rule.status === 404) return { status: "invalid", reason: `${via}: host 404 rule` };
  if (!REDIRECT_STATUSES.has(rule.status)) return { status: "invalid", reason: `${via}: status ${rule.status} is not a redirect/rewrite` };
  let unknownParam = false;
  const dest = rule.to.replace(/:([A-Za-z_]\w*)/g, (_, name: string) => {
    if (params![name] === undefined) unknownParam = true;
    return params![name] ?? "";
  });
  if (unknownParam) return { status: "unresolved", reason: `${via}: destination uses a parameter the source does not capture` };
  if (EXTERNAL.test(dest)) return { status: "external", reason: `${via}: redirects off-site, not verified` };
  const next = resolvePath(dest, ctx, chain);
  if (next.status === "page" || next.status === "asset" || next.status === "alias") {
    return { status: "alias", reason: `${via}; ${next.reason}` };
  }
  return { status: next.status, reason: `${via}; ${next.reason}` };
}

export function classifyTarget(target: string, ctx: ResolveContext): Resolution {
  if (EXTERNAL.test(target) || target.startsWith("#")) return { status: "external", reason: "external or same-page" };
  if (!target.startsWith("/")) return { status: "dynamic", reason: "relative target depends on the current URL" };
  return resolvePath(target, ctx);
}

export interface ExtractedLink {
  line: number;
  raw: string;
  dynamic: boolean;
}

const NAV_METHODS = new Set(["push", "replace", "prefetch"]);

/**
 * Parses the file with the TypeScript compiler, so multiline attributes/calls and escapes are handled.
 * Supported forms: JSX `href` attribute, `href:` object property, `router.push|replace|prefetch(arg)`.
 * A string or no-substitution template is literal; a template whose `${}` starts after `?`/`#` keeps a
 * literal path; anything else is reported as dynamic.
 */
export function extractLinks(content: string, fileName: string): ExtractedLink[] {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : /\.js$/.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, kind);
  const out: ExtractedLink[] = [];

  const add = (expr: ts.Expression) => {
    const line = sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1;
    let e = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push({ line, raw: e.text, dynamic: false });
    else if (ts.isTemplateExpression(e) && /[?#]/.test(e.head.text)) out.push({ line, raw: e.head.text, dynamic: false });
    else out.push({ line, raw: e.getText(sf).replace(/\s+/g, " ").slice(0, 120), dynamic: true });
  };
  const nameIs = (name: ts.Node, value: string) => (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === value;

  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "href" && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) add(node.initializer);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) add(node.initializer.expression);
    } else if (ts.isPropertyAssignment(node) && nameIs(node.name, "href")) {
      add(node.initializer);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      NAV_METHODS.has(node.expression.name.text) &&
      /(^|\.)router$/.test(node.expression.expression.getText(sf)) &&
      node.arguments[0]
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function runAudit(root: string, sourceDirs = ["src", "components"]): AuditResult {
  const boundaries: string[] = [];
  const appDir = fs.existsSync(path.join(root, "src", "app")) ? path.join(root, "src", "app") : path.join(root, "app");
  const routes = collectAppRoutes(root, appDir, boundaries);
  const rules = collectHostRules(root, boundaries);
  const ctx: ResolveContext = { root, routes, rules };
  const findings: LinkFinding[] = [];
  let scannedFiles = 0;
  let skippedTestFiles = 0;
  for (const dir of sourceDirs) {
    for (const file of walk(path.join(root, dir))) {
      if (!SOURCE_EXT.test(file)) continue;
      if (TEST_FILE.test(file)) {
        skippedTestFiles++;
        continue;
      }
      scannedFiles++;
      for (const link of extractLinks(fs.readFileSync(file, "utf8"), file)) {
        const res: Resolution = link.dynamic
          ? { status: "dynamic", reason: "expression not resolvable statically" }
          : classifyTarget(link.raw, ctx);
        findings.push({ file: rel(root, file), line: link.line, raw: link.raw, ...res });
      }
    }
  }
  return { routes, rules, boundaries, findings, scannedFiles, skippedTestFiles };
}
