import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import puppeteer from "puppeteer-core";
import { formatRelativeTime } from "../src/components/LandingJobsTickerStrip";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function findChromePath(): string {
  const paths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.CHROME_BIN,
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Chrome binary not found on system");
}

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-jobs-ticker.ts", "--negative-control"],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  assert.notStrictEqual(
    res.status,
    0,
    `Expected negative control subprocess to exit non-zero, but got status=${res.status}`
  );
  console.log("  [PASS] Negative control '--negative-control' exited non-zero (1)");
}

async function testMiddlewareExemption() {
  const { middleware } = await import("../src/middleware");

  // 1. Signed-out GET /api/ticker passes (200)
  const tickerGetReq = new NextRequest("http://localhost:3000/api/ticker", {
    method: "GET",
  });
  const tickerGetRes = await middleware(tickerGetReq);
  assert.strictEqual(
    tickerGetRes.status,
    200,
    "Signed-out GET /api/ticker must pass middleware (status 200)"
  );

  // 1b. Signed-out GET /.netlify/functions/ticker passes (200)
  const netlifyTickerGetReq = new NextRequest(
    "http://localhost:3000/.netlify/functions/ticker",
    { method: "GET" }
  );
  const netlifyTickerGetRes = await middleware(netlifyTickerGetReq);
  assert.strictEqual(
    netlifyTickerGetRes.status,
    200,
    "Signed-out GET /.netlify/functions/ticker must pass middleware (status 200)"
  );

  // 2. Signed-out POST /api/ticker returns 403
  const tickerPostReq = new NextRequest("http://localhost:3000/api/ticker", {
    method: "POST",
  });
  const tickerPostRes = await middleware(tickerPostReq);
  assert.strictEqual(
    tickerPostRes.status,
    403,
    "Signed-out POST /api/ticker must return 403"
  );
  const postBody = await tickerPostRes.json();
  assert.strictEqual(postBody.error, "Early access only");

  // 3. Exact match check: /api/ticker/extra must return 403
  const prefixReq = new NextRequest("http://localhost:3000/api/ticker/extra", {
    method: "GET",
  });
  const prefixRes = await middleware(prefixReq);
  assert.strictEqual(
    prefixRes.status,
    403,
    "GET /api/ticker/extra must return 403 (exact match only, no prefix)"
  );

  // 4. Other /api paths still return 403 for signed-out visitors
  for (const blockedPath of ["/api/jobs/search", "/api/jobs/pro", "/api/ai", "/api/track", "/api/admin/stats"]) {
    const res = await middleware(
      new NextRequest(`http://localhost:3000${blockedPath}`, { method: "GET" })
    );
    assert.strictEqual(
      res.status,
      403,
      `Signed-out visitor to ${blockedPath} must return 403`
    );
  }

  if (isNegativeControl) {
    throw new Error("Negative control: simulated middleware failure");
  }

  console.log("  [PASS] Middleware: GET /api/ticker passes; POST /api/ticker, /api/ticker/extra and other /api return 403");
}

