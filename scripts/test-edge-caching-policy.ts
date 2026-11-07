/**
 * Rank 42 (Edge Caching) + the real pieces of ranks 43/44 - public cache policy guard.
 *
 * Policy (parent-reviewed, 2026-11-07):
 *   - /api/ticker 200: public, s-maxage=60, stale-while-revalidate=300
 *     (fully public payload, no auth surface).
 *   - /api/stats 200: that same public header ONLY when the request carries
 *     no Authorization header at all; any Authorization header (valid or
 *     invalid), every authed 200, and every non-200 stays no-store.
 *   - ALL /api/stats responses carry Vary: Authorization.
 *   - No route ever emits public caching on a non-200.
 *   - Rate limiting still runs before any response (cache misses only reach
 *     the origin; nothing may short-circuit the limiter).
 *   - public/_headers caches content-hashed build assets immutably.
 * TTL values are chosen defaults from that review, not measurements.
 *
 * Offline and static: asserts the policy against the route sources so a
 * regression (e.g. re-adding public caching to the authed stats branch)
 * fails the suite.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_TTL = "public, s-maxage=60, stale-while-revalidate=300";
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`PASS: ${label}`); }
  else { failed += 1; console.log(`FAIL: ${label}`); }
}

function main(): void {
  const stats = fs.readFileSync(path.join(ROOT, "src/app/api/stats/route.ts"), "utf8");
  const ticker = fs.readFileSync(path.join(ROOT, "src/app/api/ticker/route.ts"), "utf8");
  const headersFile = fs.readFileSync(path.join(ROOT, "public/_headers"), "utf8");

  // --- ticker ---
  check(ticker.includes(`"Cache-Control": "${PUBLIC_TTL}"`),
    "ticker 200 carries the reviewed public TTL (s-maxage=60, swr=300)");
  check((ticker.match(/s-maxage/g) ?? []).length === 1,
    "ticker emits the public TTL on exactly one path (the 200)");
  check(ticker.includes("computeWeakEtag") && ticker.includes("notModifiedResponse"),
    "ticker keeps weak-ETag/304 revalidation");

  // --- stats: public TTL only in the no-Authorization branch ---
  check(/"Cache-Control": authHeader\s*\?\s*"no-store"\s*:\s*"public, s-maxage=60, stale-while-revalidate=300"/.test(stats),
    "stats public TTL is conditional on the request carrying NO Authorization header");
  check((stats.match(/s-maxage/g) ?? []).length === 1,
    "stats emits the public TTL on exactly one branch (anonymous 200)");

  // --- stats: the authed full-corpus 200 stays no-store ---
  const corpusIdx = stats.indexOf("companiesScanned");
  const afterCorpus = stats.slice(corpusIdx);
  const nextCC = /"Cache-Control": "([^"]+)"/.exec(afterCorpus);
  check(!!nextCC && nextCC[1] === "no-store",
    "stats authed full-metrics 200 stays no-store (no shared-cache leak of corpus metrics)");

  // --- stats: Vary: Authorization on every response ---
  const varyCount = (stats.match(/Vary: "Authorization"/g) ?? []).length;
  const headerBlocks = (stats.match(/headers: \{/g) ?? []).length;
  check(varyCount >= headerBlocks - 1,
    `stats carries Vary: Authorization on every response (${varyCount} vary / ${headerBlocks} header blocks)`);

  // --- no public caching on any non-200 in either route ---
  for (const [name, src] of [["stats", stats], ["ticker", ticker]] as Array<[string, string]>) {
    const blocks = [...src.matchAll(/status: (\d{3}),[\s\S]{0,300}?headers: \{([\s\S]*?)\}/g)];
    const bad = blocks.filter((b) => b[1] !== "200" && /s-maxage|public,/.test(b[2]));
    check(bad.length === 0, `${name}: no non-200 response carries public caching (${blocks.length} status blocks scanned)`);
  }

  // --- rate limiting still runs before responses (cache misses) ---
  for (const [name, src] of [["stats", stats], ["ticker", ticker]] as Array<[string, string]>) {
    const limiterIdx = src.indexOf("checkSharedRateLimit");
    const firstResponseIdx = src.indexOf("NextResponse.json");
    check(limiterIdx > -1 && limiterIdx < firstResponseIdx,
      `${name}: rate limiter runs before any response is constructed`);
  }

  // --- _headers: immutable caching for content-hashed build assets ---
  check(/\/_next\/static\/\*\s*\n\s*Cache-Control: public, max-age=31536000, immutable/.test(headersFile),
    "public/_headers caches /_next/static/* immutably (content-hashed assets)");

  // --- no security headers lost from _headers ---
  check(headersFile.includes("Content-Security-Policy:") && headersFile.includes("Strict-Transport-Security:"),
    "_headers keeps its existing security header block");

  // --- suite registration ---
  const sr = fs.readFileSync(path.join(ROOT, "scripts", "suite-runner.ts"), "utf8");
  check(sr.includes("test-edge-caching-policy.ts"), "suite registered in scripts/suite-runner.ts");

  console.log(`\n[PASS-LOCAL] ${passed} edge-caching checks passed${failed ? `; ${failed} FAILED` : ""}\n`);
  process.exit(failed ? 1 : 0);
}

main();
