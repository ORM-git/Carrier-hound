// Rendered job-card regression at 1024/1280/1440 (sidebar collapsed + expanded): cards must not overflow,
// the meta grid stays 2 rows, the logo box stays 72x72, and a broken logo URL ends on the letter tile.
// A second pass serves the page with a CSP that blocks every external image host (broken.invalid,
// unavatar.io): every card must show the letter tile with no <img>, no broken-image icon and no alt text.
// Needs a build (npm run build).
//   node scripts/test-jobs-card-geometry.cjs [--save <file>] [--compare <file>]
// --save writes card heights; --compare fails if any card grew vs that file.
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const puppeteer = require("puppeteer-core");
const { setupPageMocks, mockJobs, CHROME_PATH } = require("./test-prompt5-base.cjs");

const PORT = 3597;
const argVal = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const saveFile = argVal("--save");
const compareFile = argVal("--compare");
const isBaseline = Boolean(saveFile); // baseline run on main: geometry only, no style/logo checks

const CSP = "img-src 'self' data:"; // blocks broken.invalid and unavatar.io in the browser itself
let cspOn = false;

const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };
// Same lookup order as test-jobs-filter-geometry.cjs: .next build first, then out/ export, then public/.
const ROOTS = { html: [".next/server/app", "out"], static: [".next/static", "out/_next/static"], public: ["public"] };
const find = (dirs, rel) => dirs.map((d) => path.resolve(d, "." + rel)).find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  let file;
  if (p.startsWith("/_next/static/")) file = find(ROOTS.static, p.slice("/_next/static".length));
  else file = find(ROOTS.public, p) || find(ROOTS.html, (p === "/" ? "/index" : p) + (path.extname(p) ? "" : ".html"));
  if (!file) {
    res.writeHead(404);
    return res.end();
  }
  const headers = { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" };
  if (cspOn && headers["Content-Type"] === "text/html") headers["Content-Security-Policy"] = CSP;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

async function loadCards(browser, width, sidebarExpanded) {
  const page = await browser.newPage();
  await setupPageMocks(page, { isSigned: true, isPro: true });
  await page.evaluateOnNewDocument((expanded) => {
    localStorage.setItem("careermonke_sidebar_expanded", JSON.stringify({ v: 1, data: expanded }));
    window.__cspBlocked = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspBlocked.push(e.blockedURI));
  }, sidebarExpanded);
  await page.setViewport({ width, height: 900 });
  await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="job-card"]', { timeout: 20000 });
  // Wait until every desktop card image has loaded or errored (hidden mobile lazy imgs never load), let
  // onError re-renders, the Pro unlock re-render and the entry animation settle, then wait again for any
  // image that re-render inserted.
  const imagesSettled = () => page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="job-card"] > div.hidden.sm\\:flex img')].every((i) => i.complete),
    { timeout: 15000 }
  );
  await imagesSettled();
  await new Promise((r) => setTimeout(r, 600));
  await imagesSettled();

  const cards = await page.$$eval('[data-testid="job-card"]', (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const desktop = el.querySelector(":scope > div.hidden.sm\\:flex") || el;
      const grid = desktop.querySelector(".grid.grid-cols-3");
      const logo = desktop.querySelector(".sm\\:w-\\[72px\\]");
      const img = logo && logo.querySelector("img");
      const gridStyle = grid && getComputedStyle(grid);
      const visibleImgs = [...el.querySelectorAll("img")].filter((i) => i.getBoundingClientRect().width > 0);
      return {
        company: (desktop.textContent || "").slice(0, 40),
        height: Math.round(r.height),
        right: Math.round(r.right),
        overflowX: el.scrollWidth - el.clientWidth,
        gridHeight: grid ? Math.round(grid.getBoundingClientRect().height) : null,
        gridWeight: gridStyle ? gridStyle.fontWeight : null,
        gridColor: gridStyle ? gridStyle.color : null,
        logoW: logo ? Math.round(logo.getBoundingClientRect().width) : null,
        logoH: logo ? Math.round(logo.getBoundingClientRect().height) : null,
        logoKind: !logo ? "none" : img ? (img.complete && img.naturalWidth > 0 ? "image" : "pending-image") : "tile",
        logoText: logo ? logo.textContent.trim() : "",
        brokenVisibleImgs: visibleImgs.filter((i) => i.complete && i.naturalWidth === 0).length,
        altTextShown: visibleImgs.some((i) => i.complete && i.naturalWidth === 0 && i.alt),
        cardText: el.innerText,
      };
    })
  );
  const blocked = await page.evaluate(() => window.__cspBlocked);
  await page.close();
  return { cards, blocked };
}

