/**
 * Row 26 (prefetching / preloading): pins the deliberate route-prefetch
 * strategy documented in docs/prefetch-strategy.md.
 * 1. No `prefetch={false}` outside the curated opt-out allowlist.
 * 2. Every curated browser-fetch third-party origin is preconnected in the
 *    root layout head (server-to-server and outbound-href origins excluded
 *    by design - preconnect does nothing for them).
 * 3. next/font in use (automatic font preloading).
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
check(/next\/font\/(google|local)/.test(layout), "root layout uses next/font (automatic font preload)");

console.log(`\nprefetch-strategy: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
