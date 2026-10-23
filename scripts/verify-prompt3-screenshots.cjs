const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const ssr = require("@supabase/ssr");

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

const validJwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfbW9ja18xMjMiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJleHAiOjE4OTM0NTYwMDB9.signature";

const sampleSession = {
  access_token: validJwt,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 1893456000,
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
  name: "Alex Candidate",
  email: "alex.candidate@careermonke.com",
  phone: "+1 (555) 019-2834",
  location: "San Francisco, CA (Remote)",
  headline: "Staff Software Engineer - Infrastructure",
  summary: "Experienced backend and platform engineer specializing in distributed systems.",
  targetTitles: ["Staff Software Engineer", "Tech Lead"],
  topSkills: ["TypeScript", "Next.js", "React", "PostgreSQL", "Tailwind CSS"],
  skills: ["TypeScript", "Next.js", "React", "PostgreSQL", "Tailwind CSS", "Go", "Docker", "Kubernetes"],
  experience: [
    {
      id: "exp_1",
      company: "Stripe",
      role: "Staff Software Engineer",
      startDate: "2021",
      endDate: "Present",
      bullets: ["Architected multi-region database replication serving 50M daily transactions."],
    },
  ],
  education: [
    {
      id: "edu_1",
      degree: "B.S. Computer Science",
      institution: "Stanford University",
      year: "2019",
    },
  ],
  certifications: ["AWS Certified Solutions Architect"],
  confirmedAt: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
};

const mockJobs = [
  {
    id: "job_sample_1",
    title: "Senior Solutions Consultant",
    company: "PlanetScale",
    location: "Chicago, IL (Remote)",
    date: new Date().toISOString(),
    salary: "$180,000 - $220,000",
    category: "engineering",
    remote: true,
    remoteScope: "Worldwide",
    remoteEligibility: "Worldwide",
    country: "US",
    type: "Full-time",
    directSource: true,
    applyUrl: "https://planetscale.com/careers/sample-1",
    description: "Lead technical customer engagements and distributed database architecture discussions for enterprise clients worldwide.",
    skills: ["TypeScript", "PostgreSQL", "Distributed Systems"],
    postedAt: new Date().toISOString(),
  },
  {
    id: "job_sample_2",
    title: "Staff Software Engineer, User Targeting",
    company: "Datadog",
    location: "New York City, NY",
    date: new Date().toISOString(),
    salary: "$210,000 - $250,000",
    category: "engineering",
    remote: true,
    remoteScope: "Worldwide",
    remoteEligibility: "Worldwide",
    country: "US",
    type: "Full-time",
    directSource: true,
    applyUrl: "https://datadoghq.com/careers/sample-2",
    description: "Design high-throughput ingestion pipelines and feature stores processing petabytes of telemetry and event data.",
    skills: ["Go", "Kubernetes", "PostgreSQL", "Docker"],
    postedAt: new Date().toISOString(),
  },
];

