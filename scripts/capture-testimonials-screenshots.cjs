const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_DIR = path.resolve(__dirname, "..", "out");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\059c9c1e-6c07-4697-a424-b2281efb19eb";
const REPORTS_DIR = path.resolve(__dirname, "..", "reports", "landing-testimonials");

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
  const PORT = 3567;
  const server = await startServer(PORT);
  console.log(`Test static server running at http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    // Enable motion simulation
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);

    // Dismiss cookie notice
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem("cm_cookie_notice", "dismissed");
    });

    // 1. Desktop 1440px Viewport
    console.log("Capturing Desktop 1440px Testimonials Runner...");
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="landing-testimonials-section"]');

    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-testimonials-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 1200));

    const section = await page.$('[data-testid="landing-testimonials-section"]');
    const desktopPath = path.join(REPORTS_DIR, "testimonials-desktop-1440px.png");
    const desktopArtifact = path.join(ARTIFACT_DIR, "testimonials-desktop-1440px.png");
    await section.screenshot({ path: desktopPath });
    fs.copyFileSync(desktopPath, desktopArtifact);
    console.log(`Saved: ${desktopPath}`);

    // 2. Desktop 1440px - Hover over a testimonial card to verify instant pause
    console.log("Capturing Hover Paused state over testimonial card...");
    const cardEl = await page.$('[data-testid="testimonial-card"]');
    if (cardEl) {
      await cardEl.hover();
      await new Promise((r) => setTimeout(r, 600));
    }

    const pausedPath = path.join(REPORTS_DIR, "testimonials-hover-paused.png");
    const pausedArtifact = path.join(ARTIFACT_DIR, "testimonials-hover-paused.png");
    await section.screenshot({ path: pausedPath });
    fs.copyFileSync(pausedPath, pausedArtifact);
    console.log(`Saved: ${pausedPath}`);

    // 3. Mobile 390px Viewport
    console.log("Capturing Mobile 390px Testimonials Runner...");
    await page.setViewport({ width: 390, height: 850, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-testimonials-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 1200));

    const mob390Section = await page.$('[data-testid="landing-testimonials-section"]');
    const mob390Path = path.join(REPORTS_DIR, "testimonials-mobile-390px.png");
    const mob390Artifact = path.join(ARTIFACT_DIR, "testimonials-mobile-390px.png");
    await mob390Section.screenshot({ path: mob390Path });
    fs.copyFileSync(mob390Path, mob390Artifact);
    console.log(`Saved: ${mob390Path}`);

    // 4. Mobile 360px Viewport
    console.log("Capturing Mobile 360px Testimonials Runner...");
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-testimonials-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 1200));

    const mob360Section = await page.$('[data-testid="landing-testimonials-section"]');
    const mob360Path = path.join(REPORTS_DIR, "testimonials-mobile-360px.png");
    const mob360Artifact = path.join(ARTIFACT_DIR, "testimonials-mobile-360px.png");
    await mob360Section.screenshot({ path: mob360Path });
    fs.copyFileSync(mob360Path, mob360Artifact);
    console.log(`Saved: ${mob360Path}`);

    // 5. Reduced-Motion State: Animation Disabled & Accessible Manual Scroll
    console.log("Capturing Reduced-Motion Accessible Mode...");
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => {
      const banner = document.getElementById("cm-cookie-notice");
      if (banner) banner.remove();
      document.querySelector('[data-testid="landing-testimonials-section"]').scrollIntoView({ behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 1200));

    const rmSection = await page.$('[data-testid="landing-testimonials-section"]');
    const rmPath = path.join(REPORTS_DIR, "testimonials-reduced-motion.png");
    const rmArtifact = path.join(ARTIFACT_DIR, "testimonials-reduced-motion.png");
    await rmSection.screenshot({ path: rmPath });
    fs.copyFileSync(rmPath, rmArtifact);
    console.log(`Saved: ${rmPath}`);

    console.log("\nAll testimonials screenshots successfully captured!");
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((err) => {
  console.error("Screenshot error:", err);
  process.exit(1);
});
