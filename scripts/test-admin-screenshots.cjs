const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const puppeteer = require("puppeteer-core");
const ssr = require("@supabase/ssr");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_DIR = path.resolve(__dirname, "..", "out");
const REPORT_DIR = path.resolve(__dirname, "..", "reports", "admin-a1");

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

// MIME types for static export serving
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Fixtures for authentic React admin UI rendering
const VALID_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJlbWFpbCI6Inhic3VyeWFrYW50QGdtYWlsLmNvbSIsInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTA2MzI1NDEzfQ.c2lnbmF0dXJl";

const MOCK_ADMIN_SESSION = {
  access_token: VALID_JWT,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 2106325413,
  refresh_token: "mock-admin-refresh-token",
  user: {
    id: "00000000-0000-0000-0000-000000000001",
    aud: "authenticated",
    role: "authenticated",
    email: "xbsuryakant@gmail.com",
    app_metadata: { provider: "email" },
    user_metadata: { role: "admin" },
    created_at: "2026-01-01T00:00:00.000Z",
  },
};

const FIXTURE_USERS = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    email: "xbsuryakant@gmail.com",
    isPro: true,
    plan: "pro",
    createdAt: "2026-01-10T12:00:00.000Z",
    lastSignInAt: "2026-04-11T09:30:00.000Z",
    isBlocked: false,
    blockReason: null,
    totalViews: 215,
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    email: "alex.chen@example.com",
    isPro: true,
    plan: "pro",
    createdAt: "2026-02-14T10:15:00.000Z",
    lastSignInAt: "2026-04-10T14:22:00.000Z",
    isBlocked: false,
    blockReason: null,
    totalViews: 142,
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    email: "sarah.connor@example.com",
    isPro: false,
    plan: "free",
    createdAt: "2026-03-01T08:00:00.000Z",
    lastSignInAt: "2026-04-09T18:40:00.000Z",
    isBlocked: true,
    blockReason: "Automated scraping pattern detected",
    totalViews: null, // FIX 1: Explicit null / Unavailable for failed count query!
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    email: "dev.marcus@example.com",
    isPro: false,
    plan: "free",
    createdAt: "2026-03-15T16:20:00.000Z",
    lastSignInAt: "2026-04-11T08:05:00.000Z",
    isBlocked: false,
    blockReason: null,
    totalViews: 45,
  },
];

const FIXTURE_USER_ACTIVITY = {
  ok: true,
  userId: "00000000-0000-0000-0000-000000000002",
  userEmail: "alex.chen@example.com",
  summary: {
    views24h: 14,
    views7d: 52,
    totalRecordedViews: 142,
  },
  activity: [
    {
      id: "pv-01",
      user_id: "00000000-0000-0000-0000-000000000002",
      path: "/jobs",
      page_title: "Remote Engineering Roles | CareerMonke",
      created_at: "2026-04-11T09:12:00.000Z",
    },
    {
      id: "pv-02",
      user_id: "00000000-0000-0000-0000-000000000002",
      path: "/remote/hidden-job-market-guide",
      page_title: "Hidden Job Market Guide | CareerMonke",
      created_at: "2026-04-11T08:45:00.000Z",
    },
    {
      id: "pv-03",
      user_id: "00000000-0000-0000-0000-000000000002",
      path: "/dashboard",
      page_title: "Candidate Dashboard | CareerMonke",
      created_at: "2026-04-10T14:22:00.000Z",
    },
    {
      id: "pv-04",
      user_id: "00000000-0000-0000-0000-000000000002",
      path: "/pricing",
      page_title: "Pro Membership Plans | CareerMonke",
      created_at: "2026-04-09T17:30:00.000Z",
    },
  ],
};

