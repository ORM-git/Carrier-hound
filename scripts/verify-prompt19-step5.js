const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3334;
const OUT_DIR = path.join(__dirname, "..", "out");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\caf034a4-a523-4c7f-8755-7fa4fad550ba\\perf_screenshots";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const isNegativeControl = process.argv.includes("--negative-control");

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

async function diffImages(page, path1, path2, width, height) {
  if (!fs.existsSync(path1) || !fs.existsSync(path2)) {
    throw new Error(`Cannot diff missing image: ${path1} or ${path2}`);
  }

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
  console.log("             STEP 5: REGRESSION & VISUAL CHECK (PROMPT 19)                       ");
  console.log("==================================================================================\n");

  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[INFO] Static server listening on http://localhost:${PORT}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // -------------------------------------------------------------------------
    // STEP 5a: Test redirect and query param preservation
    // -------------------------------------------------------------------------
    console.log("\n--- STEP 5a: Client Fallback Redirect Verification ---");
    const testPage = await browser.newPage();
    await testPage.setViewport({ width: 1440, height: 900 });

    const initialUrl = `http://localhost:${PORT}/job-search/all?search=devops&category=ai`;
    console.log(`[NAVIGATE] Visiting: ${initialUrl}`);
    await testPage.goto(initialUrl, { waitUntil: "networkidle0" });

    // Wait for Next.js router.replace to execute and React to render
    await testPage.waitForFunction(
      () => window.location.pathname === "/jobs",
      { timeout: 10000 }
    );
    await new Promise((r) => setTimeout(r, 1500));

    const finalUrl = testPage.url();
    console.log(`[RESULT] Final URL: ${finalUrl}`);

    const expectedUrlPrefix = `http://localhost:${PORT}/jobs?search=devops&category=ai`;
    if (finalUrl !== expectedUrlPrefix) {
      throw new Error(`URL mismatch! Expected: ${expectedUrlPrefix}, Got: ${finalUrl}`);
    }
    console.log("[PASS] Final URL strictly preserved query params: ?search=devops&category=ai");

    // Check search input value
    const searchVal = await testPage.$eval(
      'input[aria-label="Search by job title, company, or keyword"]',
      (el) => el.value
    );
    console.log(`[RESULT] Rendered Search Input Value: "${searchVal}"`);
    if (searchVal !== "devops") {
      throw new Error(`Search input value mismatch! Expected: "devops", Got: "${searchVal}"`);
    }
    console.log('[PASS] /jobs search input correctly populated with "devops"');

    // Check category state / active filter
    const pageContent = await testPage.evaluate(() => {
      const banner = document.querySelector(".flex.items-center.justify-between.text-xs.text-slate-500")?.textContent || "";
      const searchInput = document.querySelector('input[aria-label="Search by job title, company, or keyword"]')?.value || "";
      return { banner, searchInput };
    });
    console.log(`[RESULT] Results count banner text: "${pageContent.banner.trim()}"`);

    await testPage.close();

    // -------------------------------------------------------------------------
    // STEP 5b: Pixel diff of /jobs top at 390px and 1440px vs baseline
    // -------------------------------------------------------------------------
    console.log("\n--- STEP 5b: Pixel Diff of /jobs top at 390px and 1440px ---");
    const diffPage = await browser.newPage();

    const viewports = [
      { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
      { name: "1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
    ];

    const diffResults = [];
    for (const vp of viewports) {
      await diffPage.setViewport(vp);
      await diffPage.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1500));

      const currentPath = path.join(ARTIFACT_DIR, `p19_top_${vp.name}.png`);
      await diffPage.screenshot({ path: currentPath, fullPage: false });
      console.log(`[CAPTURED] Captured p19_top_${vp.name}.png`);

      const baselinePath = path.join(ARTIFACT_DIR, `before_top_${vp.name}.png`);
      const diff = await diffImages(diffPage, baselinePath, currentPath, vp.width, vp.height);

      let effectiveDiffPercent = diff.diffPercent;
      if (isNegativeControl) {
        // Intentionally simulate diff failure
        effectiveDiffPercent = 99.99;
      }

      const passed = effectiveDiffPercent <= 0.05;
      diffResults.push({
        state: `top_${vp.name}`,
        diffPercent: effectiveDiffPercent.toFixed(4) + "%",
        mismatchedPixels: isNegativeControl ? 99999 : diff.mismatched,
        totalPixels: diff.totalPixels,
        verdict: passed ? "PASS-LOCAL" : "FAIL",
      });

      console.log(
        `${passed ? "[PASS]" : "[FAIL]"} top_${vp.name}: ${effectiveDiffPercent.toFixed(4)}% diff (${diff.mismatched} / ${diff.totalPixels} px)`
      );
    }

    await diffPage.close();

    console.log("\nVisual Diff Summary:");
    console.table(diffResults);

    const anyFailed = diffResults.some((r) => r.verdict === "FAIL");
    if (anyFailed) {
      console.error("[FAIL] Step 5b pixel diff exceeded threshold!");
      process.exit(1);
    }

    console.log("\n[PASS-LOCAL] STEP 5a and STEP 5b verified successfully!");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in verify-prompt19-step5.js:", err.message);
  process.exit(1);
});
