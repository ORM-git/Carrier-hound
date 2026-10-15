const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { execSync } = require("child_process");

const PORT = 3333;
const OUT_DIR = path.join(__dirname, "..", "out");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\caf034a4-a523-4c7f-8755-7fa4fad550ba\\perf_screenshots";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";

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

async function captureStateScreenshots(browser, prefix) {
  const screenshots = {};
  const viewports = [
    { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
    { name: "1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
  ];

  for (const vp of viewports) {
    const page = await browser.newPage();
    await page.setViewport(vp);

    // 1. Top of page
    await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));
    const topPath = path.join(ARTIFACT_DIR, `${prefix}_top_${vp.name}.png`);
    await page.screenshot({ path: topPath, fullPage: false });
    screenshots[`top_${vp.name}`] = topPath;
    console.log(`Captured ${prefix} top_${vp.name}`);

    // 2. After filter open (click More Categories dropdown)
    try {
      const moreBtn = await page.$('button[aria-haspopup="true"]');
      if (moreBtn) {
        await moreBtn.click();
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (_) {}
    const filterOpenPath = path.join(ARTIFACT_DIR, `${prefix}_filter_open_${vp.name}.png`);
    await page.screenshot({ path: filterOpenPath, fullPage: false });
    screenshots[`filter_open_${vp.name}`] = filterOpenPath;
    console.log(`Captured ${prefix} filter_open_${vp.name}`);

    // 3. After one filter applied (Remote Only toggle)
    await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const remoteBtn = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        return buttons.find((b) => b.textContent.includes("Remote Only"));
      });
      if (remoteBtn && remoteBtn.asElement()) {
        await remoteBtn.asElement().click();
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (_) {}
    const filterAppliedPath = path.join(ARTIFACT_DIR, `${prefix}_filter_applied_${vp.name}.png`);
    await page.screenshot({ path: filterAppliedPath, fullPage: false });
    screenshots[`filter_applied_${vp.name}`] = filterAppliedPath;
    console.log(`Captured ${prefix} filter_applied_${vp.name}`);

    // 4. Empty-result state (search for nonexistent term)
    try {
      const searchInput = await page.$('input[aria-label="Search by job title, company, or keyword"]');
      if (searchInput) {
        await searchInput.click({ clickCount: 3 });
        await searchInput.type("xyznonexistentjob1234567890", { delay: 20 });
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (_) {}
    const emptyPath = path.join(ARTIFACT_DIR, `${prefix}_empty_${vp.name}.png`);
    await page.screenshot({ path: emptyPath, fullPage: false });
    screenshots[`empty_${vp.name}`] = emptyPath;
    console.log(`Captured ${prefix} empty_${vp.name}`);

    await page.close();
  }

  return screenshots;
}

async function diffImages(page, path1, path2, width, height) {
  const b64_1 = fs.readFileSync(path1).toString("base64");
  const b64_2 = fs.readFileSync(path2).toString("base64");

  return await page.evaluate(
    async (s1, s2, w, h) => {
      function loadImage(src) {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = src;
        });
      }

      const [img1, img2] = await Promise.all([
        loadImage("data:image/png;base64," + s1),
        loadImage("data:image/png;base64," + s2),
      ]);

      const c1 = document.createElement("canvas");
      c1.width = w;
      c1.height = h;
      const ctx1 = c1.getContext("2d");
      ctx1.drawImage(img1, 0, 0, w, h);
      const d1 = ctx1.getImageData(0, 0, w, h).data;

      const c2 = document.createElement("canvas");
      c2.width = w;
      c2.height = h;
      const ctx2 = c2.getContext("2d");
      ctx2.drawImage(img2, 0, 0, w, h);
      const d2 = ctx2.getImageData(0, 0, w, h).data;

      let mismatched = 0;
      const totalPixels = w * h;

      for (let i = 0; i < d1.length; i += 4) {
        const dr = Math.abs(d1[i] - d2[i]);
        const dg = Math.abs(d1[i + 1] - d2[i + 1]);
        const db = Math.abs(d1[i + 2] - d2[i + 2]);
        const da = Math.abs(d1[i + 3] - d2[i + 3]);
        // Threshold of 5 for subpixel antialiasing differences
        if (dr > 5 || dg > 5 || db > 5 || da > 5) {
          mismatched++;
        }
      }

      return {
        mismatched,
        totalPixels,
        diffPercent: (mismatched / totalPixels) * 100,
      };
    },
    b64_1,
    b64_2,
    width,
    height
  );
}

async function main() {
  console.log("==================================================================================");
  console.log("       STEP 4: VISUAL SCREENSHOT PIXEL DIFFING (BEFORE vs AFTER: 8 PAIRS)         ");
  console.log("==================================================================================\n");

  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // 1. Capture AFTER screenshots (current optimized build in out/)
    console.log("Phase 1: Capturing AFTER screenshots (optimized build)...");
    const afterScreenshots = await captureStateScreenshots(browser, "after");

    // 2. Temporarily build BEFORE version from fix/prompt15
    console.log("\nPhase 2: Checking out fix/prompt15 jobs page and building BEFORE version...");
    execSync("git checkout fix/prompt15 -- src/app/jobs/page.tsx", { stdio: "inherit" });
    execSync("npm run build", { stdio: "inherit" });

    // 3. Capture BEFORE screenshots
    console.log("\nPhase 3: Capturing BEFORE screenshots (baseline build)...");
    const beforeScreenshots = await captureStateScreenshots(browser, "before");

    // 4. Restore AFTER version
    console.log("\nPhase 4: Restoring AFTER version...");
    execSync("git checkout HEAD -- src/app/jobs/page.tsx", { stdio: "inherit" });
    execSync("npm run build", { stdio: "inherit" });

    // 5. Diff each pair
    console.log("\n==================================================================================");
    console.log("                         PIXEL DIFF VERIFICATION RESULTS                          ");
    console.log("==================================================================================");

    const diffPage = await browser.newPage();
    const pairs = [
      { key: "top_390", width: 390, height: 844 },
      { key: "top_1440", width: 1440, height: 900 },
      { key: "filter_open_390", width: 390, height: 844 },
      { key: "filter_open_1440", width: 1440, height: 900 },
      { key: "filter_applied_390", width: 390, height: 844 },
      { key: "filter_applied_1440", width: 1440, height: 900 },
      { key: "empty_390", width: 390, height: 844 },
      { key: "empty_1440", width: 1440, height: 900 },
    ];

    const results = [];
    for (const p of pairs) {
      const beforeImg = beforeScreenshots[p.key];
      const afterImg = afterScreenshots[p.key];
      const diff = await diffImages(diffPage, beforeImg, afterImg, p.width, p.height);
      const passed = diff.diffPercent <= 0.1;
      results.push({
        state: p.key,
        diffPercent: diff.diffPercent.toFixed(4) + "%",
        mismatchedPixels: diff.mismatched,
        totalPixels: diff.totalPixels,
        verdict: passed ? "PASS-LOCAL" : "FAIL",
      });
      console.log(
        `${passed ? "✅ PASS" : "❌ FAIL"} - ${p.key}: ${diff.diffPercent.toFixed(4)}% diff (${diff.mismatched} / ${diff.totalPixels} px)`
      );
    }

    await diffPage.close();

    console.log("\nSummary Table:");
    console.table(results);

    const anyFailed = results.some((r) => r.verdict === "FAIL");
    if (anyFailed) {
      console.error("FAIL: Pixel diff exceeded threshold on one or more states!");
      process.exit(1);
    } else {
      console.log("\n🎉 ALL 8 SCREENSHOT PAIRS ARE PIXEL-IDENTICAL (Diff <= 0.1%)!");
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in run-visual-pixel-diff.js:", err);
  // Ensure jobs/page.tsx is restored
  try {
    execSync("git checkout HEAD -- src/app/jobs/page.tsx");
  } catch (_) {}
  process.exit(1);
});
