const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 3333;
const OUT_DIR = path.join(__dirname, "..", "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// MIME types map
const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";

    let filePath = path.join(OUT_DIR, cleanUrl);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (fs.existsSync(filePath + ".html")) {
        filePath = filePath + ".html";
      } else if (fs.existsSync(path.join(filePath, "index.html"))) {
        filePath = path.join(filePath, "index.html");
      }
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    fs.createReadStream(filePath).pipe(res);
  });
}

function runLighthouse(url, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `npx lighthouse "${url}" --chrome-flags="--headless" --output=json --output-path="${outputPath}" --only-categories=performance --quiet`;
    exec(cmd, { env: { ...process.env, CHROME_PATH } }, (err, stdout, stderr) => {
      if (err) return reject(err);
      try {
        const report = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        fs.unlinkSync(outputPath);
        resolve(report);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function extractMetrics(report) {
  const perfScore = Math.round((report?.categories?.performance?.score || 0) * 100);
  const lcp = report?.audits?.["largest-contentful-paint"]?.numericValue || 0;
  const tbt = report?.audits?.["total-blocking-time"]?.numericValue || 0;
  const cls = report?.audits?.["cumulative-layout-shift"]?.numericValue || 0;

  // Total transfer byte weight
  const transferBytes = report?.audits?.["total-byte-weight"]?.numericValue || 0;
  const transferKb = Math.round(transferBytes / 1024);

  // Unused JavaScript byte weight
  const unusedJsBytes = report?.audits?.["unused-javascript"]?.numericValue || 0;
  const unusedJsKb = Math.round(unusedJsBytes / 1024);

  return {
    requestedUrl: report.requestedUrl,
    finalDisplayedUrl: report.finalDisplayedUrl,
    perfScore,
    lcp: Math.round(lcp),
    tbt: Math.round(tbt),
    cls: Number(cls.toFixed(3)),
    transferKb,
    unusedJsKb,
  };
}

async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));
  console.log(`Static server running on http://localhost:${PORT}`);

  try {
    const runs = [];
    console.log("Running 3 Lighthouse mobile runs on http://localhost:3333/job-search/all...\n");

    for (let i = 1; i <= 3; i++) {
      console.log(`Starting Run ${i}...`);
      const rep = await runLighthouse(`http://localhost:${PORT}/job-search/all`, `lh_run_${i}.json`);
      const metrics = extractMetrics(rep);
      runs.push(metrics);
      console.log(`Run ${i} results:`, metrics);
    }

    // Median calculations
    const median = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const medianResults = {
      requestedUrl: runs[0].requestedUrl,
      finalDisplayedUrl: runs[0].finalDisplayedUrl,
      perfScore: median(runs.map((r) => r.perfScore)),
      lcp: median(runs.map((r) => r.lcp)),
      tbt: median(runs.map((r) => r.tbt)),
      cls: Number(median(runs.map((r) => r.cls)).toFixed(3)),
      transferKb: median(runs.map((r) => r.transferKb)),
      unusedJsKb: median(runs.map((r) => r.unusedJsKb)),
    };

    console.log("\n==================================================================================");
    console.log("LIGHTHOUSE 3-RUN MEDIAN BASELINE (BEFORE): /job-search/all");
    console.log("==================================================================================");
    console.log(JSON.stringify(medianResults, null, 2));

  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in measure-jobsearch-perf.js:", err);
  process.exit(1);
});
