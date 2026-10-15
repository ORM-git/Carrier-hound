const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 3334;
const OUT_DIR = path.join(__dirname, "..", "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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
    exec(cmd, { env: { ...process.env, CHROME_PATH } }, (err) => {
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

async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));
  console.log(`Diagnostic server listening on http://localhost:${PORT}`);

  try {
    const targetUrl = `http://localhost:${PORT}/jobs`;
    console.log(`Running Lighthouse mobile audit on ${targetUrl}...`);
    const report = await runLighthouse(targetUrl, "diag_lh.json");

    const lcpAudit = report.audits["largest-contentful-paint"];
    const lcpElementAudit = report.audits["largest-contentful-paint-element"];
    const networkAudit = report.audits["network-requests"];

    console.log("\n=================== 1. LCP METRIC & BREAKDOWN ===================");
    console.log("LCP Value (ms):", lcpAudit?.numericValue);
    console.log("LCP Display Value:", lcpAudit?.displayValue);

    // LCP element details
    const lcpItem = lcpElementAudit?.details?.items?.[0];
    console.log("\n=================== 2. LCP ELEMENT ===================");
    console.log("Selector:", lcpItem?.node?.selector);
    console.log("Snippet:", lcpItem?.node?.snippet);
    console.log("Node Label:", lcpItem?.node?.nodeLabel);
    console.log("Timing items:", lcpItem);

    console.log("\n=================== 3. REQUEST WATERFALL (NETWORK REQUESTS) ===================");
    const requests = networkAudit?.details?.items || [];
    console.log(`Total requests captured by Lighthouse: ${requests.length}`);
    const summary = requests.map((r) => {
      let urlMasked = r.url;
      // mask any keys if present
      urlMasked = urlMasked.replace(/apikey=[^&]+/g, "apikey=REDACTED");
      return {
        url: urlMasked,
        resourceType: r.resourceType,
        statusCode: r.statusCode,
        startTimeMs: Math.round(r.startTime * 1000),
        endTimeMs: Math.round(r.endTime * 1000),
        durationMs: Math.round((r.endTime - r.startTime) * 1000),
        transferSize: r.transferSize,
      };
    });

    console.log(JSON.stringify(summary, null, 2));

  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error("Diagnosis error:", e);
  process.exit(1);
});