async function main() {
  assert.ok(find(ROOTS.html, "/jobs.html"), "jobs.html build output missing: run npm run build first");
  await new Promise((r) => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  const results = {};
  try {
    // Pass 1. Job 1: working local logo. Job 2: broken stored logo. Job 3: no logo, domain only (external, aborted by mocks).
    mockJobs[0].logoUrl = mockJobs[0].logo_url = "/logo.png";
    mockJobs[1].logoUrl = mockJobs[1].logo_url = "https://broken.invalid/logo.png";
    if (mockJobs[2]) mockJobs[2].companyDomain = "example.org";
    for (const width of [1024, 1280, 1440]) {
      for (const sidebarExpanded of [false, true]) {
        const label = `${width}px sidebar-${sidebarExpanded ? "expanded" : "collapsed"}`;
        const { cards } = await loadCards(browser, width, sidebarExpanded);
        assert.ok(cards.length >= 2, `${label}: expected job cards, got ${cards.length}`);
        cards.forEach((c, i) => {
          const tag = `${label} card ${i}`;
          assert.ok(c.overflowX <= 0, `${tag}: horizontal overflow ${c.overflowX}px`);
          assert.ok(c.right <= width, `${tag}: right edge ${c.right} past viewport`);
          assert.ok(c.gridHeight <= 50, `${tag}: meta grid ${c.gridHeight}px, expected 2 rows (48px)`);
          assert.strictEqual(c.logoW, 72, `${tag}: logo width ${c.logoW}`);
          assert.strictEqual(c.logoH, 72, `${tag}: logo height ${c.logoH}`);
          if (!isBaseline) assert.strictEqual(c.gridWeight, "600", `${tag}: meta weight ${c.gridWeight}`);
        });
        if (!isBaseline) {
          assert.strictEqual(cards[0].logoKind, "image", `${label}: working logo should render, got ${cards[0].logoKind}`);
          assert.strictEqual(cards[1].logoKind, "tile", `${label}: broken logo should fall back to tile, got ${cards[1].logoKind}`);
          assert.ok(/^[A-Z]$/.test(cards[1].logoText), `${label}: tile should show one letter, got "${cards[1].logoText}"`);
          if (cards[2]) assert.strictEqual(cards[2].logoKind, "tile", `${label}: unreachable domain logo should fall back to tile`);
        }
        results[label] = cards.map((c) => c.height);
        console.log(`[PASS] ${label}: ${cards.length} cards, heights ${results[label].join("/")}px, meta ${cards[0].gridHeight}px w${cards[0].gridWeight} ${cards[0].gridColor}, logos ${cards.map((c) => c.logoKind).join("/")}`);
      }
    }

    // Pass 2. CSP blocks every external image host; every stored logo is on broken.invalid.
    if (!isBaseline) {
      cspOn = true;
      mockJobs.forEach((j, i) => { j.logoUrl = j.logo_url = `https://broken.invalid/logo-${i}.png`; j.companyDomain = "broken.invalid"; });
      for (const width of [1024, 1280, 1440]) {
        const label = `${width}px CSP`;
        const { cards, blocked } = await loadCards(browser, width, false);
        assert.ok(blocked.some((u) => u.includes("broken.invalid")), `${label}: CSP did not block broken.invalid (saw ${JSON.stringify(blocked)})`);
        cards.forEach((c, i) => {
          const tag = `${label} card ${i}`;
          assert.strictEqual(c.logoKind, "tile", `${tag}: expected letter tile, got ${c.logoKind}`);
          assert.ok(/^[A-Z]$/.test(c.logoText), `${tag}: tile should show one letter, got "${c.logoText}"`);
          assert.strictEqual(c.brokenVisibleImgs, 0, `${tag}: ${c.brokenVisibleImgs} broken image(s) visible`);
          assert.ok(!c.altTextShown && !/ logo\b/.test(c.cardText), `${tag}: alt text visible`);
          assert.strictEqual(c.logoW, 72, `${tag}: logo width ${c.logoW}`);
          assert.ok(c.overflowX <= 0, `${tag}: horizontal overflow ${c.overflowX}px`);
        });
        console.log(`[PASS] ${label}: ${cards.length} cards all letter tiles (${cards.map((c) => c.logoText).join("/")}), 0 broken images, 0 alt text, CSP blocked ${blocked.length} image request(s), heights ${cards.map((c) => c.height).join("/")}px`);
      }
      cspOn = false;
    }

    if (saveFile) fs.writeFileSync(saveFile, JSON.stringify(results, null, 2));
    if (compareFile) {
      const base = JSON.parse(fs.readFileSync(compareFile, "utf8"));
      for (const k of Object.keys(base)) {
        assert.ok(results[k], `baseline case ${k} missing from this run`);
        base[k].forEach((h, i) => {
          assert.ok(results[k][i] <= h + 1, `${k} card ${i} grew: ${h}px -> ${results[k][i]}px`);
        });
      }
      console.log(`[PASS] no card taller than baseline ${compareFile}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  process.exit(1);
});
