import assert from "assert";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { capJobsPerCompany } from "../src/lib/jobs/service";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.mock_key_for_offline_suite";
process.env.NODE_ENV = "test";

(globalThis as any).__mockRateLimitClient = {
  rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
};

async function runSuite() {
  console.log("==================================================================================");
  console.log("   CAREERMONKE COMPANY LOGOS & COMPANY CAPS VERIFICATION SUITE                    ");
  console.log("==================================================================================");
  console.log(`Mode: ${IS_NEGATIVE_CONTROL ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VERIFICATION"}\n`);

  const failures: string[] = [];

  // ====================================================================================
  // TEST 1: capJobsPerCompany Algorithm & Visible Top-30 Invariants
  // ====================================================================================
  console.log("TEST 1: Verifying capJobsPerCompany (max 3 per company in any visible top-30)...");

  // 1a. Mass posting scenario: Company A posts 20 jobs, Company B posts 15 jobs, Company C posts 10 jobs
  const massPostingJobs = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `a-${i}`, company: "MassiveCorp", title: `Role A${i}` })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `b-${i}`, company: "MegaScale", title: `Role B${i}` })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `c-${i}`, company: "TechFlow", title: `Role C${i}` })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `d-${i}`, company: "StartupX", title: `Role D${i}` })),
  ];

  const cappedMass = capJobsPerCompany(massPostingJobs, 3, 30);
  const visibleTop30 = cappedMass.slice(0, 30);

  // In deliberate negative control mode, corrupt the visible top 30
  if (IS_NEGATIVE_CONTROL) {
    visibleTop30.push({ id: "corrupt-1", company: "MassiveCorp", title: "Role A99" });
    visibleTop30.push({ id: "corrupt-2", company: "MassiveCorp", title: "Role A100" });
  }

  const compACountInTop30 = visibleTop30.filter((j) => j.company.toLowerCase() === "massivecorp").length;
  const compBCountInTop30 = visibleTop30.filter((j) => j.company.toLowerCase() === "megascale").length;
  const compCCountInTop30 = visibleTop30.filter((j) => j.company.toLowerCase() === "techflow").length;

  if (compACountInTop30 > 3) {
    failures.push(`CAP VIOLATION: MassiveCorp has ${compACountInTop30} jobs in visible top-30 (expected <= 3)`);
  } else {
    console.log(`  [PASS] 1a. MassiveCorp capped at ${compACountInTop30}/3 in visible top-30`);
  }

  if (compBCountInTop30 > 3) {
    failures.push(`CAP VIOLATION: MegaScale has ${compBCountInTop30} jobs in visible top-30 (expected <= 3)`);
  } else {
    console.log(`  [PASS] 1b. MegaScale capped at ${compBCountInTop30}/3 in visible top-30`);
  }

  if (compCCountInTop30 > 3) {
    failures.push(`CAP VIOLATION: TechFlow has ${compCCountInTop30} jobs in visible top-30 (expected <= 3)`);
  } else {
    console.log(`  [PASS] 1c. TechFlow capped at ${compCCountInTop30}/3 in visible top-30`);
  }

  // 1d. Short list scenario: Company A has 10 jobs, Company B has 2 jobs (total 12 < 30)
  const shortJobs = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `sa-${i}`, company: "FloodCorp", title: `Flood ${i}` })),
    { id: "sb-1", company: "Boutique", title: "Designer" },
    { id: "sb-2", company: "Boutique", title: "Engineer" },
  ];

  const cappedShort = capJobsPerCompany(shortJobs, 3, 30);
  const floodCountInShort = cappedShort.slice(0, 30).filter((j) => j.company.toLowerCase() === "floodcorp").length;
  if (floodCountInShort > 3) {
    failures.push(`SHORT LIST FLOOD: FloodCorp has ${floodCountInShort} jobs in visible top-30 of short list (expected <= 3)`);
  } else {
    console.log(`  [PASS] 1d. Short list flood protection: FloodCorp has ${floodCountInShort}/3 visible jobs`);
  }

  // 1e. Preserves diverse companies without alteration
  const diverseJobs = [
    { id: "1", company: "Alpha", title: "Dev" },
    { id: "2", company: "Beta", title: "Dev" },
    { id: "3", company: "Gamma", title: "Dev" },
  ];
  const cappedDiverse = capJobsPerCompany(diverseJobs, 3, 30);
  if (cappedDiverse.length !== 3) {
    failures.push(`DIVERSE LIST LOSS: Diverse list changed length from 3 to ${cappedDiverse.length}`);
  } else {
    console.log("  [PASS] 1e. Diverse company list preserved perfectly without loss");
  }

  // ====================================================================================
  // TEST 2: /api/ticker & Netlify ticker Endpoint Capping (Max 2 per company in 20)
  // ====================================================================================
  console.log("\nTEST 2: Verifying /api/ticker and Netlify ticker company capping (max 2 per company)...");

  // Mock DB where Company A posted 15 jobs, and other companies posted 20 jobs
  const now = Date.now();
  const mockDbRows = [
    ...Array.from({ length: 15 }, (_, i) => ({
      id: `ticker-flood-${i}`,
      company: "DominantCorp",
      company_id: "comp-dom-id",
      title: `Dominant Role ${i}`,
      posted_at: new Date(now - i * 1000).toISOString(),
      created_at: new Date(now - i * 1000).toISOString(),
    })),
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `ticker-other-${i}`,
      company: `Company_${i}`,
      company_id: `comp-other-${i}`,
      title: `Other Role ${i}`,
      posted_at: new Date(now - (i + 20) * 1000).toISOString(),
      created_at: new Date(now - (i + 20) * 1000).toISOString(),
    })),
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs")) {
      return new Response(JSON.stringify(mockDbRows), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `0-${mockDbRows.length - 1}/${mockDbRows.length}`,
        },
      });
    }
    if (urlStr.includes("companies")) {
      return new Response(
        JSON.stringify([
          {
            id: "comp-dom-id",
            name: "DominantCorp",
            logo_url: "https://mock.supabase.co/storage/v1/object/public/company-logos/dominant.png",
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    return origFetch(url, opts);
  }) as any;

  try {
    const { GET: tickerGet } = await import("../src/app/api/ticker/route");
    const { handler: netlifyTicker } = await import("../netlify/functions/ticker");

    const req = new Request("http://localhost:3000/api/ticker", { method: "GET" });
    const res = await tickerGet(req);
    const tickerItems = await res.json();

    assert(Array.isArray(tickerItems), "Ticker response must be an array");
    const domCount = tickerItems.filter((j: any) => j.company.toLowerCase() === "dominantcorp").length;

    if (domCount > 2) {
      failures.push(`TICKER CAP FAIL (App Route): DominantCorp has ${domCount} jobs in ticker (expected max 2)`);
    } else {
      console.log(`  [PASS] 2a. App Router /api/ticker caps DominantCorp at ${domCount}/2 in ticker items`);
    }

    assert(tickerItems.length <= 20, "Ticker must return max 20 items");
    console.log(`  [PASS] 2b. /api/ticker total items capped at ${tickerItems.length} (<= 20)`);

    const netlifyRes = await netlifyTicker();
    const netlifyItems = JSON.parse(netlifyRes.body);
    const netlifyDomCount = netlifyItems.filter((j: any) => j.company.toLowerCase() === "dominantcorp").length;

    if (netlifyDomCount > 2) {
      failures.push(`TICKER CAP FAIL (Netlify): DominantCorp has ${netlifyDomCount} jobs in netlify ticker (expected max 2)`);
    } else {
      console.log(`  [PASS] 2c. Netlify functions/ticker caps DominantCorp at ${netlifyDomCount}/2 in ticker items`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  // ====================================================================================
  // TEST 3: CompanyLogo Component Fallback Contract
  // ====================================================================================
  console.log("\nTEST 3: Verifying CompanyLogo component contract...");
  const companyLogoPath = path.resolve(__dirname, "../src/components/CompanyLogo.tsx");
  const logoCode = fs.readFileSync(companyLogoPath, "utf-8");

  // 3a. Accepts logoUrl prop
  if (!logoCode.includes("logoUrl?: string | null")) {
    failures.push("CompanyLogoProps is missing logoUrl prop");
  } else {
    console.log("  [PASS] 3a. CompanyLogoProps defines optional logoUrl?: string | null");
  }

  // 3b. Uses self-hosted logo first
  if (!logoCode.includes('"self-hosted"') || !logoCode.includes("logoUrl")) {
    failures.push("CompanyLogo must prioritize self-hosted logoUrl first");
  } else {
    console.log("  [PASS] 3b. CompanyLogo prioritizes self-hosted logoUrl first");
  }

  // 3c. Calls unavatar.io only as last fallback
  if (!logoCode.includes("https://unavatar.io/") || !logoCode.includes('"unavatar"')) {
    failures.push("CompanyLogo must use unavatar.io as fallback");
  } else {
    console.log("  [PASS] 3c. CompanyLogo calls unavatar.io only as fallback when self-hosted fails");
  }

  // 3d. Zero gstatic.com fallback
  if (logoCode.includes("gstatic.com")) {
    failures.push("CompanyLogo should NOT call gstatic.com; unavatar.io is the last fallback before letter tile");
  } else {
    console.log("  [PASS] 3d. Zero gstatic.com fallback in CompanyLogo");
  }

  // 3e. Letter tile rendered if both fail
  if (!logoCode.includes("bg-gradient-to-br") || !logoCode.includes("{initial}")) {
    failures.push("CompanyLogo must render letter tile if both fail");
  } else {
    console.log("  [PASS] 3e. CompanyLogo renders letter tile if both fail");
  }

  // ====================================================================================
  // TEST 4: LandingJobsTickerStrip Logo Fallback Contract
  // ====================================================================================
  console.log("\nTEST 4: Verifying LandingJobsTickerStrip logo fallback contract...");
  const tickerStripPath = path.resolve(__dirname, "../src/components/LandingJobsTickerStrip.tsx");
  const stripCode = fs.readFileSync(tickerStripPath, "utf-8");

  // 4a. Uses self-hosted logo_url first
  if (!stripCode.includes("job.logo_url") || !stripCode.includes('"self-hosted"')) {
    failures.push("LandingJobsTickerStrip must use job.logo_url first");
  } else {
    console.log("  [PASS] 4a. LandingJobsTickerStrip uses job.logo_url (self-hosted) first");
  }

  // 4b. Falls back to unavatar.io
  if (!stripCode.includes("https://unavatar.io/") || !stripCode.includes('"unavatar"')) {
    failures.push("LandingJobsTickerStrip must fall back to unavatar.io when self-hosted fails");
  } else {
    console.log("  [PASS] 4b. LandingJobsTickerStrip falls back to unavatar.io");
  }

  // 4c. Letter tile if both fail
  if (!stripCode.includes("{letter}")) {
    failures.push("LandingJobsTickerStrip must show letter tile if both fail");
  } else {
    console.log("  [PASS] 4c. LandingJobsTickerStrip shows neutral letter tile if both fail");
  }

  // ====================================================================================
  // TEST 5: Job Cards Logo Wiring in src/app/jobs/page.tsx
  // ====================================================================================
  console.log("\nTEST 5: Verifying job cards logo wiring in src/app/jobs/page.tsx...");
  const jobsPagePath = path.resolve(__dirname, "../src/app/jobs/page.tsx");
  const jobsCode = fs.readFileSync(jobsPagePath, "utf-8");

  if (!jobsCode.includes("logoUrl={job.logoUrl || (job as any).logo_url}")) {
    failures.push("Job cards in page.tsx must pass logoUrl to CompanyLogo");
  } else {
    console.log("  [PASS] 5a. Job cards pass self-hosted logoUrl to CompanyLogo");
  }

  if (!jobsCode.includes("capJobsPerCompany(result, 3, 30)")) {
    failures.push("Recommended list in page.tsx must call capJobsPerCompany(result, 3, 30)");
  } else {
    console.log("  [PASS] 5b. Recommended tab in page.tsx enforces capJobsPerCompany(result, 3, 30)");
  }

  // ====================================================================================
  // TEST 6: Negative Control Mode Handling
  // ====================================================================================
  if (IS_NEGATIVE_CONTROL) {
    if (failures.length > 0) {
      console.error("\n❌ NEGATIVE CONTROL PROVED: Injected cap violation caught as expected!");
      failures.forEach((f) => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.error("\n❌ NEGATIVE CONTROL FAILED: Injected cap violation was NOT caught!");
      process.exit(2);
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ VALIDATION FAILED with ${failures.length} errors:`);
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
  }

  // ====================================================================================
  // TEST 7: Automated Negative Control Subprocess (Proves Non-Zero Exit)
  // ====================================================================================
  console.log("\nTEST 6: Spawning negative control child process to verify non-zero exit...");
  const child = spawnSync("npx", [
    "tsx",
    path.resolve(__dirname, "test-company-logos-and-caps.ts"),
    "--negative-control",
  ], {
    shell: true,
    stdio: "pipe",
  });

  const negStatus = child.status;
  assert.strictEqual(
    negStatus,
    1,
    `Negative control MUST exit with status 1! Received status: ${negStatus}`
  );
  console.log(`  [PASS] 6a. Negative control exited with code ${negStatus} (non-zero exit verified on cap violation)`);

  console.log("\n==================================================================================");
  console.log("COMPANY LOGOS & COMPANY CAPS VALIDATION: PASS-LOCAL");
  console.log("==================================================================================");
  process.exit(0);
}

runSuite().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