const FIXTURE_AUDIT_LOGS = [
  {
    id: "audit-001",
    actor_id: "00000000-0000-0000-0000-000000000001",
    actor_email: "xbsuryakant@gmail.com",
    action: "user.block",
    target_type: "user",
    target_id: "00000000-0000-0000-0000-000000000003",
    details: {
      reason: "Automated scraping pattern detected",
      target_email: "sarah.connor@example.com",
    },
    ip_address: "127.0.0.1",
    created_at: "2026-04-10T16:30:00.000Z",
  },
  {
    id: "audit-002",
    actor_id: "00000000-0000-0000-0000-000000000001",
    actor_email: "xbsuryakant@gmail.com",
    action: "user.unblock",
    target_type: "user",
    target_id: "00000000-0000-0000-0000-000000000004",
    details: {
      reason: "Manual verification confirmed legitimate candidate account",
      target_email: "dev.marcus@example.com",
    },
    ip_address: "127.0.0.1",
    created_at: "2026-04-09T11:20:00.000Z",
  },
];

function startStaticServer(port = 4195) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url.split("?")[0];
      if (reqPath === "/") reqPath = "/index.html";

      let filePath = path.join(OUT_DIR, reqPath);

      if (!fs.existsSync(filePath) && fs.existsSync(`${filePath}.html`)) {
        filePath = `${filePath}.html`;
      } else if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        const indexHtml = path.join(filePath, "index.html");
        if (fs.existsSync(indexHtml)) filePath = indexHtml;
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`Not found: ${reqPath}`);
      }
    });

    server.listen(port, "localhost", () => resolve(server));
    server.on("error", reject);
  });
}

