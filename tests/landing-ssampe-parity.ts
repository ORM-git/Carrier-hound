/**
 * Parity guard: the home page must stay an exact port of ORM-git/ssampe index.html
 * @ f21504b30e3466952208cbbcc426877268a11baf (vendored as landing-ssampe-parity.source.html).
 * Run: npx tsx tests/landing-ssampe-parity.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const source = read("tests/landing-ssampe-parity.source.html");
const page = read("src/app/page.tsx");
const css = read("src/styles/careermonke-landing.css");
const runtime = read("src/components/landing/careermonke-landing-runtime.ts");

const srcBody = source.match(/<body>([\s\S]*?)<script>/)![1];
const markup = page.slice(page.indexOf("return ("));
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// 1. Same visible text, in the same order.
const texts = (s: string) =>
  squash(s.replace(/<!--[\s\S]*?-->|\{\/\*[\s\S]*?\*\/\}/g, "").replace(/<[^>]+>/g, " ").replace(/\{" "\}|[(){};]/g, " "))
    .replace(/return|\$\{[^}]*\}/g, "")
    .split(" ")
    .filter(Boolean);
const want = texts(srcBody);
const got = texts(markup).filter((w) => !["`landing-wrapper", "jakarta.variable`", "`"].includes(w));
assert.deepEqual(got, want, "visible text must match the source word for word");
assert.match(srcBody, /<p class="kicker">Skip LinkedIn competition<\/p>/);
assert.match(page, /<p className="kicker">Skip LinkedIn competition<\/p>/, "mobile kicker line must be present");

// 2. Same classes, in the same order.
const classes = (s: string, attr: string) => Array.from(s.matchAll(new RegExp(`${attr}="([^"]*)"`, "g")), (m) => m[1]);
assert.deepEqual(classes(markup, "className"), classes(srcBody, "class"), "class list must match the source");

// 3. Only the three placeholder hrefs change.
assert.deepEqual(classes(srcBody, "href"), ["#", "#", "#", "#"]);
assert.deepEqual(classes(markup, "href"), ["#", "/login", "/signup", "/jobs"]);
assert.match(markup, /href="\/login" className="btn-ghost"/);
assert.match(markup, /href="\/signup" className="btn-dark"/);
assert.match(markup, /href="\/jobs" className="btn-cta"/);
assert.doesNotMatch(page, /iframe|workers\.dev/, "no iframe / worker redirect");

// 4. CSS = source CSS with every selector scoped, plus the documented host neutraliser only.
const decls = (s: string) =>
  squash(s.replace(/\/\*[\s\S]*?\*\//g, ""))
    .replace(/\s*([{};,:>+])\s*/g, "$1")
    .replace(/;}/g, "}");
const srcCss = source.match(/<style>([\s\S]*?)<\/style>/)![1];
const expected = decls(srcCss)
  .replace(/"Plus Jakarta Sans",system-ui/, 'var(--font-cm-jakarta),"Plus Jakarta Sans",system-ui')
  .replace(/\bpulse\b/g, "cm-landing-pulse");
const ours = decls(css)
  .replace(/\.landing-wrapper a,\.landing-wrapper button\{transition:none\}\.landing-wrapper \.ring\{box-shadow:none\}@media \(max-width:359px\)\{\.landing-wrapper \.job\{grid-template-columns:minmax\(0,1fr\)\}\.landing-wrapper \.meta\{grid-template-columns:auto\}\}$/, "")
  .replace(/\.landing-wrapper,\.landing-wrapper \*\{/, "*{")
  .replace(/(^|\})\.landing-wrapper\{--navy/, "$1:root{--navy")
  .replace(/(^|\})\.landing-wrapper\{font-family/, "$1body{font-family")
  .replace(/\.landing-wrapper /g, "");
assert.equal(ours, expected, "landing CSS must equal the source CSS (scoped)");
for (const sel of squash(css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^{}]*\}/g, "\n")).split(/[\n,]/)) {
  const s = sel.trim();
  if (!s || s.startsWith("@") || /^(\d+%|from|to)/.test(s) || s === "}") continue;
  assert.ok(s.startsWith(".landing-wrapper"), `unscoped selector: ${s}`);
}

// 5. Runtime: same peek maths, observer cleaned up.
assert.match(runtime, /Math\.round\(first\.offsetHeight \* 0\.5 \+ 28\)/);
assert.match(runtime, /new ResizeObserver\(set\)/);
assert.match(runtime, /ro\.disconnect\(\)/);
assert.match(page, /useEffect\(\(\) => initCareerMonkeLanding\(\), \[\]\)/);

console.log("landing-ssampe-parity: OK");
