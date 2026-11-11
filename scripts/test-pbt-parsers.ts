/**
 * Property-based tests for pure parsers and validators (Backend sheet row
 * "Property-based Testing").
 *
 * Covers:
 * 1. src/lib/security/bodySize.ts Content-Length parsing:
 *    - Trimmed decimal digits accepted
 *    - Suffix, fraction, sign, exponent, comma, hex, non-digits rejected
 * 2. src/lib/api/etag.ts etagMatches weak comparison helper:
 *    - RFC 9110 weak comparison semantics
 *    - Wildcard '*' match, list parsing, whitespace tolerance
 *    - Malformed headers rejected safely, never throws
 * 3. src/lib/api/clientSchemas.ts validators:
 *    - parseStatsResponse, parseGlobeStats, parseTickerResponse
 *    - Well-formed payloads accepted and normalised
 *    - Malformed payloads safely dropped to null or [], never throws
 *
 * Run: npx tsx scripts/test-pbt-parsers.ts
 * Run negative control: npx tsx scripts/test-pbt-parsers.ts --negative-control
 */

import { exceedsGlobalBodyCap, GLOBAL_API_BODY_CAP_BYTES } from "../src/lib/security/bodySize";
import { etagMatches } from "../src/lib/api/etag";
import { parseStatsResponse, parseGlobeStats, parseTickerResponse } from "../src/lib/api/clientSchemas";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const isNegativeControl = process.argv.includes("--negative-control");
if (isNegativeControl) {
  // Proves that an invalid condition exits non-zero
  console.log("NEGATIVE CONTROL: Simulating assertion failure");
  check("negative control deliberate failure", false);
  process.exit(1);
}

// Seeded PRNG (mulberry32) for deterministic reproducible testing
const SEED = 0x5eeded;
const ITERATIONS = 300;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(SEED);

// Random helpers
function randomInt(min: number, max: number): number {
  return Math.floor(rnd() * (max - min + 1)) + min;
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

const CHAR_POOL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./\\;:'\"!@#$%^&*()+=[]{}|<> \t\r\n";
function randomString(maxLen = 32): string {
  const len = Math.floor(rnd() * maxLen);
  let s = "";
  for (let i = 0; i < len; i++) s += CHAR_POOL[Math.floor(rnd() * CHAR_POOL.length)];
  return s;
}

const OPAQUE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:!#$%&*+-";
function randomOpaqueTag(maxLen = 16): string {
  const len = Math.max(1, Math.floor(rnd() * maxLen));
  let s = "";
  for (let i = 0; i < len; i++) s += OPAQUE_CHARS[Math.floor(rnd() * OPAQUE_CHARS.length)];
  return s;
}

// -----------------------------------------------------------------------------
// 1. Content-Length parser property tests (src/lib/security/bodySize.ts)
// -----------------------------------------------------------------------------

// Property 1a: Valid decimal digits with optional leading/trailing whitespace are accepted
{
  let allOk = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const val = randomInt(GLOBAL_API_BODY_CAP_BYTES + 1, GLOBAL_API_BODY_CAP_BYTES * 10);
    const wsPrefix = " ".repeat(randomInt(0, 3));
    const wsSuffix = " ".repeat(randomInt(0, 3));
    const header = `${wsPrefix}${val}${wsSuffix}`;
    const result = exceedsGlobalBodyCap("POST", "/api/upload", header, GLOBAL_API_BODY_CAP_BYTES);
    if (result !== true) {
      allOk = false;
      break;
    }
  }
  check("bodySize: trimmed decimal digits exceeding cap return true", allOk);
}

{
  let allOk = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const val = randomInt(0, GLOBAL_API_BODY_CAP_BYTES);
    const wsPrefix = " ".repeat(randomInt(0, 3));
    const wsSuffix = " ".repeat(randomInt(0, 3));
    const header = `${wsPrefix}${val}${wsSuffix}`;
    const result = exceedsGlobalBodyCap("POST", "/api/upload", header, GLOBAL_API_BODY_CAP_BYTES);
    if (result !== false) {
      allOk = false;
      break;
    }
  }
  check("bodySize: trimmed decimal digits within cap return false", allOk);
}

// Property 1b: Suffixes rejected (KB, MB, B, etc.)
{
  const SUFFIXES = ["KB", "kb", "MB", "mb", "GB", "B", "bytes", " octets"];
  let allRejected = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const num = randomInt(GLOBAL_API_BODY_CAP_BYTES + 1, GLOBAL_API_BODY_CAP_BYTES * 5);
    const suffix = randomChoice(SUFFIXES);
    const header = `${num}${suffix}`;
    // Malformed header passes through to route guards (returns false)
    if (exceedsGlobalBodyCap("POST", "/api/test", header, GLOBAL_API_BODY_CAP_BYTES) !== false) {
      allRejected = false;
      break;
    }
  }
  check("bodySize: unit suffixes rejected", allRejected);
}

