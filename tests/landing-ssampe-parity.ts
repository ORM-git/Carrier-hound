/**
 * Parity guard for the composite home page:
 *   - top fold  = ORM-git/ssampe index.html @ f21504b30e3466952208cbbcc426877268a11baf  (scoped .cm-top)
 *   - lower page = ORM-git/ssampe @ 3386250e9aef17b68666bc471e5c8293e8f02bc9, stats row .. footer + sticky bar
 *                  (index.html + src/landing.css + src/site.css, scoped .landing-wrapper)
 * Sources are vendored next to this file and pinned by git blob hash.
 * Every check runs on the real files, then on deliberately broken copies (negative controls) that must fail.
 * The live runtime cleanup (listeners, frames, timers, observers) is exercised in scripts/test-landing-top-artifact.ts.
 * Run: npx tsx tests/landing-ssampe-parity.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const blob = (buf: Buffer) => crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

// Pinned provenance (git blob hashes in ORM-git/ssampe at the commits above).
const SOURCES: Record<string, string> = {
  "tests/landing-ssampe-parity.source.html": "1f51106b2b879196dc32dab73adfbdf2f57cec02", // f21504b index.html
  "tests/landing-ssampe-parity.lower.source.html": "311d27ea7d52954bc23423337efcfb1596235226", // 3386250 index.html
  "tests/landing-ssampe-parity.lower.landing.css": "6dcbac50e31bf862de3ea0ff0accc7dcb0b48064", // 3386250 src/landing.css
  "tests/landing-ssampe-parity.lower.site.css": "06d930f90b27a7725853cd6e81a77ea50a863ca8", // 3386250 src/site.css
};
const ASSETS: Record<string, string> = {
  "/mascot.png": "030e3eadbef1d86115adc7ac423ae2ef5882727b",
  "/owner.jpg": "29fdee8bc59472ea8e5bcf326d27a4134eb1bcb8",
  "/careermonke-logo.png": "f5d981e790b389df8719761c1bb9ef43e1c8d03b",
};
// The only copy change below the fold: the five CareerMonke Way cells, in order.
const CELLS: [string, string][] = [
  ["Under 20 applicants, direct", "Jobs matched to your resume"],
  ["1-tap ATS-matched resume", "See your percentage match score"],
  ["Instant keyword match score", "Verified employer job listings"],
  ["From verified employers", "Filter jobs by role, location and work mode"],
  ["Seen by recruiters early", "Apply on the employer's careers page"],
];
const LOWER_ORDER = ["CareerMonke in numbers", "Companies hiring now (sample)", "cmp-h", "feat-h", "rv-h", "fd-h", "q-h", "w-h", "cta-h", "footer", "sb"];

type Input = { page: string; topCss: string; lowerCss: string; topRuntime: string; lowerRuntime: string; asset: (p: string) => Buffer | null };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const words = (s: string) =>
  squash(s.replace(/<!--[\s\S]*?-->|\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\{" "\}/g, " ").replace(/<[^>]+>/g, " ")).split(" ").filter(Boolean);
const attrs = (s: string, attr: string) => Array.from(s.matchAll(new RegExp(`\\s${attr}="([^"]*)"`, "g")), (m) => m[1]);
const decls = (s: string) =>
  squash(s.replace(/\/\*[\s\S]*?\*\//g, ""))
    .replace(/\s*([{};,:>+])\s*/g, "$1")
    .replace(/;}/g, "}");
