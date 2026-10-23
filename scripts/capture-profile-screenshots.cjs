const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3456;
const OUT_DIR = path.resolve(process.cwd(), "out");
const REPORTS_DIR = path.resolve(process.cwd(), "reports", "prompt7-profile");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
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

async function capture() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Static server running at http://localhost:${PORT}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    const sampleUser = {
      id: "usr-sample-123",
      email: "alex.morgan@example.com",
      user_metadata: { full_name: "Alex Morgan" },
      aud: "authenticated",
      role: "authenticated",
    };

    const sampleSession = {
      access_token: "mock-token",
      refresh_token: "mock-refresh",
      expires_in: 3600,
      token_type: "bearer",
      user: sampleUser,
    };

    const sampleProfile = {
      name: "Alex Morgan",
      email: "alex.morgan@example.com",
      phone: "+1 (415) 555-0199",
      location: "San Francisco, CA (Remote)",
      headline: "Staff Full-Stack Engineer & Distributed Systems Architect",
      summary:
        "Staff Engineer with 9+ years building high-throughput distributed systems, event-driven backends, and responsive Next.js web applications. Passionate about system resilience, developer experience, and user-centric software architecture.",
      skills: [
        "TypeScript",
        "React",
        "Next.js",
        "Node.js",
        "PostgreSQL",
        "Go",
        "Docker",
        "Kubernetes",
        "Redis",
        "GraphQL",
      ],
      experience: [
        {
          id: "exp-1",
          company: "Apex Cloud Technologies",
          role: "Staff Infrastructure Engineer",
          startDate: "2023",
          endDate: "Present",
          location: "San Francisco, CA",
          bullets: [
            "Architected event-driven microservices processing 45M daily webhooks with 99.99% uptime.",
            "Designed resilient PostgreSQL read replicas and reduced median query latency by 42%.",
          ],
        },
        {
          id: "exp-2",
          company: "HyperScale Labs",
          role: "Senior Full-Stack Engineer",
          startDate: "2020",
          endDate: "2023",
          location: "Remote",
          bullets: [
            "Led migration of monolith dashboard into modular Next.js App Router frontends.",
            "Implemented client-side caching and dynamic prefetching, improving LCP from 3.8s to 0.9s.",
          ],
        },
      ],
      education: [
        {
          id: "edu-1",
          degree: "B.S. in Computer Science",
          institution: "University of California, Berkeley",
          year: "2019",
          fieldOfStudy: "Computer Systems & Networking",
        },
      ],
      certifications: ["AWS Certified Solutions Architect - Professional"],
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
        value: "alex.morgan@example.com",
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

    // 0. Baseline Before View (/settings?tab=preferences)
    console.log("Capturing Baseline Before View (/settings?tab=preferences)...");
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/settings?tab=preferences`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({
      path: path.join(REPORTS_DIR, "profile-before.png"),
      fullPage: false,
    });
    console.log("  Saved profile-before.png");

    // 1. Desktop Profile View
    console.log("Capturing Desktop Profile View...");
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/profile`, { waitUntil: "networkidle0" });
    console.log("Navigated to URL:", page.url());

    // Wait for the profile elements
    await page.waitForSelector('[data-testid="profile-header-card"]', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 600));

    await page.screenshot({
      path: path.join(REPORTS_DIR, "profile-desktop.png"),
      fullPage: false,
    });
    console.log("  Saved profile-desktop.png");

    // 2. Open Personal Drawer on Desktop
    console.log("Capturing Desktop Personal Drawer...");
    const editBtn = await page.$('[data-testid="edit-header-btn"]');
    if (editBtn) {
      await editBtn.click();
      await page.waitForSelector('[data-testid="profile-drawer-personal"]', { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 600));

      await page.screenshot({
        path: path.join(REPORTS_DIR, "profile-drawer-personal.png"),
        fullPage: false,
      });
      console.log("  Saved profile-drawer-personal.png");

      // Test Escape key closes drawer and returns focus
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 500));
    }

    // 3. Open Work Experience Drawer
    console.log("Capturing Work Experience Drawer...");
    const expEditBtn = await page.$('#section-experience button[aria-label="Edit work experience"]');
    if (expEditBtn) {
      await expEditBtn.click();
      await page.waitForSelector('[data-testid="profile-drawer-experience"]', { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 600));

      await page.screenshot({
        path: path.join(REPORTS_DIR, "profile-drawer-experience.png"),
        fullPage: false,
      });
      console.log("  Saved profile-drawer-experience.png");

      // Close drawer
      const cancelBtn = await page.$('[data-testid="drawer-cancel-btn"]');
      if (cancelBtn) await cancelBtn.click();
      await new Promise((r) => setTimeout(r, 500));
    }

    // 4. Mobile Profile View
    console.log("Capturing Mobile Profile View...");
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/profile`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="profile-header-card"]', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 600));

    await page.screenshot({
      path: path.join(REPORTS_DIR, "profile-mobile.png"),
      fullPage: false,
    });
    console.log("  Saved profile-mobile.png");

    // 5. Mobile Full-Screen Drawer
    console.log("Capturing Mobile Full-Screen Drawer...");
    const mobileEditBtn = await page.$('[data-testid="edit-header-btn"]');
    if (mobileEditBtn) {
      await mobileEditBtn.click();
      await page.waitForSelector('[data-testid="profile-drawer-personal"]', { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 600));

      await page.screenshot({
        path: path.join(REPORTS_DIR, "profile-drawer-mobile.png"),
        fullPage: false,
      });
      console.log("  Saved profile-drawer-mobile.png");
    }

    console.log("All screenshots successfully captured in reports/prompt7-profile/");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

capture().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
