/**
 * Property-based tests for the display sanitizers (Backend row
 * "Property-based Testing": "no fast-check; the sanitizers would benefit
 * most").
 *
 * Zero-dependency harness (deterministic seeded RNG): package-lock.json
 * cannot be updated from the web flow, so adopting fast-check is an
 * owner-side step (npm install fast-check); see docs/pbt.md. The
 * properties below are the ones fast-check would encode.
 *
 * Run: npx tsx scripts/test-pbt-sanitizers.ts
 */
import {
  stripControlChars,
  escapeHtml,
  stripHtmlAndExecutableMarkup,
  sanitizeExternalUrl,
  sanitizeInternalPath,
  sanitizeDownloadFilename,
} from "../src/lib/security/xss";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

// Chosen defaults: fixed seed keeps CI deterministic; 500 iterations per
// property per generator is enough to catch regressions in practice while
// keeping the suite under a second.
const SEED = 0xc0ffee;
const ITERATIONS = 500;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL =
  "abcXYZ019 <>&\"'=/\\;:.-_@#\t\n" +
  "\x00\x01\x08\x0b\x0c\x0e\x1f\x7f" +
  "é日🚀";
const FRAGMENTS = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=x>",
  "<iframe src=https://evil.example>",
  "<style>body{}</style>",
  "<object data=x></object>",
  "<embed src=x>",
  "javascript:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>",
  'onload=alert(1)',
  "onerror='x'",
  "<img src=x>",
  "</div>",
  "<b>bold</b>",
  "https://ok.example/path",
  "http://ok.example",
  "mailto:a@b.co",
  "//evil.example/x",
  "\\\\evil",
  "..",
  "../etc/passwd",
  "file.pdf",
  "#",
];

function genRandom(rnd: () => number): string {
  const len = Math.floor(rnd() * 64);
  let s = "";
  for (let i = 0; i < len; i++) s += POOL[Math.floor(rnd() * POOL.length)];
  return s;
}

function genInjected(rnd: () => number): string {
  const parts: string[] = [];
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    parts.push(genRandom(rnd).slice(0, 12));
    parts.push(FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)]);
  }
  parts.push(genRandom(rnd).slice(0, 12));
  return parts.join("");
}

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function forEachInput(fn: (input: string) => string | null) {
  const rnd = mulberry32(SEED);
  for (let i = 0; i < ITERATIONS; i++) fn(genRandom(rnd));
  for (let i = 0; i < ITERATIONS; i++) fn(genInjected(rnd));
  return null;
}

// stripControlChars: output never contains stripped control characters.
{
  let bad: string | null = null;
  forEachInput((input) => {
    const out = stripControlChars(input);
    if (CONTROL_CHARS.test(out)) bad = out;
    return null;
  });
  check("stripControlChars: no control chars survive", bad === null);
}

// escapeHtml: no raw angle brackets and no control chars in output.
{
  let bad = false;
  forEachInput((input) => {
    const out = escapeHtml(input);
    if (/[<>]/.test(out) || CONTROL_CHARS.test(out)) bad = true;
    return null;
  });
  check("escapeHtml: no raw < > or control chars in output", !bad);
}

// stripHtmlAndExecutableMarkup: no executable markup or dangerous schemes survive.
{
  let bad: string | null = null;
  forEachInput((input) => {
    const out = stripHtmlAndExecutableMarkup(input);
    if (
      CONTROL_CHARS.test(out) ||
      /<script/i.test(out) ||
      /<iframe/i.test(out) ||
      /<style/i.test(out) ||
      /<object/i.test(out) ||
      /<embed/i.test(out) ||
      /javascript\s*:/i.test(out) ||
      /vbscript\s*:/i.test(out) ||
      /\son[a-z]{2,}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(out)
    ) {
      bad = out;
    }
    return null;
  });
  check("stripHtmlAndExecutableMarkup: no script/style/iframe/object/embed, handlers, or js: schemes survive", bad === null);
}

// sanitizeExternalUrl: any non-null result parses with an allowed protocol.
{
  let bad = false;
  forEachInput((input) => {
    const out = sanitizeExternalUrl(input);
    if (out !== null) {
      try {
        const p = new URL(out).protocol.toLowerCase();
        if (p !== "http:" && p !== "https:" && p !== "mailto:") bad = true;
      } catch {
        bad = true;
      }
    }
    return null;
  });
  check("sanitizeExternalUrl: non-null results are http/https/mailto only", !bad);
}

// sanitizeInternalPath: result is "/" or a single-slash clean path.
{
  let bad = false;
  forEachInput((input) => {
    const out = sanitizeInternalPath(input);
    const ok =
      out === "/" ||
      (out.startsWith("/") &&
        !out.startsWith("//") &&
        !out.startsWith("/\\") &&
        !/[\x00-\x20<>'"]/.test(out));
    if (!ok) bad = true;
    return null;
  });
  check("sanitizeInternalPath: always '/' or a clean single-slash path", !bad);
}

// sanitizeDownloadFilename: no path/HTML metacharacters, bounded length, never empty.
{
  let bad = false;
  forEachInput((input) => {
    const out = sanitizeDownloadFilename(input);
    if (
      out.length === 0 ||
      out.length > 100 ||
      /[<>:"/\\|?*\x00-\x1F]/.test(out) ||
      out.includes("..")
    ) {
      bad = true;
    }
    return null;
  });
  check("sanitizeDownloadFilename: metachar-free, <=100 chars, never empty", !bad);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
