/**
 * Row 26 (prefetching / preloading): pins the deliberate route-prefetch
 * strategy documented in docs/prefetch-strategy.md.
 * 1. No `prefetch={false}` outside the curated opt-out allowlist.
 * 2. Every curated browser-fetch third-party origin is preconnected in the
 *    root layout head (server-to-server and outbound-href origins excluded
 *    by design - preconnect does nothing for them).
 * 3. Same-origin Inter CSS, class, and valid WOFF2 preload stay wired.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const PREFETCH_OPTOUT_ALLOWLIST = new Set([
  "src/app/dashboard/page.tsx",
  "src/components/GuideHeader.tsx",
  "src/components/UserMenu.tsx",
  "src/components/Footer.tsx",
]);
const CLIENT_FETCH_ORIGINS = ["unavatar.io"];
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`PASS: ${label}`); }
  else { failed += 1; console.log(`FAIL: ${label}`); }
}

function walk(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(ent.name)) out.push(path.relative(ROOT, full).replace(/\\/g, "/"));
  }
}
const files: string[] = [];
walk(SRC, files);

const offenders = files.filter(
  (rel) => !PREFETCH_OPTOUT_ALLOWLIST.has(rel) && /prefetch=\{false\}/.test(fs.readFileSync(path.join(ROOT, rel), "utf8"))
);
check(offenders.length === 0, `no Link prefetch opt-outs outside the curated allowlist (found: ${offenders.join(", ") || "none"})`);
for (const rel of PREFETCH_OPTOUT_ALLOWLIST) {
  check(files.includes(rel), `documented opt-out file exists: ${rel}`);
}

const layout = fs.readFileSync(path.join(ROOT, "src/app/layout.tsx"), "utf8");
const hintsSource = fs.readFileSync(path.join(ROOT, "src/lib/seo/structuredData.ts"), "utf8");
check(
  layout.includes("getConnectionHints") && /rel=.preconnect/.test(layout),
  "root layout renders preconnect links from getConnectionHints()"
);
for (const origin of CLIENT_FETCH_ORIGINS) {
  check(
    hintsSource.includes(origin),
    `client-fetch origin ${origin} is in the connection-hints list`
  );
}
const interCss = fs.readFileSync(path.join(ROOT, "src/styles/inter-local.css"), "utf8");
const fontPath = "/fonts/inter/inter-6.woff2";
const font = fs.readFileSync(path.join(ROOT, "public", fontPath));
function hasLocalFontPreload(source: string, css: string, bytes: Buffer): boolean {
  return source.includes('import "@/styles/inter-local.css";') &&
    /<html\s+lang="en"\s+className="cm-inter-font scroll-smooth">/.test(source) &&
    source.includes(`<link rel="preload" href="${fontPath}" as="font" type="font/woff2" crossOrigin="anonymous" />`) &&
    css.includes(`src: url(${fontPath}) format('woff2');`) &&
    css.includes(".cm-inter-font{--font-inter:'Inter','Inter Fallback';}") &&
    css.includes("font-display: swap;") && bytes.subarray(0, 4).toString() === "wOF2";
}
check(hasLocalFontPreload(layout, interCss, font), "root layout wires bundled Inter CSS/class and valid same-origin cross-origin font preload");
for (const [label, source, css, bytes] of [
  ["CSS import removed", layout.replace('import "@/styles/inter-local.css";', ''), interCss, font],
  ["font class removed", layout.replace('cm-inter-font scroll-smooth', 'scroll-smooth'), interCss, font],
  ["preload removed", layout.replace('rel="preload"', 'rel="stylesheet"'), interCss, font],
  ["wrong preload URL", layout.replace(fontPath, '/fonts/missing.woff2'), interCss, font],
  ["crossOrigin removed", layout.replace('crossOrigin="anonymous"', ''), interCss, font],
  ["CSS source removed", layout, interCss.replaceAll(fontPath, '/fonts/missing.woff2'), font],
  ["invalid font bytes", layout, interCss, Buffer.from('not a font')],
] as const) check(!hasLocalFontPreload(source, css, bytes), `negative control rejects ${label}`);

console.log(`\nprefetch-strategy: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