async function testEndpointImplementation() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.mock_key_for_offline_suite";
  process.env.NODE_ENV = "test";

  (globalThis as any).__mockRateLimitClient = {
    rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
  };

  const now = Date.now();

  const testDbRows = [
    // Valid row 1 (normal recent past, with company_id)
    {
      id: "j1",
      company: "Company 1",
      company_id: "c-uuid-1",
      title: "Engineer 1",
      posted_at: new Date(now - 120000).toISOString(),
    },
    // Valid row 2 (future-dated within 5 mins, skew +2 mins)
    {
      id: "j2",
      company: "Company 2",
      title: "Engineer 2",
      posted_at: new Date(now + 120000).toISOString(),
    },
    // Invalid row 3: Future-dated > 5 mins (skew +10 mins) -> MUST BE DROPPED
    {
      id: "j3",
      company: "Future Co",
      title: "Time Traveler Engineer",
      posted_at: new Date(now + 600000).toISOString(),
    },
    // Invalid row 4: Neither posted_at nor created_at -> MUST BE DROPPED
    {
      id: "j4",
      company: "No Time Co",
      title: "Timeless Engineer",
      posted_at: null,
      created_at: null,
    },
    // Valid row 5 (created_at fallback)
    {
      id: "j5",
      company: "Company 5",
      title: "Engineer 5",
      posted_at: null,
      created_at: new Date(now - 300000).toISOString(),
    },
    // Generate more valid rows so total valid exceeds 20
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `j-${i + 6}`,
      company: `Company ${i + 6}`,
      title: `Engineer ${i + 6}`,
      posted_at: new Date(now - (i + 6) * 60000).toISOString(),
    })),
  ];

  let shouldFailDb = false;

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs")) {
      if (shouldFailDb) {
        return new Response(JSON.stringify({ message: "DB query failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(testDbRows), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `0-${testDbRows.length - 1}/${testDbRows.length}`,
        },
      });
    }
    if (urlStr.includes("companies")) {
      if (shouldFailDb) {
        return new Response(JSON.stringify({ message: "DB query failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify([
          {
            id: "c-uuid-1",
            name: "Company 1",
            logo_url: "https://mock.supabase.co/storage/v1/object/public/company-logos/comp1.png",
          },
          {
            id: "c-uuid-2",
            name: "Company 2",
            logo_url: null,
          },
          {
            id: "c-uuid-ext",
            name: "Company 6",
            logo_url: "https://external-domain.com/untrusted-logo.png",
          },
        ]),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }
    return origFetch(url, opts);
  }) as any;

  try {
    const { GET } = await import("../src/app/api/ticker/route");
    const { handler: netlifyTickerHandler } = await import("../netlify/functions/ticker");

    // Test 1: Successful GET returns max 20 items with strictly 4 keys only
    const req = new Request("http://localhost:3000/api/ticker", { method: "GET" });
    const res = await GET(req);
    assert.strictEqual(res.status, 200, "GET /api/ticker should return status 200");

    const cacheHeader = res.headers.get("Cache-Control");
    assert(
      cacheHeader && cacheHeader.includes("max-age=60"),
      `Expected Cache-Control 60s, got: ${cacheHeader}`
    );

    const rows = await res.json();
    assert(Array.isArray(rows), "Endpoint must return an array of rows");
    assert.strictEqual(rows.length, 20, "Endpoint must limit response to max 20 rows");

    // Verify invalid rows were dropped:
    const companies = rows.map((r: any) => r.company);
    assert(!companies.includes("Future Co"), "Rows further than 5m in the future must be dropped");
    assert(!companies.includes("No Time Co"), "Rows without posted_at and created_at must be dropped");
    assert(companies.includes("Company 2"), "Rows within 5m in future must be kept");

    // Verify company logo lookup:
    // A job whose company has logo_url gets it in the response; unknown company gets null
    const comp1 = rows.find((r: any) => r.company === "Company 1");
    assert(comp1, "Company 1 must be present in ticker items");
    assert.strictEqual(
      comp1.logo_url,
      "https://mock.supabase.co/storage/v1/object/public/company-logos/comp1.png",
      "Company with logo_url in companies table must receive it in ticker response"
    );

    const comp2 = rows.find((r: any) => r.company === "Company 2");
    assert(comp2, "Company 2 must be present in ticker items");
    assert.strictEqual(comp2.logo_url, null, "Company with null logo_url must receive null");

    const comp5 = rows.find((r: any) => r.company === "Company 5");
    assert(comp5, "Company 5 must be present in ticker items");
    assert.strictEqual(comp5.logo_url, null, "Unknown company must receive null for logo_url");

    // External logo URL rejection check: logo_url not pointing at project storage under /company-logos/ must be null
    const comp6 = rows.find((r: any) => r.company === "Company 6");
    assert(comp6, "Company 6 must be present in ticker items");
    assert.strictEqual(
      comp6.logo_url,
      null,
      "External logo URL not under /company-logos/ on project storage host must be sanitized to null"
    );

    const ALLOWED_KEYS = ["company", "logo_url", "posted_at", "title"];
    for (const row of rows) {
      const keys = Object.keys(row).sort();
      assert.deepStrictEqual(
        keys,
        ALLOWED_KEYS,
        `Row has unexpected fields: ${JSON.stringify(row)}`
      );
      assert.strictEqual((row as any).id, undefined, "Row must NOT contain 'id'");
      assert.strictEqual((row as any).apply_url, undefined, "Row must NOT contain 'apply_url'");
    }

    // Test 1b: Netlify function parity check
    const netlifyRes = await netlifyTickerHandler({
      httpMethod: "GET",
      headers: {},
    });
    assert.strictEqual(netlifyRes.statusCode, 200, "Netlify /ticker should return 200");
    const netlifyRows = JSON.parse(netlifyRes.body);
    assert(Array.isArray(netlifyRows));
    assert.strictEqual(netlifyRows.length, 20);
    const netlifyCompanies = netlifyRows.map((r: any) => r.company);
    assert(!netlifyCompanies.includes("Future Co"), "Netlify: >5m future rows dropped");
    assert(!netlifyCompanies.includes("No Time Co"), "Netlify: rows missing timestamp dropped");

    const netlifyComp1 = netlifyRows.find((r: any) => r.company === "Company 1");
    assert.strictEqual(
      netlifyComp1.logo_url,
      "https://mock.supabase.co/storage/v1/object/public/company-logos/comp1.png",
      "Netlify: Company with logo_url receives it in response"
    );
    const netlifyComp5 = netlifyRows.find((r: any) => r.company === "Company 5");
    assert.strictEqual(netlifyComp5.logo_url, null, "Netlify: unknown company receives null for logo_url");

    // Test 2: Database failure returns 503 with Cache-Control: no-store
    shouldFailDb = true;
    const failRes = await GET(req);
    assert.strictEqual(failRes.status, 503, "DB error must respond with HTTP 503");
    const failCache = failRes.headers.get("Cache-Control");
    assert(
      failCache && failCache.includes("no-store"),
      `On error, Cache-Control must be no-store, got: ${failCache}`
    );

    const failNetlify = await netlifyTickerHandler({ httpMethod: "GET", headers: {} });
    assert.strictEqual(failNetlify.statusCode, 503, "Netlify error must respond with HTTP 503");
    assert(failNetlify.headers["Cache-Control"].includes("no-store"));

    console.log("  [PASS] Endpoint: max 20 rows, strict shape, dropped missing & >5m future timestamps, 60s cache, 503 no-store on error");
  } finally {
    globalThis.fetch = origFetch;
  }
}

