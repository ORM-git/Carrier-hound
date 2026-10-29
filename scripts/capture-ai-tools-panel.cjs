const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3591;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPORT_DIR = path.resolve(process.cwd(), "reports", "ai-tools-panel");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\09dd50cb-fcab-4371-bc4f-135069b32d67";

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

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

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    if (cleanUrl === "/") cleanUrl = "/index.html";
    if (!path.extname(cleanUrl)) {
      if (fs.existsSync(path.join(OUT_DIR, cleanUrl + ".html"))) {
        cleanUrl = cleanUrl + ".html";
      } else if (fs.existsSync(path.join(OUT_DIR, cleanUrl, "index.html"))) {
        cleanUrl = path.join(cleanUrl, "index.html");
      }
    }

    const filePath = path.join(OUT_DIR, cleanUrl);

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

const sampleCandidate = {
  fullName: "Alex Morgan",
  title: "Senior Full-Stack Engineer",
  skills: ["React", "TypeScript", "Node.js", "PostgreSQL", "Next.js", "Tailwind CSS"],
  confirmedAt: "2026-10-20T12:00:00Z",
  workExperiences: [
    {
      id: "1",
      title: "Senior Full-Stack Engineer",
      company: "Tech Corp",
      startDate: "2022-01-01",
      endDate: null,
      isCurrent: true,
      bullets: ["Built React and TypeScript web applications"],
    },
  ],
};

async function captureScreenshots() {
  console.log("CAREERMONKE: CAPTURING AI TOOLS PANEL SCREENSHOTS (1440px & 390px)");

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Static server running on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    // 1. Desktop 1440px Capture
    console.log("1. Capturing Desktop 1440px Viewport...");
    const pageDesktop = await browser.newPage();
    await pageDesktop.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    await pageDesktop.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
    await pageDesktop.evaluate((cand) => {
      localStorage.setItem("careermonke_candidate_profile", JSON.stringify(cand));
      localStorage.setItem("cm_candidate_profile", JSON.stringify(cand));
    }, sampleCandidate);

    await pageDesktop.reload({ waitUntil: "networkidle0" });
    await pageDesktop.waitForSelector("[data-testid='job-ai-tools-panel']", { timeout: 8000 }).catch(() => null);

    const desktopPath = path.join(REPORT_DIR, "ai-tools-panel-desktop-1440.png");
    await pageDesktop.screenshot({ path: desktopPath, fullPage: false });
    console.log(`  [SAVED] Desktop 1440px screenshot: ${desktopPath}`);
    if (fs.existsSync(ARTIFACT_DIR)) {
      fs.copyFileSync(desktopPath, path.join(ARTIFACT_DIR, "ai-tools-panel-desktop-1440.png"));
    }
    await pageDesktop.close();

    // 2. Mobile 390px Capture (Collapsed & Expanded)
    console.log("2. Capturing Mobile 390px Viewport...");
    const pageMobile = await browser.newPage();
    await pageMobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });

    await pageMobile.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
    await pageMobile.evaluate((cand) => {
      localStorage.setItem("careermonke_candidate_profile", JSON.stringify(cand));
      localStorage.setItem("cm_candidate_profile", JSON.stringify(cand));
    }, sampleCandidate);

    await pageMobile.reload({ waitUntil: "networkidle0" });
    await pageMobile.waitForSelector("[data-testid='job-ai-tools-panel']", { timeout: 8000 }).catch(() => null);

    const mobileCollapsedPath = path.join(REPORT_DIR, "ai-tools-panel-mobile-390-collapsed.png");
    await pageMobile.screenshot({ path: mobileCollapsedPath, fullPage: false });
    console.log(`  [SAVED] Mobile 390px (collapsed): ${mobileCollapsedPath}`);

    // Click toggle to expand
    const toggleBtn = await pageMobile.$("button[aria-controls='ai-tools-panel-body']");
    if (toggleBtn) {
      await toggleBtn.click();
      await new Promise((r) => setTimeout(r, 400));
    }

    const mobileExpandedPath = path.join(REPORT_DIR, "ai-tools-panel-mobile-390-expanded.png");
    await pageMobile.screenshot({ path: mobileExpandedPath, fullPage: false });
    console.log(`  [SAVED] Mobile 390px (expanded): ${mobileExpandedPath}`);
    if (fs.existsSync(ARTIFACT_DIR)) {
      fs.copyFileSync(mobileCollapsedPath, path.join(ARTIFACT_DIR, "ai-tools-panel-mobile-390-collapsed.png"));
      fs.copyFileSync(mobileExpandedPath, path.join(ARTIFACT_DIR, "ai-tools-panel-mobile-390-expanded.png"));
    }
    await pageMobile.close();

    console.log("\nAll AI tools panel screenshots successfully captured!");
  } finally {
    await browser.close();
    server.close();
  }
}

captureScreenshots().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