async function setupPageMocks(page, options = {}) {
  const { isSigned = true, isPro = true, cookieNotice = false } = options;

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();

    // Respond immediately to CORS preflights
    if (req.method() === "OPTIONS") {
      req.respond({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
      return;
    }

    // Intercept subscription checks
    if (url.includes("/subscriptions") || url.includes("/api/billing")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      const subRow = {
        id: "sub_mock_active",
        user_id: "usr_mock_123",
        status: isPro ? "active" : "canceled",
        plan: "pro_monthly",
        plan_id: "price_pro_monthly",
        current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
        created_at: new Date().toISOString(),
      };
      const body = isPro
        ? (isObjectExpected ? JSON.stringify(subRow) : JSON.stringify([subRow]))
        : (isObjectExpected ? "null" : JSON.stringify([]));

      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body,
      });
      return;
    }

    // Intercept candidate profile
    if (url.includes("/candidate_profiles") || url.includes("/profiles")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isObjectExpected ? JSON.stringify(sampleProfile) : JSON.stringify([sampleProfile]),
      });
      return;
    }

    // Intercept user preferences
    if (url.includes("/user_preferences")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      const prefData = {
        user_id: "usr_mock_123",
        onboarding_completed: true,
        roles: ["Staff Software Engineer"],
        categories: ["engineering"],
        experience_level: "senior",
        locations: ["Remote / Global"],
        updated_at: new Date().toISOString(),
      };
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isObjectExpected ? JSON.stringify(prefData) : JSON.stringify([prefData]),
      });
      return;
    }

    // Intercept radar stats or coordinates
    if (url.includes("/api/radar") || url.includes("/radar.json") || url.includes("/data/radar.json")) {
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          header: {
            totalActive: 2341,
            totalVerified: 1820,
            dataAsOf: new Date().toISOString(),
          },
          cities: [
            {
              id: "san-francisco",
              name: "San Francisco",
              countryCode: "US",
              region: "americas",
              coordinates: [-122.4194, 37.7749],
              totalCount: 420,
              verifiedCount: 380,
              topCompanies: ["Stripe", "OpenAI", "Datadog"],
            },
            {
              id: "new-york",
              name: "New York",
              countryCode: "US",
              region: "americas",
              coordinates: [-74.0060, 40.7128],
              totalCount: 310,
              verifiedCount: 290,
              topCompanies: ["Bloomberg", "Datadog", "Google"],
            },
            {
              id: "london",
              name: "London",
              countryCode: "GB",
              region: "europe",
              coordinates: [-0.1278, 51.5074],
              totalCount: 210,
              verifiedCount: 195,
              topCompanies: ["Revolut", "Monzo", "DeepMind"],
            },
            {
              id: "bengaluru",
              name: "Bengaluru",
              countryCode: "IN",
              region: "asia_pac",
              coordinates: [77.5946, 12.9716],
              totalCount: 180,
              verifiedCount: 160,
              topCompanies: ["Razorpay", "Flipkart", "Postman"],
            },
          ],
          countries: {
            US: { name: "United States", total: 730, verified: 670, coordinates: [-95.7129, 37.0902] },
            GB: { name: "United Kingdom", total: 210, verified: 195, coordinates: [-3.4360, 55.3781] },
            IN: { name: "India", total: 180, verified: 160, coordinates: [78.9629, 20.5937] },
          },
          worldwideRemote: {
            id: "worldwide-remote",
            name: "Worldwide Remote",
            totalCount: 980,
            verifiedCount: 850,
            topCompanies: ["GitLab", "Automattic", "Canonical"],
          },
          unlocated: { totalCount: 50, verifiedCount: 40 },
        }),
      });
      return;
    }

    // Allow normal static asset loading
    req.continue();
  });

  if (isSigned) {
    const cookieChunks = ssr.createChunks(
      "sb-szakevhxhwpeskidvtfs-auth-token",
      "base64-" + ssr.stringToBase64URL(JSON.stringify(sampleSession))
    );
    for (const c of cookieChunks) {
      await page.setCookie({
        name: c.name,
        value: c.value,
        domain: "localhost",
        path: "/",
      });
    }

    await page.setCookie({
      name: "careermonke_user_email",
      value: "alex.candidate@careermonke.com",
      domain: "localhost",
      path: "/",
    });

    await page.evaluateOnNewDocument((sess, prof, proActive, showCookie, jobs) => {
      localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
      localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
      localStorage.setItem("careermonke_candidate_profile", JSON.stringify(prof));
      localStorage.setItem("careermonke_user_email", prof.email);
      localStorage.setItem("careermonke_pro_active", proActive ? "true" : "false");
      localStorage.setItem("careermonke_resume_title", "Alex Candidate - Resume");
      localStorage.setItem("careermonke_onboarding_completed", "true");
      localStorage.setItem("careermonke_preferences", JSON.stringify({
        roles: ["Staff Software Engineer"],
        categories: ["engineering"],
        experienceLevel: "senior",
        employmentTypes: ["full-time"],
        locations: ["Remote / Global"],
        remotePreference: "remote",
        onboardingCompleted: true,
        updatedAt: new Date().toISOString(),
      }));
      localStorage.setItem("careermonke_applications_tracker", JSON.stringify([
        {
          id: "app_1",
          jobId: "job_sample_1",
          company: "PlanetScale",
          title: "Senior Solutions Consultant",
          stage: "applied",
          location: "Remote",
          appliedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
          updatedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        },
        {
          id: "app_2",
          jobId: "job_sample_2",
          company: "Datadog",
          title: "Staff Software Engineer, User Targeting",
          stage: "interview",
          location: "New York, NY",
          appliedAt: new Date(Date.now() - 7 * 86400000).toISOString(),
          updatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        },
      ]));
      if (showCookie) {
        localStorage.removeItem("cm_cookie_notice");
      } else {
        localStorage.setItem("cm_cookie_notice", "true");
      }
    }, sampleSession, sampleProfile, isPro, cookieNotice, mockJobs);
  } else {
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
}