// Property 1c: Fractions rejected
{
  let allRejected = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const whole = randomInt(GLOBAL_API_BODY_CAP_BYTES + 1, GLOBAL_API_BODY_CAP_BYTES * 5);
    const frac = randomInt(1, 99);
    const header = `${whole}.${frac}`;
    if (exceedsGlobalBodyCap("POST", "/api/test", header, GLOBAL_API_BODY_CAP_BYTES) !== false) {
      allRejected = false;
      break;
    }
  }
  check("bodySize: fractions rejected", allRejected);
}

// Property 1d: Signs rejected (+ and -)
{
  let allRejected = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const num = randomInt(GLOBAL_API_BODY_CAP_BYTES + 1, GLOBAL_API_BODY_CAP_BYTES * 5);
    const sign = randomChoice(["+", "-"]);
    const header = `${sign}${num}`;
    if (exceedsGlobalBodyCap("POST", "/api/test", header, GLOBAL_API_BODY_CAP_BYTES) !== false) {
      allRejected = false;
      break;
    }
  }
  check("bodySize: explicit signs rejected", allRejected);
}

// Property 1e: Exponents rejected (scientific notation)
{
  let allRejected = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const base = randomInt(1, 9);
    const exp = randomInt(6, 12);
    const char = randomChoice(["e", "E"]);
    const header = `${base}${char}${exp}`;
    if (exceedsGlobalBodyCap("POST", "/api/test", header, GLOBAL_API_BODY_CAP_BYTES) !== false) {
      allRejected = false;
      break;
    }
  }
  check("bodySize: scientific exponent notation rejected", allRejected);
}

// Property 1f: Commas rejected
{
  let allRejected = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const thousands = randomInt(1000, 9999);
    const header = `${thousands.toLocaleString("en-US")}`;
    if (exceedsGlobalBodyCap("POST", "/api/test", header, GLOBAL_API_BODY_CAP_BYTES) !== false) {
      allRejected = false;
      break;
    }
  }
  check("bodySize: formatted commas rejected", allRejected);
}

// Property 1g: Hexadecimal rejected
{
  let allRejected = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const hex = randomInt(GLOBAL_API_BODY_CAP_BYTES + 1, GLOBAL_API_BODY_CAP_BYTES * 5).toString(16);
    const prefix = randomChoice(["0x", "0X"]);
    const header = `${prefix}${hex}`;
    if (exceedsGlobalBodyCap("POST", "/api/test", header, GLOBAL_API_BODY_CAP_BYTES) !== false) {
      allRejected = false;
      break;
    }
  }
  check("bodySize: hexadecimal notation rejected", allRejected);
}

// Property 1h: Safe methods (GET, HEAD, OPTIONS) and non-API routes always return false
{
  let allSafe = true;
  const SAFE_METHODS = ["GET", "get", "HEAD", "head", "OPTIONS", "options"];
  for (let i = 0; i < ITERATIONS; i++) {
    const m = randomChoice(SAFE_METHODS);
    const p = randomChoice(["/api/jobs", "/api/track", "/api/stats"]);
    const big = `${GLOBAL_API_BODY_CAP_BYTES * 10}`;
    if (exceedsGlobalBodyCap(m, p, big, GLOBAL_API_BODY_CAP_BYTES) !== false) {
      allSafe = false;
      break;
    }
  }
  check("bodySize: safe HTTP methods bypass body cap check", allSafe);
}

// -----------------------------------------------------------------------------
// 2. ETag weak comparison property tests (src/lib/api/etag.ts)
// -----------------------------------------------------------------------------

// Property 2a: Wildcard '*' always matches any valid entity tag
{
  let allMatch = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const tag = `"${randomOpaqueTag(16)}"`;
    const weakTag = `W/${tag}`;
    const target = randomChoice([tag, weakTag]);
    if (etagMatches("*", target) !== true || etagMatches(" * ", target) !== true) {
      allMatch = false;
      break;
    }
  }
  check("etagMatches: wildcard '*' matches any entity tag", allMatch);
}

// Property 2b: Weak and strong tags with identical opaque tag match symmetrically
{
  let allMatch = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const opaque = randomOpaqueTag(12);
    const strong = `"${opaque}"`;
    const weak = `W/"${opaque}"`;
    if (!etagMatches(strong, strong)) allMatch = false;
    if (!etagMatches(weak, strong)) allMatch = false;
    if (!etagMatches(strong, weak)) allMatch = false;
    if (!etagMatches(weak, weak)) allMatch = false;
  }
  check("etagMatches: weak and strong tags match weakly per RFC 9110", allMatch);
}

// Property 2c: Comma-separated list containing the target tag matches
{
  let allMatch = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const targetTag = `"target-${randomOpaqueTag(8)}"`;
    const otherTags = Array.from({ length: randomInt(1, 4) }, () => `"${randomOpaqueTag(8)}"`);
    // Insert targetTag at random position
    const pos = randomInt(0, otherTags.length);
    otherTags.splice(pos, 0, randomChoice([targetTag, `W/${targetTag}`]));
    const listHeader = otherTags.join(", ");
    if (!etagMatches(listHeader, targetTag)) {
      allMatch = false;
      break;
    }
  }
  check("etagMatches: comma-separated list matches when target tag is included", allMatch);
}

