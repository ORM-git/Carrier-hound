const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3892;
const FIXTURE_DIR = path.resolve(process.cwd(), "reports", "onboarding-redesign");
const SCREENSHOT_DIR = path.join(FIXTURE_DIR, "screenshots");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\29983ad6-2163-4f94-a5f7-494d97616cb7";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/" || cleanUrl === "") cleanUrl = "/index.html";

    // Handle icon requests from Next Image
    if (cleanUrl.startsWith("/_next/image") || cleanUrl === "/icon.png" || cleanUrl === "/icon-v2.png") {
      const iconPath = path.resolve(process.cwd(), "public", cleanUrl === "/icon-v2.png" ? "icon-v2.png" : "icon.png");
      if (fs.existsSync(iconPath)) {
        res.writeHead(200, { "Content-Type": "image/png" });
        fs.createReadStream(iconPath).pipe(res);
        return;
      }
    }

    const filePath = path.join(FIXTURE_DIR, cleanUrl);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found: " + cleanUrl);
    }
  });
}

const VIEWPORTS = [
  { name: "360", width: 360, height: 740, isMobile: true },
  { name: "390", width: 390, height: 844, isMobile: true },
  { name: "768", width: 768, height: 1024, isMobile: false },
  { name: "1280", width: 1280, height: 800, isMobile: false },
  { name: "1440", width: 1440, height: 900, isMobile: false },
];

const STATES = [
  { id: "step1-default", label: "Step 1 Initial / Empty" },
  { id: "step1-filled", label: "Step 1 Validated / Filled" },
  { id: "picker-open", label: "Job Function Picker Open" },
  { id: "picker-search", label: "Job Function Picker Search" },
  { id: "step2-initial", label: "Step 2 Initial / Upload" },
  { id: "step2-processing", label: "Step 2 Processing Screen" },
  { id: "step2-parsed", label: "Step 2 Parsed Summary" },
  { id: "step2-failed", label: "Step 2 Failed Fallback" },
  { id: "error-state", label: "Save Rejection Error State" },
];

async function capture() {
  console.log("Starting static server on port", PORT);
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));

  console.log("Launching Chrome from", CHROME_PATH);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const capturedFiles = [];

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n=== Capturing Viewport ${vp.name} (${vp.width}x${vp.height}) ===`);
      const page = await browser.newPage();
      await page.setViewport({
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 2,
        isMobile: vp.isMobile,
      });

      for (const state of STATES) {
        const url = `http://localhost:${PORT}/index.html?view=${state.id}`;
        await page.goto(url, { waitUntil: "networkidle0" });

        // If picker-search, type into search box to show filtered view
        if (state.id === "picker-search") {
          const searchInput = await page.$("input[aria-label='Search expected job function or role']");
          if (searchInput) {
            await searchInput.type("Data", { delay: 20 });
            await new Promise((r) => setTimeout(r, 150));
          }
        }

        // Allow animations and render to settle
        await new Promise((r) => setTimeout(r, 200));

        const fileName = `${state.id}_${vp.name}.png`;
        const filePath = path.join(SCREENSHOT_DIR, fileName);
        await page.screenshot({ path: filePath, fullPage: false });

        // Copy to artifact directory
        const artifactPath = path.join(ARTIFACT_DIR, fileName);
        fs.copyFileSync(filePath, artifactPath);

        capturedFiles.push({ state: state.id, viewport: vp.name, path: filePath, artifactPath });
        console.log(`  ✓ Saved: ${fileName}`);
      }

      await page.close();
    }

    console.log(`\nSuccessfully captured all ${capturedFiles.length} screenshots!`);
  } finally {
    await browser.close();
    server.close();
  }
}

capture().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
