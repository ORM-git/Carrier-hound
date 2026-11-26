/**
 * Static route-resolution audit: checks literal internal navigation targets in
 * source against the Next.js app tree and static host redirect rules on disk.
 * It never makes a network request. A "resolved" link means a matching file or
 * rule exists, not that the page loads, authorises correctly or works live.
 */
import fs from "fs";
import path from "path";

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

export type LinkStatus = "page" | "alias" | "asset" | "external" | "dynamic" | "invalid";

export interface LinkFinding {
  file: string;
  line: number;
  raw: string;
  status: LinkStatus;
}

export interface AuditResult {
  routes: RoutePattern[];
  aliases: RoutePattern[];
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

function hostRuleSegments(from: string): Segment[] {
  return from
    .split("/")
    .filter(Boolean)
    .map((part): Segment => (part === "*" ? { kind: "catchAll" } : part.startsWith(":") ? { kind: "dynamic" } : { kind: "static", value: part }));
}

/**
 * Netlify redirect/rewrite rules read as text from netlify.toml and public/_redirects.
 * Supported: exact paths, `:placeholder` segments and a `*` splat. 404 rules and the
 * bare `/*` fallback are not aliases. Conditions (country, role, query) are ignored.
 */
export function collectHostAliases(root: string, boundaries: string[]): RoutePattern[] {
  const rules: { from: string; status: string; source: string }[] = [];
  const toml = path.join(root, "netlify.toml");
  if (fs.existsSync(toml)) {
    const text = fs.readFileSync(toml, "utf8");
    for (const block of text.split(/^\s*\[\[redirects\]\]\s*$/m).slice(1)) {
      const body = block.split(/^\s*\[/m)[0];
      const from = body.match(/^\s*from\s*=\s*"([^"]+)"/m)?.[1];
      const status = body.match(/^\s*status\s*=\s*(\d+)/m)?.[1] ?? "301";
      if (from) rules.push({ from, status, source: "netlify.toml" });
    }
  }
  const underscore = path.join(root, "public", "_redirects");
  if (fs.existsSync(underscore)) {
    for (const line of fs.readFileSync(underscore, "utf8").split("\n")) {
      const [from, , status = "301"] = line.trim().split(/\s+/);
      if (from && from.startsWith("/")) rules.push({ from, status: status.replace("!", ""), source: "public/_redirects" });
    }
  }
  const aliases: RoutePattern[] = [];
  for (const r of rules) {
    if (r.status === "404" || r.from === "/*") continue;
    if (/\*./.test(r.from)) {
      boundaries.push(`mid-path splat not modelled: ${r.from} (${r.source})`);
      continue;
    }
    aliases.push({ pattern: r.from, segments: hostRuleSegments(r.from), source: r.source });
  }
  for (const name of ["src/middleware.ts", "middleware.ts"]) {
    if (fs.existsSync(path.join(root, name))) boundaries.push(`${name} runtime redirects (auth/returnTo) are not evaluated`);
  }
  for (const name of ["next.config.mjs", "next.config.js", "next.config.ts"]) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && /\b(redirects|rewrites)\s*[:(]/.test(fs.readFileSync(file, "utf8"))) {
      boundaries.push(`${name} declares redirects/rewrites; not executed, so its aliases are not applied`);
    }
  }
  return aliases;
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

export function classifyTarget(
  target: string,
  routes: RoutePattern[],
  aliases: RoutePattern[],
  publicDir: string,
): LinkStatus {
  if (/^(mailto:|tel:|sms:|[a-z][a-z0-9+.-]*:\/\/|\/\/)/i.test(target) || target.startsWith("#")) return "external";
  if (!target.startsWith("/")) return "dynamic"; // relative target: resolution depends on the current URL
  if (/^\/(_next|\.netlify)\//.test(target)) return "asset";
  const parts = pathParts(target);
  if (routes.some((r) => matchSegments(r.segments, parts))) return "page";
  if (aliases.some((a) => matchSegments(a.segments, parts))) return "alias";
  const publicFile = path.join(publicDir, ...parts);
  if (parts.length > 0 && fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) return "asset";
  return "invalid";
}

// Literal forms: href="…", href='…', href={"…"}, href={`…`}, href: "…" (object/nav config),
// router.push|replace|prefetch("…"). A template literal containing ${…} is dynamic.
const LITERAL_FORMS = /(?:\bhref\s*=\s*\{?\s*|\bhref\s*:\s*|\brouter\.(?:push|replace|prefetch)\(\s*)(["'`])((?:(?!\1)[^\\]|\\.)*?)\1/g;
// Expression forms the audit cannot resolve statically: href={expr}, router.push(expr).
const DYNAMIC_FORMS = /\bhref\s*=\s*\{\s*(?!["'`])([^}]*)\}|\brouter\.(?:push|replace|prefetch)\(\s*(?!["'`)])([^)]*)\)/g;

export function extractLinks(content: string): { line: number; raw: string; dynamic: boolean }[] {
  const out: { line: number; raw: string; dynamic: boolean }[] = [];
  content.split("\n").forEach((text, idx) => {
    for (const m of text.matchAll(LITERAL_FORMS)) {
      // Interpolation only in the query/hash leaves a static, checkable path.
      out.push({ line: idx + 1, raw: m[2], dynamic: m[1] === "`" && m[2].split(/[?#]/)[0].includes("${") });
    }
    for (const m of text.matchAll(DYNAMIC_FORMS)) {
      out.push({ line: idx + 1, raw: (m[1] ?? m[2]).trim(), dynamic: true });
    }
  });
  return out;
}

export function runAudit(root: string, sourceDirs = ["src", "components"]): AuditResult {
  const boundaries: string[] = [];
  const appDir = fs.existsSync(path.join(root, "src", "app")) ? path.join(root, "src", "app") : path.join(root, "app");
  const routes = collectAppRoutes(root, appDir, boundaries);
  const aliases = collectHostAliases(root, boundaries);
  const publicDir = path.join(root, "public");
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
      for (const link of extractLinks(fs.readFileSync(file, "utf8"))) {
        const status = link.dynamic ? "dynamic" : classifyTarget(link.raw, routes, aliases, publicDir);
        findings.push({ file: rel(root, file), line: link.line, raw: link.raw, status });
      }
    }
  }
  return { routes, aliases, boundaries, findings, scannedFiles, skippedTestFiles };
}
