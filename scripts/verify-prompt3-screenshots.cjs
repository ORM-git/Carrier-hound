const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3588;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPORT_DIR = path.resolve(process.cwd(), "reports", "prompt3");

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

const sampleProfile = {
  userId: "usr_mock_123",
  fullName: "Alex Candidate",
  email: "alex.candidate@careermonke.com",
  phone: "+1 (555) 019-2834",
  location: "San Francisco, CA (Remote)",
  targetTitles: ["Staff Software Engineer", "Tech Lead"],
  topSkills: ["TypeScript", "Next.js", "React", "PostgreSQL", "Tailwind CSS"],
  skills: ["TypeScript", "Next.js", "React", "PostgreSQL", "Tailwind CSS"],
  confirmedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function setupSignedState(page, options = {}) {
  const { cookieNotice = false } = options;
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

  await page.evaluateOnNewDocument((sess, prof, showCookie) => {
    localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
    localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
    localStorage.setItem("careermonke_candidate_profile", JSON.stringify(prof));
    localStorage.setItem("careermonke_user_email", prof.email);
    localStorage.setItem("careermonke_pro_active", "true");
    if (showCookie) {
      localStorage.removeItem("cm_cookie_notice");
    } else {
      localStorage.setItem("cm_cookie_notice", "true");
    }
  }, sampleSession, sampleProfile, cookieNotice);
}

async function setupGuestState(page, options = {}) {
  const { cookieNotice = false } = options;
  await page.deleteCookie(
    { name: "sb-szakevhxhwpeskidvtfs-auth-token", domain: "localhost" },
    { name: "careermonke_user_email", domain: "localhost" }
  );

  await page.evaluateOnNewDocument((showCookie) => {
    localStorage.clear();
    if (showCookie) {
      localStorage.removeItem("cm_cookie_notice");
    } else {
      localStorage.setItem("cm_cookie_notice", "true");
    }
  }, cookieNotice);
}

async function run() {
  console.log("================================================================================");
  console.log("CAREERMONKE PROMPT 3 VISUAL & OVERLAP VERIFICATION CAPTURE");
  console.log("================================================================================");

  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[INFO] Server running at http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    // -------------------------------------------------------------------------
    // 1. DESKTOP 1280px SCREENSHOTS (SIGNED-IN)
    // -------------------------------------------------------------------------
    console.log("\n--- Capturing 1280px Desktop Pages ---");
    const pages1280 = [
      { name: "dashboard_desktop_1280.png", url: `http://localhost:${PORT}/dashboard` },
      { name: "jobs_desktop_1280.png", url: `http://localhost:${PORT}/jobs` },
      { name: "resume_desktop_1280.png", url: `http://localhost:${PORT}/resume` },
      { name: "tracker_desktop_1280.png", url: `http://localhost:${PORT}/tracker` },
      { name: "profile_desktop_1280.png", url: `http://localhost:${PORT}/profile` },
      { name: "settings_desktop_1280.png", url: `http://localhost:${PORT}/settings` },
      { name: "radar_desktop_1280.png", url: `http://localhost:${PORT}/radar` },
    ];

    for (const p of pages1280) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 });
      await setupSignedState(page, { cookieNotice: false });
      await page.goto(p.url, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      const outPath = path.join(REPORT_DIR, p.name);
      await page.screenshot({ path: outPath });
      console.log(`  [CAPTURED] ${p.name} -> ${outPath}`);
      await page.close();
    }

    // -------------------------------------------------------------------------
    // 2. DESKTOP 1280px JOB DETAIL VIEW
    // -------------------------------------------------------------------------
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 });
      await setupSignedState(page, { cookieNotice: false });
      await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await page.waitForSelector('[data-testid="job-card"]', { timeout: 4000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      const cardClicked = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="job-card"]') || document.querySelector("article");
        if (card) {
          card.click();
          return true;
        }
        return false;
      });
      await new Promise((r) => setTimeout(r, 800));
      const outPath = path.join(REPORT_DIR, "jobs_detail_desktop_1280.png");
      await page.screenshot({ path: outPath });
      console.log(`  [CAPTURED] jobs_detail_desktop_1280.png (cardClicked: ${cardClicked}) -> ${outPath}`);
      await page.close();
    }

    // -------------------------------------------------------------------------
    // 3. MOBILE 390px SCREENSHOTS (SIGNED-IN)
    // -------------------------------------------------------------------------
    console.log("\n--- Capturing 390px Mobile Pages ---");
    const pages390 = [
      { name: "dashboard_mobile_390.png", url: `http://localhost:${PORT}/dashboard` },
      { name: "jobs_mobile_390.png", url: `http://localhost:${PORT}/jobs` },
      { name: "resume_mobile_390.png", url: `http://localhost:${PORT}/resume` },
      { name: "tracker_mobile_390.png", url: `http://localhost:${PORT}/tracker` },
      { name: "profile_mobile_390.png", url: `http://localhost:${PORT}/profile` },
      { name: "settings_mobile_390.png", url: `http://localhost:${PORT}/settings` },
      { name: "radar_mobile_390.png", url: `http://localhost:${PORT}/radar` },
    ];

    for (const p of pages390) {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await setupSignedState(page, { cookieNotice: false });
      await page.goto(p.url, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      const outPath = path.join(REPORT_DIR, p.name);
      await page.screenshot({ path: outPath });
      console.log(`  [CAPTURED] ${p.name} -> ${outPath}`);
      await page.close();
    }

    // -------------------------------------------------------------------------
    // 4. MOBILE 390px JOB DETAIL VIEW OVERLAY
    // -------------------------------------------------------------------------
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await setupSignedState(page, { cookieNotice: false });
      await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await page.waitForSelector('[data-testid="job-card"]', { timeout: 4000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      await page.evaluate(() => {
        const card = document.querySelector('[data-testid="job-card"]') || document.querySelector("article");
        if (card) card.click();
      });
      await new Promise((r) => setTimeout(r, 800));
      const outPath = path.join(REPORT_DIR, "jobs_detail_mobile_390.png");
      await page.screenshot({ path: outPath });
      console.log(`  [CAPTURED] jobs_detail_mobile_390.png -> ${outPath}`);
      await page.close();
    }

    // -------------------------------------------------------------------------
    // 5. MOBILE OVERLAP CHECKS AT 390px
    // -------------------------------------------------------------------------
    console.log("\n--- Capturing Mobile Overlap Checks (Cookie Notice vs Nav & Apply Bar) ---");

    // 5a. Signed-in: Cookie notice visible -> Bottom nav lifted
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await setupSignedState(page, { cookieNotice: true });
      await page.goto(`http://localhost:${PORT}/dashboard`, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));

      const navOffset = await page.evaluate(() => {
        const nav = document.querySelector('[data-testid="app-mobile-nav"]');
        const cookie = document.getElementById("cm-cookie-notice");
        return {
          navExists: !!nav,
          navBottom: nav ? nav.style.bottom : null,
          cookieExists: !!cookie,
          cookieHeight: cookie ? Math.round(cookie.getBoundingClientRect().height) : 0,
        };
      });
      console.log("  [CHECK] Signed-in Cookie Notice Visible:", navOffset);

      const outPath = path.join(REPORT_DIR, "mobile_overlap_cookie_visible_signedin_nav_390.png");
      await page.screenshot({ path: outPath });
      console.log(`  [CAPTURED] mobile_overlap_cookie_visible_signedin_nav_390.png -> ${outPath}`);

      // Dismiss cookie notice by clicking accept button
      const clickedDismiss = await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label="Accept essential cookies and close notice"]') ||
                    Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "OK");
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      await new Promise((r) => setTimeout(r, 800));

      const dismissedOffset = await page.evaluate(() => {
        const nav = document.querySelector('[data-testid="app-mobile-nav"]');
        return {
          navBottom: nav ? nav.style.bottom : null,
        };
      });
      console.log("  [CHECK] After Cookie Dismissed (clickedDismiss: " + clickedDismiss + "):", dismissedOffset);

      const dismissedPath = path.join(REPORT_DIR, "mobile_overlap_cookie_dismissed_signedin_nav_390.png");
      await page.screenshot({ path: dismissedPath });
      console.log(`  [CAPTURED] mobile_overlap_cookie_dismissed_signedin_nav_390.png -> ${dismissedPath}`);

      await page.close();
    }

    // 5b. Guest: Cookie notice visible -> Job Detail Apply bar lifted
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await setupGuestState(page, { cookieNotice: true });
      await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await page.waitForSelector('[data-testid="job-card"]', { timeout: 4000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));

      await page.evaluate(() => {
        const card = document.querySelector('[data-testid="job-card"]') || document.querySelector("article");
        if (card) card.click();
      });
      await new Promise((r) => setTimeout(r, 1000));

      const guestOffset = await page.evaluate(() => {
        const cookie = document.getElementById("cm-cookie-notice");
        const fixedBars = Array.from(document.querySelectorAll("div.fixed.bottom-0"));
        return {
          cookieExists: !!cookie,
          cookieHeight: cookie ? Math.round(cookie.getBoundingClientRect().height) : 0,
          fixedBarsCount: fixedBars.length,
          barsBottom: fixedBars.map(b => b.style.bottom),
        };
      });
      console.log("  [CHECK] Guest Job Detail Cookie Notice Visible:", guestOffset);

      const outGuestPath = path.join(REPORT_DIR, "mobile_overlap_cookie_visible_guest_apply_390.png");
      await page.screenshot({ path: outGuestPath });
      console.log(`  [CAPTURED] mobile_overlap_cookie_visible_guest_apply_390.png -> ${outGuestPath}`);

      await page.close();
    }

    console.log("\n[SUCCESS] All screenshots and mobile overlap checks captured successfully!");
  } catch (err) {
    console.error("[ERROR] Failed capturing screenshots:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}

run();
