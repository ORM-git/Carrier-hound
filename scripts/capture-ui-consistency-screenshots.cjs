const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3899;
const OUT_DIR = path.resolve(__dirname, "..", "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\e3f59ab1-b1e8-4caa-8cca-243d9678620c";
const REPORT_DIR = path.resolve(__dirname, "..", "reports", "ui-consistency");

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";
    let filePath = path.join(OUT_DIR, cleanUrl);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (fs.existsSync(filePath + ".html")) {
        filePath = filePath + ".html";
      }
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found: " + cleanUrl);
    }
  });
}

const PAGES = [
  { name: "landing", path: "/" },
  { name: "login", path: "/login" },
  { name: "jobs", path: "/jobs" },
  { name: "resume", path: "/resume" },
  { name: "tracker", path: "/tracker" },
  { name: "profile", path: "/profile" },
  { name: "radar", path: "/radar" },
  { name: "pricing", path: "/pricing" },
  { name: "terms", path: "/terms" },
];

const VIEWPORTS = [
  { name: "mobile-390", width: 390, height: 844 },
  { name: "desktop-1440", width: 1440, height: 900 },
];

async function capture() {
  console.log("Starting static server on port", PORT);
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));

  console.log("Launching Chrome...");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const page = await browser.newPage();

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.width, height: vp.height });

    for (const p of PAGES) {
      const url = `http://127.0.0.1:${PORT}${p.path}`;
      console.log(`Navigating to ${p.name} (${vp.name}) at ${url}...`);

      try {
        await page.goto(url, { waitUntil: ["domcontentloaded", "networkidle2"], timeout: 15000 });
      } catch (err) {
        console.warn(`Warning: Navigation timeout or error on ${url}:`, err.message);
      }

      // Small delay to allow any client-side transitions to settle
      await new Promise((r) => setTimeout(r, 600));

      const filename = `${p.name}-${vp.name}.png`;
      const reportPath = path.join(REPORT_DIR, filename);
      const artifactPath = path.join(ARTIFACT_DIR, filename);

      await page.screenshot({ path: reportPath, fullPage: false });
      fs.copyFileSync(reportPath, artifactPath);
      console.log(`Saved screenshot: ${filename}`);
    }
  }

  // 1. Scrolled page showing footer (Desktop 1440)
  console.log("Capturing scrolled footer (Desktop 1440)...");
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT}/terms`, { waitUntil: ["domcontentloaded", "networkidle2"] });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 600));
  const scrolledFooterDeskPath = path.join(REPORT_DIR, "scrolled-footer-desktop-1440.png");
  await page.screenshot({ path: scrolledFooterDeskPath, fullPage: false });
  fs.copyFileSync(scrolledFooterDeskPath, path.join(ARTIFACT_DIR, "scrolled-footer-desktop-1440.png"));
  console.log("Saved: scrolled-footer-desktop-1440.png");

  // 2. Scrolled page showing footer (Mobile 390)
  console.log("Capturing scrolled footer (Mobile 390)...");
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${PORT}/terms`, { waitUntil: ["domcontentloaded", "networkidle2"] });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 600));
  const scrolledFooterMobPath = path.join(REPORT_DIR, "scrolled-footer-mobile-390.png");
  await page.screenshot({ path: scrolledFooterMobPath, fullPage: false });
  fs.copyFileSync(scrolledFooterMobPath, path.join(ARTIFACT_DIR, "scrolled-footer-mobile-390.png"));
  console.log("Saved: scrolled-footer-mobile-390.png");

  // 3. Open mobile drawer view (Mobile 390 on /jobs)
  console.log("Capturing open mobile drawer (Mobile 390)...");
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${PORT}/jobs`, { waitUntil: ["domcontentloaded", "networkidle2"] });
  await new Promise((r) => setTimeout(r, 800));
  const menuButton = await page.$('button[aria-label="Open navigation menu"]');
  if (menuButton) {
    await menuButton.click();
    await new Promise((r) => setTimeout(r, 600));
    const drawerOpenPath = path.join(REPORT_DIR, "mobile-drawer-open-390.png");
    await page.screenshot({ path: drawerOpenPath, fullPage: false });
    fs.copyFileSync(drawerOpenPath, path.join(ARTIFACT_DIR, "mobile-drawer-open-390.png"));
    console.log("Saved: mobile-drawer-open-390.png");
  }

  // 4. BackToTop visible above bottom nav (Mobile 390 on /jobs)
  console.log("Capturing BackToTop above bottom nav (Mobile 390)...");
  await page.goto(`http://127.0.0.1:${PORT}/jobs`, { waitUntil: ["domcontentloaded", "networkidle2"] });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => window.scrollTo(0, 800));
  await new Promise((r) => setTimeout(r, 600));
  const backToTopPath = path.join(REPORT_DIR, "mobile-back-to-top-390.png");
  await page.screenshot({ path: backToTopPath, fullPage: false });
  fs.copyFileSync(backToTopPath, path.join(ARTIFACT_DIR, "mobile-back-to-top-390.png"));
  console.log("Saved: mobile-back-to-top-390.png");

  await browser.close();
  server.close();
  console.log("All screenshots captured successfully!");
}

capture().catch((err) => {
  console.error("Fatal error capturing screenshots:", err);
  process.exit(1);
});
