const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3462;
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

async function captureScreenshots() {
  console.log("Starting screenshot capture for Dual-Mode Sidebar & Navigation...");

  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Local static server listening at http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
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

  // Set cookies for @supabase/ssr
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

  // Set localStorage items
  await page.evaluateOnNewDocument(
    (sess, prof) => {
      localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
      localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
      localStorage.setItem("careermonke_candidate_profile", JSON.stringify(prof));
      localStorage.setItem("careermonke_user_email", prof.email);
      localStorage.setItem("careermonke_pro_active", "true");
    },
    sampleSession,
    sampleProfile
  );

  // 1. DESKTOP NARROW MODE (72px) on /profile
  console.log("1. Capturing Desktop Narrow Mode (72px) on /profile...");
  await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:${PORT}/profile`, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    localStorage.setItem("careermonke_sidebar_expanded", "false");
    window.dispatchEvent(new CustomEvent("careermonke_sidebar_mode_changed", { detail: { expanded: false } }));
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(REPORT_DIR, "sidebar-narrow-desktop.png") });
  console.log("  [SAVED] sidebar-narrow-desktop.png");

  // 2. DESKTOP EXPANDED MODE (240px) on /profile
  console.log("2. Capturing Desktop Expanded Mode (240px) on /profile...");
  await page.evaluate(() => {
    localStorage.setItem("careermonke_sidebar_expanded", "true");
    window.dispatchEvent(new CustomEvent("careermonke_sidebar_mode_changed", { detail: { expanded: true } }));
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(REPORT_DIR, "sidebar-expanded-desktop.png") });
  console.log("  [SAVED] sidebar-expanded-desktop.png");

  // 3. HOVER HIGHLIGHT (Coaching-style blue hover on Jobs nav item in expanded mode)
  console.log("3. Capturing Hover Highlight...");
  const jobsLink = await page.$('aside[data-testid="app-icon-rail"] nav a[aria-label="Jobs"]');
  if (jobsLink) {
    await jobsLink.hover();
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(REPORT_DIR, "sidebar-hover-highlight.png") });
    console.log("  [SAVED] sidebar-hover-highlight.png");
  } else {
    console.warn("  [WARNING] Jobs link not found for hover");
  }

  // 4. FOCUS STATE (Keyboard focus on Resume nav item)
  console.log("4. Capturing Keyboard Focus State...");
  const resumeLink = await page.$('aside[data-testid="app-icon-rail"] nav a[aria-label="Resume"]');
  if (resumeLink) {
    await resumeLink.focus();
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(REPORT_DIR, "sidebar-keyboard-focus.png") });
    console.log("  [SAVED] sidebar-keyboard-focus.png");
  } else {
    console.warn("  [WARNING] Resume link not found for focus");
  }

  // 5. MOBILE HAMBURGER NAVIGATION DRAWER (390px viewport)
  console.log("5. Capturing Mobile Hamburger Drawer (390px)...");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.goto(`http://localhost:${PORT}/profile`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));
  const hamburgerBtn = await page.$('button[aria-label="Open navigation menu"]');
  if (hamburgerBtn) {
    await hamburgerBtn.click();
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: path.join(REPORT_DIR, "mobile-nav-drawer.png") });
    console.log("  [SAVED] mobile-nav-drawer.png");
  } else {
    console.warn("  [WARNING] Hamburger button not found on mobile");
  }

  await browser.close();
  server.close();
  console.log("All screenshots captured and saved to:", REPORT_DIR);
}

captureScreenshots().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
