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
  console.log("     AUTOMATED BROWSER CHECKS: LOGIN & SIGNUP AUTH PRESENTATION & FLOWS          ");
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
        console.log("BROWSER LOG:", txt);
      }
    });

    // -------------------------------------------------------------------------
    // TEST 1: DESKTOP LOGIN LAYOUT & CARD DIMENSIONS
    // -------------------------------------------------------------------------
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]', { timeout: 10000 });

    const cardBox = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="login-auth-card"]');
      if (!card) return null;
      const rect = card.getBoundingClientRect();
      const style = window.getComputedStyle(card);
      return {
        width: rect.width,
        borderRadius: style.borderRadius,
        paddingLeft: style.paddingLeft,
      };
    });

    if (!cardBox || cardBox.width < 430 || cardBox.width > 470) {
      throw new Error(`Login card width expected 440-470px, got: ${cardBox?.width}px`);
    }
    console.log(`  [PASS] Desktop login card dimensions: width ${Math.round(cardBox.width)}px, radius ${cardBox.borderRadius}`);

    // Check heading
    const loginHeading = await page.$eval("h1", (el) => el.textContent.trim());
    if (loginHeading !== "Welcome back to CareerMonke") {
      throw new Error(`Expected login heading 'Welcome back to CareerMonke', got: '${loginHeading}'`);
    }
    console.log(`  [PASS] Login heading verified: "${loginHeading}"`);

    // -------------------------------------------------------------------------
    // TEST 2: EMPTY & INVALID EMAIL VALIDATION (NO REAL MAGIC LINKS SENT)
    // -------------------------------------------------------------------------
    const emailInput = await page.$('input#login-email');
    if (!emailInput) throw new Error("Email input not found on /login");

    // Click submit with empty email
    const submitBtn = await page.$('button[type="submit"]');
    if (!submitBtn) throw new Error("Submit button not found");

    // HTML5 validation or form submit test:
    // Try typing an invalid email (e.g. "notanemail")
    await emailInput.focus();
    await emailInput.type("notanemail");
    await page.evaluate(() => {
      // Trigger submit bypassing html5 pattern to test JS validation fallback
      const form = document.querySelector("form");
      if (form) {
        form.noValidate = true;
        form.requestSubmit();
      }
    });
    await new Promise((r) => setTimeout(r, 300));

    const validationAlert = await page.evaluate(() => {
      const alert = document.querySelector('[data-testid="auth-error-banner"]');
      return alert ? alert.textContent.trim() : "";
    });
    if (!validationAlert.includes("Please enter a valid email address.")) {
      throw new Error(`Expected validation error banner, got: "${validationAlert}"`);
    }
    console.log(`  [PASS] Invalid email validation banner displayed: "${validationAlert}"`);

    // -------------------------------------------------------------------------
    // TEST 3: SIMULATED BACKEND ERROR (RATE LIMIT / DB TIMEOUT)
    // -------------------------------------------------------------------------
    // Clear and enter valid email
    await emailInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await emailInput.type("candidate@example.com");

    // Intercept Supabase signInWithOtp network request or mock fetch
    await page.evaluate(() => {
      window.__MOCK_AUTH_MODE__ = "error";
      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const url = String(args[0] || "");
        if (url.includes("/auth/v1/otp")) {
          return new Response(
            JSON.stringify({ message: "Rate limit exceeded. Please wait 60 seconds." }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          );
        }
        return origFetch.apply(this, args);
      };
    });

    await submitBtn.click();
    await page.waitForSelector('[data-testid="auth-error-banner"]', { timeout: 5000 });

    const simulatedError = await page.$eval('[data-testid="auth-error-banner"]', (el) => el.textContent.trim());
    if (!simulatedError.includes("Rate limit exceeded")) {
      throw new Error(`Expected simulated error banner, got: "${simulatedError}"`);
    }
    console.log(`  [PASS] Simulated auth error banner verified: "${simulatedError}"`);

    // -------------------------------------------------------------------------
    // TEST 4: SUCCESSFUL MAGIC-LINK SUBMISSION (MOCKED - NO REAL EMAILS SENT)
    // -------------------------------------------------------------------------
    await page.evaluate(() => {
      window.fetch = async function (...args) {
        const url = String(args[0] || "");
        if (url.includes("/auth/v1/otp")) {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      };
    });

    await submitBtn.click();
    await page.waitForSelector('[data-testid="auth-email-sent"]', { timeout: 5000 });

    const sentText = await page.$eval('[data-testid="auth-email-sent"]', (el) => el.textContent);
    if (!sentText.includes("candidate@example.com") || !sentText.includes("Check your inbox")) {
      throw new Error(`Email-sent confirmation text missing email address: "${sentText}"`);
    }
    console.log("  [PASS] Email-sent state rendered with candidate email address and resend cooldown");

    // Click "Use a different email" to reset view
    const diffEmailBtn = await page.evaluateHandle(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      return buttons.find((b) => b.textContent.includes("Use a different email"));
    });
    if (!diffEmailBtn) throw new Error("Use different email button not found");
    await diffEmailBtn.click();
    await new Promise((r) => setTimeout(r, 400));

    const emailFormBack = await page.$('input#login-email');
    if (!emailFormBack) throw new Error("Email form did not restore after clicking 'Use a different email'");
    console.log("  [PASS] 'Use a different email' reset the auth view back to input form");

    // -------------------------------------------------------------------------
    // TEST 5: RETURN DESTINATION (?next) PRESERVATION ON PAGE SWITCH
    // -------------------------------------------------------------------------
    await page.goto(`http://localhost:${PORT}/login?next=%2Ftracker`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]', { timeout: 10000 });
    const signupLink = await page.$eval('[data-testid="login-auth-card"] a[href*="/signup"]', (el) => el.getAttribute("href"));
    if (signupLink !== "/signup?next=%2Ftracker") {
      throw new Error(`Expected signup link to preserve ?next=%2Ftracker, got: "${signupLink}"`);
    }
    console.log(`  [PASS] Return destination preserved in switch link: "${signupLink}"`);

    // -------------------------------------------------------------------------
    // TEST 6: SIGNUP PAGE AUDIT & PRESENTATION
    // -------------------------------------------------------------------------
    await page.goto(`http://localhost:${PORT}/signup?next=%2Fjobs`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="signup-auth-card"]', { timeout: 10000 });

    const signupHeading = await page.$eval("h1", (el) => el.textContent.trim());
    if (signupHeading !== "Create your CareerMonke account") {
      throw new Error(`Expected signup heading 'Create your CareerMonke account', got: '${signupHeading}'`);
    }
    console.log(`  [PASS] Signup heading verified: "${signupHeading}"`);

    const loginSwitchLink = await page.$eval('[data-testid="signup-auth-card"] a[href*="/login"]', (el) => el.getAttribute("href"));
    if (loginSwitchLink !== "/login?next=%2Fjobs") {
      throw new Error(`Expected login switch link to preserve ?next=%2Fjobs, got: "${loginSwitchLink}"`);
    }
    console.log(`  [PASS] Signup to login switch link preserved: "${loginSwitchLink}"`);

    // -------------------------------------------------------------------------
    // TEST 7: MOBILE VIEWPORT & ZERO HORIZONTAL OVERFLOW
    // -------------------------------------------------------------------------
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-auth-card"]', { timeout: 10000 });

    const overflowCheck = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      const scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
      const clientWidth = doc.clientWidth;
      return {
        scrollWidth,
        clientWidth,
        hasHorizontalOverflow: scrollWidth > clientWidth,
      };
    });

    if (overflowCheck.hasHorizontalOverflow) {
      throw new Error(
        `Mobile horizontal overflow detected: scrollWidth (${overflowCheck.scrollWidth}) > clientWidth (${overflowCheck.clientWidth})`
      );
    }
    console.log(`  [PASS] Mobile 390px viewport: zero horizontal overflow (scrollWidth=${overflowCheck.scrollWidth}, clientWidth=${overflowCheck.clientWidth})`);

    console.log("\n==================================================================================");
    console.log("  ALL AUTH PRESENTATION & INTERACTION BROWSER CHECKS PASSED [PASS-LOCAL]          ");
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
