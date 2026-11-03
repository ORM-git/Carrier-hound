const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_DIR = path.resolve(__dirname, "..", "out");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\059c9c1e-6c07-4697-a424-b2281efb19eb";
const REPORTS_DIR = path.resolve(__dirname, "..", "reports", "landing-globe");

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

let mockStatsMode = "normal"; // "normal" | "zero" | "error"

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let cleanUrl = req.url.split("?")[0].split("#")[0];

      if (cleanUrl === "/api/stats") {
        if (mockStatsMode === "error") {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Service unavailable" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            activeJobs: 16573,
            totalJobs: 16573,
            jobsToday: mockStatsMode === "zero" ? 0 : 42,
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
  const PORT = 3456;
  const server = await startServer(PORT);
  console.log(`Test static server running at http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    // Dismiss cookie notice
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem("cm_cookie_notice", "dismissed");
    });

    // 1. Desktop 1440px - Tour Active State (San Francisco pin & tooltip)
    console.log("Capturing Desktop 1440px Tour Active...");
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 2 });
    mockStatsMode = "normal";
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="landing-globe-feature-section"]');
    
    // Hide cookie banner if still mounted
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-globe-feature-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 2200));

    const globeSection = await page.$('[data-testid="landing-globe-feature-section"]');
    const desktopPath = path.join(REPORTS_DIR, "globe-desktop-1440px.png");
    const desktopArtifact = path.join(ARTIFACT_DIR, "globe-desktop-1440px.png");
    await globeSection.screenshot({ path: desktopPath });
    fs.copyFileSync(desktopPath, desktopArtifact);
    console.log(`Saved: ${desktopPath}`);

    // 1b. Capture Tour Stop 2: Paris
    console.log("Waiting for Tour Stop 2: Paris...");
    await new Promise((r) => setTimeout(r, 3800));
    const parisPath = path.join(REPORTS_DIR, "globe-tour-paris.png");
    const parisArtifact = path.join(ARTIFACT_DIR, "globe-tour-paris.png");
    await globeSection.screenshot({ path: parisPath });
    fs.copyFileSync(parisPath, parisArtifact);
    console.log(`Saved: ${parisPath}`);

    // 1c. Capture Tour Stop 3: Singapore
    console.log("Waiting for Tour Stop 3: Singapore...");
    await new Promise((r) => setTimeout(r, 4500));
    const sgPath = path.join(REPORTS_DIR, "globe-tour-singapore.png");
    const sgArtifact = path.join(ARTIFACT_DIR, "globe-tour-singapore.png");
    await globeSection.screenshot({ path: sgPath });
    fs.copyFileSync(sgPath, sgArtifact);
    console.log(`Saved: ${sgPath}`);

    // 2. Desktop 1440px - Click "Drag to explore" to show "Resume tour" control
    console.log("Capturing Desktop 1440px Explore Mode (Resume tour button)...");
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="landing-globe-feature-section"] button');
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 600));
    const explorePath = path.join(REPORTS_DIR, "globe-desktop-resume-tour.png");
    const exploreArtifact = path.join(ARTIFACT_DIR, "globe-desktop-resume-tour.png");
    await globeSection.screenshot({ path: explorePath });
    fs.copyFileSync(explorePath, exploreArtifact);
    console.log(`Saved: ${explorePath}`);

    // 3. Desktop 1440px - JobsToday = 0 State
    console.log("Capturing Desktop 1440px with jobsToday=0...");
    mockStatsMode = "zero";
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-globe-feature-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 1800));
    const zeroSection = await page.$('[data-testid="landing-globe-feature-section"]');
    const zeroPath = path.join(REPORTS_DIR, "globe-desktop-jobstoday-0.png");
    const zeroArtifact = path.join(ARTIFACT_DIR, "globe-desktop-jobstoday-0.png");
    await zeroSection.screenshot({ path: zeroPath });
    fs.copyFileSync(zeroPath, zeroArtifact);
    console.log(`Saved: ${zeroPath}`);

    // 4. Desktop 1440px - API Error State (Neutral placeholders)
    console.log("Capturing Desktop 1440px with API Error...");
    mockStatsMode = "error";
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-globe-feature-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 1800));
    const errSection = await page.$('[data-testid="landing-globe-feature-section"]');
    const errPath = path.join(REPORTS_DIR, "globe-desktop-api-error.png");
    const errArtifact = path.join(ARTIFACT_DIR, "globe-desktop-api-error.png");
    await errSection.screenshot({ path: errPath });
    fs.copyFileSync(errPath, errArtifact);
    console.log(`Saved: ${errPath}`);

    // 5. Mobile 390px Viewport
    console.log("Capturing Mobile 390px Viewport...");
    mockStatsMode = "normal";
    await page.setViewport({ width: 390, height: 950, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-globe-feature-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 1800));
    const mob390Section = await page.$('[data-testid="landing-globe-feature-section"]');
    const mob390Path = path.join(REPORTS_DIR, "globe-mobile-390px.png");
    const mob390Artifact = path.join(ARTIFACT_DIR, "globe-mobile-390px.png");
    await mob390Section.screenshot({ path: mob390Path });
    fs.copyFileSync(mob390Path, mob390Artifact);
    console.log(`Saved: ${mob390Path}`);

    // 6. Mobile 360px Viewport
    console.log("Capturing Mobile 360px Viewport...");
    await page.setViewport({ width: 360, height: 900, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-globe-feature-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 1800));
    const mob360Section = await page.$('[data-testid="landing-globe-feature-section"]');
    const mob360Path = path.join(REPORTS_DIR, "globe-mobile-360px.png");
    const mob360Artifact = path.join(ARTIFACT_DIR, "globe-mobile-360px.png");
    await mob360Section.screenshot({ path: mob360Path });
    fs.copyFileSync(mob360Path, mob360Artifact);
    console.log(`Saved: ${mob360Path}`);

    console.log("\nAll globe screenshots successfully captured!");
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
