const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer-core");
const {
  PORT,
  CHROME_PATH,
  createServer,
  setupPageMocks,
} = require("./test-prompt5-base.cjs");

const REPORT_DIR = path.resolve(process.cwd(), "reports", "prompt-t1");
const SCREENSHOT_DIR = path.join(REPORT_DIR, "screenshots");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\f124d0fc-3342-4fb1-b070-301ce6e60d8f";

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function getSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function captureTailorModalScreenshots() {
  console.log("================================================================================");
  console.log("CAREERMONKE T1: CAPTURE AI RESUME TAILORING UI SCREENSHOTS");
  console.log("================================================================================\n");

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[SERVER] Static server listening on port ${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
    ],
  });

  const manifest = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Enable request interception and setup standard mocks with isSigned: true, isPro: true, cookieNotice: false (real key cm_cookie_notice = "accepted")
    await setupPageMocks(page, { isSigned: true, isPro: true, cookieNotice: false });

    // Seed real cookie consent key cm_cookie_notice
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem("cm_cookie_notice", "accepted");
    });

    console.log("[NAV] Navigating to /dashboard...");
    await page.goto(`http://localhost:${PORT}/dashboard`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1200));

    // Wait for "AI Resume" button in Top 10 jobs
    await page.waitForSelector('button', { timeout: 10000 });

    console.log("[ACTION] Finding and clicking 'AI Resume' button...");
    const opened = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const aiBtn = btns.find((b) => b.textContent && b.textContent.includes("AI Resume"));
      if (aiBtn) {
        aiBtn.click();
        return true;
      }
      return false;
    });

    if (!opened) {
      throw new Error("Could not find 'AI Resume' button on dashboard");
    }

    await new Promise((r) => setTimeout(r, 1200));

    // Wait for modal header
    await page.waitForSelector('[aria-label="Close modal"], h2', { timeout: 8000 });

    // -------------------------------------------------------------
    // CAPTURE 1: Rules-based Default State
    // -------------------------------------------------------------
    console.log("[CAPTURE 1] Capturing ai_tailor_rules_state.png...");
    const path1 = path.join(SCREENSHOT_DIR, "ai_tailor_rules_state.png");
    await page.screenshot({ path: path1, fullPage: false });

    // -------------------------------------------------------------
    // CAPTURE 2: Click "Generate AI-tailored version" -> Review State
    // -------------------------------------------------------------
    console.log("[ACTION] Clicking 'Generate AI-tailored version' button...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const genBtn = btns.find((b) => b.textContent && b.textContent.includes("Generate AI-tailored version"));
      if (genBtn) genBtn.click();
    });

    await new Promise((r) => setTimeout(r, 1500));

    console.log("[CAPTURE 2] Capturing ai_tailor_review_state.png...");
    const path2 = path.join(SCREENSHOT_DIR, "ai_tailor_review_state.png");
    await page.screenshot({ path: path2, fullPage: false });

    // -------------------------------------------------------------
    // CAPTURE 3: Click "Accept AI Changes" -> Accepted State
    // -------------------------------------------------------------
    console.log("[ACTION] Clicking 'Accept AI Changes' button...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const acceptBtn = btns.find((b) => b.textContent && b.textContent.includes("Accept AI Changes"));
      if (acceptBtn) acceptBtn.click();
    });

    await new Promise((r) => setTimeout(r, 1000));

    console.log("[CAPTURE 3] Capturing ai_tailor_accepted_state.png...");
    const path3 = path.join(SCREENSHOT_DIR, "ai_tailor_accepted_state.png");
    await page.screenshot({ path: path3, fullPage: false });

    // -------------------------------------------------------------
    // CAPTURE 4: Revert to Rules, Trigger Failed State
    // -------------------------------------------------------------
    console.log("[ACTION] Reverting to rules and triggering simulated AI failure...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const revertBtn = btns.find((b) => b.textContent && b.textContent.includes("Revert to Rules"));
      if (revertBtn) revertBtn.click();
    });
    await new Promise((r) => setTimeout(r, 600));

    // Override /api/ai to return 502 error
    await page.setRequestInterception(true);
    page.removeAllListeners("request");
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/ai")) {
        req.respond({
          status: 502,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify({ error: "AI service generation failed. Please try again." }),
        });
        return;
      }
      try { req.continue(); } catch {}
    });

    // Click "Generate AI-tailored version"
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const genBtn = btns.find((b) => b.textContent && b.textContent.includes("Generate AI-tailored version"));
      if (genBtn) genBtn.click();
    });

    await new Promise((r) => setTimeout(r, 1200));

    console.log("[CAPTURE 4] Capturing ai_tailor_failed_state.png...");
    const path4 = path.join(SCREENSHOT_DIR, "ai_tailor_failed_state.png");
    await page.screenshot({ path: path4, fullPage: false });

    // Copy to artifact directory
    const shots = [
      { name: "ai_tailor_rules_state.png", file: path1 },
      { name: "ai_tailor_review_state.png", file: path2 },
      { name: "ai_tailor_accepted_state.png", file: path3 },
      { name: "ai_tailor_failed_state.png", file: path4 },
    ];

    for (const s of shots) {
      if (fs.existsSync(s.file)) {
        const dest = path.join(ARTIFACT_DIR, s.name);
        fs.copyFileSync(s.file, dest);
        const stat = fs.statSync(s.file);
        const hash = getSha256(s.file);
        manifest.push({
          name: s.name,
          path: s.file,
          artifactPath: dest,
          bytes: stat.size,
          sha256: hash,
        });
      }
    }

    console.log("\n================================================================================");
    console.log("SCREENSHOT CAPTURE MANIFEST:");
    manifest.forEach((m) => {
      console.log(`  - ${m.name}: ${m.bytes} bytes | SHA256: ${m.sha256}`);
    });
    console.log("================================================================================");
  } finally {
    await browser.close();
    server.close();
  }
}

captureTailorModalScreenshots().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
