const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const {
  CHROME_PATH,
  createServer,
  setupPageMocks,
} = require("./test-prompt5-base.cjs");

const PORT = 3597;
const VISUAL_OUT_DIR = path.resolve("D:\\Carrer-hound\\visual-out");
const ARTIFACT_DIR = path.resolve("C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\c5deb1a1-59c2-4f16-b151-2ec9625c9084");

if (!fs.existsSync(VISUAL_OUT_DIR)) {
  fs.mkdirSync(VISUAL_OUT_DIR, { recursive: true });
}
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

async function saveDual(page, filename) {
  const p1 = path.join(VISUAL_OUT_DIR, filename);
  const p2 = path.join(ARTIFACT_DIR, filename);
  await page.screenshot({ path: p1, fullPage: false });
  fs.copyFileSync(p1, p2);
  console.log(`  📸 [SAVED] ${filename} -> visual-out/ and artifact dir`);
}

async function run() {
  console.log("================================================================================");
  console.log("       CAPTURING JOBRIGHT-STYLE FILTERS & SCROLL VISUAL DELIVERABLES            ");
  console.log("================================================================================\n");

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[SERVER] Mock static server listening on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--use-gl=angle",
      "--use-angle=default",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--hide-scrollbars",
    ],
  });

  const viewports = [
    { name: "1440", width: 1440, height: 900, isMobile: false },
    { name: "1024", width: 1024, height: 768, isMobile: false },
    { name: "768", width: 768, height: 1024, isMobile: false },
    { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
    { name: "360", width: 360, height: 740, isMobile: true, hasTouch: true },
  ];

  let allPassed = true;

  try {
    // -------------------------------------------------------------------------
    // SECTION 1: VIEWPORT OVERFLOW AUDIT (1440, 1024, 768, 390, 360)
    // -------------------------------------------------------------------------
    console.log("\n--- SECTION 1: ZERO HORIZONTAL OVERFLOW AUDIT ---");
    for (const vp of viewports) {
      const page = await browser.newPage();
      await page.setViewport(vp);
      await setupPageMocks(page, { isSigned: true, isPro: true, cookieNotice: false });
      await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="job-card"]', { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 400));

      const overflow = await page.evaluate(() => {
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          isOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });

      if (overflow.isOverflow) {
        console.error(`  ❌ [FAIL] ${vp.name}px: scrollWidth (${overflow.scrollWidth}) > innerWidth (${overflow.innerWidth})`);
        allPassed = false;
      } else {
        console.log(`  ✅ [PASS] ${vp.name}px: scrollWidth (${overflow.scrollWidth}) === innerWidth (${overflow.innerWidth})`);
      }
      await page.close();
    }

    // -------------------------------------------------------------------------
    // SECTION 2: DESKTOP FILTER BAR INTERACTION (1440px)
    // -------------------------------------------------------------------------
    console.log("\n--- SECTION 2: DESKTOP 1440px FILTER INTERACTIONS ---");
    const page1440 = await browser.newPage();
    await page1440.setViewport({ width: 1440, height: 900 });
    await setupPageMocks(page1440, { isSigned: true, isPro: true, cookieNotice: false });
    await page1440.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
    await page1440.waitForSelector('[data-testid="job-card"]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 600));

    // A. Open Location Popover
    console.log("  Opening Location filter popover...");
    const locTrigger = await page1440.waitForSelector('button[aria-label^="Location filter"]', { timeout: 5000 });
    await locTrigger.click();
    await page1440.waitForSelector('[role="dialog"][aria-label="Filter by Location"]', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    await saveDual(page1440, "desktop-filterbar-popover-1440.png");

    // B. Select "United States" in Location Popover and Confirm
    console.log("  Selecting United States and Confirming...");
    await page1440.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Filter by Location"]');
      if (!dialog) return;
      const btns = Array.from(dialog.querySelectorAll("button"));
      const usBtn = btns.find((b) => b.textContent && b.textContent.includes("United States"));
      if (usBtn) usBtn.click();
    });
    await new Promise((r) => setTimeout(r, 200));
    await page1440.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Filter by Location"]');
      if (!dialog) return;
      const btns = Array.from(dialog.querySelectorAll("button"));
      const confirmBtn = btns.find((b) => b.textContent && b.textContent.includes("Confirm"));
      if (confirmBtn) confirmBtn.click();
    });
    await new Promise((r) => setTimeout(r, 500));
    await saveDual(page1440, "desktop-filterbar-active-chips-1440.png");

    // C. Open All Filters Drawer (872px on wide desktop)
    console.log("  Opening All Filters Drawer...");
    const allFiltersBtn = await page1440.waitForSelector('button[aria-label="Open all filters drawer"]', { timeout: 5000 });
    await allFiltersBtn.click();
    await page1440.waitForSelector('[role="dialog"][aria-label="All Filters"]', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 600));
    await saveDual(page1440, "desktop-all-filters-drawer-1440.png");

    // Close drawer via Escape
    await page1440.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));
    await page1440.close();

    // -------------------------------------------------------------------------
    // SECTION 3: MOBILE FILTER BAR & SHEET (390px)
    // -------------------------------------------------------------------------
    console.log("\n--- SECTION 3: MOBILE 390px FILTER BAR & SHEET ---");
    const page390 = await browser.newPage();
    await page390.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await setupPageMocks(page390, { isSigned: true, isPro: true, cookieNotice: false });
    await page390.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
    await page390.waitForSelector('[data-testid="job-card"]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 500));

    // Capture Mobile Trigger Row (Filters button + Sort)
    await saveDual(page390, "mobile-filters-trigger-row-390.png");

    // Open Mobile Bottom Sheet
    console.log("  Opening Mobile Filter Sheet on 390px...");
    const mobileTrigger = await page390.waitForSelector('button[aria-label="Open filter settings"]', { timeout: 5000 });
    await mobileTrigger.click();
    await page390.waitForSelector('[role="dialog"][aria-label="Filter positions"]', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));

    // Scroll sheet to reveal accordion and "View Hidden Positions"
    await page390.evaluate(() => {
      const scrollable = document.querySelector('[role="dialog"][aria-label="Filter positions"] .overflow-y-auto');
      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight / 2;
      }
    });
    await new Promise((r) => setTimeout(r, 400));
    await saveDual(page390, "mobile-filters-sheet-390.png");
    await page390.close();

    // -------------------------------------------------------------------------
    // SECTION 4: MOBILE 360px FILTER SHEET
    // -------------------------------------------------------------------------
    console.log("\n--- SECTION 4: MOBILE 360px FILTER SHEET ---");
    const page360 = await browser.newPage();
    await page360.setViewport({ width: 360, height: 740, isMobile: true, hasTouch: true });
    await setupPageMocks(page360, { isSigned: true, isPro: true, cookieNotice: false });
    await page360.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0" });
    await page360.waitForSelector('[data-testid="job-card"]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 500));

    const mobileTrigger360 = await page360.waitForSelector('button[aria-label="Open filter settings"]', { timeout: 5000 });
    await mobileTrigger360.click();
    await page360.waitForSelector('[role="dialog"][aria-label="Filter positions"]', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 500));
    await saveDual(page360, "mobile-filters-sheet-360.png");
    await page360.close();

    console.log("\n================================================================================");
    if (allPassed) {
      console.log("             ALL VISUAL CAPTURES & OVERFLOW AUDITS PASSED [PASS-LOCAL]          ");
    } else {
      console.error("             SOME CHECKS FAILED                                               ");
    }
    console.log("================================================================================");

  } catch (err) {
    console.error("Error during visual capture:", err);
    process.exit(1);
  } finally {
    await browser.close();
    server.close();
  }
}

run();
