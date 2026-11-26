/**
 * Static internal route-resolution audit (offline, no network requests).
 * Usage: npx tsx scripts/check-internal-links.ts [--root <dir>]
 * Exit 1: at least one internal link is confirmed invalid (no app route, public file or
 * working redirect chain: missing destination, loop, 404/non-redirect status).
 * Exit 0: no confirmed invalid links. Dynamic, unresolved (conditional/unmodelled rule) and
 * external targets are listed but not verified. Passing does not prove pages load or authorise.
 */
import path from "path";
import { runAudit, type LinkFinding } from "./lib/internal-route-audit";

const rootFlag = process.argv.indexOf("--root");
const root = path.resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] : ".");
const result = runAudit(root);

const by = (status: LinkFinding["status"]) => result.findings.filter((f) => f.status === status);
const show = (f: LinkFinding) => `  - ${f.file}:${f.line} -> ${f.raw}  [${f.reason}]`;
const list = (title: string, items: LinkFinding[]) => {
  if (items.length === 0) return;
  console.log(`\n${title}: ${items.length}`);
  items.forEach((f) => console.log(show(f)));
};
const invalid = by("invalid");
const dynamic = by("dynamic");
const unresolved = by("unresolved");
const offsite = by("external").filter((f) => f.reason.includes("redirects off-site"));

console.log("STATIC INTERNAL ROUTE-RESOLUTION AUDIT (files on disk only; no network requests)\n");
console.log(`App routes derived from tree: ${result.routes.length}`);
console.log(`Host redirect rules (public/_redirects, then netlify.toml): ${result.rules.length}`);
console.log(`Scanned ${result.scannedFiles} runtime source files (${result.skippedTestFiles} test/fixture files skipped)`);
console.log(
  `Links: page ${by("page").length}, alias ${by("alias").length}, asset ${by("asset").length}, ` +
    `external ${by("external").length}, dynamic ${dynamic.length}, unresolved ${unresolved.length}, invalid ${invalid.length}`,
);

if (result.boundaries.length > 0) {
  console.log("\nNot evaluated (audit boundary):");
  result.boundaries.forEach((b) => console.log(`  - ${b}`));
}
list("Internal links that redirect off-site (not verified)", offsite);
list("Unresolved: conditional or unmodelled redirect rule (no verdict)", unresolved);
list("Dynamic expressions (not checked)", dynamic);
list("INVALID internal links", invalid);

if (invalid.length > 0) process.exit(1);
console.log(
  `\nNo confirmed invalid internal links. ${dynamic.length} dynamic, ${unresolved.length} unresolved and ` +
    `${by("external").length} external targets were not verified.`,
);
