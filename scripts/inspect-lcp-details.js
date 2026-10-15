const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 3335;
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
  console.log(`Server on port ${PORT}`);

  try {
    const report = await runLighthouse(`http://localhost:${PORT}/jobs`, "diag_full.json");

    console.log("=== LCP ELEMENT AUDIT ===");
    console.log(JSON.stringify(report.audits["largest-contentful-paint-element"], null, 2));

    console.log("=== LCP AUDIT DETAILS ===");
    console.log(JSON.stringify(report.audits["largest-contentful-paint"], null, 2));

    console.log("=== FIRST NETWORK REQUEST KEYS & SAMPLE ===");
    const items = report.audits["network-requests"]?.details?.items || [];
    if (items.length > 0) {
      console.log("Keys:", Object.keys(items[0]));
      console.log("Sample first item:", JSON.stringify(items[0], null, 2));
      console.log("Sample supabase item:", JSON.stringify(items.find(i => i.url.includes("supabase")), null, 2));
    }

    // Save full report network requests to a json file for precise parsing
    fs.writeFileSync(path.join(__dirname, "lh_network_sample.json"), JSON.stringify(items, null, 2));
    console.log("Saved network items to scripts/lh_network_sample.json");

  } finally {
    server.close();
  }
}

main().catch(console.error);
