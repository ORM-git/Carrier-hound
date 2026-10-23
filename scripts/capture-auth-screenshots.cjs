const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3459;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPORT_DIR = path.resolve(process.cwd(), "reports", "prompt8-auth");

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
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";
    if (!path.extname(cleanUrl)) {
      cleanUrl = cleanUrl + ".html";
    }

    const filePath = path.join(OUT_DIR, cleanUrl);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });
}

async function captureScreenshots() {
  console.log("Starting screenshot capture for Prompt 8 Auth Presentation...");

  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Static server running on http://localhost:${PORT}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    const page = await browser.newPage();

    // 1. Login Desktop
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "login-desktop.png"), fullPage: false });
    console.log("Captured: login-desktop.png");

    // 2. Login Mobile
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "login-mobile.png"), fullPage: false });
    console.log("Captured: login-mobile.png");

    // 3. Login Focus Desktop
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('input#login-email');
    await page.focus('input#login-email');
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(REPORT_DIR, "login-focus-desktop.png"), fullPage: false });
    console.log("Captured: login-focus-desktop.png");

    // 4. Login Error Desktop
    await page.evaluate(() => {
      window.fetch = async function () {
        return new Response(
          JSON.stringify({ message: "Rate limit exceeded. Please wait 60 seconds before trying again." }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      };
    });
    await page.type('input#login-email', 'candidate@example.com');
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-error-banner"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "login-error-desktop.png"), fullPage: false });
    console.log("Captured: login-error-desktop.png");

    // 5. Login Email-Sent Desktop
    await page.evaluate(() => {
      window.fetch = async function () {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-email-sent"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "login-email-sent-desktop.png"), fullPage: false });
    console.log("Captured: login-email-sent-desktop.png");

    // 6. Signup Desktop
    await page.goto(`http://localhost:${PORT}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="signup-auth-card"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "signup-desktop.png"), fullPage: false });
    console.log("Captured: signup-desktop.png");

    // 7. Signup Mobile
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="signup-auth-card"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "signup-mobile.png"), fullPage: false });
    console.log("Captured: signup-mobile.png");

    // 8. Signup Error Desktop
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('input#signup-email');
    await page.evaluate(() => {
      window.fetch = async function () {
        return new Response(
          JSON.stringify({ message: "An account already exists with this email address. Please sign in instead." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      };
    });
    await page.type('input#signup-email', 'candidate@example.com');
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-error-banner"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "signup-error-desktop.png"), fullPage: false });
    console.log("Captured: signup-error-desktop.png");

    // 9. Signup Email-Sent Desktop
    await page.evaluate(() => {
      window.fetch = async function () {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-email-sent"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "signup-email-sent-desktop.png"), fullPage: false });
    console.log("Captured: signup-email-sent-desktop.png");

    console.log("All screenshots captured successfully in reports/prompt8-auth/");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

captureScreenshots().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
