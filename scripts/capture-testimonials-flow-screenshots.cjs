const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_DIR = path.resolve(__dirname, "..", "out");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\059c9c1e-6c07-4697-a424-b2281efb19eb";
const REPORTS_DIR = path.resolve(__dirname, "..", "reports", "landing-testimonials-flow");

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let cleanUrl = req.url.split("?")[0].split("#")[0];

      if (cleanUrl === "/api/stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            activeJobs: 16573,
            totalJobs: 16573,
            jobsToday: 42,
            updatedAt: new Date().toISOString(),
          })
        );
        return;
      }

      if (cleanUrl === "/") cleanUrl = "/index.html";

      let filePath = path.join(OUT_DIR, cleanUrl);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (fs.existsSync(filePath + ".html")) {
          filePath = filePath + ".html";
        } else {
          filePath = path.join(OUT_DIR, "index.html");
        }
      }

      const ext = path.extname(filePath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not Found");
        } else {
          res.writeHead(200, { "Content-Type": mime });
          res.end(data);
        }
      });
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

async function run() {
  const PORT = 3569;
  const server = await startServer(PORT);
  console.log(`Test static server running at http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem("cm_cookie_notice", "dismissed");
    });

    // 1. Desktop 1440px - Wall 1 (Below Features, Above Comparison)
    console.log("Capturing Desktop 1440px Testimonials Flow...");
    await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1.5 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
    });
    await new Promise((r) => setTimeout(r, 1500));

    // Full page overview or section captures
    const wall1Path = path.join(REPORTS_DIR, "flow-desktop-wall1-features-comparison.png");
    const wall1Artifact = path.join(ARTIFACT_DIR, "flow-desktop-wall1-features-comparison.png");
    await page.evaluate(() => {
      const walls = document.querySelectorAll('[data-testid="landing-testimonials-section"]');
      if (walls[0]) walls[0].scrollIntoView({ behavior: "instant", block: "center" });
    });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: wall1Path });
    fs.copyFileSync(wall1Path, wall1Artifact);

    // Wall 2 (Below Founder, Above FAQ)
    const wall2Path = path.join(REPORTS_DIR, "flow-desktop-wall2-founder-faq.png");
    const wall2Artifact = path.join(ARTIFACT_DIR, "flow-desktop-wall2-founder-faq.png");
    await page.evaluate(() => {
      const walls = document.querySelectorAll('[data-testid="landing-testimonials-section"]');
      if (walls[1]) walls[1].scrollIntoView({ behavior: "instant", block: "center" });
    });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: wall2Path });
    fs.copyFileSync(wall2Path, wall2Artifact);

    // 2. Mobile 390px
    console.log("Capturing Mobile 390px Testimonials Flow...");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
    });
    await new Promise((r) => setTimeout(r, 1500));

    const mob1Path = path.join(REPORTS_DIR, "flow-mobile-390px-wall1.png");
    const mob1Artifact = path.join(ARTIFACT_DIR, "flow-mobile-390px-wall1.png");
    await page.evaluate(() => {
      const walls = document.querySelectorAll('[data-testid="landing-testimonials-section"]');
      if (walls[0]) walls[0].scrollIntoView({ behavior: "instant", block: "center" });
    });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: mob1Path });
    fs.copyFileSync(mob1Path, mob1Artifact);

    const mob2Path = path.join(REPORTS_DIR, "flow-mobile-390px-wall2.png");
    const mob2Artifact = path.join(ARTIFACT_DIR, "flow-mobile-390px-wall2.png");
    await page.evaluate(() => {
      const walls = document.querySelectorAll('[data-testid="landing-testimonials-section"]');
      if (walls[1]) walls[1].scrollIntoView({ behavior: "instant", block: "center" });
    });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: mob2Path });
    fs.copyFileSync(mob2Path, mob2Artifact);

    // 3. Mobile 360px
    console.log("Capturing Mobile 360px Testimonials Flow...");
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
    });
    await new Promise((r) => setTimeout(r, 1500));

    const mob360Path = path.join(REPORTS_DIR, "flow-mobile-360px-wall1.png");
    const mob360Artifact = path.join(ARTIFACT_DIR, "flow-mobile-360px-wall1.png");
    await page.evaluate(() => {
      const walls = document.querySelectorAll('[data-testid="landing-testimonials-section"]');
      if (walls[0]) walls[0].scrollIntoView({ behavior: "instant", block: "center" });
    });
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: mob360Path });
    fs.copyFileSync(mob360Path, mob360Artifact);

    console.log("\nAll flow screenshots captured successfully!");
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