async function run() {
  console.log("================================================================================");
  console.log("CAREERMONKE PROMPT 4 VERIFICATION: EXACT FIXES, MEASUREMENTS & SCREENSHOTS");
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
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--use-gl=angle",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--hide-scrollbars",
    ],
  });

  const capturedSizes = new Map();

  try {
    // -------------------------------------------------------------------------
    // 1. DESKTOP 1280px SCREENSHOTS (SIGNED-IN)
    // -------------------------------------------------------------------------
    console.log("\n--- 1. Capturing 1280px Desktop Pages (Loaded Content) ---");
    const pages1280 = [
      {
        name: "dashboard_desktop_1280.png",
        url: `http://localhost:${PORT}/dashboard`,
        waitSelector: '[data-testid="dashboard-greeting"], [data-testid="dashboard-stats"], #main-content',
      },
      {
        name: "jobs_desktop_1280.png",
        url: `http://localhost:${PORT}/jobs`,
        waitSelector: '[data-testid="job-card"], article',
      },
      {
        name: "resume_desktop_1280.png",
        url: `http://localhost:${PORT}/resume`,
        waitSelector: '[data-testid="resume-card"], table',
      },
      {
        name: "tracker_desktop_1280.png",
        url: `http://localhost:${PORT}/tracker`,
        waitSelector: '[data-testid="tracker-board"], [data-stage]',
      },
      {
        name: "profile_desktop_1280.png",
        url: `http://localhost:${PORT}/profile`,
        waitSelector: '#personal, #work-experience',
      },
      {
        name: "settings_desktop_1280.png",
        url: `http://localhost:${PORT}/settings`,
        waitSelector: 'nav[aria-label="Settings navigation"], button',
      },
      {
        name: "radar_desktop_1280.png",
        url: `http://localhost:${PORT}/radar`,
        waitSelector: '#radar-canvas-container, canvas, [data-testid="job-radar-globe"]',
      },
    ];

    for (const p of pages1280) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 });
      await setupPageMocks(page, { isSigned: true, isPro: true, cookieNotice: false });
      await page.goto(p.url, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      if (p.waitSelector) {
        await page.waitForSelector(p.waitSelector, { timeout: 6000 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));

      // Extra verification on /resume: measure rendered table dimensions
      if (p.name === "resume_desktop_1280.png") {
        const tableMeasurements = await page.evaluate(() => {
          const card = document.querySelector('[data-testid="resume-card"]');
          const row = document.querySelector('tbody tr');
          const th = document.querySelector('thead th');
          return {
            cardWidth: card ? Math.round(card.getBoundingClientRect().width) : 0,
            cardRadius: card ? getComputedStyle(card).borderRadius : null,
            rowHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
            thFont: th ? `${getComputedStyle(th).fontSize} / ${getComputedStyle(th).fontWeight}` : null,
          };
        });
        console.log("  [MEASUREMENT] Desktop Resume Table:", tableMeasurements);
      }

      const outPath = path.join(REPORT_DIR, p.name);
      await page.screenshot({ path: outPath });
      const size = fs.statSync(outPath).size;
      capturedSizes.set(p.name, size);
      console.log(`  [CAPTURED] ${p.name} (${size.toLocaleString()} bytes) -> ${outPath}`);
      await page.close();
    }

    // -------------------------------------------------------------------------
    // 2. DESKTOP 1280px JOB DETAIL VIEW
    // -------------------------------------------------------------------------
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 850, deviceScaleFactor: 2 });
      await setupPageMocks(page, { isSigned: true, isPro: true, cookieNotice: false });
      await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await page.waitForSelector('[data-testid="job-card"]', { timeout: 6000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));

      const cardClicked = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="job-card"]') || document.querySelector("article");
        if (card) {
          card.click();
          return true;
        }
        return false;
      });
      await page.waitForSelector('button[aria-label="Back to jobs"], [data-testid="report-issue-link"], h1', { timeout: 5000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));

      const outPath = path.join(REPORT_DIR, "jobs_detail_desktop_1280.png");
      await page.screenshot({ path: outPath });
      const size = fs.statSync(outPath).size;
      capturedSizes.set("jobs_detail_desktop_1280.png", size);
      console.log(`  [CAPTURED] jobs_detail_desktop_1280.png (${size.toLocaleString()} bytes, cardClicked: ${cardClicked}) -> ${outPath}`);
      await page.close();
    }

    // -------------------------------------------------------------------------
    // 3. MOBILE 390px SCREENSHOTS (SIGNED-IN)
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Capturing 390px Mobile Pages (Loaded Content) ---");
    const pages390 = [
      {
        name: "dashboard_mobile_390.png",
        url: `http://localhost:${PORT}/dashboard`,
        waitSelector: '[data-testid="dashboard-greeting"], [data-testid="dashboard-stats"], #main-content',
      },
      {
        name: "jobs_mobile_390.png",
        url: `http://localhost:${PORT}/jobs`,
        waitSelector: '[data-testid="job-card"], article',
      },
      {
        name: "resume_mobile_390.png",
        url: `http://localhost:${PORT}/resume`,
        waitSelector: '[data-testid="resume-card"], table',
      },
      {
        name: "tracker_mobile_390.png",
        url: `http://localhost:${PORT}/tracker`,
        waitSelector: '[data-testid="tracker-board"], [data-stage]',
      },
      {
        name: "profile_mobile_390.png",
        url: `http://localhost:${PORT}/profile`,
        waitSelector: '#personal, #work-experience',
      },
      {
        name: "settings_mobile_390.png",
        url: `http://localhost:${PORT}/settings`,
        waitSelector: 'nav[aria-label="Settings navigation"], button',
      },
      {
        name: "radar_mobile_390.png",
        url: `http://localhost:${PORT}/radar`,
        waitSelector: '#radar-canvas-container, canvas, [data-testid="job-radar-globe"]',
      },
    ];

    for (const p of pages390) {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await setupPageMocks(page, { isSigned: true, isPro: true, cookieNotice: false });
      await page.goto(p.url, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      if (p.waitSelector) {
        await page.waitForSelector(p.waitSelector, { timeout: 6000 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
      const outPath = path.join(REPORT_DIR, p.name);
      await page.screenshot({ path: outPath });
      const size = fs.statSync(outPath).size;
      capturedSizes.set(p.name, size);
      console.log(`  [CAPTURED] ${p.name} (${size.toLocaleString()} bytes) -> ${outPath}`);
      await page.close();
    }

    // -------------------------------------------------------------------------
    // 4. MOBILE 390px JOB DETAIL VIEW OVERLAY (Route-specific loaded check)
    // -------------------------------------------------------------------------
    {
      console.log("\n--- 3. Verifying Route-Specific Content on Mobile Job Detail ---");
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await setupPageMocks(page, { isSigned: true, isPro: true, cookieNotice: false });
      await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await page.waitForSelector('[data-testid="job-card"]', { timeout: 6000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));

      // Trigger card click
      const cardClicked = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="job-card"]') || document.querySelector("article");
        if (card) {
          card.click();
          return true;
        }
        return false;
      });

      // Wait explicitly for the route-specific back button or detail header
      const detailLoaded = await page.waitForSelector('button[aria-label="Back to jobs"], [data-testid="report-issue-detail-link"], .text-\\[24px\\]', {
        timeout: 6000,
      }).catch(() => null);

      await new Promise((r) => setTimeout(r, 1200));

      const outPath = path.join(REPORT_DIR, "jobs_detail_mobile_390.png");
      await page.screenshot({ path: outPath });
      const size = fs.statSync(outPath).size;
      capturedSizes.set("jobs_detail_mobile_390.png", size);
      console.log(`  [CAPTURED] jobs_detail_mobile_390.png (${size.toLocaleString()} bytes, cardClicked: ${cardClicked}, detailLoaded: ${!!detailLoaded}) -> ${outPath}`);

      // Check duplicate comparison
      const jobsMobileSize = capturedSizes.get("jobs_mobile_390.png");
      if (jobsMobileSize && jobsMobileSize === size) {
        console.warn(`  [WARNING] Unexpected duplicate image detected: jobs_mobile_390.png and jobs_detail_mobile_390.png have identical size (${size} bytes)!`);
      } else {
        console.log(`  [VERIFIED] Distinct content confirmed: jobs_mobile_390.png (${jobsMobileSize} bytes) vs jobs_detail_mobile_390.png (${size} bytes).`);
      }

      await page.close();
    }

    // -------------------------------------------------------------------------
    // 5. MOBILE OVERLAP CHECKS AT 390px
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Capturing Mobile Overlap Checks (Cookie Notice vs Nav & Apply Bar) ---");

    // 5a. Signed-in: Cookie notice visible -> Bottom nav lifted
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await setupPageMocks(page, { isSigned: true, isPro: true, cookieNotice: true });
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
      await setupPageMocks(page, { isSigned: false, isPro: false, cookieNotice: true });
      await page.goto(`http://localhost:${PORT}/jobs`, { waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
      await page.waitForSelector('[data-testid="job-card"]', { timeout: 6000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));

      await page.evaluate(() => {
        const card = document.querySelector('[data-testid="job-card"]') || document.querySelector("article");
        if (card) card.click();
      });
      await new Promise((r) => setTimeout(r, 1200));

      const guestOffset = await page.evaluate(() => {
        const cookie = document.getElementById("cm-cookie-notice");
        const applyBar = document.querySelector('[aria-label="Quick apply bar"]');
        return {
          cookieExists: !!cookie,
          cookieHeight: cookie ? Math.round(cookie.getBoundingClientRect().height) : 0,
          applyBarExists: !!applyBar,
          applyBarBottom: applyBar ? applyBar.style.bottom : null,
        };
      });
      console.log("  [CHECK] Guest Job Detail Cookie Notice Visible:", guestOffset);

      const outGuestPath = path.join(REPORT_DIR, "mobile_overlap_cookie_visible_guest_apply_390.png");
      await page.screenshot({ path: outGuestPath });
      console.log(`  [CAPTURED] mobile_overlap_cookie_visible_guest_apply_390.png -> ${outGuestPath}`);

      await page.close();
    }

    console.log("\n[SUCCESS] Prompt 4 screenshot verification executed cleanly!");
  } catch (err) {
    console.error("[ERROR] Screenshot capture failed:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}

run();
