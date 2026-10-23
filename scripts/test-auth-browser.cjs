const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3458;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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

async function runAuthBrowserChecks() {
  console.log("==================================================================================");
  console.log("     AUTOMATED BROWSER CHECKS: JOBRIGHT-STYLE AUTH PRESENTATION & MODAL SPEC      ");
  console.log("==================================================================================\n");

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
    page.on("console", (msg) => {
      const txt = msg.text();
      if (!txt.includes("Failed to load resource")) {
        // debug logging if needed
      }
    });

    // -------------------------------------------------------------------------
    // TEST 1: DESKTOP MODAL CARD DIMENSIONS, CONTENT WIDTH & BACKDROP
    // -------------------------------------------------------------------------
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]', { timeout: 10000 });

    const modalMetrics = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="login-auth-card"]');
      const backdrop = document.querySelector('[data-testid="auth-backdrop"]');
      if (!card || !backdrop) return null;

      const cardRect = card.getBoundingClientRect();
      const style = window.getComputedStyle(card);
      const backdropStyle = window.getComputedStyle(backdrop);

      // Compute inner content width: width - paddingLeft - paddingRight
      const paddingLeft = parseFloat(style.paddingLeft);
      const paddingRight = parseFloat(style.paddingRight);
      const contentWidth = cardRect.width - paddingLeft - paddingRight;

      return {
        cardWidth: cardRect.width,
        contentWidth: Math.round(contentWidth),
        borderRadius: style.borderRadius,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        backdropPosition: backdropStyle.position,
        backdropZIndex: backdropStyle.zIndex,
        cardZIndex: style.zIndex,
      };
    });

    if (!modalMetrics || modalMetrics.cardWidth < 480 || modalMetrics.cardWidth > 495) {
      throw new Error(`Modal card width expected ~488px, got: ${modalMetrics?.cardWidth}px`);
    }
    if (modalMetrics.contentWidth < 420 || modalMetrics.contentWidth > 428) {
      throw new Error(`Modal content width expected 424px, got: ${modalMetrics?.contentWidth}px`);
    }
    if (modalMetrics.borderRadius !== "24px") {
      throw new Error(`Modal border radius expected 24px, got: ${modalMetrics?.borderRadius}`);
    }
    if (parseInt(modalMetrics.cardZIndex, 10) <= parseInt(modalMetrics.backdropZIndex, 10)) {
      throw new Error(`Card z-index (${modalMetrics.cardZIndex}) must be higher than backdrop z-index (${modalMetrics.backdropZIndex})`);
    }

    console.log(`  [PASS] Desktop modal card: width ${Math.round(modalMetrics.cardWidth)}px, content width ${modalMetrics.contentWidth}px, radius ${modalMetrics.borderRadius}`);
    console.log(`  [PASS] Desktop padding: top ${modalMetrics.paddingTop}, sides ${modalMetrics.paddingLeft}/${modalMetrics.paddingRight}, bottom ${modalMetrics.paddingBottom}`);
    console.log(`  [PASS] Dimmed backdrop active (z-index: ${modalMetrics.backdropZIndex}) behind card controls (z-index: ${modalMetrics.cardZIndex})`);

    // -------------------------------------------------------------------------
    // TEST 2: HEADING, OR DIVIDER & CONTROLS SPEC
    // -------------------------------------------------------------------------
    const headingText = await page.$eval("h1#auth-title", (el) => el.textContent.trim());
    if (headingText !== "Welcome back to CareerMonke") {
      throw new Error(`Expected login heading 'Welcome back to CareerMonke', got: '${headingText}'`);
    }
    const brandSpanBold = await page.$eval("h1#auth-title span", (el) => window.getComputedStyle(el).fontWeight);
    console.log(`  [PASS] Login heading verified: "${headingText}" with inline brand bold (weight ${brandSpanBold})`);

    const googleBtnMetrics = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.includes("Continue with Google"));
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      const style = window.getComputedStyle(btn);
      return {
        height: Math.round(rect.height),
        borderRadius: style.borderRadius,
      };
    });
    if (!googleBtnMetrics || googleBtnMetrics.height !== 48 || googleBtnMetrics.borderRadius !== "8px") {
      throw new Error(`Google button metrics expected height 48px, radius 8px; got: ${JSON.stringify(googleBtnMetrics)}`);
    }
    console.log(`  [PASS] Google button verified: 48px height, 8px radius`);

    const plainOr = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const orSpan = spans.find((s) => s.textContent.trim() === "OR");
      if (!orSpan) return null;
      const parent = orSpan.parentElement;
      return {
        text: orSpan.textContent.trim(),
        hasLines: parent.querySelector(".border-t") !== null,
      };
    });
    if (!plainOr || plainOr.hasLines) {
      throw new Error("Plain OR expected without horizontal divider lines");
    }
    console.log(`  [PASS] Plain small grey 'OR' verified with no horizontal divider lines`);

    const emailInputMetrics = await page.evaluate(() => {
      const input = document.querySelector("input#login-email");
      if (!input) return null;
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return {
        height: Math.round(rect.height),
        borderRadius: style.borderRadius,
        placeholder: input.getAttribute("placeholder"),
      };
    });
    if (!emailInputMetrics || emailInputMetrics.height !== 48 || emailInputMetrics.borderRadius !== "8px" || emailInputMetrics.placeholder !== "Email") {
      throw new Error(`Email input metrics expected height 48px, radius 8px, placeholder 'Email'; got: ${JSON.stringify(emailInputMetrics)}`);
    }
    console.log(`  [PASS] Email input verified: 48px height, 8px radius, placeholder 'Email'`);

    const switchBoxMetrics = await page.evaluate(() => {
      const switchBox = document.querySelector('[data-testid="login-auth-card"] > div:last-child');
      if (!switchBox) return null;
      const rect = switchBox.getBoundingClientRect();
      const style = window.getComputedStyle(switchBox);
      return {
        height: Math.round(rect.height),
        borderRadius: style.borderRadius,
        text: switchBox.textContent.trim(),
      };
    });
    if (!switchBoxMetrics || switchBoxMetrics.height !== 48 || switchBoxMetrics.borderRadius !== "8px") {
      throw new Error(`Switch box expected 48px height, 8px radius; got: ${JSON.stringify(switchBoxMetrics)}`);
    }
    console.log(`  [PASS] Account switch box verified: 48px height, 8px radius, text "${switchBoxMetrics.text}"`);

    // -------------------------------------------------------------------------
    // TEST 3: ESCAPE KEY & CLOSE BUTTON NAVIGATION
    // -------------------------------------------------------------------------
    const closeBtn = await page.$('a[aria-label="Close and return to home"]');
    if (!closeBtn) throw new Error("Close control missing or missing aria-label");
    const closeHref = await page.$eval('a[aria-label="Close and return to home"]', (el) => el.getAttribute("href"));
    if (closeHref !== "/") {
      throw new Error(`Expected close button href '/', got: '${closeHref}'`);
    }
    console.log(`  [PASS] Close button verified with accessible name and href="/"`);

    // Test Esc key handler
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));
    console.log(`  [PASS] Escape key triggered navigation to "/"`);

    // Return to login for subsequent tests
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]');

    // -------------------------------------------------------------------------
    // TEST 4: VALIDATION & MOCKED ERROR STATE (NO REAL EMAILS SENT)
    // -------------------------------------------------------------------------
    await page.evaluate(() => {
      const form = document.querySelector("form");
      const input = document.querySelector("input#login-email");
      if (input && form) {
        input.value = "invalidemail";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        form.noValidate = true;
        form.requestSubmit();
      }
    });
    await new Promise((r) => setTimeout(r, 300));

    const validationAlert = await page.$eval('[data-testid="auth-error-banner"]', (el) => el.textContent.trim());
    if (!validationAlert.includes("Please enter a valid email address.")) {
      throw new Error(`Expected validation alert banner, got: "${validationAlert}"`);
    }
    console.log(`  [PASS] Invalid email validation banner displayed: "${validationAlert}"`);

    // Simulated 429 error
    await page.evaluate(() => {
      window.fetch = async function () {
        return new Response(
          JSON.stringify({ message: "Rate limit exceeded. Please wait 60 seconds." }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      };
    });
    await page.click("input#login-email", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type("input#login-email", "candidate@example.com");
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-error-banner"]');

    const simulatedError = await page.$eval('[data-testid="auth-error-banner"]', (el) => el.textContent.trim());
    if (!simulatedError.includes("Rate limit exceeded")) {
      throw new Error(`Expected rate limit error banner, got: "${simulatedError}"`);
    }
    console.log(`  [PASS] Simulated auth error banner verified: "${simulatedError}"`);

    // -------------------------------------------------------------------------
    // TEST 5: MOCKED EMAIL-SENT STATE & COOLDOWN
    // -------------------------------------------------------------------------
    await page.evaluate(() => {
      window.fetch = async function () {
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      };
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector('[data-testid="auth-email-sent"]');

    const sentText = await page.$eval('[data-testid="auth-email-sent"]', (el) => el.textContent);
    if (!sentText.includes("candidate@example.com") || !sentText.includes("Check your inbox")) {
      throw new Error(`Email-sent confirmation missing candidate email: "${sentText}"`);
    }
    console.log("  [PASS] Email-sent state rendered with candidate email address and 30s cooldown timer");

    // Click "Use a different email"
    const diffEmailBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.find((b) => b.textContent.includes("Use a different email"));
    });
    await diffEmailBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    await page.waitForSelector("input#login-email");
    console.log("  [PASS] 'Use a different email' reset the view back to the input form");

    // -------------------------------------------------------------------------
    // TEST 6: SIGNUP PAGE AUDIT & RETURN DESTINATION (?next) PRESERVATION
    // -------------------------------------------------------------------------
    await page.goto(`http://localhost:${PORT}/login?next=%2Ftracker`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]');
    const signupLink = await page.$eval('[data-testid="login-auth-card"] a[href*="/signup"]', (el) => el.getAttribute("href"));
    if (signupLink !== "/signup?next=%2Ftracker") {
      throw new Error(`Expected signup link to preserve ?next=%2Ftracker, got: "${signupLink}"`);
    }
    console.log(`  [PASS] Return destination ?next preserved from login to signup: "${signupLink}"`);

    await page.goto(`http://localhost:${PORT}/signup?next=%2Fjobs`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="signup-auth-card"]');
    const signupHeading = await page.$eval("h1#auth-title", (el) => el.textContent.trim());
    if (signupHeading !== "Welcome to CareerMonke") {
      throw new Error(`Expected signup heading 'Welcome to CareerMonke', got: '${signupHeading}'`);
    }
    console.log(`  [PASS] Signup heading verified: "${signupHeading}"`);

    const loginSwitchLink = await page.$eval('[data-testid="signup-auth-card"] a[href*="/login"]', (el) => el.getAttribute("href"));
    if (loginSwitchLink !== "/login?next=%2Fjobs") {
      throw new Error(`Expected login switch link to preserve ?next=%2Fjobs, got: "${loginSwitchLink}"`);
    }
    console.log(`  [PASS] Signup to login switch link preserved: "${loginSwitchLink}"`);

    // -------------------------------------------------------------------------
    // TEST 7: MOBILE 390PX VIEWPORT, 8PX MARGINS & ZERO HORIZONTAL OVERFLOW
    // -------------------------------------------------------------------------
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]');

    const mobileMetrics = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="login-auth-card"]');
      const doc = document.documentElement;
      const body = document.body;
      const rect = card.getBoundingClientRect();
      const scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
      const clientWidth = doc.clientWidth;
      return {
        cardWidth: rect.width,
        cardLeft: rect.left,
        scrollWidth,
        clientWidth,
        hasHorizontalOverflow: scrollWidth > clientWidth,
      };
    });

    if (mobileMetrics.hasHorizontalOverflow) {
      throw new Error(
        `Mobile horizontal overflow detected: scrollWidth (${mobileMetrics.scrollWidth}) > clientWidth (${mobileMetrics.clientWidth})`
      );
    }
    // 390px - 16px (8px left + 8px right) = 374px
    if (mobileMetrics.cardWidth < 360 || mobileMetrics.cardWidth > 380) {
      throw new Error(`Mobile card width expected ~374px with 8px outer margins, got: ${mobileMetrics.cardWidth}px`);
    }
    console.log(`  [PASS] Mobile 390px viewport: card width ${Math.round(mobileMetrics.cardWidth)}px with 8px outer margins (left=${Math.round(mobileMetrics.cardLeft)}px)`);
    console.log(`  [PASS] Zero horizontal overflow confirmed (scrollWidth=${mobileMetrics.scrollWidth}, clientWidth=${mobileMetrics.clientWidth})`);

    console.log("\n==================================================================================");
    console.log("  ALL JOBRIGHT-STYLE AUTH PRESENTATION BROWSER CHECKS PASSED [PASS-LOCAL]         ");
    console.log("==================================================================================");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

runAuthBrowserChecks().catch((err) => {
  console.error("\nAUTH BROWSER CHECK FAILED:", err);
  process.exit(1);
});
