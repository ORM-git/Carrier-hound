/**
 * Static internal route-resolution audit (offline, no network requests).
 * Usage: npx tsx scripts/check-internal-links.ts [--root <dir>]
 * Exits 1 when a literal internal link resolves to no app route, host alias or public file.
 * Passing means targets resolve on disk only, not that pages load or authorise correctly.
 */
import path from "path";
import { runAudit, type LinkFinding } from "./lib/internal-route-audit";

const rootFlag = process.argv.indexOf("--root");
const root = path.resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : ".");
const result = runAudit(root);

const by = (status: LinkFinding["status"]) => result.findings.filter((f) => f.status === status);
const show = (f: LinkFinding) => `  - ${f.file}:${f.line} -> ${f.raw}`;
const invalid = by("invalid");
const dynamic = by("dynamic");

console.log("STATIC INTERNAL ROUTE-RESOLUTION AUDIT (files on disk only; no network requests)\n");
console.log(`App routes derived from tree: ${result.routes.length}`);
console.log(`Static host aliases (netlify.toml, public/_redirects): ${result.aliases.length}`);
console.log(`Scanned ${result.scannedFiles} runtime source files (${result.skippedTestFiles} test/fixture files skipped)`);
console.log(
  `Links: page ${by("page").length}, alias ${by("alias").length}, asset ${by("asset").length}, ` +
    `external ${by("external").length}, dynamic ${dynamic.length}, invalid ${invalid.length}`,
);

if (result.boundaries.length > 0) {
  console.log("\nNot evaluated (audit boundary):");
  result.boundaries.forEach((b) => console.log(`  - ${b}`));
}
if (dynamic.length > 0) {
  console.log(`\nUnresolved dynamic expressions (not checked, not failed): ${dynamic.length}`);
  dynamic.forEach((f) => console.log(show(f)));
}
if (invalid.length > 0) {
  console.log(`\nINVALID internal links (no matching route, alias or public file): ${invalid.length}`);
  invalid.forEach((f) => console.log(show(f)));
  process.exit(1);
}
console.log("\nAll literal internal links resolve to an app route, static host alias or public file.");
