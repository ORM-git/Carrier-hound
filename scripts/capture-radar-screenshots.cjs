const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const ssr = require("@supabase/ssr");

const PORT = 3478;
const OUT_DIR = path.resolve(__dirname, "..", "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\b394cb45-691f-4617-abee-cf5da55fdbd5";
const REPORTS_DIR = path.resolve(__dirname, "..", "reports", "radar");

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
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
    let cleanUrl = req.url.split("?")[0].split("#")[0];

    // Serve radar data for /api/radar if queried
    if (cleanUrl === "/api/radar" || cleanUrl === "/api/radar.json") {
      const radarPath = path.resolve(__dirname, "..", "public", "api", "radar.json");
      if (fs.existsSync(radarPath)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        fs.createReadStream(radarPath).pipe(res);
        return;
      }
    }

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

async function capture() {
  console.log("Starting radar screenshot capture...");
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Static server running at http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--enable-webgl"],
  });

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => console.log("PAGE CONSOLE:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

    const sampleUser = {
      id: "c833c355-cfa8-42cc-9792-31812da9f870",
      email: "xbsuryakant+test@gmail.com",
      user_metadata: { full_name: "Alex Candidate" },
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "email", providers: ["email"] },
      created_at: "2026-01-01T00:00:00.000Z",
    };

    const sampleSession = {
      access_token: "mock-valid-access-token",
      refresh_token: "mock-valid-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: sampleUser,
    };

    // Enable request interception for Supabase API calls
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      const method = req.method();
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "*",
      };

      if (url.includes("supabase.co")) {
        if (method === "OPTIONS") {
          req.respond({
            status: 200,
            headers: corsHeaders,
            body: "ok",
          });
          return;
        }

        if (url.includes("/rest/v1/subscriptions")) {
          const accept = req.headers()["accept"] || "";
          const payload = {
            status: "active",
            plan_id: "intl_monthly_9",
            current_period_end: "2030-01-01T00:00:00.000Z",
            grace_period_end: null,
          };
          const body = accept.includes("vnd.pgrst.object+json")
            ? JSON.stringify(payload)
            : JSON.stringify([payload]);
          req.respond({
            status: 200,
            headers: {
              ...corsHeaders,
              "content-type": "application/json",
            },
            body,
          });
          return;
        }

        if (url.includes("/auth/v1/user") || url.includes("/auth/v1/session")) {
          req.respond({
            status: 200,
            headers: {
              ...corsHeaders,
              "content-type": "application/json",
            },
            body: JSON.stringify(sampleUser),
          });
          return;
        }
      }

      req.continue();
    });

    // Chunk and set @supabase/ssr cookies
    const cookieName = "sb-szakevhxhwpeskidvtfs-auth-token";
    const rawStr = JSON.stringify(sampleSession);
    const cookieVal = "base64-" + ssr.stringToBase64URL(rawStr);
    const chunks = ssr.createChunks(cookieName, cookieVal);
    const cookies = chunks.map((c) => ({
      name: c.name,
      value: c.value,
      domain: "localhost",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    }));
    await page.setCookie(
      ...cookies,
      {
        name: "careermonke_user_email",
        value: sampleUser.email,
        domain: "localhost",
        path: "/",
      }
    );

    // Also prime localStorage
    await page.evaluateOnNewDocument(
      (sess, user) => {
        localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
        localStorage.setItem("careermonke_auth_user", JSON.stringify(user));
        localStorage.setItem("careermonke_user_email", user.email);
        localStorage.setItem("careermonke_pro_active", "true");
        localStorage.setItem("cm_cookie_notice", "dismissed");
      },
      sampleSession,
      sampleUser
    );

    // 1. DESKTOP VIEWPORT (1280px)
    console.log("Capturing 1280px Desktop Radar...");
    await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/radar`, { waitUntil: "domcontentloaded" });
    console.log("Current page URL:", page.url());

    try {
      await page.waitForSelector("canvas", { timeout: 15000 });
      console.log("Canvas rendered, waiting for telemetry markers and WebGL render...");
      await new Promise((r) => setTimeout(r, 4000));
    } catch (err) {
      console.error("Canvas not found! Current URL is:", page.url());
      const bodyHtml = await page.evaluate(() => document.body.innerText);
      console.error("Body text:", bodyHtml);
      const debugScreenshot = path.join(REPORTS_DIR, "radar-debug.png");
      await page.screenshot({ path: debugScreenshot });
      console.error("Saved debug screenshot to:", debugScreenshot);
      throw err;
    }

    const desktopPath = path.join(REPORTS_DIR, "radar-desktop-1280px.png");
    const desktopArtifact = path.join(ARTIFACT_DIR, "radar-desktop-1280px.png");
    await page.screenshot({ path: desktopPath });
    fs.copyFileSync(desktopPath, desktopArtifact);
    console.log("  Saved:", desktopPath);
    console.log("  Copied to artifact:", desktopArtifact);

    // 2. MOBILE VIEWPORT (390px)
    console.log("Capturing 390px Mobile Radar...");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/radar`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("canvas", { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 4000));

    const mobilePath = path.join(REPORTS_DIR, "radar-mobile-390px.png");
    const mobileArtifact = path.join(ARTIFACT_DIR, "radar-mobile-390px.png");
    await page.screenshot({ path: mobilePath });
    fs.copyFileSync(mobilePath, mobileArtifact);
    console.log("  Saved:", mobilePath);
    console.log("  Copied to artifact:", mobileArtifact);

    console.log("All screenshots captured successfully!");
  } finally {
    await browser.close();
    server.close();
  }
}

capture().catch((err) => {
  console.error("Error capturing screenshots:", err);
  process.exit(1);
});
