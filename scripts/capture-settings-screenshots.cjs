const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3789;
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\095142a5-8fb0-434d-a887-b22dbe29bdd2";
const SETTINGS_SCREENSHOT_DIR = path.join(ARTIFACT_DIR, "settings-screenshots");
const REPORT_DIR = path.resolve(process.cwd(), "reports", "settings-screenshots");
const OUT_DIR = "D:\\Carrer-hound\\out";

[SETTINGS_SCREENSHOT_DIR, REPORT_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// SVG Icons
const ICON_SETTINGS = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const ICON_BELL = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>`;
const ICON_CARD = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><rect width="20" height="14" x="2" y="5" rx="2"></rect><line x1="2" x2="22" y1="10" y2="10"></line></svg>`;
const ICON_SHIELD = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path></svg>`;
const ICON_GRID = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5"><rect width="7" height="7" x="3" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="14" rx="1"></rect><rect width="7" height="7" x="3" y="14" rx="1"></rect></svg>`;
const ICON_BRIEFCASE = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5"><rect width="20" height="14" x="2" y="7" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>`;
const ICON_FILE = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>`;
const ICON_GLOBE = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>`;
const ICON_CHECK = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5"><rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="m9 12 2 2 4-4"></path></svg>`;

function buildPageHtml(state) {
  const isPro = state.isPro;
  const email = state.email || "subscriber@careermonke.com";

  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
  <link rel="stylesheet" href="/_next/static/css/54dd24ff8cb7a123.css"/>
  <link rel="stylesheet" href="/_next/static/css/0990c75cfb587ca7.css"/>
  <link rel="stylesheet" href="/_next/static/css/d8b854a97b305de7.css"/>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
  </style>
  <title>Settings — CareerMonke</title>
</head>
<body class="font-sans antialiased text-[#09090B] bg-[#F8FAFC] min-h-screen flex flex-col selection:bg-blue-100 selection:text-blue-900 overflow-x-hidden w-full max-w-full">
  <div class="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
    
    <!-- Left Icon Rail (desktop) -->
    <aside class="hidden md:flex flex-col fixed inset-y-0 left-0 z-50 w-[72px] bg-white border-r border-slate-200/80 py-4 items-center justify-between">
      <div class="flex flex-col items-center gap-6 w-full">
        <a href="/" class="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-sm font-bold text-lg">
          🐵
        </a>
        <nav class="flex flex-col items-center gap-2 w-full px-2">
          <a href="/dashboard" class="w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-50 transition">
            ${ICON_GRID}
          </a>
          <a href="/jobs" class="w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-50 transition">
            ${ICON_BRIEFCASE}
          </a>
          <a href="/resume" class="w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-50 transition">
            ${ICON_FILE}
          </a>
          <a href="/tracker" class="w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-50 transition">
            ${ICON_CHECK}
          </a>
          <a href="/worldwide" class="w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-50 transition">
            ${ICON_GLOBE}
          </a>
        </nav>
      </div>
      <div class="flex flex-col items-center gap-2 w-full px-2">
        <a href="/settings" class="w-11 h-11 rounded-xl flex items-center justify-center text-blue-600 bg-blue-50/80 border border-blue-200/60 shadow-xs font-bold transition">
          ${ICON_SETTINGS}
        </a>
      </div>
    </aside>

    <!-- Top Bar + Main Content Area -->
    <div class="md:pl-[72px] flex-1 flex flex-col">
      <header class="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200/80 px-4 sm:px-6 py-3 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <button class="md:hidden p-2 rounded-lg text-slate-500 hover:bg-slate-100">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
          </button>
          <h1 class="text-xs sm:text-sm font-bold tracking-wider text-slate-900 uppercase">
            SETTINGS
          </h1>
        </div>
        <div class="flex items-center gap-2.5">
          ${isPro ? `
            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              PRO
            </span>
          ` : `
            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200 text-xs font-semibold">
              FREE
            </span>
          `}
          <div class="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-bold shadow-xs">
            ${email[0].toUpperCase()}
          </div>
        </div>
      </header>

      <main class="flex-1">
        <div class="max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-8">
          <div>
            <h1 class="text-[18px] font-bold uppercase tracking-wider text-[#0F172A]">
              SETTINGS
            </h1>
            <p class="text-xs sm:text-sm text-slate-500 mt-1">
              Manage your target preferences, notifications, billing, and privacy controls.
            </p>
          </div>

          <!-- Signed-in Account Identity Card -->
          <div class="bg-white rounded-2xl p-5 sm:p-6 border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="space-y-1.5">
              <span class="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Signed-in Account
              </span>
              <div class="text-sm sm:text-base font-bold text-slate-900 flex items-center gap-2">
                <span>${email}</span>
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                  Verified
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-600">
                <span class="text-slate-500">Auth Method:</span>
                <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-800 text-xs font-semibold border border-blue-200">
                  <span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                  Email Magic Link (Passwordless)
                </span>
              </div>
            </div>

            <button type="button" class="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-bold transition cursor-pointer min-h-[44px] shrink-0">
              <span>Sign Out</span>
            </button>
          </div>

          <!-- Tab Navigation -->
          <div class="flex flex-wrap sm:flex-nowrap items-center gap-1.5 sm:gap-2 border-b border-slate-200 overflow-x-auto pb-px">
            <button type="button" class="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2.5 border-b-2 text-xs sm:text-sm font-bold transition whitespace-nowrap cursor-pointer shrink-0 min-h-[44px] border-transparent text-slate-500 hover:text-slate-800">
              ${ICON_SETTINGS}
              <span>Profile &amp; Preferences</span>
            </button>
            <button type="button" class="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2.5 border-b-2 text-xs sm:text-sm font-bold transition whitespace-nowrap cursor-pointer shrink-0 min-h-[44px] border-transparent text-slate-500 hover:text-slate-800">
              ${ICON_BELL}
              <span>Notifications</span>
            </button>
            <button type="button" class="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2.5 border-b-2 text-xs sm:text-sm font-bold transition whitespace-nowrap cursor-pointer shrink-0 min-h-[44px] border-blue-600 text-blue-600">
              ${ICON_CARD}
              <span>Billing &amp; Plans</span>
            </button>
            <button type="button" class="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2.5 border-b-2 text-xs sm:text-sm font-bold transition whitespace-nowrap cursor-pointer shrink-0 min-h-[44px] border-transparent text-slate-500 hover:text-slate-800">
              ${ICON_SHIELD}
              <span>Privacy &amp; Data</span>
            </button>
          </div>

          <!-- TAB 3: BILLING -->
          <div class="bg-white rounded-2xl p-6 sm:p-8 border border-slate-200 shadow-2xs space-y-6">
            <div class="flex items-center justify-between">
              <div>
                <h2 class="text-base sm:text-lg font-bold text-slate-900">
                  Subscription &amp; Billing
                </h2>
                <p class="text-xs text-slate-500">
                  Manage your CareerMonke Pro access, invoices, and renewal.
                </p>
              </div>

              <span class="text-xs font-bold px-3 py-1 rounded-full ${
                isPro ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"
              }">
                ${isPro ? "Pro Active" : "Free Plan"}
              </span>
            </div>

            <div class="p-5 rounded-2xl border border-slate-200 bg-slate-50/70 space-y-3">
              <div class="flex items-start justify-between">
                <div>
                  <h3 class="font-bold text-sm text-slate-900">
                    ${isPro ? "CareerMonke Pro Plan" : "CareerMonke Free Tier"}
                  </h3>
                  <p class="text-xs text-slate-500">
                    ${
                      isPro
                        ? "Monthly Plan (₹1,499 / monthly). Full direct apply unlocked."
                        : "Standard title browsing, 5 tracker slots, 1 ATS resume export."
                    }
                  </p>
                </div>

                ${
                  !isPro
                    ? `<button type="button" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition shadow-xs cursor-pointer">
                        Upgrade to Pro
                      </button>`
                    : ""
                }
              </div>

              <!-- Recurring / Status Banner -->
              <div class="pt-3 border-t border-slate-200/80 flex items-center justify-between text-xs">
                <span class="text-slate-600">
                  ${state.statusText}
                </span>

                ${
                  state.showCancelButton
                    ? `<button type="button" ${state.isCanceling ? "disabled" : ""} class="px-3 py-1.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-bold rounded-xl transition shadow-2xs cursor-pointer disabled:opacity-50 ${state.isCanceling ? "opacity-50" : ""}">
                        ${state.isCanceling ? "Canceling..." : "Cancel auto-renew"}
                      </button>`
                    : ""
                }
              </div>
            </div>
          </div>

        </div>
      </main>
    </div>
  </div>
</body>
</html>`;
}

const STATES = {
  prepaid: {
    id: "prepaid",
    isPro: true,
    email: "subscriber@careermonke.com",
    statusText: `Pro access ends on: <strong>12/15/2026</strong> (does not auto-renew)`,
    showCancelButton: false,
    isCanceling: false,
    description: "Pro Active with prepaid plan (does not auto-renew)",
  },
  recurring_active: {
    id: "recurring-active",
    isPro: true,
    email: "subscriber@careermonke.com",
    statusText: `Pro access ends on: <strong>12/15/2026</strong> (auto-renews)`,
    showCancelButton: true,
    isCanceling: false,
    description: "Pro Active with recurring mandate (auto-renews, Cancel button active)",
  },
  canceling: {
    id: "canceling",
    isPro: true,
    email: "subscriber@careermonke.com",
    statusText: `Pro access ends on: <strong>12/15/2026</strong> (auto-renews)`,
    showCancelButton: true,
    isCanceling: true,
    description: "Pro Active with cancellation in progress (button shows Canceling... disabled)",
  },
  canceled: {
    id: "canceled",
    isPro: true,
    email: "subscriber@careermonke.com",
    statusText: `Pro access ends on: <strong>12/15/2026</strong> (auto-renew canceled)`,
    showCancelButton: false,
    isCanceling: false,
    description: "Pro Active with auto-renew canceled (keeps access until end date)",
  },
  cancel_without_pro: {
    id: "cancel-without-pro",
    isPro: false,
    email: "candidate@careermonke.com",
    statusText: `Mandate pending confirmation (auto-renews)`,
    showCancelButton: true,
    isCanceling: false,
    description: "Free tier with pending recurring mandate (shows Cancel auto-renew without Pro)",
  },
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];

    // Serve custom state HTMLs
    for (const [key, state] of Object.entries(STATES)) {
      if (cleanUrl === `/${key}` || cleanUrl === `/${key}.html`) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildPageHtml(state));
        return;
      }
    }

    // Serve static files from OUT_DIR (CSS, images, etc.)
    const filePath = path.join(OUT_DIR, cleanUrl);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found: " + cleanUrl);
    }
  });
}

async function capture() {
  console.log(`Starting mock settings server on port ${PORT}...`);
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));

  console.log(`Launching Chrome from ${CHROME_PATH}...`);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  const page = await browser.newPage();

  const results = [];

  for (const [key, state] of Object.entries(STATES)) {
    console.log(`\nCapturing state [${key}] - ${state.description}...`);

    // 1. Desktop: 1280x800
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/${key}`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 400));

    const desktopFilename = `settings-${state.id}-desktop.png`;
    const desktopReportPath = path.join(REPORT_DIR, desktopFilename);
    const desktopArtifactPath1 = path.join(SETTINGS_SCREENSHOT_DIR, desktopFilename);
    const desktopArtifactPath2 = path.join(ARTIFACT_DIR, desktopFilename);

    await page.screenshot({ path: desktopReportPath, fullPage: true });
    fs.copyFileSync(desktopReportPath, desktopArtifactPath1);
    fs.copyFileSync(desktopReportPath, desktopArtifactPath2);
    console.log(`  ✓ Desktop: saved to ${desktopFilename}`);

    // 2. Mobile: 375x667 (full page so billing card with cancel button is completely visible)
    await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/${key}`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 400));

    const mobileFilename = `settings-${state.id}-mobile.png`;
    const mobileReportPath = path.join(REPORT_DIR, mobileFilename);
    const mobileArtifactPath1 = path.join(SETTINGS_SCREENSHOT_DIR, mobileFilename);
    const mobileArtifactPath2 = path.join(ARTIFACT_DIR, mobileFilename);

    await page.screenshot({ path: mobileReportPath, fullPage: true });
    fs.copyFileSync(mobileReportPath, mobileArtifactPath1);
    fs.copyFileSync(mobileReportPath, mobileArtifactPath2);
    console.log(`  ✓ Mobile: saved to ${mobileFilename}`);

    results.push({
      state: key,
      description: state.description,
      desktop: desktopFilename,
      mobile: mobileFilename,
    });
  }

  await browser.close();
  server.close();

  console.log("\n=======================================================");
  console.log("   ALL 10 SETTINGS SCREENSHOTS CAPTURED SUCCESSFULLY!   ");
  console.log("=======================================================\n");
  console.table(results);
}

capture().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
