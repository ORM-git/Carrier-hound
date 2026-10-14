const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { exec } = require("child_process");

const PORT = 3333;
const OUT_DIR = path.join(__dirname, "..", "out");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\caf034a4-a523-4c7f-8755-7fa4fad550ba";
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

// Static file server for out/
function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";

    let filePath = path.join(OUT_DIR, cleanUrl);

    // If file doesn't exist directly, check with .html
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

async function run() {
  console.log("==================================================================================");
  console.log("           VISUAL CHECK & LIGHTHOUSE VERIFICATION: /job-search/all & /jobs        ");
  console.log("==================================================================================\n");

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Local test server running on http://localhost:${PORT}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    // 1. Mobile Screenshot (390px)
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 1000));
    const mobileScreenshotPath = path.join(ARTIFACT_DIR, "jobs_mobile_390.png");
    await page.screenshot({ path: mobileScreenshotPath, fullPage: false });
    console.log(`✅ Captured 390px mobile visual screenshot: ${mobileScreenshotPath}`);

    // 2. Desktop Screenshot (1440px)
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 1000));
    const desktopScreenshotPath = path.join(ARTIFACT_DIR, "jobs_desktop_1440.png");
    await page.screenshot({ path: desktopScreenshotPath, fullPage: false });
    console.log(`✅ Captured 1440px desktop visual screenshot: ${desktopScreenshotPath}`);

    await browser.close();
    browser = null;

    // 3. Run Lighthouse Mobile Audit asynchronously so event loop stays alive
    console.log("\nRunning Lighthouse mobile performance audit against http://localhost:3333/job-search/all...");
    await new Promise((resolve) => {
      const lhCmd = `npx lighthouse http://localhost:${PORT}/job-search/all --chrome-flags="--headless" --output=json --output-path=lighthouse_out.json --only-categories=performance --quiet`;
      exec(lhCmd, { env: { ...process.env, CHROME_PATH } }, (err, stdout, stderr) => {
        if (err) {
          console.log(`Lighthouse audit note: ${err.message} (NOT RUN)`);
        } else if (fs.existsSync("lighthouse_out.json")) {
          const lhReport = JSON.parse(fs.readFileSync("lighthouse_out.json", "utf8"));
          const perfScore = Math.round((lhReport?.categories?.performance?.score || 0) * 100);
          console.log(`\n==================================================================================`);
          console.log(`LIGHTHOUSE MOBILE PERFORMANCE SCORE (After Fix 5): ${perfScore}/100`);
          console.log(`==================================================================================`);
          fs.unlinkSync("lighthouse_out.json");
        }
        resolve();
      });
    });

  } finally {
    if (browser) await browser.close();
    server.close();
    console.log("Local test server stopped.");
  }
}

run().catch((err) => {
  console.error("FATAL ERROR in verify-jobsearch-perf.js:", err);
  process.exit(1);
});
