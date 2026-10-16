const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 3333;
const OUT_DIR = path.join(__dirname, "..", "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";
    let filePath = path.join(OUT_DIR, cleanUrl);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (fs.existsSync(filePath + ".html")) filePath = filePath + ".html";
      else if (fs.existsSync(path.join(filePath, "index.html"))) filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

function runDesktopLighthouse(url, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `npx lighthouse "${url}" --preset=desktop --chrome-flags="--headless" --output=json --output-path="${outputPath}" --only-categories=performance --quiet`;
    exec(cmd, { env: { ...process.env, CHROME_PATH } }, (err) => {
      if (err) return reject(err);
      try {
        const report = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        fs.unlinkSync(outputPath);
        const score = Math.round((report?.categories?.performance?.score || 0) * 100);
        resolve({ url, score });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function main() {
  console.log("==================================================================================");
  console.log("           STEP 5: DESKTOP LIGHTHOUSE SCORES FOR /, /job-search/all, /login       ");
  console.log("==================================================================================\n");

  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));

  try {
    const targets = [
      `http://localhost:${PORT}/`,
      `http://localhost:${PORT}/job-search/all`,
      `http://localhost:${PORT}/login`,
    ];

    const results = [];
    for (const target of targets) {
      console.log(`Running desktop audit for ${target}...`);
      const res = await runDesktopLighthouse(target, `lh_desk_${Date.now()}.json`);
      results.push(res);
      console.log(`✅ ${res.url} -> Desktop Performance Score: ${res.score}/100`);
    }

    console.log("\n==================================================================================");
    console.log("DESKTOP LIGHTHOUSE PERFORMANCE SCORES SUMMARY");
    console.log("==================================================================================");
    console.table(results);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in measure-desktop-lh.js:", err);
  process.exit(1);
});