const selectors = (css: string) => {
  const out: string[] = [];
  const flat = decls(css);
  for (const m of Array.from(flat.matchAll(/(?:^|[{}])([^{}@]+)\{/g))) {
    // split on top-level commas only (not inside :is(...) / :not(...))
    for (const s of m[1].split(/,(?![^(]*\))/)) if (s.trim() && !/^(\d+%|from|to)$/.test(s.trim())) out.push(s.trim());
  }
  return out;
};
const keyframes = (css: string) => Array.from(css.matchAll(/@keyframes\s+([\w-]+)/g), (m) => m[1]);

function check(x: Input) {
  // --- split the page into the top fold and the lower page ---
  const TOP_OPEN = "<div className={`cm-top ${jakarta.variable}`}>";
  const LOW_OPEN = '<div className="landing-wrapper" ref={lowerRef}>';
  const t0 = x.page.indexOf(TOP_OPEN), l0 = x.page.indexOf(LOW_OPEN), end = x.page.lastIndexOf("</>");
  assert.ok(t0 > 0 && l0 > t0 && end > l0, "page must render .cm-top then .landing-wrapper as siblings");
  const top = x.page.slice(t0 + TOP_OPEN.length, l0);
  const lower = x.page.slice(l0 + LOW_OPEN.length, end);

  // --- 1. top fold: unchanged from f21504b (text, classes), only the three hrefs ---
  const topSrc = read("tests/landing-ssampe-parity.source.html");
  const topBody = topSrc.match(/<body>([\s\S]*?)<script>/)![1];
  assert.deepEqual(words(top), words(topBody), "top fold text must match f21504b word for word");
  assert.deepEqual(attrs(top, "className"), attrs(topBody, "class"), "top fold classes must match f21504b");
  assert.deepEqual(attrs(top, "href"), ["#", "/login", "/signup", "/jobs"], "top fold links: Sign in /login, Sign up free /signup, View Jobs /jobs");
  assert.match(top, /<p className="kicker">Skip LinkedIn competition<\/p>/, "mobile kicker line must be present");

  // --- 2. lower page: 3386250 stats row .. sticky bar, hero/header/job cards excluded ---
  const lowSrc = read("tests/landing-ssampe-parity.lower.source.html");
  let want = lowSrc.match(/<svg[^>]*><symbol id="laurel"[\s\S]*?<\/svg>/)![0] + lowSrc.slice(lowSrc.indexOf('<section class="wrap s stats-row"'), lowSrc.indexOf("</aside>") + 8);
  want = want.replace("</main>", "");
  for (const [from, to] of CELLS) want = want.replace(`<span class="vx">${from}</span>`, `<span class="vx">${to}</span>`);
  assert.deepEqual(words(lower), words(want), "lower page copy must match 3386250 except the five CareerMonke Way cells");
  assert.deepEqual(attrs(lower, "className"), attrs(want, "class"), "lower page classes must match 3386250");
  const wantHrefs = attrs(want, "href").map((h) => h.replace(/^https:\/\/careermonke\.com\//, "/"));
  assert.deepEqual(attrs(lower, "href"), wantHrefs, "lower page links must match 3386250 (same-site links made relative)");
  assert.deepEqual(attrs(lower, "id"), attrs(want, "id"), "lower page ids (runtime hooks) must match 3386250");

  // --- 3. order, five cells, things that must not come back ---
  const order = Array.from(lower.matchAll(/<(section|footer|aside)\b([^>]*)>/g), (m) =>
    m[1] === "footer" ? "footer" : m[1] === "aside" ? "sb" : (m[2].match(/aria-(?:label|labelledby)="([^"]*)"/) || [])[1]
  );
  assert.deepEqual(order, LOWER_ORDER, "lower sections must be in 3386250 order");
  const cells = Array.from(lower.matchAll(/<span className="vx">\s*([^<]*?)\s*<\/span>/g), (m) => squash(m[1]));
  assert.deepEqual(cells.filter((_, i) => i % 2 === 1), CELLS.map((c) => c[1]), "CareerMonke Way cells must be exactly the five new lines, in order");
  const usual = Array.from(want.matchAll(/<tr><td>[\s\S]*?<span class="vx">([^<]*)<\/span>/g), (m) => m[1]);
  assert.deepEqual(cells.filter((_, i) => i % 2 === 0), usual, "Usual Grind column must be unchanged");
  for (const banned of ['id="hero-h"', "fj-cards", "hjs", "try-demo", 'data-run="tailor"', "A resume for every role", "github.com", "LandingJobsTickerStrip"]) {
    assert.ok(!x.page.includes(banned), `removed block must not come back: ${banned}`);
  }

  // --- 4. CSS: top = f21504b scoped .cm-top; lower = 3386250 scoped .landing-wrapper; nothing else ---
  const topWant = decls(topSrc.match(/<style>([\s\S]*?)<\/style>/)![1])
    .replace(/"Plus Jakarta Sans",system-ui/, 'var(--font-cm-jakarta),"Plus Jakarta Sans",system-ui')
    .replace(/\bpulse\b/g, "cm-landing-pulse");
  const topGot = decls(x.topCss)
    .replace(/\.cm-top a,\.cm-top button\{transition:none\}\.cm-top \.ring\{box-shadow:none\}@media \(max-width:359px\)\{\.cm-top \.job\{grid-template-columns:minmax\(0,1fr\)\}\.cm-top \.meta\{grid-template-columns:auto\}\}$/, "")
    .replace(/\.cm-top,\.cm-top \*\{/, "*{")
    .replace(/(^|\})\.cm-top\{--navy/, "$1:root{--navy")
    .replace(/(^|\})\.cm-top\{font-family/, "$1body{font-family")
    .replace(/\.cm-top /g, "");
  assert.equal(topGot, topWant, "top CSS must equal the f21504b CSS (scoped) plus the documented host neutralisers");

  const srcLowerCss = read("tests/landing-ssampe-parity.lower.landing.css") + "\n" + read("tests/landing-ssampe-parity.lower.site.css");
  const names = keyframes(srcLowerCss);
  const prefix = (v: string) => names.reduce((acc, n) => acc.replace(new RegExp(`(?<![\\w-])${n}(?![\\w-])`, "g"), `cml-${n}`), v);
  const lowerWant = decls(srcLowerCss)
    .replace(/@keyframes ([\w-]+)/g, "@keyframes cml-$1")
    .replace(/(animation(?:-name)?:)([^;}]*)/g, (_, k, v) => k + prefix(v))
    .replace(/(^|[{}])body\{/g, "$1.landing-wrapper{");
  const lowerGot = decls(x.lowerCss)
    .replace(/^\.landing-wrapper a,\.landing-wrapper button\{transition:none\}/, "")
    // owner-approved: below 360px only, founder stats columns may shrink so 320px reflows
    .replace(/@media \(max-width:359px\)\{\.landing-wrapper \.fd-stats\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}\.landing-wrapper \.fd-stats dt,\.landing-wrapper \.fd-stats dd\{overflow-wrap:anywhere\}\}$/, "");
  assert.equal(lowerGot, lowerWant, "lower CSS must equal 3386250 landing.css + site.css (keyframes cml-, body scoped) plus the documented host neutraliser");

  // --- 5. isolation: top and lower can't reach each other or other pages ---
  for (const s of selectors(x.topCss)) {
    assert.ok(s.startsWith(".cm-top") && !s.includes("landing-wrapper"), `top CSS selector must stay inside .cm-top: ${s}`);
  }
  for (const s of selectors(x.lowerCss)) {
    assert.ok(s.startsWith(".landing-wrapper") && !s.includes("cm-top"), `lower CSS selector must stay inside .landing-wrapper: ${s}`);
  }
  const topKf = keyframes(x.topCss), lowKf = keyframes(x.lowerCss);
  assert.deepEqual(topKf, ["cm-landing-pulse"], "top CSS owns exactly one keyframes name");
  assert.ok(lowKf.length > 0 && lowKf.every((k) => k.startsWith("cml-")), "lower keyframes must all be cml- prefixed");
  assert.ok(!lowKf.some((k) => topKf.includes(k)), "top and lower keyframes must not collide");
  for (const css of [x.topCss, x.lowerCss].map((c) => c.replace(/\/\*[\s\S]*?\*\//g, ""))) assert.doesNotMatch(css, /@import|@font-face|(^|[{}\s]):root\b|(^|[{}\s])(html|body)\s*[{,]/, "landing CSS must not touch :root, html, body or load fonts");

  // --- 6. assets: every image the lower page uses is the pinned 3386250 file ---
  const srcs = attrs(lower, "src");
  assert.ok(srcs.length > 0, "lower page must reference its images");
  for (const s of srcs) {
    assert.ok(ASSETS[s], `unexpected asset ${s}`);
    const buf = x.asset(s);
    assert.ok(buf, `asset ${s} must exist in public/`);
    assert.equal(blob(buf), ASSETS[s], `asset ${s} must be byte-identical to ssampe@3386250`);
  }

  // --- 7. runtimes: scoped queries and complete cleanup, wired into the page effect ---
  assert.match(x.topRuntime, /Math\.round\(first\.offsetHeight \* 0\.5 \+ 28\)/);
  assert.match(x.topRuntime, /querySelector<HTMLElement>\("\.cm-top \.peek"\)/, "top runtime must query inside .cm-top");
  assert.match(x.topRuntime, /return \(\) => ro\.disconnect\(\)/, "top runtime must disconnect its ResizeObserver");
  assert.doesNotMatch(x.lowerRuntime, /document\.(getElementById|querySelector)/, "lower runtime must query inside its root only");
  for (const re of [/clearTimers\(\);/, /cleanups\.forEach\(\(c\) => c\(\)\);/, /cardStops\.forEach/, /cancelAnimationFrame\(gLoopReq\)/, /cancelAnimationFrame\(rvReq\)/, /clearInterval\(tourT\)/, /compObserver\.disconnect\(\)/, /globeObserver\.disconnect\(\)/, /cardObservers\.forEach\(\(io\) => io\.disconnect\(\)\)/]) {
    assert.match(x.lowerRuntime, re, `lower runtime cleanup must include ${re}`);
  }
  assert.match(x.lowerRuntime, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/, "lower runtime must honour reduced motion");
  assert.match(x.page, /const stopTop = initCareerMonkeLanding\(\);[\s\S]*initCareerMonkeLandingLower\(lowerRef\.current\)[\s\S]*return \(\) => \{\s*stopTop\(\);\s*stopLower\(\);\s*\};/, "page effect must start both runtimes and clean both up");
  assert.doesNotMatch(x.page, /iframe|workers\.dev|from "vite"|import\.meta\.env/, "no iframe, worker redirect or Vite");
}

// ---------------- run on the real files ----------------
for (const [p, sha] of Object.entries(SOURCES)) assert.equal(blob(fs.readFileSync(path.join(root, p))), sha, `${p} must be the pinned upstream file`);
const real: Input = {
  page: read("src/app/page.tsx"),
  topCss: read("src/styles/careermonke-landing.css"),
  lowerCss: read("src/styles/careermonke-landing-lower.css"),
  topRuntime: read("src/components/landing/careermonke-landing-runtime.ts"),
  lowerRuntime: read("src/components/landing/careermonke-landing-lower-runtime.ts"),
  asset: (p) => { const f = path.join(root, "public", p); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
};
check(real);

// ---------------- negative controls: each broken copy must fail ----------------
const mut = (k: keyof Omit<Input, "asset">, a: string | RegExp, b: string): Input => {
  const v = real[k] as string;
  const next = v.replace(a, b);
  assert.notEqual(next, v, `negative control did not apply: ${String(a)}`);
  return { ...real, [k]: next };
};
const controls: [string, Input][] = [ // each must fail for its own reason (see WHY below)
  ["hero copy changed", mut("page", "1,240 new jobs found today", "1,250 new jobs found today")],
  ["kicker removed", mut("page", '<p className="kicker">Skip LinkedIn competition</p>', "")],
  ["top link changed", mut("page", 'href="/login"', 'href="/signin"')],
  ["lower copy changed", mut("page", "Orissa here!", "Orissa here")],
  ["CareerMonke cell reverted", mut("page", "Jobs matched to your resume", "Under 20 applicants, direct")],
  ["Usual Grind cell changed", mut("page", "Hours tailoring every bullet", "Hours tailoring each bullet")],
  ["FAQ moved above founder", (() => {
    const p = real.page, f = p.indexOf('<section className="wrap s fd"'), q = p.indexOf('<section className="wrap s band" aria-labelledby="q-h">'), w = p.indexOf('<section className="wrap s" aria-labelledby="w-h">');
    return { ...real, page: p.slice(0, f) + p.slice(q, w) + p.slice(f, q) + p.slice(w) };
  })()],
  ["lower link absolutised", mut("page", 'href="/radar"', 'href="https://careermonke.com/radar"')],
  ["AI-resume panel back", mut("page", 'data-run="match"', 'data-run="tailor"')],
  ["footer GitHub link back", mut("page", 'href="https://x.com/careermonke"', 'href="https://github.com/careermonke"')],
  ["top CSS value changed", mut("topCss", "max-width: 1080px", "max-width: 1100px")],
  ["top CSS unscoped rule", mut("topCss", /$/, "\nh2 { color: red; }\n")],
  ["top CSS reaches lower", mut("topCss", /$/, "\n.cm-top .landing-wrapper .h2 { color: red; }\n")],
  ["lower CSS value changed", mut("lowerCss", ".landing-wrapper .fd{max-width:760px}", ".landing-wrapper .fd{max-width:780px}")],
  ["lower CSS global body", mut("lowerCss", /$/, "\nbody{margin:0}\n")],
  ["keyframes collide", mut("lowerCss", "@keyframes cml-blink", "@keyframes cm-landing-pulse")],
  ["top runtime leaks observer", mut("topRuntime", "return () => ro.disconnect();", "return () => {};")],
  ["lower runtime leaks marquee frame", mut("lowerRuntime", "if (rvReq) cancelAnimationFrame(rvReq);", "")],
  ["lower runtime unscoped query", mut("lowerRuntime", "root.querySelector<HTMLElement>(\".sb\")", "document.querySelector<HTMLElement>(\".sb\")")],
  ["asset swapped", { ...real, asset: (p) => (p === "/owner.jpg" ? Buffer.from("not the photo") : real.asset(p)) }],
];
const WHY: Record<string, RegExp> = {
  "hero copy changed": /top fold text/,
  "kicker removed": /top fold text/,
  "top link changed": /top fold links/,
  "lower copy changed": /lower page copy/,
  "CareerMonke cell reverted": /lower page copy/,
  "Usual Grind cell changed": /lower page copy/,
  "FAQ moved above founder": /lower page copy/,
  "lower link absolutised": /lower page links/,
  "AI-resume panel back": /lower page classes|removed block|lower page copy/,
  "footer GitHub link back": /lower page links/,
  "top CSS value changed": /top CSS must equal/,
  "top CSS unscoped rule": /top CSS must equal/,
  "top CSS reaches lower": /top CSS must equal/,
  "lower CSS value changed": /lower CSS must equal/,
  "lower CSS global body": /lower CSS must equal/,
  "keyframes collide": /lower CSS must equal/,
  "top runtime leaks observer": /disconnect its ResizeObserver/,
  "lower runtime leaks marquee frame": /lower runtime cleanup must include \/cancelAnimationFrame\\\(rvReq/,
  "lower runtime unscoped query": /query inside its root/,
  "asset swapped": /byte-identical/,
};
for (const [name, input] of controls) {
  assert.throws(() => check(input), (e: Error) => WHY[name].test(e.message), `negative control "${name}" must fail with /${WHY[name]?.source}/`);
}

console.log(`landing-ssampe-parity: OK (${controls.length} negative controls failed as expected)`);
