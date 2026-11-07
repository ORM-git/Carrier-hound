/**
 * Guards src/app/sitemap.ts lastmod freshness:
 * every sitemap entry carries a real, parseable lastModified that is not in
 * the future, and dates are derived from per-route content history (so they
 * are not a single uniform build timestamp).
 * Run: npx tsx scripts/test-sitemap-lastmod.ts
 */
import { execSync } from "child_process";
import sitemap from "../src/app/sitemap";

// CI checkouts are shallow (fetch-depth 1): no per-path git history exists,
// so sitemap.ts omits lastModified entirely and date assertions are skipped.
function isShallowRepo(): boolean {
  try {
    return execSync("git rev-parse --is-shallow-repository", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() === "true";
  } catch {
    return true;
  }
}
const shallow = isShallowRepo();

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const entries = sitemap();
const now = Date.now();

check("sitemap has entries", entries.length > 0);

if (shallow) {
  check(
    "shallow checkout: lastModified omitted honestly (no uniform HEAD dates)",
    entries.every((e) => e.lastModified === undefined || e.lastModified === null)
  );
  console.log("SKIP date assertions: shallow checkout has no per-path git history");
} else {
  check(
    "every entry has a lastModified",
    entries.every((e) => e.lastModified !== undefined && e.lastModified !== null)
  );
  check(
    "every lastModified is a parseable date",
    entries.every((e) => !Number.isNaN(new Date(e.lastModified as string | Date).getTime()))
  );
  check(
    "no lastModified is in the future",
    entries.every((e) => new Date(e.lastModified as string | Date).getTime() <= now + 60_000)
  );

  const distinct = new Set(entries.map((e) => new Date(e.lastModified as string | Date).getTime()));
  check(
    "lastmod dates are content-derived, not one uniform timestamp",
    distinct.size > 1
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