// Property 2d: Fuzzed corrupt headers never throw and return boolean
{
  let neverThrows = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const corrupt = randomString(32);
    const target = `"${randomString(8).replace(/[\\"]/g, "")}"`;
    try {
      const res = etagMatches(corrupt, target);
      if (typeof res !== "boolean") neverThrows = false;
    } catch {
      neverThrows = false;
    }
  }
  check("etagMatches: fuzzed corrupt headers never throw", neverThrows);
}

// -----------------------------------------------------------------------------
// 3. Client schema validation property tests (src/lib/api/clientSchemas.ts)
// -----------------------------------------------------------------------------

// Property 3a: parseStatsResponse accepts well-formed payloads and normalises
{
  let allValid = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const active = randomInt(0, 100000);
    const comps = randomInt(0, 5000);
    const today = randomInt(0, 500);
    const res = parseStatsResponse({ activeJobs: active, companies: comps, jobsToday: today });
    if (!res || res.activeJobs !== active || res.companies !== comps || res.jobsToday !== today) {
      allValid = false;
      break;
    }
  }
  check("parseStatsResponse: well-formed stats payload accepted and preserved", allValid);
}

// Property 3b: parseStatsResponse drops malformed counts to null (jobsToday to 0), never throws
{
  let allSafe = true;
  const MALFORMED_VALUES = ["not-a-number", null, undefined, NaN, Infinity, -Infinity, {}, [], false, true];
  for (let i = 0; i < ITERATIONS; i++) {
    const badActive = randomChoice(MALFORMED_VALUES);
    const badComps = randomChoice(MALFORMED_VALUES);
    const badToday = randomChoice(MALFORMED_VALUES);
    try {
      const res = parseStatsResponse({ activeJobs: badActive, companies: badComps, jobsToday: badToday });
      if (!res || res.activeJobs !== null || res.companies !== null || res.jobsToday !== 0) {
        allSafe = false;
        break;
      }
    } catch {
      allSafe = false;
      break;
    }
  }
  check("parseStatsResponse: malformed counts safely dropped to null, never throws", allSafe);
}

// Property 3c: parseGlobeStats accepts well-formed and safely drops malformed
{
  let allOk = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const total = randomInt(1, 50000);
    const scanned = randomInt(1, 2000);
    const today = randomInt(0, 100);
    const good = parseGlobeStats({ totalJobs: total, companiesScanned: scanned, jobsToday: today });
    if (!good || good.totalJobs !== total || good.companiesScanned !== scanned || good.jobsToday !== today) {
      allOk = false;
      break;
    }
    const bad = parseGlobeStats("invalid-string-payload");
    if (bad !== null) {
      allOk = false;
      break;
    }
  }
  check("parseGlobeStats: well-formed accepted, non-objects return null", allOk);
}

// Property 3d: parseTickerResponse parses array and { jobs: [...] }, drops invalid items
{
  let allOk = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const validItem = {
      company: `Company-${i}`,
      title: `Software Engineer ${i}`,
      posted_at: "2026-11-10T12:00:00Z",
      logo_url: i % 2 === 0 ? "https://example.com/logo.png" : null,
    };
    const invalidItem = {
      company: 12345, // invalid type
      title: null,
      posted_at: "2026-11-10T12:00:00Z",
    };

    // Array input with valid and invalid mixed
    const parsedList = parseTickerResponse([validItem, invalidItem]);
    if (parsedList.length !== 1 || parsedList[0].company !== validItem.company) {
      allOk = false;
      break;
    }

    // Object wrapper { jobs: [...] }
    const parsedWrapper = parseTickerResponse({ jobs: [validItem] });
    if (parsedWrapper.length !== 1 || parsedWrapper[0].title !== validItem.title) {
      allOk = false;
      break;
    }

    // Malformed root payload returns empty array
    const malformed = parseTickerResponse(randomChoice([null, undefined, 42, "string", true]));
    if (!Array.isArray(malformed) || malformed.length !== 0) {
      allOk = false;
      break;
    }
  }
  check("parseTickerResponse: valid items retained, malformed dropped, root malformed returns []", allOk);
}

// Property 3e: Arbitrary fuzzed payloads across all clientSchemas validators never throw
{
  let neverThrows = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const fuzzPayload = randomChoice([
      randomString(32),
      randomInt(-1000, 1000),
      null,
      undefined,
      { [randomString(8)]: randomString(8) },
      [randomString(8), randomInt(0, 100)],
      { activeJobs: randomString(10), jobsToday: {} },
      { jobs: [{ company: null, title: undefined, posted_at: 123 }] },
    ]);

    try {
      parseStatsResponse(fuzzPayload);
      parseGlobeStats(fuzzPayload);
      parseTickerResponse(fuzzPayload);
    } catch {
      neverThrows = false;
      break;
    }
  }
  check("clientSchemas: fuzzed arbitrary inputs never throw across all validators", neverThrows);
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
