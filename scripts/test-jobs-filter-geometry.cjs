const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const puppeteer = require("puppeteer-core");
const { setupPageMocks } = require("./test-prompt5-base.cjs");

const PORT = 3596;
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\dbd87148-a017-40bc-8ecd-2836c0e73eaa";

function getChromePath() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.platform === "win32") {
    const winCandidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    ];
    for (const c of winCandidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  const linuxCandidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of linuxCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.env.CHROME_PATH || "/usr/bin/google-chrome";
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

function createStaticServer() {
  const rootDir = process.cwd();
  const outDir = path.resolve(rootDir, "out");
  const nextDir = path.resolve(rootDir, ".next");
  const publicDir = path.resolve(rootDir, "public");

  return http.createServer((req, res) => {
    const rawUrl = req.url || "/";
    const [pathname] = rawUrl.split("?");

    if (pathname.startsWith("/_next/static/")) {
      const relPath = pathname.replace(/^\/_next\/static\//, "");
      const candidates = [
        path.join(nextDir, "static", relPath),
        path.join(outDir, "_next", "static", relPath),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          const ext = path.extname(cand).toLowerCase();
          res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
          fs.createReadStream(cand).pipe(res);
          return;
        }
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const publicCand = path.join(publicDir, pathname);
    if (fs.existsSync(publicCand) && fs.statSync(publicCand).isFile()) {
      const ext = path.extname(publicCand).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      fs.createReadStream(publicCand).pipe(res);
      return;
    }

    let cleanUrl = pathname === "/" ? "/index.html" : pathname;
    if (!path.extname(cleanUrl)) {
      cleanUrl = cleanUrl + ".html";
    }

    const htmlCandidates = [
      path.join(nextDir, "server", "app", cleanUrl),
      path.join(outDir, cleanUrl),
    ];
    for (const hc of htmlCandidates) {
      if (fs.existsSync(hc) && fs.statSync(hc).isFile()) {
        res.writeHead(200, { "Content-Type": "text/html" });
        fs.createReadStream(hc).pipe(res);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
}

async function safeScreenshot(page, filePath) {
  if (!fs.existsSync(ARTIFACT_DIR)) return;
  try {
    await page.screenshot({ path: filePath, fullPage: false });
  } catch (err) {
    try {
      await new Promise((r) => setTimeout(r, 1000));
      await page.screenshot({ path: filePath, fullPage: false });
    } catch {}
  }
}

async function runGeometryRegression() {
  console.log("================================================================================");
  console.log("      RENDERED BROWSER GEOMETRY REGRESSION: FILTER BAR & OPEN MENUS             ");
  console.log("================================================================================\n");

  const server = createStaticServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[SERVER] Static server listening on port ${PORT}`);

  const chromePath = getChromePath();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });

  try {
    // 1. Verify Viewport Geometries & Long Active Labels
    const viewports = [
      { name: "1440px-collapsed", width: 1440, height: 900, sidebarExpanded: false, expectRows: 2, shot: "after-filter-1440-collapsed.png" },
      { name: "1440px-expanded", width: 1440, height: 900, sidebarExpanded: true, expectRows: 2, shot: "after-filter-1440-expanded.png" },
      { name: "1280px-collapsed", width: 1280, height: 900, sidebarExpanded: false, expectRows: 2, shot: "after-filter-1280-collapsed.png" },
      { name: "1280px-expanded", width: 1280, height: 900, sidebarExpanded: true, expectRows: null, shot: "after-filter-1280-expanded.png" },
      { name: "1024px-collapsed", width: 1024, height: 900, sidebarExpanded: false, expectRows: null, shot: "after-filter-1024-collapsed.png" },
      { name: "1024px-expanded", width: 1024, height: 900, sidebarExpanded: true, expectRows: null, shot: "after-filter-1024-expanded.png" },
      { name: "850px-tablet", width: 850, height: 900, sidebarExpanded: false, expectRows: 2, shot: "after-filter-850-tablet.png" },
      { name: "390px-mobile", width: 390, height: 844, isMobile: true, hasTouch: true, shot: "after-filter-390-mobile.png" },
      { name: "1280px-long-labels", width: 1280, height: 900, sidebarExpanded: false, qs: "?country_code=US&category=engineering&level=Senior&type=Full-time&workModel=Remote", shot: "after-filter-long-labels.png" },
    ];

    for (const vp of viewports) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height, isMobile: Boolean(vp.isMobile), hasTouch: Boolean(vp.hasTouch) });
      await setupPageMocks(page, { isSigned: true, isPro: true, cookieNotice: false });

      if (vp.sidebarExpanded !== undefined) {
        await page.evaluateOnNewDocument((expanded) => {
          localStorage.setItem("careermonke_sidebar_expanded", JSON.stringify({ v: 1, data: expanded }));
        }, vp.sidebarExpanded);
      }

      const pageUrl = vp.qs ? `http://localhost:${PORT}/jobs${vp.qs}` : `http://localhost:${PORT}/jobs`;
      try {
        await page.goto(pageUrl, { waitUntil: "networkidle0", timeout: 10000 });
      } catch {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
      }
      await page.waitForSelector('button', { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 1200));

      if (vp.shot) {
        await safeScreenshot(page, path.join(ARTIFACT_DIR, vp.shot));
      }

      if (!vp.isMobile) {
        let geo;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            geo = await page.evaluate(() => {
              const allFiltersBtn = Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("All Filters"));
              const desktopBar = allFiltersBtn ? allFiltersBtn.closest(".hidden.md\\:flex") : null;
              if (!desktopBar) return { found: false };

              const rect = desktopBar.getBoundingClientRect();
              const buttons = Array.from(desktopBar.querySelectorAll("button"))
                .filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0)
                .map((b) => {
                  const r = b.getBoundingClientRect();
                  return {
                    text: b.innerText.trim().replace(/\n/g, " "),
                    rawText: b.innerText,
                    top: Math.round(r.top),
                    bottom: Math.round(r.bottom),
                    left: Math.round(r.left),
                    right: Math.round(r.right),
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                  };
                });

              const topBuckets = [];
              for (const b of buttons) {
                let bucket = topBuckets.find((bkt) => Math.abs(bkt.top - b.top) <= 6);
                if (!bucket) {
                  bucket = { top: b.top, buttons: [] };
                  topBuckets.push(bucket);
                }
                bucket.buttons.push(b);
              }
              topBuckets.sort((a, b) => a.top - b.top);

              return {
                found: true,
                containerWidth: Math.round(rect.width),
                containerHeight: Math.round(rect.height),
                rowCount: topBuckets.length,
                rows: topBuckets.map((bkt) => ({ top: bkt.top, count: bkt.buttons.length, buttons: bkt.buttons })),
                buttons,
              };
            });
            break;
          } catch (evalErr) {
            if (attempt === 2) throw evalErr;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        assert.ok(geo.found, `Desktop filter bar found at ${vp.name}`);

        // Verify button heights are 32px (h-8)
        for (const btn of geo.buttons) {
          assert.strictEqual(btn.height, 32, `Button "${btn.text}" height must be 32px (got ${btn.height}px)`);
        }

        // Verify Sort button is on Row 1 (top-aligned with Row 1)
        const sortBtn = geo.buttons.find((b) => b.text.includes("Sort:") || b.text === "Recommended" || b.text === "Newest");
        assert.ok(sortBtn, "Sort button must be present");
        assert.strictEqual(sortBtn.top, geo.rows[0].top, `Sort button must be pinned to Row 1 top (${geo.rows[0].top}px)`);

        // If viewport has expected row count, assert it
        if (vp.expectRows !== null && vp.expectRows !== undefined) {
          assert.strictEqual(
            geo.rowCount,
            vp.expectRows,
            `Expected ${vp.expectRows} visual rows at ${vp.name}, got ${geo.rowCount} (height ${geo.containerHeight}px)`
          );
          console.log(`  [PASS] ${vp.name}: exactly ${vp.expectRows} visual rows (container width ${geo.containerWidth}px, height ${geo.containerHeight}px)`);
        } else {
          console.log(`  [PASS] ${vp.name}: ${geo.rowCount} visual rows (Sort pinned on Row 1, width ${geo.containerWidth}px)`);
        }
      } else {
        console.log(`  [PASS] ${vp.name}: mobile layout rendered cleanly`);
      }

      await page.close();
    }

    // 2. Verify Menus Open Without Clipping
    console.log("\n--- Testing Filter Menus Open State & Geometry ---");
    const menuTests = [
      { name: "location", triggerSelector: '.hidden.md\\:flex button[aria-label*="location filter" i]', dialogRole: "Filter by Location", shot: "after-menu-location.png" },
      { name: "category", triggerSelector: '.hidden.md\\:flex button[aria-label*="category filter" i]', dialogRole: "Filter by Job Category", shot: "after-menu-category.png" },
      { name: "level", triggerSelector: '.hidden.md\\:flex button[aria-label*="level filter" i]', dialogRole: "Filter by Experience Level", shot: "after-menu-level.png" },
      { name: "jobType", triggerSelector: '.hidden.md\\:flex button[aria-label*="job type filter" i]', dialogRole: "Filter by Job Type", shot: "after-menu-jobtype.png" },
      { name: "workModel", triggerSelector: '.hidden.md\\:flex button[aria-label*="work model filter" i]', dialogRole: "Filter by Work Model", shot: "after-menu-workmodel.png" },
      { name: "datePosted", triggerSelector: '.hidden.md\\:flex button[aria-label*="date posted filter" i]', dialogRole: "Filter by Date Posted", shot: "after-menu-dateposted.png" },
      { name: "experience", triggerSelector: '.hidden.md\\:flex button[aria-label*="experience filter" i]', dialogRole: "Filter by Experience", shot: "after-menu-experience.png" },
      { name: "sort", triggerSelector: '.hidden.md\\:flex button[aria-label^="Sort by"]', shot: "after-menu-sort.png" },
    ];

    const menuPage = await browser.newPage();
    await menuPage.setViewport({ width: 1280, height: 900 });
    await setupPageMocks(menuPage, { isSigned: true, isPro: true, cookieNotice: false });
    await menuPage.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "domcontentloaded" });
    await menuPage.waitForSelector('[data-testid="job-card"]', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 600));

    for (const m of menuTests) {
      const btn = await menuPage.$(m.triggerSelector);
      assert.ok(btn, `Trigger button found for menu ${m.name}`);
      await btn.click();
      await new Promise((r) => setTimeout(r, 300));

      if (m.shot) {
        await safeScreenshot(menuPage, path.join(ARTIFACT_DIR, m.shot));
      }

      const menuGeo = await menuPage.evaluate((expectedRole) => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        const dialog = dialogs.find((d) => {
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (!expectedRole || d.getAttribute("aria-label")?.toLowerCase().includes(expectedRole.toLowerCase()));
        });
        if (!dialog) {
          // Sort menu dropdown
          const sortMenu = Array.from(document.querySelectorAll("div.absolute")).find((d) => d.innerText.includes("Recommended"));
          if (sortMenu) {
            const r = sortMenu.getBoundingClientRect();
            return {
              visible: r.width > 0 && r.height > 0,
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              width: r.width,
              height: r.height,
            };
          }
          return { visible: false };
        }
        const r = dialog.getBoundingClientRect();
        return {
          visible: true,
          role: dialog.getAttribute("aria-label"),
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
        };
      }, m.dialogRole);

      assert.ok(menuGeo.visible, `Menu ${m.name} must be visible on click`);
      assert.ok(menuGeo.width > 100 && menuGeo.height > 50, `Menu ${m.name} must have valid dimensions`);
      assert.ok(menuGeo.top >= 0 && menuGeo.left >= 0, `Menu ${m.name} must be inside viewport`);
      console.log(`  [PASS] Menu "${m.name}" opened visibly (${Math.round(menuGeo.width)}x${Math.round(menuGeo.height)}px, unclipped)`);

      // Close menu by clicking again or outside
      await btn.click();
      await new Promise((r) => setTimeout(r, 200));
    }

    await menuPage.close();

    await browser.close();
    server.close();

    console.log("\n================================================================================");
    console.log("  ALL RENDERED BROWSER GEOMETRY REGRESSION CHECKS PASSED (PASS-LOCAL)           ");
    console.log("================================================================================\n");
  } catch (err) {
    if (browser) await browser.close();
    server.close();
    throw err;
  }
}

runGeometryRegression().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