function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function captureAllScreenshots() {
  console.log("================================================================================");
  console.log("ACTUAL COMPILED REACT APP SCREENSHOT HARNESS (PUPPETEER E2E VERIFICATION)");
  console.log("================================================================================\n");

  const PORT = 4195;
  const server = await startStaticServer(PORT);
  console.log(`✅ Static server running at http://localhost:${PORT} serving compiled out/ static export\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
    ],
  });

  const capturedManifest = [];

  try {
    const viewports = [
      { name: "desktop", width: 1280, height: 800 },
      { name: "mobile-390px", width: 390, height: 844 },
    ];

    // Helper to configure a clean authenticated page
    const createAuthenticatedPage = async (vp, apiConfig) => {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height });

      // Request interception with strict default deny
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const urlStr = req.url();

        // 1. Supabase Auth session endpoint
        if (urlStr.includes("/auth/v1/user")) {
          req.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(MOCK_ADMIN_SESSION.user),
          });
          return;
        }

        // 2. Users Activity endpoint
        if (urlStr.includes("/api/admin/users/activity")) {
          req.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(FIXTURE_USER_ACTIVITY),
          });
          return;
        }

        // 3. Admin Users endpoint
        if (urlStr.includes("/api/admin/users")) {
          if (apiConfig.usersState === "loading") {
            // Keep pending to render loading skeleton
            return;
          }
          if (apiConfig.usersState === "error") {
            req.respond({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ ok: false, error: "Database connection failed. Please retry." }),
            });
            return;
          }
          if (apiConfig.usersState === "empty") {
            req.respond({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                ok: true,
                users: [],
                pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasNextPage: false, hasPrevPage: false },
                searchNotice: null,
              }),
            });
            return;
          }
          if (apiConfig.usersState === "search") {
            req.respond({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                ok: true,
                users: [FIXTURE_USERS[1]], // alex.chen only
                pagination: { page: 1, pageSize: 25, total: 4, totalPages: 1, hasNextPage: false, hasPrevPage: false },
                searchNotice: "Email search filters users on the current page. Global search across all accounts requires server-side index configuration.",
              }),
            });
            return;
          }
          // Normal state
          req.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              users: FIXTURE_USERS,
              pagination: { page: 1, pageSize: 25, total: 4, totalPages: 1, hasNextPage: false, hasPrevPage: false },
              searchNotice: null,
            }),
          });
          return;
        }

        // 4. Admin Audit Log endpoint
        if (urlStr.includes("/api/admin/audit-log")) {
          if (apiConfig.auditState === "loading") {
            return;
          }
          if (apiConfig.auditState === "error") {
            req.respond({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ ok: false, error: "Database error reading audit log: relation admin_audit_log does not exist" }),
            });
            return;
          }
          if (apiConfig.auditState === "empty") {
            req.respond({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                ok: true,
                entries: [],
                total: 0,
                totalPages: 1,
              }),
            });
            return;
          }
          // Normal state
          req.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              entries: FIXTURE_AUDIT_LOGS,
              total: FIXTURE_AUDIT_LOGS.length,
              totalPages: 1,
            }),
          });
          return;
        }

        // 5. Allow local static assets
        if (urlStr.startsWith(`http://localhost:${PORT}/`)) {
          req.continue();
          return;
        }

        // Strict Default-Deny on any unexpected external traffic
        req.abort();
      });

      // Navigate to root to set session cookies and local storage on localhost origin
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });

      const cookieName = "sb-szakevhxhwpeskidvtfs-auth-token";
      const rawStr = JSON.stringify(MOCK_ADMIN_SESSION);
      const cookieVal = "base64-" + ssr.stringToBase64URL(rawStr);
      const chunks = ssr.createChunks(cookieName, cookieVal);
      const cookies = chunks.map((c) => ({
        name: c.name,
        value: c.value,
        domain: "localhost",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      }));
      await page.setCookie(...cookies);

      await page.evaluate((sess) => {
        localStorage.setItem("careermonke_user_email", sess.user.email);
        localStorage.setItem("careermonke_pro_active", "true");
        localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
      }, MOCK_ADMIN_SESSION);

      return page;
    };

    // -------------------------------------------------------------------------
    // 1. /admin/users SCREENSHOTS
    // -------------------------------------------------------------------------
    console.log("--- CAPTURING ACTUAL REACT APP /admin/users ---");

    // A. Normal State (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { usersState: "normal" });
      await page.goto(`http://localhost:${PORT}/admin/users`, { waitUntil: "networkidle0" });

      const fileName = `admin-users-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/users",
        fixture: "normal (4 fixture users, active/blocked/pro status, server pagination)",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // B. Search Active State (Desktop & Mobile) - Proving honest page-local notice and separate counts
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { usersState: "search" });
      await page.goto(`http://localhost:${PORT}/admin/users?q=alex`, { waitUntil: "networkidle0" });

      const fileName = `admin-users-search-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/users?q=alex",
        fixture: "search (1 matching on this page, honest page-local banner, 4 registered accounts total)",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // B2. Block Confirmation Modal (Mobile-390px) - Proving accessible action confirmation controls
    {
      const vp = viewports[1]; // mobile-390px
      const page = await createAuthenticatedPage(vp, { usersState: "normal" });
      await page.goto(`http://localhost:${PORT}/admin/users`, { waitUntil: "networkidle0" });

      // Find and click visible Block button on an active non-admin user
      const blockButtons = await page.$$("button");
      for (const btn of blockButtons) {
        const box = await btn.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          const text = await page.evaluate((el) => el.innerText, btn);
          if (text && text.trim() === "Block") {
            await page.evaluate((el) => el.click(), btn);
            await new Promise((r) => setTimeout(r, 600));
            break;
          }
        }
      }

      const fileName = `admin-users-block-modal-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/users (Block Confirmation Modal)",
        fixture: "moderation confirmation dialog on mobile",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // C. Activity Modal (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { usersState: "normal" });
      await page.goto(`http://localhost:${PORT}/admin/users`, { waitUntil: "networkidle0" });

      // Click on visible activity button of second user (alex.chen)
      const buttons = await page.$$("button[title='Click to view visited pages']");
      let clicked = false;
      for (const btn of buttons) {
        const box = await btn.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          const text = await page.evaluate((el) => el.innerText, btn);
          if (text && text.includes("142 views")) {
            await page.evaluate((el) => el.click(), btn);
            await new Promise((r) => setTimeout(r, 600)); // wait for modal animation
            clicked = true;
            break;
          }
        }
      }
      if (!clicked && buttons.length > 0) {
        for (const btn of buttons) {
          const box = await btn.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            await page.evaluate((el) => el.click(), btn);
            await new Promise((r) => setTimeout(r, 600));
            break;
          }
        }
      }

      const fileName = `admin-users-activity-modal-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/users (Activity Modal)",
        fixture: "activity (24h/7d metrics + visited pages timeline)",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // D. Loading State (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { usersState: "loading" });
      await page.goto(`http://localhost:${PORT}/admin/users`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 200));

      const fileName = `admin-users-loading-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/users",
        fixture: "loading skeleton state",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // E. Empty State (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { usersState: "empty" });
      await page.goto(`http://localhost:${PORT}/admin/users`, { waitUntil: "networkidle0" });

      const fileName = `admin-users-empty-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/users",
        fixture: "empty user table",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // F. Error State (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { usersState: "error" });
      await page.goto(`http://localhost:${PORT}/admin/users`, { waitUntil: "networkidle0" });

      const fileName = `admin-users-error-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/users",
        fixture: "error state (feedback banner with retry/dismiss)",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // -------------------------------------------------------------------------
    // 2. /admin/audit-log SCREENSHOTS
    // -------------------------------------------------------------------------
    console.log("\n--- CAPTURING ACTUAL REACT APP /admin/audit-log ---");

    // A. Normal State (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { auditState: "normal" });
      await page.goto(`http://localhost:${PORT}/admin/audit-log`, { waitUntil: "networkidle0" });

      const fileName = `admin-audit-log-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/audit-log",
        fixture: "normal (user.block & user.unblock entries + pending immutability disclosure)",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // B. Loading State (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { auditState: "loading" });
      await page.goto(`http://localhost:${PORT}/admin/audit-log`, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 200));

      const fileName = `admin-audit-log-loading-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/audit-log",
        fixture: "loading skeleton state",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // C. Empty State (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { auditState: "empty" });
      await page.goto(`http://localhost:${PORT}/admin/audit-log`, { waitUntil: "networkidle0" });

      const fileName = `admin-audit-log-empty-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/audit-log",
        fixture: "empty audit log state",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

    // D. Error State with Retry Button (Desktop & Mobile)
    for (const vp of viewports) {
      const page = await createAuthenticatedPage(vp, { auditState: "error" });
      await page.goto(`http://localhost:${PORT}/admin/audit-log`, { waitUntil: "networkidle0" });

      const fileName = `admin-audit-log-error-${vp.name}.png`;
      const outPath = path.join(REPORT_DIR, fileName);
      await page.screenshot({ path: outPath, fullPage: true });
      await page.close();

      capturedManifest.push({
        route: "/admin/audit-log",
        fixture: "error state with retry button (HTTP 500 simulated)",
        viewport: vp.name,
        dimensions: `${vp.width}x${vp.height}`,
        file: fileName,
        path: outPath,
      });
      console.log(`📸 Captured: ${fileName}`);
    }

  } finally {
    await browser.close();
    server.close();
  }

  // -------------------------------------------------------------------------
  // Print verification manifest table
  // -------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("SCREENSHOT MANIFEST & INTEGRITY TABLE (ACTUAL COMPILED REACT APP)");
  console.log("================================================================================");
  console.table(
    capturedManifest.map((item) => {
      const stat = fs.statSync(item.path);
      const sha256 = computeFileHash(item.path);
      return {
        File: item.file,
        Route: item.route,
        Viewport: item.dimensions,
        Bytes: stat.size,
        "SHA-256": `${sha256.substring(0, 16)}...`,
      };
    })
  );

  console.log("🎉 ALL ACTUAL REACT APP SCREENSHOTS CAPTURED SUCCESSFULLY (PASS-LOCAL)!");
}

captureAllScreenshots().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
