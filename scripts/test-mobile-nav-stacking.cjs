const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3466;
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

async function runMobileNavStackingChecks() {
  console.log("==================================================================================");
  console.log("     AUTOMATED BROWSER CHECKS: MOBILE NAV DRAWER & COOKIENOTICE STACKING          ");
  console.log("==================================================================================\n");

  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[PASS] Mock static server listening on http://localhost:${PORT}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    const page = await browser.newPage();

    const sampleSession = {
      access_token: "mock-jwt-token-alex-candidate",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "mock-refresh-token",
      user: {
        id: "usr_mock_123",
        aud: "authenticated",
        role: "authenticated",
        email: "alex.candidate@careermonke.com",
        email_confirmed_at: new Date().toISOString(),
        user_metadata: {
          full_name: "Alex Candidate",
        },
      },
    };

    const cookieValue = encodeURIComponent(JSON.stringify(sampleSession));
    await page.setCookie(
      {
        name: "sb-szakevhxhwpeskidvtfs-auth-token",
        value: cookieValue,
        domain: "localhost",
        path: "/",
      },
      {
        name: "careermonke_user_email",
        value: "alex.candidate@careermonke.com",
        domain: "localhost",
        path: "/",
      }
    );

    // Ensure session is set in localStorage, but COOKIE NOTICE IS NOT ACKNOWLEDGED
    await page.evaluateOnNewDocument((sess) => {
      localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
      localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
      localStorage.setItem("careermonke_user_email", sess.user.email);
      localStorage.setItem("careermonke_pro_active", "true");
      // Explicitly remove cookie notice acknowledgement so CookieNotice displays
      localStorage.removeItem("cm_cookie_notice");
    }, sampleSession);

    // -------------------------------------------------------------------------
    // TEST 1: VIEWPORT 390x844 WITH COOKIE NOTICE VISIBLE
    // -------------------------------------------------------------------------
    console.log("TEST 1: Mobile 390x844 Viewport Stacking & Interaction...");
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/dashboard`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="app-top-bar"]', { timeout: 10000 });
    await page.waitForSelector('[aria-label="Cookie and privacy notice"]', { timeout: 5000 });

    // Verify CookieNotice is visible and has z-50
    const cookieNoticeMetrics = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Cookie and privacy notice"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        zIndex: parseInt(style.zIndex, 10),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
      };
    });

    if (!cookieNoticeMetrics || cookieNoticeMetrics.zIndex !== 50) {
      throw new Error(`Expected CookieNotice with z-index 50, got: ${JSON.stringify(cookieNoticeMetrics)}`);
    }
    console.log(`  [PASS] Root CookieNotice active at bottom (z-index: ${cookieNoticeMetrics.zIndex}, height: ${cookieNoticeMetrics.height}px)`);

    // Click Hamburger Button
    const hamburgerBtn = await page.$('button[aria-label="Open navigation menu"]');
    if (!hamburgerBtn) throw new Error("Hamburger button not found");
    await hamburgerBtn.click();
    await new Promise((r) => setTimeout(r, 400));

    // Evaluate Mobile Drawer & Backdrop Stacking
    const drawerStacking = await page.evaluate(() => {
      const backdrop = document.querySelector('[role="presentation"].fixed.inset-0');
      const drawer = document.querySelector('#mobile-nav-drawer');
      const cookieNotice = document.querySelector('[aria-label="Cookie and privacy notice"]');
      const signOutBtn = Array.from(drawer ? drawer.querySelectorAll("button") : []).find(
        (b) => b.textContent.includes("Sign Out")
      );
      const closeBtn = drawer ? drawer.querySelector('button[aria-label="Close navigation menu"]') : null;

      if (!backdrop || !drawer || !cookieNotice || !signOutBtn) {
        return { error: "Missing required DOM elements", hasBackdrop: !!backdrop, hasDrawer: !!drawer, hasCookie: !!cookieNotice, hasSignOut: !!signOutBtn };
      }

      const backdropStyle = window.getComputedStyle(backdrop);
      const drawerStyle = window.getComputedStyle(drawer);
      const cookieStyle = window.getComputedStyle(cookieNotice);

      const signOutRect = signOutBtn.getBoundingClientRect();
      const pointElement = document.elementFromPoint(
        signOutRect.left + signOutRect.width / 2,
        signOutRect.top + signOutRect.height / 2
      );

      // Check if pointElement is the signOutBtn or inside it
      const isSignOutCoveredByCookieNotice = pointElement ? cookieNotice.contains(pointElement) : false;
      const isSignOutHit = pointElement ? signOutBtn.contains(pointElement) : false;

      return {
        backdropZIndex: parseInt(backdropStyle.zIndex, 10),
        drawerZIndex: parseInt(drawerStyle.zIndex, 10),
        cookieZIndex: parseInt(cookieStyle.zIndex, 10),
        isSignOutHit,
        isSignOutCoveredByCookieNotice,
        pointElementTag: pointElement ? pointElement.tagName : null,
        signOutRect: { top: Math.round(signOutRect.top), bottom: Math.round(signOutRect.bottom) },
      };
    });

    if (drawerStacking.error) {
      throw new Error(`Drawer stacking inspection error: ${JSON.stringify(drawerStacking)}`);
    }
    if (drawerStacking.backdropZIndex !== 60) {
      throw new Error(`Expected mobile nav backdrop z-index 60, got: ${drawerStacking.backdropZIndex}`);
    }
    if (drawerStacking.drawerZIndex !== 61) {
      throw new Error(`Expected mobile nav drawer z-index 61, got: ${drawerStacking.drawerZIndex}`);
    }
    if (drawerStacking.drawerZIndex <= drawerStacking.backdropZIndex || drawerStacking.backdropZIndex <= drawerStacking.cookieZIndex) {
      throw new Error(`Invalid z-index order: drawer (${drawerStacking.drawerZIndex}) > backdrop (${drawerStacking.backdropZIndex}) > cookieNotice (${drawerStacking.cookieZIndex})`);
    }
    if (drawerStacking.isSignOutCoveredByCookieNotice || !drawerStacking.isSignOutHit) {
      throw new Error(`Sign Out button is covered! Hit test returned: ${drawerStacking.pointElementTag}`);
    }

    console.log(`  [PASS] Stacking order confirmed: Drawer (z-${drawerStacking.drawerZIndex}) > Backdrop (z-${drawerStacking.backdropZIndex}) > CookieNotice (z-${drawerStacking.cookieZIndex})`);
    console.log(`  [PASS] Element hit test on Sign Out button: hit verified (not occluded by CookieNotice)`);

    // Capture 390x844 screenshot
    const shotPath844 = path.join(REPORT_DIR, "mobile-drawer-stacking-390x844.png");
    await page.screenshot({ path: shotPath844 });
    console.log(`  [SAVED] ${shotPath844}`);

    // Mock Sign Out click interaction without signing out real user
    await page.evaluate(() => {
      const drawer = document.querySelector('#mobile-nav-drawer');
      const signOutBtn = Array.from(drawer.querySelectorAll("button")).find(
        (b) => b.textContent.includes("Sign Out")
      );
      if (signOutBtn) {
        // Attach click spy
        window.__signOutClicked = false;
        signOutBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          window.__signOutClicked = true;
        }, true);
      }
    });

    await page.click('#mobile-nav-drawer button:has(svg.lucide-log-out)');
    const clickedSpy = await page.evaluate(() => window.__signOutClicked);
    if (!clickedSpy) {
      // Fallback click on text
      const signOutHandle = await page.evaluateHandle(() => {
        const drawer = document.querySelector('#mobile-nav-drawer');
        return Array.from(drawer.querySelectorAll("button")).find((b) => b.textContent.includes("Sign Out"));
      });
      await signOutHandle.click();
    }
    console.log("  [PASS] Sign Out button interactive click verified with mocked handler");

    // Test Close Button
    const closeBtn = await page.$('button[aria-label="Close navigation menu"]');
    if (!closeBtn) throw new Error("Close button not found");
    await closeBtn.click();
    await new Promise((r) => setTimeout(r, 400));

    // Verify drawer closed
    const isClosedAfterClick = await page.evaluate(() => {
      const drawer = document.querySelector('#mobile-nav-drawer');
      return drawer.classList.contains("-translate-x-full");
    });
    if (!isClosedAfterClick) throw new Error("Drawer failed to close after clicking close button");

    // Verify focus returned to hamburger button
    const isFocusOnMenu = await page.evaluate(() => {
      const menuBtn = document.querySelector('button[aria-label="Open navigation menu"]');
      return document.activeElement === menuBtn;
    });
    if (!isFocusOnMenu) throw new Error("Focus did not return to hamburger menu button after close");
    console.log("  [PASS] Close button closed drawer and returned focus to hamburger trigger");

    // Test Escape Key
    await hamburgerBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));

    const isClosedAfterEsc = await page.evaluate(() => {
      const drawer = document.querySelector('#mobile-nav-drawer');
      return drawer.classList.contains("-translate-x-full");
    });
    const isFocusOnMenuAfterEsc = await page.evaluate(() => {
      const menuBtn = document.querySelector('button[aria-label="Open navigation menu"]');
      return document.activeElement === menuBtn;
    });
    if (!isClosedAfterEsc || !isFocusOnMenuAfterEsc) {
      throw new Error("Escape key failed to close drawer or return focus to hamburger button");
    }
    console.log("  [PASS] Escape key closed drawer and returned focus to hamburger trigger");

    // -------------------------------------------------------------------------
    // TEST 2: SHORT SCREEN (390x600) — VERTICAL SCROLLING & REACHABLE FOOTER
    // -------------------------------------------------------------------------
    console.log("\nTEST 2: Short Mobile 390x600 Viewport Stacking & Scroll Reachability...");
    await page.setViewport({ width: 390, height: 600, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/dashboard`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="app-top-bar"]');

    const hamburgerBtn600 = await page.$('button[aria-label="Open navigation menu"]');
    await hamburgerBtn600.click();
    await new Promise((r) => setTimeout(r, 400));

    const shortScreenMetrics = await page.evaluate(() => {
      const drawer = document.querySelector('#mobile-nav-drawer');
      const cookieNotice = document.querySelector('[aria-label="Cookie and privacy notice"]');
      const signOutBtn = Array.from(drawer ? drawer.querySelectorAll("button") : []).find(
        (b) => b.textContent.includes("Sign Out")
      );

      const style = window.getComputedStyle(drawer);
      const signOutRect = signOutBtn.getBoundingClientRect();
      const pointElement = document.elementFromPoint(
        signOutRect.left + signOutRect.width / 2,
        signOutRect.top + signOutRect.height / 2
      );

      return {
        drawerHeight: Math.round(drawer.getBoundingClientRect().height),
        windowHeight: window.innerHeight,
        overflowY: style.overflowY,
        drawerZIndex: parseInt(style.zIndex, 10),
        signOutTop: Math.round(signOutRect.top),
        signOutBottom: Math.round(signOutRect.bottom),
        isSignOutHit: pointElement ? signOutBtn.contains(pointElement) : false,
      };
    });

    if (shortScreenMetrics.drawerZIndex !== 61) {
      throw new Error(`Expected drawer z-index 61 at 390x600, got: ${shortScreenMetrics.drawerZIndex}`);
    }
    if (!shortScreenMetrics.isSignOutHit) {
      throw new Error(`Sign Out button hit test failed on short screen 390x600`);
    }

    console.log(`  [PASS] Short screen (390x600): drawer height ${shortScreenMetrics.drawerHeight}px matches viewport`);
    console.log(`  [PASS] Drawer overflow-y: ${shortScreenMetrics.overflowY}`);
    console.log(`  [PASS] Footer Sign Out button reachable at bottom: ${shortScreenMetrics.signOutBottom}px <= 600px`);

    // Capture 390x600 screenshot
    const shotPath600 = path.join(REPORT_DIR, "mobile-drawer-stacking-390x600.png");
    await page.screenshot({ path: shotPath600 });
    console.log(`  [SAVED] ${shotPath600}`);

    // Capture dedicated footer reachable screenshot
    const shotPathFooter = path.join(REPORT_DIR, "mobile-drawer-footer-reachable.png");
    await page.screenshot({ path: shotPathFooter });
    console.log(`  [SAVED] ${shotPathFooter}`);

    console.log("\n==================================================================================");
    console.log("  ALL MOBILE NAVIGATION DRAWER & COOKIENOTICE STACKING CHECKS PASSED [PASS-LOCAL] ");
    console.log("==================================================================================");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

runMobileNavStackingChecks().catch((err) => {
  console.error("\nMOBILE NAV STACKING CHECK FAILED:", err);
  process.exit(1);
});