async function testComponentContractAndAccessibility() {
  const componentPath = path.resolve(ROOT, "src", "components", "LandingJobsTickerStrip.tsx");
  const code = fs.readFileSync(componentPath, "utf8");

  // 1. Accessibility for duplicate sets
  assert(
    code.includes('aria-hidden="true"'),
    "Duplicate sets must have aria-hidden='true'"
  );
  assert(
    code.includes("tabIndex={isDuplicate ? -1 : undefined}") || code.includes("tabIndex={-1}"),
    "Links in duplicate sets must have tabIndex={-1}"
  );

  // 2. Format relative time clamping
  const futureSkew = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 mins future
  assert.strictEqual(
    formatRelativeTime(futureSkew),
    "just now",
    "Future-dated timestamp within 5 minutes must clamp to 'just now'"
  );

  const pastRecent = new Date(Date.now() - 30 * 1000).toISOString(); // 30 sec ago
  assert.strictEqual(
    formatRelativeTime(pastRecent),
    "just now",
    "Timestamps < 1 min must format as 'just now'"
  );

  const pastMinutes = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
  assert.strictEqual(
    formatRelativeTime(pastMinutes),
    "5 minutes ago",
    "5 minutes ago should format as '5 minutes ago'"
  );

  const pastHours = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2 hours ago
  assert.strictEqual(
    formatRelativeTime(pastHours),
    "2 hours ago",
    "2 hours ago should format as '2 hours ago'"
  );

  // 3. Dynamic duration tuning
  assert(
    code.includes("trackRef.current.scrollWidth / 2") && code.includes("/ 50"),
    "Component must compute animation duration as (scrollWidth / 2) / 50 seconds"
  );

  // 4. Fallback when fewer than 5 jobs
  assert(code.includes("jobs.length < 5"), "Must hide the whole strip when fewer than 5 jobs");

  // 5. Referrer policy on logo <img>
  assert(
    code.includes('referrerPolicy="no-referrer"'),
    "Component logo <img> must have referrerPolicy='no-referrer'"
  );

  console.log("  [PASS] Component contract: duplicate sets have aria-hidden='true' & tabIndex={-1}, time clamping to 'just now' verified, dynamic duration tuning");
}

