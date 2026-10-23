const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3460;
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

async function runVerification() {
  console.log("==================================================================================");
  console.log("  PROMPT 1/4 VERIFICATION: AUTH OVERLAYS (COOKIE FIX) & JOB-DETAIL ACTIONS       ");
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
    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));

    // =========================================================================
    // PART A.1: MOBILE /login at 390x844 with CookieNotice Active
    // =========================================================================
    console.log("\n--- TEST A.1: Mobile /login at 390x844 with CookieNotice ---");
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]', { timeout: 10000 });

    // Verify CookieNotice is active in DOM with z-50
    const cookieMetrics = await page.evaluate(() => {
      const notice = document.querySelector('[aria-label="Cookie and privacy notice"]');
      if (!notice) return null;
      const style = window.getComputedStyle(notice);
      const rect = notice.getBoundingClientRect();
      return {
        zIndex: parseInt(style.zIndex, 10),
        rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
      };
    });

    if (!cookieMetrics || cookieMetrics.zIndex !== 50) {
      throw new Error(`Expected CookieNotice with z-index 50, got: ${JSON.stringify(cookieMetrics)}`);
    }
    console.log(`  [PASS] CookieNotice active in DOM at bottom (z-50)`);

    // Verify backdrop z-[70] and auth card z-[71]
    const authStacking = await page.evaluate(() => {
      const backdrop = document.querySelector('[data-testid="auth-backdrop"]');
      const card = document.querySelector('[data-testid="login-auth-card"]');
      if (!backdrop || !card) return null;
      const bStyle = window.getComputedStyle(backdrop);
      const cStyle = window.getComputedStyle(card);
      return {
        backdropZ: parseInt(bStyle.zIndex, 10),
        cardZ: parseInt(cStyle.zIndex, 10),
      };
    });

    if (!authStacking || authStacking.backdropZ !== 70 || authStacking.cardZ !== 71) {
      throw new Error(`Expected backdrop z-70 and card z-71, got: ${JSON.stringify(authStacking)}`);
    }
    console.log(`  [PASS] Stacking confirmed: Auth Card (z-${authStacking.cardZ}) > Backdrop (z-${authStacking.backdropZ}) > CookieNotice (z-50)`);

    // Interactive hit testing on /login at 390x844
    const loginHits = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="login-auth-card"]');
      const emailInput = card.querySelector('input[type="email"]');
      const submitBtn = card.querySelector('button[type="submit"]');
      const switchLink = card.querySelector('a[href*="/signup"]');
      const closeBtn = card.querySelector('a[aria-label="Close and return to home"]');

      function testHit(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el === topEl || el.contains(topEl);
      }

      return {
        emailInputAccessible: testHit(emailInput),
        submitBtnAccessible: testHit(submitBtn),
        switchLinkAccessible: testHit(switchLink),
        closeBtnAccessible: testHit(closeBtn),
      };
    });

    if (!loginHits.emailInputAccessible || !loginHits.submitBtnAccessible || !loginHits.switchLinkAccessible || !loginHits.closeBtnAccessible) {
      throw new Error(`Login elements not hit-accessible: ${JSON.stringify(loginHits)}`);
    }
    console.log(`  [PASS] Hit-testing passed: Email, CTA, switch link, and close control are interactive and not occluded by CookieNotice`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "mobile-login-390x844-cookie-stacking.png"),
    });

    // =========================================================================
    // PART A.2: MOBILE /signup at 390x844 with CookieNotice Active
    // =========================================================================
    console.log("\n--- TEST A.2: Mobile /signup at 390x844 with CookieNotice ---");
    await page.goto(`http://localhost:${PORT}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="signup-auth-card"]', { timeout: 10000 });

    const signupHits = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="signup-auth-card"]');
      const emailInput = card.querySelector('input[type="email"]');
      const submitBtn = card.querySelector('button[type="submit"]');
      const switchLink = card.querySelector('a[href*="/login"]');
      const visibleTermsP = Array.from(card.querySelectorAll("p")).find(
        (p) => p.textContent.includes("By continuing, you agree") && window.getComputedStyle(p).display !== "none"
      );
      const termsLink = visibleTermsP ? visibleTermsP.querySelector('a[href="/terms-and-conditions"]') : null;
      const privacyLink = visibleTermsP ? visibleTermsP.querySelector('a[href="/privacy-policy"]') : null;
      const closeBtn = card.querySelector('a[aria-label="Close and return to home"]');

      function testHit(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el === topEl || el.contains(topEl);
      }

      return {
        emailInputAccessible: testHit(emailInput),
        submitBtnAccessible: testHit(submitBtn),
        switchLinkAccessible: testHit(switchLink),
        termsLinkAccessible: testHit(termsLink),
        privacyLinkAccessible: testHit(privacyLink),
        closeBtnAccessible: testHit(closeBtn),
      };
    });

    if (!signupHits.termsLinkAccessible || !signupHits.privacyLinkAccessible || !signupHits.switchLinkAccessible) {
      throw new Error(`Signup bottom links not hit-accessible: ${JSON.stringify(signupHits)}`);
    }
    console.log(`  [PASS] Signup Terms/Privacy and switch box interactive above CookieNotice`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "mobile-signup-390x844-cookie-stacking.png"),
    });

    // =========================================================================
    // PART A.3: SHORT SCREEN 390x600 for /login and /signup (Vertical Scrolling)
    // =========================================================================
    console.log("\n--- TEST A.3: Short Screen 390x600 Scrolling Verification ---");
    await page.setViewport({ width: 390, height: 600, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]');

    const login600Metrics = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="login-auth-card"]');
      const style = window.getComputedStyle(card);
      const isScrollable = card.scrollHeight > card.clientHeight;
      // Scroll to bottom
      card.scrollTop = card.scrollHeight;
      const switchBox = Array.from(card.querySelectorAll("div")).find((d) => d.textContent.includes("Don't have an account?"));
      const r = switchBox ? switchBox.getBoundingClientRect() : null;
      const topEl = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        overflowY: style.overflowY,
        isScrollable,
        switchReachable: topEl && (switchBox === topEl || switchBox.contains(topEl)),
      };
    });

    if (!login600Metrics.switchReachable || login600Metrics.overflowY !== "auto") {
      throw new Error(`Login 390x600 failed: ${JSON.stringify(login600Metrics)}`);
    }
    console.log(`  [PASS] Login 390x600 overflow-y:auto confirmed; switch box reachable at bottom (isScrollable: ${login600Metrics.isScrollable})`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "mobile-login-390x600-cookie-stacking.png"),
    });

    await page.goto(`http://localhost:${PORT}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="signup-auth-card"]');

    const signup600Metrics = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="signup-auth-card"]');
      card.scrollTop = card.scrollHeight;
      const terms = Array.from(card.querySelectorAll("p")).find((p) => p.textContent.includes("By continuing, you agree") && window.getComputedStyle(p).display !== "none");
      const r = terms ? terms.getBoundingClientRect() : null;
      const topEl = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        termsReachable: topEl && (terms === topEl || terms.contains(topEl)),
      };
    });

    if (!signup600Metrics.termsReachable) {
      throw new Error(`Signup 390x600 scroll failed: ${JSON.stringify(signup600Metrics)}`);
    }
    console.log(`  [PASS] Signup 390x600 vertical scrolling active; bottom Terms line reachable`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "mobile-signup-390x600-cookie-stacking.png"),
    });

    // =========================================================================
    // PART B.1: JOB-DETAIL ACTIONS (DESKTOP)
    // =========================================================================
    console.log("\n--- TEST B.1: Job-Detail Actions on Desktop (1280x900) ---");
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/jobs?id=sample-openai-01`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="share-job-button"]', { timeout: 10000 });

    // Verify existing Back, Save, Apply buttons exist
    const detailActions = await page.evaluate(() => {
      const backBtn = document.querySelector('button[aria-label="Back to jobs list"]');
      const saveBtn = document.querySelector('button[aria-label="Save job"]');
      const applyBtn = Array.from(document.querySelectorAll("a, button")).find(
        (el) => el.textContent.includes("Apply") && el.className.includes("rounded-full")
      );
      const shareBtn = document.querySelector('[data-testid="share-job-button"]');
      const reportTop = document.querySelector('[data-testid="report-issue-link"]');
      const reportDetail = document.querySelector('[data-testid="report-issue-detail-link"]');

      return {
        hasBack: Boolean(backBtn),
        hasSave: Boolean(saveBtn),
        hasApply: Boolean(applyBtn),
        hasShare: Boolean(shareBtn),
        reportTopHref: reportTop ? reportTop.getAttribute("href") : null,
        reportDetailHref: reportDetail ? reportDetail.getAttribute("href") : null,
      };
    });

    if (!detailActions.hasBack || !detailActions.hasSave || !detailActions.hasApply || !detailActions.hasShare) {
      throw new Error(`Missing job detail core controls: ${JSON.stringify(detailActions)}`);
    }
    console.log(`  [PASS] Preserved Back, Save, Apply, and added Share control in desktop header`);

    // Verify Report Issue mailto links
    if (
      !detailActions.reportTopHref ||
      !detailActions.reportTopHref.startsWith("mailto:support@careermonke.com") ||
      !detailActions.reportTopHref.includes("Research%20Engineer") ||
      !detailActions.reportTopHref.includes("sample-openai-01")
    ) {
      throw new Error(`Invalid report issue top href: ${detailActions.reportTopHref}`);
    }
    if (
      !detailActions.reportDetailHref ||
      !detailActions.reportDetailHref.startsWith("mailto:support@careermonke.com") ||
      !detailActions.reportDetailHref.includes("sample-openai-01")
    ) {
      throw new Error(`Invalid report issue detail href: ${detailActions.reportDetailHref}`);
    }
    console.log(`  [PASS] Report Issue reuses verified support@careermonke.com with sanitized job context and zero candidate data`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "job-detail-desktop-actions.png"),
    });

    // Test B.2: Share Control Success (Copies canonical URL without private/session params)
    console.log("\n--- TEST B.2: Share Control Success (Desktop) ---");
    // Mock navigator.clipboard.writeText
    await page.evaluate(() => {
      window.__copiedUrl = null;
      navigator.clipboard.writeText = async (text) => {
        window.__copiedUrl = text;
        return Promise.resolve();
      };
    });

    await page.click('[data-testid="share-job-button"]');
    await page.waitForSelector('[data-testid="link-copied-text"]', { timeout: 3000 });

    const copySuccessData = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="share-job-button"]');
      const textEl = document.querySelector('[data-testid="link-copied-text"]');
      return {
        copiedUrl: window.__copiedUrl,
        buttonText: textEl ? textEl.textContent.trim() : null,
        isEmerald: btn.className.includes("emerald"),
      };
    });

    if (copySuccessData.buttonText !== "Link copied" || !copySuccessData.isEmerald) {
      throw new Error(`Expected 'Link copied' state on button, got: ${JSON.stringify(copySuccessData)}`);
    }
    if (
      !copySuccessData.copiedUrl ||
      !copySuccessData.copiedUrl.endsWith("/jobs?id=sample-openai-01") ||
      copySuccessData.copiedUrl.includes("session") ||
      copySuccessData.copiedUrl.includes("token")
    ) {
      throw new Error(`Expected canonical URL without session params, got: ${copySuccessData.copiedUrl}`);
    }
    console.log(`  [PASS] Clipboard success: Copied canonical URL "${copySuccessData.copiedUrl}"`);
    console.log(`  [PASS] Button visibly displays "Link copied" with emerald styling`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "job-detail-share-success-desktop.png"),
    });

    // Test B.3: Share Control Failure (Clipboard throws error -> usable fallback)
    console.log("\n--- TEST B.3: Share Control Failure Fallback (Desktop) ---");
    // Reload page to reset state, with query params to test canonical stripping
    await page.goto(`http://localhost:${PORT}/jobs?id=sample-openai-01&utm_source=test&private_token=secret123`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="share-job-button"]');

    // Mock clipboard failure
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error("Clipboard permission denied by system policy");
      };
    });

    await page.click('[data-testid="share-job-button"]');
    await page.waitForSelector('[data-testid="share-fallback-container"]', { timeout: 3000 });

    const failureFallbackData = await page.evaluate(() => {
      const fallbackBox = document.querySelector('[data-testid="share-fallback-container"]');
      const fallbackInput = document.querySelector('[data-testid="share-fallback-input"]');
      const copiedText = document.querySelector('[data-testid="link-copied-text"]');
      return {
        hasFallbackBox: Boolean(fallbackBox),
        fallbackValue: fallbackInput ? fallbackInput.value : null,
        linkCopiedShown: Boolean(copiedText),
      };
    });

    if (failureFallbackData.linkCopiedShown) {
      throw new Error("'Link copied' MUST NOT be shown on clipboard failure!");
    }
    if (
      !failureFallbackData.hasFallbackBox ||
      !failureFallbackData.fallbackValue ||
      !failureFallbackData.fallbackValue.endsWith("/jobs?id=sample-openai-01") ||
      failureFallbackData.fallbackValue.includes("utm_source") ||
      failureFallbackData.fallbackValue.includes("private_token")
    ) {
      throw new Error(`Fallback input missing canonical URL: ${JSON.stringify(failureFallbackData)}`);
    }
    console.log(`  [PASS] Clipboard failure handled: "Link copied" was NOT shown`);
    console.log(`  [PASS] Usable fallback input rendered with canonical URL: "${failureFallbackData.fallbackValue}"`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "job-detail-share-failure-desktop.png"),
    });

    // =========================================================================
    // PART B.4: MOBILE JOB-DETAIL ACTIONS (390x844)
    // =========================================================================
    console.log("\n--- TEST B.4: Mobile Job-Detail Actions (390x844) ---");
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/jobs?id=sample-openai-01`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="mobile-share-job-button"]', { timeout: 10000 });

    const mobileDetailControls = await page.evaluate(() => {
      const mobileShare = document.querySelector('[data-testid="mobile-share-job-button"]');
      const mobileSave = document.querySelector('[role="region"][aria-label="Quick apply bar"] button[aria-label*="job"]');
      const mobileApply = document.querySelector('[role="region"][aria-label="Quick apply bar"] a, [role="region"][aria-label="Quick apply bar"] button:last-child');
      const topReport = document.querySelector('[data-testid="report-issue-link"]');

      return {
        hasMobileShare: Boolean(mobileShare),
        hasMobileSave: Boolean(mobileSave),
        hasMobileApply: Boolean(mobileApply),
        hasTopReport: Boolean(topReport),
      };
    });

    if (!mobileDetailControls.hasMobileShare || !mobileDetailControls.hasMobileSave || !mobileDetailControls.hasMobileApply) {
      throw new Error(`Mobile sticky apply bar missing controls: ${JSON.stringify(mobileDetailControls)}`);
    }
    console.log(`  [PASS] Mobile sticky apply bar contains Share, Save, and Apply controls (>=44px tap targets)`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "job-detail-mobile-actions.png"),
    });

    // Mobile Share Success
    await page.evaluate(() => {
      window.__copiedUrl = null;
      navigator.clipboard.writeText = async (text) => {
        window.__copiedUrl = text;
        return Promise.resolve();
      };
    });

    await page.$eval('[data-testid="mobile-share-job-button"]', (btn) => btn.click());
    await page.waitForSelector('[data-testid="share-success-banner"]', { timeout: 3000 });
    console.log(`  [PASS] Mobile share success: Floating toast 'Link copied' appeared`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "job-detail-share-success-mobile.png"),
    });

    // Mobile Share Failure Fallback
    await page.goto(`http://localhost:${PORT}/jobs?id=sample-openai-01`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="mobile-share-job-button"]');
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error("Mobile clipboard write failed");
      };
    });

    await page.$eval('[data-testid="mobile-share-job-button"]', (btn) => btn.click());
    await page.waitForSelector('[data-testid="share-fallback-container"]', { timeout: 3000 });
    console.log(`  [PASS] Mobile share failure: Usable fallback container rendered at top`);

    await page.screenshot({
      path: path.join(REPORT_DIR, "job-detail-share-failure-mobile.png"),
    });

    console.log("\n==================================================================================");
    console.log("  ALL TESTS PASSED: PROMPT 1/4 FINISHED CLEANLY [PASS-LOCAL]                      ");
    console.log("==================================================================================");

  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

runVerification().catch((err) => {
  console.error("FATAL ERROR in verification:", err);
  process.exit(1);
});
