#!/usr/bin/env node
/**
 * Performance budget gate (row: performance budget / web-vitals CI gate).
 *
 * Serves the static export in out/ over a local HTTP server, runs Lighthouse
 * (mobile emulation, Lighthouse defaults) against the configured path, and
 * compares the measured category scores against budgets/performance.json.
 *
 * Every threshold comes from that budgets file. The only measured baseline is
 * the owner-recorded mobile score of 82 (frontend audit sheet row 35); the
 * hard floor subtracts the documented flake tolerance. This script never
 * invents metric thresholds - it only enforces what the budgets file says.
 *
 * Usage:
 *   node scripts/check-perf-budget.mjs [--dir out] [--runs 3] [--url http://host:port/path]
 *
 * Exit codes: 0 = within budget, 1 = below budget (or measurement failed).
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const BUDGET_PATH = join(ROOT, "budgets", "performance.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

function parseArgs(argv) {
  const opts = { dir: "out", runs: 3, url: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dir") opts.dir = argv[++i];
    else if (argv[i] === "--runs") opts.runs = Number(argv[++i]);
    else if (argv[i] === "--url") opts.url = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/check-perf-budget.mjs [--dir out] [--runs 3] [--url URL]");
      process.exit(0);
    }
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) {
    console.error("--runs must be a positive integer");
    process.exit(2);
  }
  return opts;
}

/** Minimal static file server for the export directory (matches `next export` layout). */
function startStaticServer(dir) {
  const base = resolve(ROOT, dir);
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      let filePath = normalize(join(base, urlPath));
      if (!filePath.startsWith(base)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      let info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) {
        filePath = join(filePath, "index.html");
        info = await stat(filePath).catch(() => null);
      }
      if (!info) {
        // Static-export fallback: /foo -> /foo.html
        const htmlPath = `${filePath}.html`;
        info = await stat(htmlPath).catch(() => null);
        if (info) filePath = htmlPath;
      }
      if (!info) {
        res.writeHead(404).end("not found");
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveServer({ server, port });
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function measure(url, runs) {
  const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless", "--no-sandbox", "--disable-dev-shm-usage"] });
  const scores = [];
  const audits = { lcp: [], cls: [], tbt: [] };
  try {
    for (let i = 0; i < runs; i++) {
      const result = await lighthouse(url, {
        port: chrome.port,
        output: "json",
        logLevel: "error",
        formFactor: "mobile",
        screenEmulation: { mobile: true },
        onlyCategories: ["performance"],
      });
      const lhr = result.lhr;
      scores.push(Math.round(lhr.categories.performance.score * 100));
      audits.lcp.push(lhr.audits["largest-contentful-paint"].numericValue);
      audits.cls.push(lhr.audits["cumulative-layout-shift"].numericValue);
      audits.tbt.push(lhr.audits["total-blocking-time"].numericValue);
    }
  } finally {
    await chrome.kill();
  }
  return { scores, audits };
}

async function main() {
  const opts = parseArgs(process.argv);
  const budget = JSON.parse(await readFile(BUDGET_PATH, "utf8"));

  let targetUrl = opts.url;
  let server = null;
  if (!targetUrl) {
    const started = await startStaticServer(opts.dir);
    server = started.server;
    const path = budget.url === "/" ? "/" : budget.url;
    targetUrl = `http://127.0.0.1:${started.port}${path}`;
  }

  console.log(`Performance budget: measured baseline ${budget.measuredBaseline.performanceScore} (${budget.measuredBaseline.source})`);
  console.log(`Hard floor: ${budget.budget.categories.performance.minScore} (baseline - ${budget.flakeTolerancePoints} flake tolerance points, gate policy)`);
  console.log(`Target: ${targetUrl} (${opts.runs} run${opts.runs === 1 ? "" : "s"}, median)\n`);

  try {
    const { scores, audits } = await measure(targetUrl, opts.runs);
    const perf = Math.round(median(scores));
    console.log(`performance score: ${perf} (runs: ${scores.join(", ")})`);
    console.log(`LCP p-run values (ms): ${audits.lcp.map((v) => Math.round(v)).join(", ")}`);
    console.log(`CLS p-run values: ${audits.cls.map((v) => v.toFixed(3)).join(", ")}`);
    console.log(`TBT p-run values (ms): ${audits.tbt.map((v) => Math.round(v)).join(", ")}\n`);

    const floor = budget.budget.categories.performance.minScore;
    const baseline = budget.measuredBaseline.performanceScore;
    if (perf < floor) {
      console.error(`FAIL: performance ${perf} is below the hard floor ${floor}.`);
      process.exitCode = 1;
    } else if (perf < baseline) {
      console.error(`FAIL (below budget): performance ${perf} is above the flake floor ${floor} but below the measured baseline ${baseline}. Investigate the regression before merging; if this is CI environment noise, re-run once and confirm.`);
      process.exitCode = 1;
    } else {
      console.log(`PASS: performance ${perf} meets the measured baseline ${baseline}.`);
    }
  } finally {
    server?.close();
  }
}

main().catch((err) => {
  console.error(`Performance budget check failed to run: ${err?.stack ?? err}`);
  process.exit(1);
});