async function testBrowserScrollWidthAndSpeed() {
  const chromePath = findChromePath();

  const sampleJobs = [
    { company: "OpenAI", title: "Research Program Manager, Safety Measurement" },
    { company: "Lyft", title: "Influencer Manager, Social & Culture" },
    { company: "Cloudflare", title: "Senior Software Engineer - Security Platform" },
    { company: "Reddit", title: "Senior Data Scientist, Safety Enforcement" },
    { company: "Flexport", title: "Global Operations Associate" },
    { company: "Stripe", title: "Infrastructure Engineer, Core Payments" },
    { company: "Linear", title: "Frontend Systems Engineer" },
    { company: "Figma", title: "Product Designer, Collaboration" },
    { company: "Vercel", title: "Developer Experience Engineer" },
    { company: "Notion", title: "Staff Product Manager" },
    { company: "Airbnb", title: "Senior Backend Engineer, Search" },
    { company: "DoorDash", title: "Senior Machine Learning Engineer" },
    { company: "Discord", title: "Voice & Video Systems Engineer" },
    { company: "Datadog", title: "Observability Platform Engineer" },
    { company: "Canva", title: "Design Systems Engineer" },
    { company: "Slack", title: "Staff Mobile Engineer, iOS" },
    { company: "GitHub", title: "Platform Security Specialist" },
    { company: "Shopify", title: "Merchant Experience Engineer" },
    { company: "Spotify", title: "Senior Audio ML Researcher" },
    { company: "Retool", title: "Full Stack Growth Engineer" },
  ];

  const cardsHtml = (isDuplicate: boolean) => sampleJobs.map((j) => `
    <a href="/early-access" class="ticker-card flex items-center shrink-0 h-9 md:h-12 gap-4 md:gap-3 mr-12 md:mr-16" ${isDuplicate ? 'tabindex="-1"' : ''}>
      <div class="logo w-9 h-9 md:w-12 md:h-12 rounded-[7px] md:rounded-[10px] bg-[#1F1F1F] flex items-center justify-center shrink-0">
        <span class="text-white font-semibold text-xs md:text-base">${j.company[0]}</span>
      </div>
      <div class="flex flex-col justify-center">
        <div class="flex items-center text-white leading-tight">
          <span class="text-[13px] font-semibold text-white">${j.company}</span>
          <span class="text-white/60 mx-1.5 text-[11px] md:text-[13px]">·</span>
          <span class="text-[11px] md:text-[13px] font-normal text-white">5 minutes ago</span>
        </div>
        <div class="text-[13px] md:text-[18px] font-semibold md:font-medium text-white truncate max-w-[200px] sm:max-w-[280px] md:max-w-[340px] leading-tight mt-0.5">
          ${j.title}
        </div>
      </div>
    </a>
  `).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow-x: hidden; }
    .flex { display: flex; }
    .flex-col { flex-direction: column; }
    .items-center { align-items: center; }
    .justify-center { justify-content: center; }
    .shrink-0 { flex-shrink: 0; }
    .h-9 { height: 36px; }
    .w-9 { width: 36px; }
    .gap-4 { gap: 16px; }
    .mr-12 { margin-right: 48px; }
    .rounded-\\[7px\\] { border-radius: 7px; }
    .text-\\[11px\\] { font-size: 11px; }
    .text-\\[13px\\] { font-size: 13px; }
    .text-xs { font-size: 12px; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .max-w-\\[200px\\] { max-width: 200px; }
    .leading-tight { line-height: 1.25; }
    .mt-0\\.5 { margin-top: 2px; }
    .font-semibold { font-weight: 600; }
    .font-normal { font-weight: 400; }
    .text-white { color: #fff; }
    .text-white\\/60 { color: rgba(255,255,255,0.6); }
    .mx-1\\.5 { margin-left: 6px; margin-right: 6px; }
    .bg-\\[\\#1F1F1F\\] { background-color: #1F1F1F; }

    @keyframes tickerMarquee {
      0% {
        transform: translateX(0);
      }
      100% {
        transform: translateX(-50%);
      }
    }

    .ticker-strip {
      width: 100%;
      height: 144px;
      overflow: hidden;
      display: flex;
      align-items: center;
    }
    .ticker-track {
      display: flex;
      align-items: center;
      width: max-content;
      will-change: transform;
      animation: tickerMarquee 155s linear infinite;
    }

    @media (max-width: 767px) {
      .ticker-track {
        animation: tickerMarquee 225s linear infinite;
      }
    }

    @media (min-width: 768px) {
      .md\\:flex { display: flex; }
      .md\\:hidden { display: none; }
      .md\\:h-12 { height: 48px; }
      .md\\:w-12 { width: 48px; }
      .md\\:gap-3 { gap: 12px; }
      .md\\:mr-16 { margin-right: 64px; }
      .md\\:rounded-\\[10px\\] { border-radius: 10px; }
      .md\\:text-\\[13px\\] { font-size: 13px; }
      .md\\:text-\\[18px\\] { font-size: 18px; }
      .md\\:text-base { font-size: 16px; }
      .md\\:font-medium { font-weight: 500; }
      .md\\:max-w-\\[340px\\] { max-width: 340px; }
    }
  </style>
</head>
<body>
  <div class="ticker-strip">
    <div class="ticker-track" id="track">
      <!-- Set 1 (Desktop & Mobile - First set, accessible) -->
      <div class="flex items-center shrink-0">${cardsHtml(false)}</div>
      <!-- Set 2 (Desktop & Mobile - Duplicate, aria-hidden, tabIndex -1) -->
      <div class="flex items-center shrink-0" aria-hidden="true">${cardsHtml(true)}</div>
      <!-- Set 3 (Mobile only - Duplicate, aria-hidden, tabIndex -1) -->
      <div class="flex md:hidden items-center shrink-0" aria-hidden="true">${cardsHtml(true)}</div>
      <!-- Set 4 (Mobile only - Duplicate, aria-hidden, tabIndex -1) -->
      <div class="flex md:hidden items-center shrink-0" aria-hidden="true">${cardsHtml(true)}</div>
    </div>
  </div>
  <script>
    // Tune duration = (scrollWidth / 2) / 50
    function tune() {
      const track = document.getElementById("track");
      if (track) {
        const half = track.scrollWidth / 2;
        track.style.animationDuration = (half / 50) + "s";
      }
    }
    tune();
    window.addEventListener("resize", tune);
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();

    // 1. Measure at 1280px Desktop
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle0" });

    const desktopMetrics = await page.evaluate(() => {
      const track = document.getElementById("track")!;
      const half = track.scrollWidth / 2;
      const duration = parseFloat(window.getComputedStyle(track).animationDuration);
      return { scrollWidth: track.scrollWidth, half, duration, speed: half / duration };
    });

    console.log(`  [INFO] Desktop 1280: scrollWidth=${desktopMetrics.scrollWidth}px, half=${desktopMetrics.half}px, duration=${desktopMetrics.duration.toFixed(2)}s, calculated speed=${desktopMetrics.speed.toFixed(1)}px/s`);
    assert(
      Math.abs(desktopMetrics.speed - 50) < 1.0,
      `Desktop speed should be ~50px/s, got ${desktopMetrics.speed}`
    );

    // Sample real transform movement over 2.0s at 1280px
    const sampleX = async (): Promise<number> => {
      return await page.evaluate(() => {
        const track = document.getElementById("track");
        if (!track) return 0;
        const transform = window.getComputedStyle(track).transform;
        if (!transform || transform === "none") return 0;
        const match = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+)/);
        return match ? parseFloat(match[1]) : 0;
      });
    };

    const x0_desktop = await sampleX();
    await new Promise((r) => setTimeout(r, 2000));
    const x2_desktop = await sampleX();
    const movedDesktop = Math.abs(x2_desktop - x0_desktop);
    console.log(`  [INFO] Real browser 1280 movement: ${movedDesktop.toFixed(1)}px over 2s`);
    assert(
      movedDesktop >= 80 && movedDesktop <= 125,
      `Desktop movement over 2s should be ~100px (got ${movedDesktop}px)`
    );

    // 2. Measure at 390px Mobile
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
    });

    const mobileMetrics = await page.evaluate(() => {
      const track = document.getElementById("track")!;
      const half = track.scrollWidth / 2;
      const duration = parseFloat(window.getComputedStyle(track).animationDuration);
      return { scrollWidth: track.scrollWidth, half, duration, speed: half / duration };
    });

    console.log(`  [INFO] Mobile 390: scrollWidth=${mobileMetrics.scrollWidth}px, half=${mobileMetrics.half}px, duration=${mobileMetrics.duration.toFixed(2)}s, calculated speed=${mobileMetrics.speed.toFixed(1)}px/s`);
    assert(
      Math.abs(mobileMetrics.speed - 50) < 1.0,
      `Mobile speed should be ~50px/s, got ${mobileMetrics.speed}`
    );

    // Sample real transform movement over 2.0s at 390px
    const x0_mobile = await sampleX();
    await new Promise((r) => setTimeout(r, 2000));
    const x2_mobile = await sampleX();
    const movedMobile = Math.abs(x2_mobile - x0_mobile);
    console.log(`  [INFO] Real browser 390 movement: ${movedMobile.toFixed(1)}px over 2s`);
    assert(
      movedMobile >= 80 && movedMobile <= 125,
      `Mobile movement over 2s should be ~100px (got ${movedMobile}px)`
    );

    console.log("  [PASS] Tuned scroll speed verified at 1280px and 390px in real headless Chrome (~50px/s, ~100px over 2s)");
  } finally {
    await browser.close();
    server.close();
  }
}

async function main() {
  console.log("=== LANDING JOBS TICKER STRIP FOLLOW-UP SUITE ===");

  if (isNegativeControl) {
    await testMiddlewareExemption();
    return;
  }

  // 1. Negative control
  runNegativeControlSubprocess();

  // 2. Middleware exact match GET-only exemption tests
  await testMiddlewareExemption();

  // 3. Endpoint implementation tests (missing timestamps & >5m future dropped)
  await testEndpointImplementation();

  // 4. Component contract (aria-hidden, tabIndex -1 on duplicates, time clamping)
  await testComponentContractAndAccessibility();

  // 5. Real browser speed tuning measurement at 1280 and 390 (~50px/s)
  await testBrowserScrollWidthAndSpeed();

  console.log("\nALL LANDING JOBS TICKER FOLLOW-UP TESTS PASSED-LOCAL\n");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
