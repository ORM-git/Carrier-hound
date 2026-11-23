/**
 * Parity guard for the composite home page:
 *   - top fold  = ORM-git/ssampe index.html @ f21504b30e3466952208cbbcc426877268a11baf  (scoped .cm-top)
 *   - lower page = ORM-git/ssampe @ 3386250e9aef17b68666bc471e5c8293e8f02bc9, stats row .. footer + sticky bar
 *                  (index.html + src/landing.css + src/site.css, scoped .landing-wrapper)
 *   - owner-requested hero text: ssampe@3386250 ascending m/a/x/x typography inside the f21504b fold layout
 *   - owner-requested live content (careermonke.com snapshot in landing-ssampe-parity.live-content.json):
 *     moving reviews, review wall, founder card + socials (stat row removed), and the header logo
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
const LOWER_ORDER = ["CareerMonke in numbers", "cmp-h", "feat-h", "rv-h", "fd-h", "q-h", "w-h", "cta-h", "footer", "sb"];

// Owner-requested live content (careermonke.com snapshot): review records, orders, founder card, header logo.
type Review = { id: string; name: string; initials: string; location: string; quote: string; avatar: string; avatarSha256: string };
const LIVE: {
  reviews: Review[];
  movingRow: { heading: string; order: string[] };
  wall: { heading: string; columns: { className: string; order: string[] }[] };
  founder: { photo: string; alt: string; width: number; height: number; heading: string; role: string; socials: { label: string; href: string; external: boolean }[] };
  headerLogo: { src: string; sha256: string; natural: number[]; linkLabel: string };
  unchanged: { favicon: { path: string; sha256: string } };
} = JSON.parse(read("tests/landing-ssampe-parity.live-content.json"));
const REV = Object.fromEntries(LIVE.reviews.map((r) => [r.id, r]));
const sha256 = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");
const FOUNDER_BIO = [
  "Growing up in the US and living in India showed me the friction of job hunting is universal. Broken software discards qualified people, and legacy sites make every role a cattle call.",
  "I built CareerMonke to cut through the noise, give candidates leverage back, and land your story directly with real people without the unnecessary hollow hustle rhetoric.",
];
// The three restored 3386250 sections replaced by live content, rebuilt here from the fixture (HTML form).
const liveCard = (cls: string, by: string, size: number, r: Review, hidden: boolean) =>
  `<li class="${cls}"${hidden ? ' aria-hidden="true"' : ""}><blockquote>“${r.quote}”</blockquote><${by === "wl-by" ? "p" : "div"} class="${by}"><span class="mq-av"><img src="${r.avatar}" alt="" width="${size}" height="${size}"><i>${r.initials}</i></span><span><b>${r.name}</b><small>${r.location}</small></span></${by === "wl-by" ? "p" : "div"}></li>`;
const LIVE_SECTIONS = {
  rv: () => {
    const rs = LIVE.movingRow.order.map((id) => REV[id]);
    return `<section class="s rv" aria-labelledby="rv-h"><div class="wrap"><h2 class="h2" id="rv-h">From early&#8209;access users</h2></div><ul class="rv-track">${rs.map((r) => liveCard("rv-card", "rv-by", 36, r, false)).join("")}${rs.map((r) => liveCard("rv-card", "rv-by", 36, r, true)).join("")}</ul><p class="rv-hint">Swipe for more</p></section>`;
  },
  fd: () => {
    const f = LIVE.founder;
    return `<section class="wrap s fd" aria-labelledby="fd-h"><div class="founder"><img src="${f.photo}"><div class="founder-body"><h2 id="fd-h">${f.heading}</h2><p class="role">${f.role}</p>${FOUNDER_BIO.map((b) => `<p class="bio">${b}</p>`).join("")}<div class="socials">${f.socials.map((s) => `<a href="${s.href}"></a>`).join("")}</div></div></div></section>`;
  },
  wl: () =>
    `<section class="wrap s" aria-labelledby="w-h"><h2 class="h2" id="w-h">${LIVE.wall.heading}</h2><div class="wl">${LIVE.wall.columns
      .map((c) => {
        const rs = c.order.map((id) => REV[id]);
        return `<ul class="wl-col ${c.className}">${rs.map((r) => liveCard("wl-card", "wl-by", 28, r, false)).join("")}${rs.map((r) => liveCard("wl-card", "wl-by", 28, r, true)).join("")}</ul>`;
      })
      .join("")}</div></section>`,
};
// Parse rendered review cards back into records: [hidden, quote, photo, initials, name, location].
const cardsIn = (jsx: string, cls: string) =>
  Array.from(jsx.matchAll(new RegExp(`<li className="${cls}"( aria-hidden="true")?>([\\s\\S]*?)</li>`, "g")), (m) => {
    const t = squash(m[2].replace(/\{" "\}/g, " "));
    const g = (re: RegExp) => squash((t.match(re) || [])[1] || "");
    return { hidden: !!m[1], quote: g(/<blockquote>([\s\S]*?)<\/blockquote>/), photo: g(/src="([^"]+)"/), initials: g(/<i>([\s\S]*?)<\/i>/), name: g(/<b>([\s\S]*?)<\/b>/), location: g(/<small>([\s\S]*?)<\/small>/) };
  });
const expectCards = (ids: string[], label: string, got: ReturnType<typeof cardsIn>) => {
  const want = [...ids.map((id) => [id, false] as const), ...ids.map((id) => [id, true] as const)];
  assert.equal(got.length, want.length, `${label} must have ${ids.length} primary + ${ids.length} duplicate cards (got ${got.length})`);
  want.forEach(([id, hidden], i) => {
    const r = REV[id];
    assert.deepEqual(
      got[i],
      { hidden, quote: `“${r.quote}”`, photo: r.avatar, initials: r.initials, name: r.name, location: r.location },
      `${label} card ${i + 1} must be the exact ${id} ${r.name} record (quote/photo/initials/name/location${hidden ? ", aria-hidden duplicate" : ""})`
    );
  });
};

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

  // --- 1. top fold: unchanged from f21504b (text, classes), only the three hrefs and the header logo ---
  const topSrc = read("tests/landing-ssampe-parity.source.html");
  const CM_BADGE = '<a href="#" class="brand"><span class="brand-mark">CM</span>CareerMonke</a>';
  assert.ok(topSrc.includes(CM_BADGE), "fixture must still hold the original CM badge");
  const SRC_H1 = '<h1>Start jobma<span class="xx">XX</span>ing with AI</h1>';
  assert.ok(topSrc.includes(SRC_H1), "fixture must still hold the original f21504b headline");
  // Owner-requested exceptions: the CM badge becomes the real CareerMonke monkey logo, and the headline
  // uses the approved ssampe@3386250 ascending m/a/x/x treatment (same words, accessible name on the h1).
  const topBody = topSrc
    .match(/<body>([\s\S]*?)<script>/)![1]
    .replace(CM_BADGE, '<a href="#" class="brand" aria-label="CareerMonke home"><img class="brand-logo" src="/careermonke-logo.png" alt="" width="617" height="749">CareerMonke</a>')
    .replace(
      SRC_H1,
      '<h1 aria-label="Start jobmaxxing with AI">Start <span class="nw">job<span class="mx"><span class="m1" aria-hidden="true">m</span><span class="m2" aria-hidden="true">a</span><span class="m3" aria-hidden="true">x</span><span class="m4" aria-hidden="true">x</span></span>ing</span> with&nbsp;AI</h1>'
    );
  assert.match(
    squash(top.replace(/\{" "\}/g, " ")),
    /<h1 aria-label="Start jobmaxxing with AI"> Start <span className="nw"> job <span className="mx"> (<span className="m([1-4])" aria-hidden="true"> [max] <\/span> ){4}<\/span> ing <\/span> with&nbsp;AI <\/h1>/,
    "headline must be 'Start jobmaxxing with AI' with ascending m/a/x/x spans inside a no-wrap word and 'with AI' kept together"
  );
  assert.ok(!top.includes('className="xx"'), "flat gradient XX must be gone");
  assert.deepEqual(words(top), words(topBody), "top fold text must match f21504b word for word");
  assert.deepEqual(attrs(top, "className"), attrs(topBody, "class"), "top fold classes must match f21504b");
  assert.deepEqual(attrs(top, "href"), ["#", "/login", "/signup", "/jobs"], "top fold links: Sign in /login, Sign up free /signup, View Jobs /jobs");
  assert.match(top, /<p className="kicker">Skip LinkedIn competition<\/p>/, "mobile kicker line must be present");
  assert.match(
    squash(top),
    /<a href="#" className="brand" aria-label="CareerMonke home"> ?<img className="brand-logo" src="\/careermonke-logo\.png" alt="" width="617" height="749" ?\/> ?CareerMonke ?<\/a>/,
    "header must use the real CareerMonke logo (617x749, decorative alt, link named 'CareerMonke home')"
  );
  assert.ok(!top.includes("brand-mark"), "header CM badge must be gone");
  const logo = x.asset(LIVE.headerLogo.src);
  assert.ok(logo && sha256(logo) === LIVE.headerLogo.sha256, "header logo must be the live careermonke-logo.png bytes");

  // --- 2. lower page: 3386250 stats row .. sticky bar, hero/header/job cards excluded ---
  const lowSrc = read("tests/landing-ssampe-parity.lower.source.html");
  let want = lowSrc.match(/<svg[^>]*><symbol id="laurel"[\s\S]*?<\/svg>/)![0] + lowSrc.slice(lowSrc.indexOf('<section class="wrap s stats-row"'), lowSrc.indexOf("</aside>") + 8);
  want = want.replace("</main>", "");
  for (const [from, to] of CELLS) want = want.replace(`<span class="vx">${from}</span>`, `<span class="vx">${to}</span>`);
  // Owner-requested: moving reviews, founder block and review wall come from live careermonke.com.
  for (const [start, build] of [
    ['<section class="ls" aria-label="Companies hiring now (sample)">', () => ""],
    ['<section class="s rv" aria-labelledby="rv-h">', LIVE_SECTIONS.rv],
    ['<section class="wrap s fd" aria-labelledby="fd-h">', LIVE_SECTIONS.fd],
    ['<section class="wrap s" aria-labelledby="w-h">', LIVE_SECTIONS.wl],
  ] as const) {
    const a = want.indexOf(start);
    assert.ok(a >= 0 && want.indexOf(start, a + 1) < 0, `fixture section must exist once: ${start}`);
    want = want.slice(0, a) + build() + want.slice(want.indexOf("</section>", a) + "</section>".length);
  }
  assert.deepEqual(words(lower), words(want), "lower page copy must match 3386250 except the five CareerMonke Way cells and the live review/founder content");
  assert.deepEqual(attrs(lower, "className"), attrs(want, "class"), "lower page classes must match 3386250");
  const wantHrefs = attrs(want, "href").map((h) => h.replace(/^https:\/\/careermonke\.com\//, "/"));
  assert.deepEqual(attrs(lower, "href"), wantHrefs, "lower page links must match 3386250 (same-site links made relative)");
  assert.deepEqual(attrs(lower, "id"), attrs(want, "id"), "lower page ids (runtime hooks) must match 3386250");

  // --- 3. order, five cells, things that must not come back ---
  const order = Array.from(lower.matchAll(/<(section|footer|aside)\b([^>]*)>/g), (m) =>
    m[1] === "footer" ? "footer" : m[1] === "aside" ? "sb" : (m[2].match(/aria-(?:label|labelledby)="([^"]*)"/) || [])[1]
  );
  assert.deepEqual(order, LOWER_ORDER, "lower sections must be in 3386250 order");
  // Owner-requested: the real jobs ticker sits exactly where the sample company strip was (stats row -> ticker -> comparison).
  const statsEnd = lower.indexOf('id="stats-note"'), tickerAt = lower.indexOf("<LandingJobsTickerStrip />"), cmpAt = lower.indexOf('aria-labelledby="cmp-h"');
  assert.ok(statsEnd > 0 && statsEnd < tickerAt && tickerAt < cmpAt, "real jobs ticker must sit between the stats row and the comparison");
  assert.equal(lower.split("<LandingJobsTickerStrip").length - 1, 1, "exactly one jobs ticker");
  const cells = Array.from(lower.matchAll(/<span className="vx">\s*([^<]*?)\s*<\/span>/g), (m) => squash(m[1]));
  assert.deepEqual(cells.filter((_, i) => i % 2 === 1), CELLS.map((c) => c[1]), "CareerMonke Way cells must be exactly the five new lines, in order");
  const usual = Array.from(want.matchAll(/<tr><td>[\s\S]*?<span class="vx">([^<]*)<\/span>/g), (m) => m[1]);
  assert.deepEqual(cells.filter((_, i) => i % 2 === 0), usual, "Usual Grind column must be unchanged");
  for (const banned of ['id="hero-h"', "fj-cards", "hjs", "try-demo", 'data-run="tailor"', "A resume for every role", "github.com", "Companies hiring now (sample)", 'className="ls-card"']) {
    assert.ok(!x.page.includes(banned), `removed block must not come back: ${banned}`);
  }

  // --- 3b. live reviews: exact records, pairing, order and duplicate groups; no placeholders or ratings ---
  for (const banned of ["PLACEHOLDER", "[Reviewer name", "★", "out of 5 stars", "rv-st", "[00K+]", "fd-stats", "stat label"]) {
    assert.ok(!x.page.includes(banned), `placeholder/rating text must be gone: ${banned}`);
  }
  assert.doesNotMatch(lower, /<i>\s*R[1-6]\s*<\/i>|>\s*R[1-6]\s*</, "placeholder R1-R6 avatar tokens must be gone");
  const rvAt = lower.indexOf('<ul className="rv-track"'), rvEnd = lower.indexOf("</ul>", rvAt);
  assert.match(lower, /<h2 className="h2" id="rv-h">\s*From early&#8209;access users\s*<\/h2>/, "moving row heading must be 'From early‑access users'");
  expectCards(LIVE.movingRow.order, "moving row", cardsIn(lower.slice(rvAt, rvEnd), "rv-card"));
  assert.match(lower, /<h2 className="h2" id="w-h">\s*What job seekers are saying\s*<\/h2>/, "review wall heading must be 'What job seekers are saying'");
  const cols = Array.from(lower.matchAll(/<ul className="wl-col (wl-down|wl-up)">([\s\S]*?)<\/ul>/g));
  assert.deepEqual(cols.map((c) => c[1]), LIVE.wall.columns.map((c) => c.className), "review wall must keep down/up/down columns");
  cols.forEach((c, i) => expectCards(LIVE.wall.columns[i].order, `review wall column ${i + 1}`, cardsIn(c[2], "wl-card")));
  for (const r of LIVE.reviews) {
    const buf = x.asset(r.avatar);
    assert.ok(buf && sha256(buf) === r.avatarSha256, `avatar ${r.avatar} for ${r.name} must be the live file`);
  }

  // --- 3c. live founder card: photo, copy, exact social links, no stat row ---
  const f = LIVE.founder;
  const fdAt = lower.indexOf('<section className="wrap s fd"'), fdSec = lower.slice(fdAt, lower.indexOf("</section>", fdAt));
  assert.match(squash(fdSec), new RegExp(`<img src="${f.photo}" alt="${f.alt}" width="${f.width}" height="${f.height}" loading="lazy" />`), "founder photo must be /owner.jpg, 112x112, with its alt text");
  const fdFlat = squash(fdSec.replace(/\{" "\}/g, " "));
  for (const b of FOUNDER_BIO) assert.ok(fdFlat.includes(b), "founder bio must be unchanged");
  const socials = Array.from(fdSec.matchAll(/<a\s([^>]*)>/g), (m) => squash(m[1]));
  assert.deepEqual(
    socials,
    f.socials.map((s) => `href="${s.href}"${s.external ? ' target="_blank" rel="noopener noreferrer"' : ""} aria-label="${s.label}"`),
    "founder social links must be exactly Instagram, LinkedIn (new tab, noopener noreferrer) and Email"
  );
  assert.ok(!/<dl\b/.test(fdSec), "founder stat row must be removed");

  // --- 3d. unchanged: footer logo and favicon ---
  assert.match(squash(lower), /<img src="\/careermonke-logo\.png" alt="CareerMonke" width="66" height="80" loading="lazy" \/>/, "footer monkey logo must be unchanged");
  const fav = x.asset(LIVE.unchanged.favicon.path);
  assert.ok(fav && sha256(fav) === LIVE.unchanged.favicon.sha256, "favicon must be unchanged");

  // --- 4. CSS: top = f21504b scoped .cm-top; lower = 3386250 scoped .landing-wrapper; nothing else ---
  const topWant = decls(topSrc.match(/<style>([\s\S]*?)<\/style>/)![1])
    .replace(/"Plus Jakarta Sans",system-ui/, 'var(--font-cm-jakarta),"Plus Jakarta Sans",system-ui')
    .replace(/\bpulse\b/g, "cm-landing-pulse");
  const HERO_MARK = "/* ---- Approved hero text";
  const heroAt = x.topCss.indexOf(HERO_MARK);
  assert.ok(heroAt > 0, "top CSS must keep the approved hero text block last");
  const topGot = decls(x.topCss.slice(0, heroAt))
    .replace(/\.cm-top a,\.cm-top button\{transition:none\}\.cm-top \.ring\{box-shadow:none\}@media \(max-width:359px\)\{\.cm-top \.job\{grid-template-columns:minmax\(0,1fr\)\}\.cm-top \.meta\{grid-template-columns:auto\}\}$/, "")
    .replace(/\.cm-top,\.cm-top \*\{/, "*{")
    .replace(/(^|\})\.cm-top\{--navy/, "$1:root{--navy")
    .replace(/(^|\})\.cm-top\{font-family/, "$1body{font-family")
    .replace(/\.cm-top /g, "");
  // Single owner-requested exception: the CM badge rule became the logo rule (32px high, natural 617x749 ratio).
  const LOGO_RULE = ".brand-logo{flex:none;height:32px;width:auto;aspect-ratio:617 / 749;object-fit:contain}";
  const BADGE_RULE = ".brand-mark{width:32px;height:32px;border-radius:9px;background:linear-gradient(145deg,#a0522d,#6b3519);display:grid;place-items:center;color:#fde7cf;font-size:12px;font-weight:800}";
  assert.ok(topGot.includes(LOGO_RULE), "top CSS must size the header logo to 32px without distortion");
  assert.equal(topGot.replace(LOGO_RULE, BADGE_RULE), topWant, "top CSS must equal the f21504b CSS (scoped) plus the documented host neutralisers and the header-logo rule");
  // The appended hero block may only restyle the hero text (badge, kicker, headline, maxx letters, subtext).
  const heroBlock = x.topCss.slice(heroAt);
  const HERO_SELECTORS = new Set(
    [".pill", ".pill-dot", ".kicker", "h1", "h1 .nw", "h1 .mx", "h1 .mx span", "h1 .m1", "h1 .m2", "h1 .m3", "h1 .m4", ".subhead"].map((s) => `.cm-top ${s}`)
  );
  for (const s of selectors(heroBlock)) assert.ok(HERO_SELECTORS.has(s), `hero text CSS may not style anything else: ${s}`);
  assert.doesNotMatch(heroBlock, /@keyframes|animation|margin|display:\s*none|position:\s*(absolute|fixed)/, "hero text CSS must not change layout, spacing or animation");
  const heroFlat = decls(heroBlock);
  for (const d of [
    ".cm-top h1 .m1{font-size:1.08em}", ".cm-top h1 .m2{font-size:1.32em}", ".cm-top h1 .m3{font-size:1.62em}", ".cm-top h1 .m4{font-size:2em}",
    ".cm-top h1 .nw{white-space:nowrap}", ".cm-top h1 .mx span{display:inline-block;line-height:.5;transform-origin:50% 100%}",
    'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
    "color:#090E34", ".cm-top h1{font-size:72px}", ".cm-top .kicker{font-size:28px}", ".cm-top .subhead{max-width:46ch;font-size:16px;line-height:20px}",
  ]) {
    assert.ok(heroFlat.includes(d), `hero text CSS must keep the approved 3386250 treatment: ${d}`);
  }
  assert.doesNotMatch(heroFlat, /background-clip|gradient|Jakarta/, "hero headline must be solid navy in the system font, not the flat gradient XX / Jakarta look");

  const srcLowerCss = read("tests/landing-ssampe-parity.lower.landing.css") + "\n" + read("tests/landing-ssampe-parity.lower.site.css");
  const names = keyframes(srcLowerCss);
  const prefix = (v: string) => names.reduce((acc, n) => acc.replace(new RegExp(`(?<![\\w-])${n}(?![\\w-])`, "g"), `cml-${n}`), v);
  const lowerWant = decls(srcLowerCss)
    .replace(/@keyframes ([\w-]+)/g, "@keyframes cml-$1")
    .replace(/(animation(?:-name)?:)([^;}]*)/g, (_, k, v) => k + prefix(v))
    .replace(/(^|[{}])body\{/g, "$1.landing-wrapper{")
    // owner-requested: the founder stat row is removed, so its stat-only rules go too
    .replace(/(?<=^|[{}])\.landing-wrapper \.fd-stats[^{]*\{[^}]*\}/g, "")
    // owner-requested (#698): the real ticker replaces the sample strip and keeps its spacing hook (52px / 38px)
    .replace(".landing-wrapper .ls+section.s{", ".landing-wrapper .ls+section.s,.landing-wrapper .jobs-ticker-strip+section.s{");
  const LIVE_MARK = "/* ---- Live review cards + founder card";
  const liveAt = x.lowerCss.indexOf(LIVE_MARK);
  assert.ok(liveAt > 0, "lower CSS must keep the live review/founder block last");
  const lowerGot = decls(x.lowerCss.slice(0, liveAt)).replace(/^\.landing-wrapper a,\.landing-wrapper button\{transition:none\}/, "");
  assert.equal(lowerGot, lowerWant, "lower CSS must equal 3386250 landing.css + site.css (keyframes cml-, body scoped, stat rules removed) plus the documented host neutraliser");
  // The appended live block may only style the review cards and the founder card.
  const LIVE_SELECTORS = new Set(
    [".rv-card", ".rv-card blockquote", ".rv-by", ".rv-by b", ".rv-by small", ".founder", ".founder img", ".founder-body", ".founder h2", ".founder .role",
      ".founder p.bio", ".founder p.bio+p.bio", ".founder .socials", ".founder .socials a", ".founder .socials a:hover"].map((s) => `.landing-wrapper ${s}`)
  );
  const liveBlock = x.lowerCss.slice(liveAt);
  for (const s of selectors(liveBlock)) assert.ok(LIVE_SELECTORS.has(s), `live review/founder CSS may not style anything else: ${s}`);
  assert.doesNotMatch(liveBlock, /@keyframes|animation/, "live review/founder CSS must not add animations");
  for (const d of [".landing-wrapper .founder img{width:88px;height:88px", ".landing-wrapper .founder img{width:100px;height:100px}", "grid-template-columns:100px 1fr", ".landing-wrapper .rv-card{flex:0 0 280px", ".landing-wrapper .rv-card{flex-basis:340px"]) {
    assert.ok(decls(liveBlock).includes(d), `live review/founder CSS must match the live card: ${d}`);
  }

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
  const avatars = new Map(LIVE.reviews.map((r) => [r.avatar, r.avatarSha256]));
  for (const s of srcs) {
    const buf = x.asset(s);
    assert.ok(buf, `asset ${s} must exist in public/`);
    if (avatars.has(s)) assert.equal(sha256(buf), avatars.get(s), `avatar ${s} must be the live careermonke.com file`);
    else {
      assert.ok(ASSETS[s], `unexpected asset ${s}`);
      assert.equal(blob(buf), ASSETS[s], `asset ${s} must be byte-identical to ssampe@3386250`);
    }
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
  // live reviews / founder / header logo
  ["review photo swapped", mut("page", 'src="/images/avatars/male-1.webp"', 'src="/images/avatars/female-1.webp"')],
  ["review name swapped", mut("page", "<b>Rohan S.</b>", "<b>Pooja Verma</b>")],
  ["review quote swapped", mut("page", "Honestly didn't expect much", "Honestly did expect much")],
  ["wall column order swapped", (() => {
    const p = real.page, u = p.indexOf('<ul className="wl-col wl-down">');
    const a = p.indexOf('<li className="wl-card">', u), b = p.indexOf('<li className="wl-card">', a + 1), c = p.indexOf('<li className="wl-card">', b + 1);
    return { ...real, page: p.slice(0, a) + p.slice(b, c) + p.slice(a, b) + p.slice(c) };
  })()],
  ["moving-row duplicate missing", (() => {
    const p = real.page, a = p.indexOf('<li className="rv-card" aria-hidden="true">'), b = p.indexOf("</li>", a) + 5;
    return { ...real, page: p.slice(0, a) + p.slice(b) };
  })()],
  ["placeholder review back", mut("page", "Honestly didn't expect much", "[PLACEHOLDER REVIEW 1: replace with a real CareerMonke user quote.] Honestly didn't expect much")],
  ["star rating back", mut("page", "<small>Bengaluru</small>", "<small>★★★★★</small>")],
  ["founder stat row back", mut("page", '<div className="socials">', '<dl className="fd-stats"><div><dt>Stat</dt><dd>1</dd></div></dl><div className="socials">')],
  ["founder social link changed", mut("page", /target="_blank"\s+rel="noopener noreferrer"\s+aria-label="Instagram"/, 'aria-label="Instagram"')],
  ["header CM badge back", mut("page", /<img\s+className="brand-logo"[\s\S]*?\/>/, '<span className="brand-mark">CM</span>')],
  ["header logo CSS stretched", mut("topCss", "aspect-ratio: 617 / 749;", "aspect-ratio: 1 / 1;")],
  ["live CSS styles something else", mut("lowerCss", /$/, "\n.landing-wrapper .faq{max-width:100%}\n")],
  ["avatar file swapped", { ...real, asset: (p) => (p === "/images/avatars/male-1.webp" ? real.asset("/images/avatars/female-1.webp") : real.asset(p)) }],
  ["favicon changed", { ...real, asset: (p) => (p === "/favicon.ico" ? Buffer.from("not the favicon") : real.asset(p)) }],
  // approved hero text (ssampe@3386250 ascending maxx)
  ["maxx letters flattened", mut("page", 'className="m4"', 'className="m3"')],
  ["with AI split", mut("page", "with&nbsp;AI", "with AI")],
  ["jobmaxxing may wrap", mut("topCss", ".cm-top h1 .nw { white-space: nowrap; }", "")],
  ["gradient XX back", mut("topCss", ".cm-top h1 .m4 { font-size: 2em; }", ".cm-top h1 .m4 { font-size: 2em; }\n.cm-top h1 .mx { background: linear-gradient(90deg, #2563eb, #6d28d9); background-clip: text; }")],
  ["hero font reverted to Jakarta", mut("topCss", '.cm-top .pill, .cm-top .kicker, .cm-top h1, .cm-top .subhead { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }', ".cm-top .pill, .cm-top .kicker, .cm-top h1, .cm-top .subhead { font-family: var(--font-cm-jakarta); }")],
  ["hero CSS changes spacing", mut("topCss", ".cm-top .kicker { font-size: 20px;", ".cm-top .kicker { margin-top: 40px; font-size: 20px;")],
  ["hero CSS styles the cards", mut("topCss", /$/, "\n.cm-top .card { font-family: serif; }\n")],
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
  "top CSS unscoped rule": /top CSS must equal|hero text CSS may not style anything else/,
  "top CSS reaches lower": /top CSS must equal|hero text CSS may not style anything else/,
  "lower CSS value changed": /lower CSS must equal/,
  "lower CSS global body": /lower CSS must equal|may not style anything else/,
  "keyframes collide": /lower CSS must equal/,
  "top runtime leaks observer": /disconnect its ResizeObserver/,
  "lower runtime leaks marquee frame": /lower runtime cleanup must include \/cancelAnimationFrame\\\(rvReq/,
  "lower runtime unscoped query": /query inside its root/,
  "asset swapped": /byte-identical/,
  "review photo swapped": /moving row card 1 must be the exact D1 Rohan S\. record/,
  "review name swapped": /lower page copy|exact D1 Rohan S\. record/,
  "review quote swapped": /lower page copy|exact D1 Rohan S\. record/,
  "wall column order swapped": /lower page copy|review wall column 1 card 1/,
  "moving-row duplicate missing": /lower page copy|moving row must have 12 primary \+ 12 duplicate/,
  "placeholder review back": /lower page copy|placeholder/,
  "star rating back": /lower page copy|placeholder/,
  "founder stat row back": /lower page (copy|classes)|stat row/,
  "founder social link changed": /founder social links must be exactly/,
  "header CM badge back": /top fold (text|classes)|real CareerMonke logo/,
  "header logo CSS stretched": /size the header logo to 32px without distortion/,
  "live CSS styles something else": /may not style anything else/,
  "avatar file swapped": /avatar \/images\/avatars\/male-1\.webp for Rohan S\. must be the live file/,
  "favicon changed": /favicon must be unchanged/,
  "maxx letters flattened": /top fold classes|headline must be/,
  "with AI split": /top fold text|headline must be/,
  "jobmaxxing may wrap": /approved 3386250 treatment: \.cm-top h1 \.nw/,
  "gradient XX back": /solid navy in the system font/,
  "hero font reverted to Jakarta": /approved 3386250 treatment: font-family/,
  "hero CSS changes spacing": /must not change layout, spacing or animation/,
  "hero CSS styles the cards": /hero text CSS may not style anything else: \.cm-top \.card/,
};
for (const [name, input] of controls) {
  assert.throws(() => check(input), (e: Error) => WHY[name].test(e.message), `negative control "${name}" must fail with /${WHY[name]?.source}/`);
}

console.log(`landing-ssampe-parity: OK (${controls.length} negative controls failed as expected)`);
