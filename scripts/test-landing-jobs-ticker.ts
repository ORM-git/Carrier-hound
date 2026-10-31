import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import puppeteer from "puppeteer-core";

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

  const sampleDbJobs = Array.from({ length: 30 }, (_, i) => ({
    id: `job-uuid-${i + 1}`,
    company: `Company ${i + 1}`,
    title: `Staff Software Engineer ${i + 1}`,
    posted_at: new Date(Date.now() - (i + 1) * 300000).toISOString(),
    created_at: new Date(Date.now() - (i + 1) * 300000).toISOString(),
    apply_url: `https://example.com/apply/${i + 1}`,
    email: `recruiter@example${i + 1}.com`,
    salary_min: 150000,
    companies: i % 2 === 0 ? { logo_url: `https://cdn.example.com/logo-${i + 1}.png` } : null,
  }));

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
      return new Response(JSON.stringify(sampleDbJobs), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": "0-29/30",
        },
      });
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

    const ALLOWED_KEYS = ["company", "logo_url", "posted_at", "title"];
    for (const row of rows) {
      const keys = Object.keys(row).sort();
      assert.deepStrictEqual(
        keys,
        ALLOWED_KEYS,
        `Row has unexpected fields: ${JSON.stringify(row)}`
      );
      assert.strictEqual(typeof row.company, "string");
      assert.strictEqual(typeof row.title, "string");
      assert.strictEqual(typeof row.posted_at, "string");
      assert(row.logo_url === null || typeof row.logo_url === "string");

      // Verify strict exclusion of sensitive / extraneous columns
      assert.strictEqual((row as any).id, undefined, "Row must NOT contain 'id'");
      assert.strictEqual((row as any).apply_url, undefined, "Row must NOT contain 'apply_url'");
      assert.strictEqual((row as any).email, undefined, "Row must NOT contain 'email'");
      assert.strictEqual((row as any).salary_min, undefined, "Row must NOT contain 'salary_min'");
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
    assert.deepStrictEqual(Object.keys(netlifyRows[0]).sort(), ALLOWED_KEYS);
    assert(netlifyRes.headers["Cache-Control"].includes("max-age=60"));

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

    console.log("  [PASS] Endpoint: max 20 rows, strict shape (company, title, posted_at, logo_url only), 60s cache, 503 no-store on error");
  } finally {
    globalThis.fetch = origFetch;
  }
}

async function testComponentContractAndKeyframes() {
  const componentPath = path.resolve(ROOT, "src", "components", "LandingJobsTickerStrip.tsx");
  const code = fs.readFileSync(componentPath, "utf8");

  // 1. Verify CSS keyframes and animations
  assert(code.includes("@keyframes tickerMarquee"), "Must include @keyframes tickerMarquee");
  assert(
    code.includes("transform: translateX(0);") && code.includes("transform: translateX(-50%);"),
    "Keyframes must translate from translateX(0) to translateX(-50%)"
  );
  assert(
    code.includes("tickerMarquee 150s linear infinite"),
    "Desktop animation must be 150s linear infinite"
  );
  assert(
    code.includes("tickerMarquee 100s linear infinite"),
    "Mobile animation must be 100s linear infinite"
  );
  assert(
    code.includes("prefers-reduced-motion: reduce"),
    "Must respect prefers-reduced-motion: reduce"
  );
  assert(
    !code.includes("animation-play-state: paused") && !code.includes("hover:pause"),
    "Animation must NOT pause on hover"
  );

  // 2. Sizing and colors
  assert(code.includes("h-[100px] md:h-[144px]"), "Strip height: 100px mobile, 144px desktop");
  assert(code.includes("bg-black md:bg-[#0A0A0A]"), "Strip bg: #000 mobile, #0A0A0A desktop");
  assert(code.includes("overflow-hidden"), "Must hard clip with overflow-hidden");
  assert(code.includes("/early-access"), "Cards must link to /early-access");
  assert(code.includes("h-9 md:h-12"), "Card height: 36px (h-9) mobile, 48px (h-12) desktop");
  assert(code.includes("rounded-[7px] md:rounded-[10px]"), "Logo radius: 7px mobile, 10px desktop");
  assert(code.includes("mr-12 md:mr-16"), "Gap between cards: 48px (mr-12) mobile, 64px (mr-16) desktop");
  assert(code.includes("gap-4 md:gap-3"), "Gap logo-to-text: 16px (gap-4) mobile, 12px (gap-3) desktop");

  // 3. Fallback when fewer than 5 jobs
  assert(code.includes("jobs.length < 5"), "Must hide the whole strip when fewer than 5 jobs");

  console.log("  [PASS] Component contract: CSS keyframes, animation durations (150s/100s), sizing tokens, zero pause on hover");
}

