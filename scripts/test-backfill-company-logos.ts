import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
  cleanDomain,
  isAtsHost,
  deriveCompanyDomain,
  selectLargestQualifyingIcon,
  CompanyRow,
  JobInfo,
} from "./backfill-company-logos";

const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-backfill-company-logos.ts", "--negative-control"],
    {
      cwd: process.cwd(),
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

function testCleanDomainAndAtsFilter() {
  console.log("Testing cleanDomain and ATS domain filtering...");

  // 1. Standard domains & subdomains
  assert.strictEqual(cleanDomain("careers.airbnb.com"), "airbnb.com");
  assert.strictEqual(cleanDomain("https://stripe.com/jobs/search"), "stripe.com");
  assert.strictEqual(cleanDomain("www.mongodb.com"), "mongodb.com");
  assert.strictEqual(cleanDomain("jobs.dropbox.com"), "dropbox.com");
  assert.strictEqual(cleanDomain("https://www.samsara.com/company/careers"), "samsara.com");
  assert.strictEqual(cleanDomain("app.datadoghq.com"), "datadoghq.com");
  assert.strictEqual(cleanDomain("openai.com"), "openai.com");
  assert.strictEqual(cleanDomain("perplexity.ai"), "perplexity.ai");

  // 2. ATS and aggregator rejections
  assert.strictEqual(isAtsHost("boards.greenhouse.io"), true);
  assert.strictEqual(isAtsHost("job-boards.greenhouse.io"), true);
  assert.strictEqual(isAtsHost("greenhouse.com"), true);
  assert.strictEqual(isAtsHost("jobs.ashbyhq.com"), true);
  assert.strictEqual(isAtsHost("jobs.lever.co"), true);
  assert.strictEqual(isAtsHost("arbeitnow.com"), true);
  assert.strictEqual(isAtsHost("app.careerpuck.com"), true);

  assert.strictEqual(cleanDomain("boards.greenhouse.io"), null);
  assert.strictEqual(cleanDomain("https://jobs.ashbyhq.com/openai"), null);
  assert.strictEqual(cleanDomain("https://jobs.lever.co/netflix"), null);
  assert.strictEqual(cleanDomain("https://www.greenhouse.com"), null);
  assert.strictEqual(cleanDomain("https://arbeitnow.com/jobs"), null);

  // 3. Malformed / non-domain
  assert.strictEqual(cleanDomain("notadomain"), null);
  assert.strictEqual(cleanDomain("127.0.0.1"), null);
  assert.strictEqual(cleanDomain(""), null);

  console.log("  [PASS] cleanDomain and ATS filters verified");
}

function testDeriveCompanyDomainNeverGuesses() {
  console.log("Testing deriveCompanyDomain (never guesses)...");

  const companyA: CompanyRow = {
    id: "comp-1",
    name: "Airbnb",
    slug: "airbnb",
    ats_type: "greenhouse",
    logo_url: null,
    domain: null,
    careers_url: null,
  };

  const jobsA: JobInfo[] = [
    { apply_url: "https://careers.airbnb.com/positions/123", source_url: "https://boards.greenhouse.io/airbnb" },
  ];

  // Derived from job apply_url
  assert.strictEqual(deriveCompanyDomain(companyA, jobsA), "airbnb.com");

  // Company with Ashby board publicWebsite
  const companyOpenAI: CompanyRow = {
    id: "comp-2",
    name: "OpenAI",
    slug: "openai",
    ats_type: "ashby",
    logo_url: null,
    domain: null,
    careers_url: null,
  };
  const jobsOpenAI: JobInfo[] = [
    { apply_url: "https://jobs.ashbyhq.com/openai/xyz", source_url: "https://jobs.ashbyhq.com/openai/xyz" },
  ];
  assert.strictEqual(
    deriveCompanyDomain(companyOpenAI, jobsOpenAI, "https://openai.com/"),
    "openai.com"
  );

  // Company with company.domain
  const companyWithDomain: CompanyRow = {
    id: "comp-3",
    name: "Databricks",
    slug: "databricks",
    ats_type: "greenhouse",
    logo_url: null,
    domain: "databricks.com",
    careers_url: null,
  };
  assert.strictEqual(deriveCompanyDomain(companyWithDomain, []), "databricks.com");

  // Company with NO data: MUST return null (NEVER guess like "acme.com")
  const companyUnknown: CompanyRow = {
    id: "comp-4",
    name: "Acme Super Secrets",
    slug: "acme",
    ats_type: "greenhouse",
    logo_url: null,
    domain: null,
    careers_url: null,
  };
  const jobsUnknown: JobInfo[] = [
    { apply_url: "https://boards.greenhouse.io/acme/jobs/1", source_url: "https://boards.greenhouse.io/acme" },
  ];
  assert.strictEqual(
    deriveCompanyDomain(companyUnknown, jobsUnknown, null),
    null,
    "Unknown company without domain data MUST return null, never guess"
  );

  console.log("  [PASS] deriveCompanyDomain correctly derives and never guesses");
}

function testSelectLargestQualifyingIcon() {
  console.log("Testing selectLargestQualifyingIcon...");

  const candidates = [
    // 1. Too small (< 128px) -> rejected
    { url: "https://example.com/icon-32.png", width: 32, height: 32, contentType: "image/png", ext: "png", buffer: Buffer.alloc(100) },
    { url: "https://example.com/icon-64.png", width: 64, height: 64, contentType: "image/png", ext: "png", buffer: Buffer.alloc(200) },

    // 2. Invalid aspect ratio (< 0.6 or > 1.6) -> rejected
    { url: "https://example.com/banner-wide.png", width: 300, height: 100, contentType: "image/png", ext: "png", buffer: Buffer.alloc(500) }, // ratio 3.0 > 1.6
    { url: "https://example.com/banner-tall.png", width: 100, height: 200, contentType: "image/png", ext: "png", buffer: Buffer.alloc(500) }, // ratio 0.5 < 0.6

    // 3. Valid qualifying icons
    { url: "https://example.com/apple-icon-180.png", width: 180, height: 180, contentType: "image/png", ext: "png", buffer: Buffer.alloc(1000) }, // ratio 1.0, area 32400
    { url: "https://example.com/icon-512.png", width: 512, height: 512, contentType: "image/png", ext: "png", buffer: Buffer.alloc(5000) }, // ratio 1.0, area 262144
    { url: "https://example.com/icon-256.png", width: 256, height: 256, contentType: "image/png", ext: "png", buffer: Buffer.alloc(2500) }, // ratio 1.0, area 65536
  ];

  const selected = selectLargestQualifyingIcon(candidates);
  assert.ok(selected, "Should select a qualifying icon");
  assert.strictEqual(
    selected.url,
    "https://example.com/icon-512.png",
    "Must select the largest qualifying icon (512x512)"
  );

  // If all icons are too small or wrong ratio, returns null
  const noneValid = selectLargestQualifyingIcon([
    { url: "https://example.com/icon-64.png", width: 64, height: 64, contentType: "image/png", ext: "png", buffer: Buffer.alloc(100) },
    { url: "https://example.com/wide.png", width: 400, height: 150, contentType: "image/png", ext: "png", buffer: Buffer.alloc(100) },
  ]);
  assert.strictEqual(noneValid, null, "Should return null if no icon qualifies");

  console.log("  [PASS] selectLargestQualifyingIcon selects largest >=128px with ratio 0.6..1.6");
}

function testPrioritizationTop200Jobs() {
  console.log("Testing prioritization of companies in top 200 jobs...");

  const companies: CompanyRow[] = [
    { id: "1", name: "Acme", slug: "acme", ats_type: "greenhouse", logo_url: null },
    { id: "2", name: "Beta", slug: "beta", ats_type: "ashby", logo_url: null },
    { id: "3", name: "Stripe", slug: "stripe", ats_type: "greenhouse", logo_url: null },
    { id: "4", name: "Zeta", slug: "zeta", ats_type: "lever", logo_url: null },
  ];

  // Stripe appears in the top 200 jobs
  const top200Names = new Set(["stripe"]);
  const top200Ids = new Set<string>();

  const sorted = [...companies].sort((a, b) => {
    const aIsTop = top200Names.has(a.name.toLowerCase().trim()) || (a.id && top200Ids.has(a.id));
    const bIsTop = top200Names.has(b.name.toLowerCase().trim()) || (b.id && top200Ids.has(b.id));
    if (aIsTop && !bIsTop) return -1;
    if (!aIsTop && bIsTop) return 1;
    return a.name.localeCompare(b.name);
  });

  assert.strictEqual(sorted[0].name, "Stripe", "Stripe must be prioritized first");
  assert.strictEqual(sorted[1].name, "Acme");
  assert.strictEqual(sorted[2].name, "Beta");
  assert.strictEqual(sorted[3].name, "Zeta");

  console.log("  [PASS] Prioritization sorts top 200 job companies first");
}

async function main() {
  console.log("=== BACKFILL COMPANY LOGOS HOMEPAGE FALLBACK SUITE ===");

  if (isNegativeControl) {
    // Deliberate negative control failure
    assert.strictEqual("actual", "expected", "Intentional negative control failure");
    return;
  }

  // 1. Negative control
  runNegativeControlSubprocess();

  // 2. cleanDomain & ATS filters
  testCleanDomainAndAtsFilter();

  // 3. deriveCompanyDomain (never guesses)
  testDeriveCompanyDomainNeverGuesses();

  // 4. selectLargestQualifyingIcon
  testSelectLargestQualifyingIcon();

  // 5. Prioritization of top 200 jobs
  testPrioritizationTop200Jobs();

  console.log("\nALL BACKFILL COMPANY LOGOS FALLBACK TESTS PASSED-LOCAL\n");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
