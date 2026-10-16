const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3365;
const OUT_DIR = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\out-before-contrast";
const REPORTS_DIR = path.join(__dirname, "..", "reports", "a11y-contrast");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";
    if (cleanUrl === "/privacy") cleanUrl = "/privacy-policy.html";
    if (cleanUrl === "/terms") cleanUrl = "/terms-and-conditions.html";

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
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

const PAGES = [
  { name: "landing", path: "/", maskCanvas: false },
  { name: "login", path: "/login", maskCanvas: false },
  { name: "signup", path: "/signup", maskCanvas: false },
  { name: "jobs", path: "/jobs", maskCanvas: false },
  { name: "worldwide", path: "/worldwide", maskCanvas: false },
  { name: "privacy", path: "/privacy-policy", maskCanvas: false },
  { name: "terms", path: "/terms-and-conditions", maskCanvas: false },
  { name: "radar", path: "/radar", maskCanvas: true },
];

const VIEWPORTS = [
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[INFO] Server running on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    for (const p of PAGES) {
      for (const vp of VIEWPORTS) {
        const page = await browser.newPage();
        await page.setViewport({
          width: vp.width,
          height: vp.height,
          isMobile: vp.isMobile,
          hasTouch: vp.hasTouch,
          deviceScaleFactor: 1,
        });

        await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
        await page.goto(`http://localhost:${PORT}${p.path}`, { waitUntil: "networkidle0", timeout: 30000 });

        await page.evaluate((maskCanvas) => {
          const style = document.createElement("style");
          style.textContent = `
            *, *::before, *::after {
              animation-delay: 0s !important;
              animation-duration: 0s !important;
              transition-delay: 0s !important;
              transition-duration: 0s !important;
              caret-color: transparent !important;
            }
          `;
          document.head.appendChild(style);

          if (maskCanvas) {
            document.querySelectorAll("canvas").forEach((c) => {
              c.style.visibility = "hidden";
            });
          }
        }, p.maskCanvas);

        await page.evaluate(() => document.fonts.ready);
        await new Promise((r) => setTimeout(r, 600));

        const outPath = path.join(REPORTS_DIR, `${p.name}-${vp.name}-before.png`);
        await page.screenshot({ path: outPath, fullPage: false });
        console.log(`Saved: ${outPath}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