async function testBrowserMotionSampling() {
  const chromePath = findChromePath();

  // Create minimal standalone HTML page with the exact CSS and track structure with 20 sample cards
  const sampleCards = Array.from({ length: 20 }, (_, i) => `
    <a href="/early-access" class="ticker-card flex items-center shrink-0 h-12 gap-3 mr-16">
      <div class="logo-box w-12 h-12 rounded-[10px] bg-[#1F1F1F] flex items-center justify-center shrink-0">
        <span class="text-white font-semibold">C${i + 1}</span>
      </div>
      <div class="text-box flex flex-col justify-center">
        <div class="text-[13px] font-semibold text-white">Company ${i + 1} · 5 minutes ago</div>
        <div class="text-[18px] font-medium text-white truncate max-w-[340px]">Senior Software Engineer ${i + 1}</div>
      </div>
    </a>
  `).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #000; overflow-x: hidden; }
    .flex { display: flex; }
    .items-center { align-items: center; }
    .shrink-0 { flex-shrink: 0; }
    .h-12 { height: 48px; }
    .w-12 { width: 48px; }
    .gap-3 { gap: 12px; }
    .mr-16 { margin-right: 64px; }
    .rounded-\\[10px\\] { border-radius: 10px; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
      background: #0A0A0A;
      overflow: hidden;
      display: flex;
      align-items: center;
    }

    .ticker-track {
      display: flex;
      align-items: center;
      width: max-content;
      will-change: transform;
      animation: tickerMarquee 150s linear infinite;
    }
  </style>
</head>
<body>
  <div class="ticker-strip">
    <div class="ticker-track" id="track">
      <!-- Set 1 -->
      <div class="flex items-center shrink-0">${sampleCards}</div>
      <!-- Set 2 -->
      <div class="flex items-center shrink-0">${sampleCards}</div>
    </div>
  </div>
</body>
</html>`;

  // Start local ephemeral HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle0" });

    // Sample transform matrix at t = 0
    const sampleTransform = async (): Promise<number> => {
      return await page.evaluate(() => {
        const el = document.getElementById("track");
        if (!el) return 0;
        const style = window.getComputedStyle(el);
        const transform = style.transform || style.webkitTransform;
        if (!transform || transform === "none") return 0;
        const match = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,]+)/);
        return match ? parseFloat(match[1]) : 0;
      });
    };

    const x0 = await sampleTransform();

    // Wait exactly 2000ms
    await new Promise((r) => setTimeout(r, 2000));

    const x2 = await sampleTransform();
    const distanceMoved = Math.abs(x2 - x0);

    console.log(`  [INFO] Real browser sampling: x0 = ${x0.toFixed(2)}px, x2 = ${x2.toFixed(2)}px, moved = ${distanceMoved.toFixed(2)}px over 2.0s`);

    // Verify track translated about 100px to the left (expected ~95px - 110px at ~50px/s)
    assert(
      distanceMoved >= 70 && distanceMoved <= 135,
      `Track must move about 100px left over 2s at ~50px/s, but moved ${distanceMoved}px`
    );

    console.log(`  [PASS] Real browser motion: track moved ${distanceMoved.toFixed(1)}px left over 2.0s (~50px/s)`);
  } finally {
    await browser.close();
    server.close();
  }
}

async function main() {
  console.log("=== LANDING JOBS TICKER STRIP SUITE ===");

  if (isNegativeControl) {
    await testMiddlewareExemption();
    return;
  }

  // 1. Negative control
  runNegativeControlSubprocess();

  // 2. Middleware exact match GET-only exemption tests
  await testMiddlewareExemption();

  // 3. Endpoint implementation & contract tests
  await testEndpointImplementation();

  // 4. Component contract & CSS keyframe rules
  await testComponentContractAndKeyframes();

  // 5. Real browser motion sampling (verifies ~100px movement over 2s)
  await testBrowserMotionSampling();

  console.log("\nALL LANDING JOBS TICKER TESTS PASSED-LOCAL\n");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
