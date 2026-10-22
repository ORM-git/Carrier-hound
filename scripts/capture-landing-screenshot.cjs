const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_DIR = path.resolve(__dirname, "..", "out");
const TARGET_NAME = process.argv[2] || "before";
const REPORTS_DIR = path.resolve(__dirname, "..", "reports", "prompt2-shell");

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
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let cleanUrl = req.url.split("?")[0].split("#")[0];
      if (cleanUrl === "/") cleanUrl = "/index.html";

      let filePath = path.join(OUT_DIR, cleanUrl);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (fs.existsSync(filePath + ".html")) {
          filePath = filePath + ".html";
        } else {
          filePath = path.join(OUT_DIR, "index.html");
        }
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      } catch (err) {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.listen(port, () => resolve(server));
  });
}

async function run() {
  const port = 4921;
  const server = await startServer(port);
  console.log(`Static server running at http://localhost:${port}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1000));

  const desktopPath = path.join(REPORTS_DIR, `landing-${TARGET_NAME}-desktop.png`);
  await page.screenshot({ path: desktopPath, fullPage: false });
  console.log(`Saved desktop viewport screenshot to ${desktopPath}`);

  const fullPath = path.join(REPORTS_DIR, `landing-${TARGET_NAME}-full.png`);
  await page.screenshot({ path: fullPath, fullPage: true });
  console.log(`Saved full page screenshot to ${fullPath}`);

  await browser.close();
  server.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
