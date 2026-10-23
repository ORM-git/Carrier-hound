const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
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
  console.log("Starting screenshot & entrance recording capture for Jobright-style Auth Presentation...");

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

    // -------------------------------------------------------------------------
    // 1. DESKTOP & MOBILE STATIC CAPTURES (/login)
    // -------------------------------------------------------------------------
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "login-desktop.png"), fullPage: false });
    console.log("Captured: login-desktop.png");

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "login-mobile.png"), fullPage: false });
    console.log("Captured: login-mobile.png");

    // Focus desktop
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('input#login-email');
    await page.focus('input#login-email');
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(REPORT_DIR, "login-focus-desktop.png"), fullPage: false });
    console.log("Captured: login-focus-desktop.png");

    // Error desktop (simulated 429)
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

    // Email-sent desktop (simulated 200)
    await page.evaluate(() => {
      window.fetch = async function () {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-email-sent"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "login-email-sent-desktop.png"), fullPage: false });
    console.log("Captured: login-email-sent-desktop.png");

    // -------------------------------------------------------------------------
    // 2. DESKTOP & MOBILE STATIC CAPTURES (/signup)
    // -------------------------------------------------------------------------
    await page.goto(`http://localhost:${PORT}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="signup-auth-card"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "signup-desktop.png"), fullPage: false });
    console.log("Captured: signup-desktop.png");

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="signup-auth-card"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "signup-mobile.png"), fullPage: false });
    console.log("Captured: signup-mobile.png");

    // Signup Error desktop
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

    // Signup Email-sent desktop
    await page.evaluate(() => {
      window.fetch = async function () {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-email-sent"]');
    await page.screenshot({ path: path.join(REPORT_DIR, "signup-email-sent-desktop.png"), fullPage: false });
    console.log("Captured: signup-email-sent-desktop.png");

    // -------------------------------------------------------------------------
    // 3. ENTRANCE MOTION RECORDING (0.3s cubic-bezier(0.08, 0.82, 0.17, 1))
    // -------------------------------------------------------------------------
    console.log("Recording entrance motion frames (0 to 350ms)...");
    const framesDir = path.join(REPORT_DIR, "entrance-frames");
    if (!fs.existsSync(framesDir)) {
      fs.mkdirSync(framesDir, { recursive: true });
    }

    const entrancePage = await browser.newPage();
    await entrancePage.setViewport({ width: 1280, height: 900 });

    // We can inject animation paused and advance animation in discrete steps
    await entrancePage.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });

    // Advance animation manually to capture 8 discrete interpolation stages from 0% to 100%
    const stages = [
      { name: "frame_000.png", progress: 0.0, timeMs: 0 },
      { name: "frame_001.png", progress: 0.15, timeMs: 45 },
      { name: "frame_002.png", progress: 0.35, timeMs: 105 },
      { name: "frame_003.png", progress: 0.55, timeMs: 165 },
      { name: "frame_004.png", progress: 0.75, timeMs: 225 },
      { name: "frame_005.png", progress: 0.90, timeMs: 270 },
      { name: "frame_006.png", progress: 1.0, timeMs: 300 },
    ];

    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      // Apply exact progress state: opacity from 0 to 1, scale from 0.98 to 1
      const scale = 0.98 + (1.0 - 0.98) * s.progress;
      const opacity = s.progress;
      const backdropOpacity = Math.min(1.0, s.progress * 1.2);

      await entrancePage.evaluate(({ op, sc, bOp }) => {
        const card = document.querySelector('[data-testid="login-auth-card"]');
        const backdrop = document.querySelector('[data-testid="auth-backdrop"]');
        if (card) {
          card.style.animation = "none";
          card.style.opacity = String(op);
          card.style.transform = `scale(${sc})`;
        }
        if (backdrop) {
          backdrop.style.animation = "none";
          backdrop.style.opacity = String(bOp);
        }
      }, { op: opacity, sc: scale, bOp: backdropOpacity });

      const framePath = path.join(framesDir, s.name);
      await entrancePage.screenshot({ path: framePath });
      console.log(`Captured entrance stage: ${s.name} (${s.timeMs}ms, opacity=${opacity.toFixed(2)}, scale=${scale.toFixed(4)})`);
    }

    await entrancePage.close();

    // Use ffmpeg to compile frames into an animated GIF: login-entrance.gif
    console.log("Encoding frames into reports/prompt8-auth/login-entrance.gif via ffmpeg...");
    const gifPath = path.join(REPORT_DIR, "login-entrance.gif");
    try {
      execSync(
        `ffmpeg -y -framerate 10 -i "${framesDir}/frame_%03d.png" -filter_complex "[0:v] fps=10,scale=800:-1:flags=lanczos,split [a][b];[a] palettegen [p];[b][p] paletteuse" "${gifPath}"`,
        { stdio: "inherit" }
      );
      console.log(`Generated animated entrance GIF: ${gifPath}`);
    } catch (e) {
      console.warn("Notice: GIF encoding via ffmpeg encountered notice:", e.message);
    }

    console.log("\nAll screenshots and entrance recordings captured successfully in reports/prompt8-auth/");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

captureScreenshots().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
