#!/usr/bin/env node
/**
 * Advisory quality audit (non-blocking): axe-core accessibility checks on the
 * public static pages + Lighthouse scores for the landing page.
 *
 * Runs against the static export in out/ (default build, NOT the CF_PAGES
 * variant). Always exits 0 - results are reported to stdout and
 * reports/quality-advisory.json for review; promotion to a blocking gate is a
 * separate owner decision.
 */
import http from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import lighthouse from "lighthouse";

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "out");
const REPORTS_DIR = path.join(ROOT, "reports");
const PORT = 3399;
const CHROME_PATH =
  process.env.CHROME_PATH || "/usr/bin/google-chrome";

const ROUTES = [
  "/",
  "/early-access",
  "/remote",
  "/worldwide",
  "/pricing",
  "/signup",
  "/privacy-policy",
  "/terms-and-conditions",
  "/refund-policy",
  "/contact",
];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain",
};

if (!existsSync(OUT_DIR)) {
  console.log("[SKIP] out/ not found; run `npm run build` (default, non-CF_PAGES) first.");
  process.exit(0);
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let clean = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
      if (clean === "/") clean = "/index.html";
      let file = path.join(OUT_DIR, clean);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        if (existsSync(file + ".html")) file = file + ".html";
        else if (existsSync(path.join(file, "index.html"))) file = path.join(file, "index.html");
        else file = path.join(OUT_DIR, "404.html");
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(existsSync(file) ? 200 : 404, { "Content-Type": MIME[ext] || "application/octet-stream" });
      if (existsSync(file)) res.end(readFileSync(file));
      else res.end("not found");
    });
    server.listen(PORT, () => resolve(server));
  });
}

const server = await serve();
const report = { generatedAt: new Date().toISOString(), axe: {}, lighthouse: null };

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0"],
  });
  const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

  for (const route of ROUTES) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${PORT}${route}`, { waitUntil: "networkidle0", timeout: 30000 });
      await page.evaluate(axeSource);
      const results = await page.evaluate(async () => await window.axe.run());
      const violations = results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
        help: v.help,
      }));
      report.axe[route] = { violations, violationCount: violations.length };
      console.log(`[axe] ${route}: ${violations.length} violation(s)`);
      for (const v of violations.slice(0, 5)) {
        console.log(`   - [${v.impact}] ${v.id}: ${v.help} (${v.nodes} nodes)`);
      }
    } catch (err) {
      report.axe[route] = { error: String(err) };
      console.log(`[axe] ${route}: ERROR ${err}`);
    } finally {
      await page.close();
    }
  }

  // Lighthouse on the landing page only (heaviest signal).
  try {
    const debugPort = Number(new URL(browser.wsEndpoint()).port);
    const lh = await lighthouse(`http://127.0.0.1:${PORT}/`, {
      port: debugPort,
      output: "json",
      onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      logLevel: "error",
    });
    const cats = lh.lhr.categories;
    report.lighthouse = Object.fromEntries(
      Object.entries(cats).map(([k, c]) => [k, Math.round(c.score * 100)])
    );
    console.log(`[lighthouse] / -> ${JSON.stringify(report.lighthouse)}`);
  } catch (err) {
    report.lighthouse = { error: String(err) };
    console.log(`[lighthouse] ERROR ${err}`);
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
writeFileSync(path.join(REPORTS_DIR, "quality-advisory.json"), JSON.stringify(report, null, 2));
console.log(`\nReport written to reports/quality-advisory.json (advisory; exit 0).`);
process.exit(0);
