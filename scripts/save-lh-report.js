const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 3336;
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
    const cmd = `npx lighthouse "${url}" --chrome-flags="--headless" --output=json --output-path="${outputPath}" --quiet`;
    exec(cmd, { env: { ...process.env, CHROME_PATH }, maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) return reject(err);
      try {
        const report = JSON.parse(fs.readFileSync(outputPath, "utf8"));
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
  console.log(`Server started on ${PORT}`);

  try {
    const outputPath = path.join(__dirname, "full_lh_jobs.json");
    console.log("Running full Lighthouse on /jobs...");
    const report = await runLighthouse(`http://localhost:${PORT}/jobs`, outputPath);
    console.log("Report saved to", outputPath);

    const audits = report.audits;
    console.log("Audits with 'paint' or 'contentful' or 'element':");
    for (const k of Object.keys(audits)) {
      if (k.includes("paint") || k.includes("contentful") || k.includes("element") || k.includes("lcp")) {
        console.log(`- ${k}`);
      }
    }

    // Inspect LCP details
    const lcp = audits["largest-contentful-paint"];
    const lcpEl = audits["largest-contentful-paint-element"];
    console.log("LCP Audit:", JSON.stringify(lcp, null, 2));
    console.log("LCP Element Audit:", JSON.stringify(lcpEl, null, 2));

  } finally {
    server.close();
  }
}

main().catch(console.error);
