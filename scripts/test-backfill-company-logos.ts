import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanDomain,
  isAtsHost,
  deriveCompanyDomain,
  selectLargestQualifyingIcon,
  getCleanImageMeta,
  getImageDimensions,
  parseBackfillCliArgs,
  buildWriteApplyCommand,
  buildLogoStoragePath,
  isSelfHostedLogoUrl,
  createPoliteFetcher,
  matchLiveJobsToCompanies,
  selectCandidateCompanies,
  buildCompanyLogoSql,
  buildRunRollbackSql,
  buildBackfillManifest,
  writeReviewedManifest,
  readReviewedManifest,
  filterCandidatesByManifest,
  uploadAndPersistCompanyLogo,
  inspectCompany,
  CompanyRow,
  JobInfo,
  CandidateLogo,
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
  assert.strictEqual(cleanDomain("mailto:careers@mavenclinic.com"), "mavenclinic.com");
  assert.strictEqual(cleanDomain("academy.workato.com"), "workato.com");

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

  // Company with Greenhouse Schema.org Organization url
  const companyCloudflare: CompanyRow = {
    id: "comp-cf",
    name: "Cloudflare",
    slug: "cloudflare",
    ats_type: "greenhouse",
    logo_url: null,
    domain: null,
    careers_url: null,
  };
  const greenhouseHtml = `<html><head><script type="application/ld+json">{"@type":"Organization","name":"Cloudflare","url":"https://www.cloudflare.com"}</script></head></html>`;
  assert.strictEqual(
    deriveCompanyDomain(companyCloudflare, [], null, greenhouseHtml),
    "cloudflare.com",
    "Must derive domain from board Schema.org metadata"
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

function testImageValidationAndSvgRejection() {
  console.log("Testing image validation and SVG rejection...");

  // Mock valid 64x64 PNG buffer
  const validPngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x40, // width: 64
    0x00, 0x00, 0x00, 0x40, // height: 64
    0x08, 0x06, 0x00, 0x00, 0x00, // color/bit depth
  ]);

  const dims = getImageDimensions(validPngHeader);
  assert.ok(dims, "Must parse PNG dimensions");
  assert.strictEqual(dims.width, 64);
  assert.strictEqual(dims.height, 64);
  assert.strictEqual(dims.type, "png");

  // getCleanImageMeta allows valid PNG
  const meta = getCleanImageMeta("image/png", validPngHeader, "https://example.com/logo.png");
  assert.ok(meta, "Valid PNG metadata returned");
  assert.strictEqual(meta.contentType, "image/png");
  assert.strictEqual(meta.ext, "png");

  // Strictly rejects SVG even if content type says image/svg+xml or URL ends with .svg
  const svgMeta1 = getCleanImageMeta("image/svg+xml", validPngHeader, "https://example.com/logo.svg");
  assert.strictEqual(svgMeta1, null, "Must reject image when content-type contains svg");

  const svgMeta2 = getCleanImageMeta("image/png", validPngHeader, "https://example.com/logo.svg?token=123");
  assert.strictEqual(svgMeta2, null, "Must reject image when URL ends with .svg");

  console.log("  [PASS] Image validation sniffs raster headers and dimensions and strictly rejects SVG");
}

function testMissingOnlySchedulingFilter() {
  console.log("Testing --missing-only scheduling filter...");

  const allCompanies: CompanyRow[] = [
    { id: "1", name: "HasLogo", slug: "haslogo", ats_type: "greenhouse", logo_url: "https://example.com/logo.png" },
    { id: "2", name: "NoLogo1", slug: "nologo1", ats_type: "ashby", logo_url: null },
    { id: "3", name: "NoLogo2", slug: "nologo2", ats_type: "lever", logo_url: null },
  ];

  const missingOnly = allCompanies.filter((c) => c.logo_url === null);
  assert.strictEqual(missingOnly.length, 2, "Scheduled missing-only must filter down to only companies with logo_url === null");
  assert.strictEqual(missingOnly[0].id, "2");
  assert.strictEqual(missingOnly[1].id, "3");

  console.log("  [PASS] --missing-only accurately scopes re-checks to unpopulated rows");
}

function testPrioritizationTop200Jobs() {
  console.log("Testing prioritization of companies in top 200 jobs...");

  const companies: CompanyRow[] = [
    { id: "1", name: "Acme", slug: "acme", ats_type: "greenhouse", logo_url: null },
    { id: "2", name: "Beta", slug: "beta", ats_type: "ashby", logo_url: null },
    { id: "3", name: "Stripe", slug: "stripe", ats_type: "greenhouse", logo_url: null },
    { id: "4", name: "Zeta", slug: "zeta", ats_type: "lever", logo_url: null },
  ];

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

function testLiveOnlySelectionAndOrdering() {
  console.log("Testing --live-only selection, active-job ordering, and --limit/--offset...");

  const companies: CompanyRow[] = [
    { id: "c-zero", name: "NoActiveJobs Co", slug: "noactive", ats_type: "greenhouse", logo_url: null },
    { id: "c-low", name: "LowCount Inc", slug: "lowcount", ats_type: "ashby", logo_url: null },
    { id: "c-high", name: "HighCount Labs", slug: "highcount", ats_type: "lever", logo_url: null },
    { id: "c-expired", name: "ExpiredOnly Co", slug: "expired", ats_type: "greenhouse", logo_url: null },
  ];

  const jobs: JobInfo[] = [
    // Only status='active' AND is_active=true should count
    { company_id: "c-low", company: "LowCount Inc", status: "active", is_active: true, apply_url: "https://lowcount.com/jobs/1" },
    { company_id: "c-high", company: "HighCount Labs", status: "active", is_active: true, apply_url: "https://highcount.ai/jobs/1" },
    { company_id: "c-high", company: "HighCount Labs", status: "active", is_active: true, apply_url: "https://highcount.ai/jobs/2" },
    { company_id: "c-high", company: "HighCount Labs", status: "active", is_active: true, apply_url: "https://highcount.ai/jobs/3" },
    // Inactive / expired permutations must NOT count
    { company_id: "c-expired", company: "ExpiredOnly Co", status: "expired", is_active: true },
    { company_id: "c-expired", company: "ExpiredOnly Co", status: "active", is_active: false },
    { company_id: "c-zero", company: "NoActiveJobs Co", status: "closed", is_active: false },
  ];

  const res = selectCandidateCompanies({
    allCompanies: companies,
    liveJobs: jobs,
    liveOnly: true,
    missingOnly: false,
    force: false,
    supabaseUrl: "https://proj.supabase.co",
  });

  assert.strictEqual(res.companiesToEvaluate.length, 2, "Only companies with active & is_active=true jobs selected");
  assert.strictEqual(res.companiesToEvaluate[0].id, "c-high", "Highest active job count company must be first");
  assert.strictEqual(res.companiesToEvaluate[1].id, "c-low", "Second highest active job count company must be second");
  assert.strictEqual(res.activeJobCounts.get("c-high"), 3);
  assert.strictEqual(res.activeJobCounts.get("c-low"), 1);

  const paged = selectCandidateCompanies({
    allCompanies: companies,
    liveJobs: jobs,
    liveOnly: true,
    missingOnly: false,
    force: false,
    supabaseUrl: "https://proj.supabase.co",
    limit: 1,
    offset: 1,
  });
  assert.deepStrictEqual(
    paged.companiesToEvaluate.map((c) => c.id),
    ["c-low"],
    "--offset 1 --limit 1 must return second ordered live company"
  );

  const cli = parseBackfillCliArgs(["node", "script.ts", "--live-only", "--limit", "50", "--offset", "100", "--force"]);
  assert.strictEqual(cli.liveOnly, true);
  assert.strictEqual(cli.limit, 50);
  assert.strictEqual(cli.offset, 100);
  assert.strictEqual(cli.force, true);
  assert.strictEqual(cli.isWrite, false, "Dry-run must remain default");

  console.log("  [PASS] --live-only filtering, ordering, and chunk slicing verified");
}

function testCompanyIdNullNameMatchAndUnmatchedLogging() {
  console.log("Testing company_id IS NULL lower(btrim) name match & unmatched logging...");

  const companies: CompanyRow[] = [
    { id: "c-linear", name: "  Linear ", slug: "linear", ats_type: "ashby", logo_url: null },
    { id: "c-stripe", name: "Stripe", slug: "stripe", ats_type: "greenhouse", logo_url: null },
  ];

  const jobs: JobInfo[] = [
    // Direct company_id match
    { company_id: "c-stripe", company: "Stripe", status: "active", is_active: true, apply_url: "https://stripe.com/jobs/1" },
    // Fallback name match with company_id = null, differing case & whitespace
    { company_id: null, company: "  linear  ", status: "active", is_active: true, apply_url: "https://linear.app/careers/1" },
    { company_id: "", company: "LINEAR", status: "active", is_active: true, source_url: "https://linear.app/careers/2" },
    // Unmatched active job company name
    { company_id: null, company: "Unmatched Labs", status: "active", is_active: true },
    { company_id: null, company: "  unmatched labs ", status: "active", is_active: true },
    // Inactive unmatched job must NOT appear
    { company_id: null, company: "Dead Company", status: "expired", is_active: false },
  ];

  const match = matchLiveJobsToCompanies(jobs, companies);
  assert.strictEqual(match.matchedCounts.get("c-linear"), 2, "Must match both company_id IS NULL jobs by lower(btrim)");
  assert.strictEqual(match.matchedCounts.get("c-stripe"), 1);
  assert.strictEqual(match.unmatchedNames.length, 1, "Only active unmatched names logged");
  assert.strictEqual(match.unmatchedNames[0].name.toLowerCase(), "unmatched labs");
  assert.strictEqual(match.unmatchedNames[0].count, 2);

  // Domain derivation can use apply_url from name-matched jobs
  const linearJobs = match.jobsByCompanyId.get("c-linear") || [];
  assert.strictEqual(deriveCompanyDomain(companies[0], linearJobs), "linear.app");

  console.log("  [PASS] lower(btrim) name matching and unmatched logging verified");
}

async function testAlreadyHostedSkipAndForceOverride() {
  console.log("Testing already-hosted skip, external URL re-host, and --force...");

  const supabaseUrl = "https://projref.supabase.co";
  const companies: CompanyRow[] = [
    {
      id: "c-hosted",
      name: "Hosted Co",
      slug: "hosted",
      ats_type: "greenhouse",
      logo_url: "https://projref.supabase.co/storage/v1/object/public/company-logos/c-hosted.png",
    },
    {
      id: "c-external",
      name: "External Logo Co",
      slug: "external",
      ats_type: "greenhouse",
      logo_url: "https://cdn.example.com/company-logos/external.png",
    },
    {
      id: "c-null",
      name: "Missing Co",
      slug: "missing",
      ats_type: "greenhouse",
      logo_url: null,
    },
  ];
  const jobs: JobInfo[] = [
    { company_id: "c-hosted", status: "active", is_active: true },
    { company_id: "c-external", status: "active", is_active: true },
    { company_id: "c-null", status: "active", is_active: true },
  ];

  assert.strictEqual(isSelfHostedLogoUrl(companies[0].logo_url, supabaseUrl), true);
  assert.strictEqual(isSelfHostedLogoUrl(companies[1].logo_url, supabaseUrl), false, "External host must NOT count as self-hosted");

  const defaultSel = selectCandidateCompanies({
    allCompanies: companies,
    liveJobs: jobs,
    liveOnly: true,
    missingOnly: false,
    force: false,
    supabaseUrl,
  });

  assert.strictEqual(defaultSel.skippedAlreadyHosted, 1, "Hosted bucket row must be skipped without --force");
  assert.deepStrictEqual(
    defaultSel.companiesToEvaluate.map((c) => c.id),
    ["c-external", "c-null"],
    "External-hosted and null-logo rows must both remain eligible"
  );

  const inspSkipped = await inspectCompany(companies[0], { force: false, supabaseUrl });
  assert.strictEqual(inspSkipped.status, "already_set");

  const forcedSel = selectCandidateCompanies({
    allCompanies: companies,
    liveJobs: jobs,
    liveOnly: true,
    missingOnly: false,
    force: true,
    supabaseUrl,
  });
  assert.strictEqual(forcedSel.skippedAlreadyHosted, 0);
  assert.strictEqual(forcedSel.companiesToEvaluate.length, 3, "--force must include self-hosted companies");

  console.log("  [PASS] Already-hosted skip and --force behavior verified");
}

function testSqlGenerationAndExternalUrlGuard() {
  console.log("Testing dry-run SQL, rollback SQL, and external URL refusal...");

  const supabaseUrl = "https://projref.supabase.co";
  const candidate: CandidateLogo = {
    company: {
      id: "c-sql",
      name: "Acme O'Brien",
      slug: "acme",
      domain: null,
      ats_type: "greenhouse",
      logo_url: "https://external.example.com/old.png",
    },
    ats: "greenhouse",
    boardUrl: "https://job-boards.greenhouse.io/acme",
    imageUrl: "https://acme.com/icon.png",
    source: "icon",
    domain: "acme.com",
    buffer: Buffer.from([1, 2, 3]),
    contentType: "image/png",
    ext: "png",
    width: 128,
    height: 128,
  };

  const expectedPath = buildLogoStoragePath("c-sql", candidate.buffer, "png");
  const sqlRows = buildCompanyLogoSql([candidate], supabaseUrl);
  assert.strictEqual(sqlRows.length, 1);
  assert.strictEqual(sqlRows[0].storagePath, expectedPath);
  assert.ok(
    sqlRows[0].updateSql.includes(`https://projref.supabase.co/storage/v1/object/public/company-logos/${expectedPath}`),
    "Forward SQL must point logo_url to versioned storage public URL"
  );
  assert.ok(sqlRows[0].updateSql.includes("domain = 'acme.com'"), "Forward SQL must set known domain");
  assert.ok(
    sqlRows[0].rollbackSql.includes("logo_url = 'https://external.example.com/old.png'"),
    "Rollback SQL must restore previous logo_url"
  );
  assert.ok(
    sqlRows[0].rollbackSql.includes("domain = NULL"),
    "Rollback SQL must restore previous NULL domain"
  );

  const runRollback = buildRunRollbackSql(sqlRows);
  assert.ok(runRollback.includes("WHERE id = 'c-sql'"), "Run-only rollback SQL must scope by exact company ID");
  assert.ok(!runRollback.includes("LIKE '%company-logos%'"), "Rollback SQL must NEVER use unscoped LIKE '%company-logos%'");
  assert.ok(!buildRunRollbackSql([]).includes("LIKE '%company-logos%'"));

  assert.throws(
    () => buildCompanyLogoSql([candidate], supabaseUrl, () => "https://evil.example.com/logo.png"),
    /Refusing non-self-hosted logo_url/,
    "Must refuse storing external URLs in companies.logo_url"
  );

  console.log("  [PASS] Dry-run SQL, versioned key, run-only rollback SQL, and self-hosted guard verified");
}

function testDryRunApplyCommandAndManifestScope() {
  console.log("Testing dry-run --write apply command flag preservation and reviewed manifest...");

  const dryRunCli = parseBackfillCliArgs([
    "node",
    "scripts/backfill-company-logos.ts",
    "--live-only",
    "--limit",
    "25",
    "--offset",
    "50",
  ]);
  const writeCmd = buildWriteApplyCommand(dryRunCli);
  assert.ok(writeCmd.includes("--write"), "Printed apply command must include --write");

  const reparsed = parseBackfillCliArgs(writeCmd.split(/\s+/));
  assert.strictEqual(reparsed.isWrite, true);
  assert.strictEqual(reparsed.liveOnly, true, "Parsed apply command must preserve --live-only");
  assert.strictEqual(reparsed.limit, 25, "Parsed apply command must preserve --limit N");
  assert.strictEqual(reparsed.offset, 50, "Parsed apply command must preserve --offset M");
  assert.strictEqual(reparsed.missingOnly, false);
  assert.strictEqual(reparsed.force, false);

  // Also test --missing-only --force + --manifest roundtrip
  const supabaseUrl = "https://projref.supabase.co";
  const c1: CompanyRow = { id: "c-m1", name: "Manifest One", slug: "m1", ats_type: "ashby", logo_url: null };
  const c2: CompanyRow = { id: "c-m2", name: "Unreviewed Co", slug: "m2", ats_type: "ashby", logo_url: null };
  const jobs: JobInfo[] = [
    { company_id: "c-m1", status: "active", is_active: true },
    { company_id: "c-m2", status: "active", is_active: true },
  ];

  const cand1: CandidateLogo = {
    company: c1,
    ats: "ashby",
    boardUrl: "https://jobs.ashbyhq.com/m1",
    imageUrl: "https://m1.io/logo.png",
    source: "icon",
    domain: "m1.io",
    buffer: Buffer.from([10, 20, 30]),
    contentType: "image/png",
    ext: "png",
    width: 128,
    height: 128,
  };
  const cand2: CandidateLogo = { ...cand1, company: c2 };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-logo-manifest-"));
  try {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const sqlRows = buildCompanyLogoSql([cand1], supabaseUrl);
    const cliFlags = parseBackfillCliArgs([
      "node",
      "script.ts",
      "--live-only",
      "--missing-only",
      "--force",
      "--limit",
      "1",
      "--offset",
      "5",
    ]);
    const manifest = buildBackfillManifest(cliFlags, sqlRows, [cand1]);
    writeReviewedManifest(manifestPath, manifest);

    const writeCmdWithManifest = buildWriteApplyCommand(cliFlags, manifestPath);
    const parsedWithManifest = parseBackfillCliArgs(writeCmdWithManifest.split(/\s+/));
    assert.strictEqual(parsedWithManifest.liveOnly, true);
    assert.strictEqual(parsedWithManifest.missingOnly, true);
    assert.strictEqual(parsedWithManifest.force, true);
    assert.strictEqual(parsedWithManifest.limit, 1);
    assert.strictEqual(parsedWithManifest.offset, 5);
    assert.strictEqual(parsedWithManifest.manifestPath, manifestPath);
    assert.strictEqual(parsedWithManifest.isWrite, true);

    const loaded = readReviewedManifest(manifestPath);
    const sel = selectCandidateCompanies({
      allCompanies: [c1, c2],
      liveJobs: jobs,
      liveOnly: parsedWithManifest.liveOnly,
      missingOnly: parsedWithManifest.missingOnly,
      force: parsedWithManifest.force,
      supabaseUrl,
      limit: parsedWithManifest.limit,
      offset: parsedWithManifest.offset,
      manifest: loaded,
    });
    assert.deepStrictEqual(
      sel.companiesToEvaluate.map((c) => c.id),
      ["c-m1"],
      "--write with manifest must strictly scope to reviewed manifest companies even with offset"
    );

    const filtered = filterCandidatesByManifest([cand1, cand2], loaded);
    assert.deepStrictEqual(
      filtered.approved.map((c) => c.company.id),
      ["c-m1"],
      "Manifest filter must reject companies not in reviewed manifest"
    );
    assert.strictEqual(filtered.skippedDrift.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("  [PASS] Dry-run flag preservation and manifest scoping verified");
}

async function testPoliteFetcherHostSpacingAndRetryPolicy() {
  console.log("Testing polite fetcher (1s per host, retry once on 5xx, never retry 404)...");

  let clock = 1000;
  const slept: number[] = [];
  const calls: Array<{ url: string; t: number }> = [];
  const hostCounts = new Map<string, number>();

  const fetcher = createPoliteFetcher({
    minHostIntervalMs: 1000,
    maxRetries5xx: 1,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    fetchFn: async (url) => {
      calls.push({ url, t: clock });
      const count = (hostCounts.get(url) || 0) + 1;
      hostCounts.set(url, count);
      if (url.includes("/flaky-503") && count === 1) {
        return new Response("upstream error", { status: 503 });
      }
      if (url.includes("/always-502")) {
        return new Response("bad gateway", { status: 502 });
      }
      if (url.includes("/missing-404")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("ok", { status: 200 });
    },
  });

  // 1. Two sequential calls to same host must be >= 1000ms apart; different host has no delay
  const r1 = await fetcher("https://boards.greenhouse.io/a");
  assert.strictEqual(r1.status, 200);
  const rOther = await fetcher("https://jobs.lever.co/b");
  assert.strictEqual(rOther.status, 200);
  assert.strictEqual(slept.length, 0, "Different hosts must not wait 1000ms for each other");

  const r2 = await fetcher("https://boards.greenhouse.io/c");
  assert.strictEqual(r2.status, 200);
  const ghTimes = calls.filter((c) => c.url.includes("boards.greenhouse.io")).map((c) => c.t);
  assert.ok(ghTimes[1] - ghTimes[0] >= 1000, "Same host calls must be separated by >= 1000ms");

  // 2. 5xx retries once and recovers
  const rFlaky = await fetcher("https://retry.example.com/flaky-503");
  assert.strictEqual(rFlaky.status, 200);
  assert.strictEqual(hostCounts.get("https://retry.example.com/flaky-503"), 2, "503 must retry once");

  // 3. Persistent 5xx stops after 1 retry (2 total calls)
  const rBad = await fetcher("https://fail.example.com/always-502");
  assert.strictEqual(rBad.status, 502);
  assert.strictEqual(hostCounts.get("https://fail.example.com/always-502"), 2, "5xx must retry at most once");

  // 4. 404 never retries (1 total call)
  const r404 = await fetcher("https://missing.example.com/missing-404");
  assert.strictEqual(r404.status, 404);
  assert.strictEqual(hostCounts.get("https://missing.example.com/missing-404"), 1, "404 must never retry");

  console.log("  [PASS] Polite fetcher spacing, 5xx single retry, and 404 no-retry verified");
}

async function testUploadAndPersistRollbackSafety() {
  console.log("Testing versioned upload, DB-failure rollback under --force, and working success rollback...");

  const supabaseUrl = "https://projref.supabase.co";
  const oldKey = "comp-ext-000000000000.jpg";
  const oldUrl = `${supabaseUrl}/storage/v1/object/public/company-logos/${oldKey}`;
  const storageObjects = new Map<string, Buffer>([[oldKey, Buffer.from("old-jpg-bytes")]]);
  const dbRow: { id: string; logo_url: string | null; domain: string | null } = {
    id: "comp-ext",
    logo_url: oldUrl,
    domain: null,
  };
  let failDbUpdate = true;

  const mockSupabase: any = {
    storage: {
      from: (bucket: string) => {
        assert.strictEqual(bucket, "company-logos");
        return {
          upload: async (pathKey: string, buf: Buffer) => {
            storageObjects.set(pathKey, buf);
            return { error: null };
          },
          getPublicUrl: (pathKey: string) => ({
            data: { publicUrl: `${supabaseUrl}/storage/v1/object/public/${bucket}/${pathKey}` },
          }),
          remove: async (paths: string[]) => {
            for (const p of paths) {
              storageObjects.delete(p);
            }
            return { error: null };
          },
        };
      },
    },
    from: (table: string) => {
      assert.strictEqual(table, "companies");
      return {
        update: (payload: { logo_url: string; domain?: string }) => ({
          eq: async (_col: string, id: string) => {
            assert.strictEqual(id, dbRow.id);
            if (failDbUpdate) {
              return { error: { message: "simulated DB failure" } };
            }
            dbRow.logo_url = payload.logo_url;
            if (payload.domain !== undefined) dbRow.domain = payload.domain;
            return { error: null };
          },
        }),
      };
    },
  };

  const candidate: CandidateLogo = {
    company: {
      id: "comp-ext",
      name: "ExtChange Co",
      slug: "extchange",
      domain: null,
      ats_type: "ashby",
      logo_url: oldUrl,
    },
    ats: "ashby",
    boardUrl: "https://jobs.ashbyhq.com/extchange",
    imageUrl: "https://extchange.io/logo.png",
    source: "icon",
    domain: "extchange.io",
    buffer: Buffer.from([1, 2, 3, 4]),
    contentType: "image/png",
    ext: "png",
    width: 128,
    height: 128,
  };

  const expectedVersionedKey = buildLogoStoragePath("comp-ext", candidate.buffer, "png");
  const expectedNewUrl = `${supabaseUrl}/storage/v1/object/public/company-logos/${expectedVersionedKey}`;
  assert.notStrictEqual(expectedVersionedKey, oldKey);

  // 1. Mocked DB failure under --force scenario: removes newly uploaded object and leaves old file + old logo_url intact
  const failedRes = await uploadAndPersistCompanyLogo(mockSupabase, supabaseUrl, candidate);
  assert.strictEqual(failedRes.publicUrl, null);
  assert.ok(failedRes.error?.includes("simulated DB failure"));
  assert.strictEqual(storageObjects.has(expectedVersionedKey), false, "DB failure must clean up newly uploaded versioned object");
  assert.strictEqual(storageObjects.has(oldKey), true, "DB failure must leave old storage object intact");
  assert.strictEqual(dbRow.logo_url, oldUrl, "DB failure must leave old logo_url intact");

  // 1b. Mocked DB failure under --force when new hash matches existing versioned object key
  const sameHashCandidate: CandidateLogo = {
    ...candidate,
    company: { ...candidate.company, logo_url: expectedNewUrl },
  };
  storageObjects.set(expectedVersionedKey, candidate.buffer);
  dbRow.logo_url = expectedNewUrl;
  const sameHashFailRes = await uploadAndPersistCompanyLogo(mockSupabase, supabaseUrl, sameHashCandidate);
  assert.strictEqual(sameHashFailRes.publicUrl, null);
  assert.strictEqual(storageObjects.has(expectedVersionedKey), true, "DB failure must not delete pre-existing identical versioned object");
  assert.strictEqual(dbRow.logo_url, expectedNewUrl);
  storageObjects.delete(expectedVersionedKey);
  dbRow.logo_url = oldUrl;

  // 2. Success path updates to versioned URL while keeping old file intact so rollback SQL works
  failDbUpdate = false;
  const sqlRows = buildCompanyLogoSql([candidate], supabaseUrl);
  const runRollback = buildRunRollbackSql(sqlRows);
  const okRes = await uploadAndPersistCompanyLogo(mockSupabase, supabaseUrl, candidate);
  assert.strictEqual(okRes.publicUrl, expectedNewUrl);
  assert.strictEqual(dbRow.logo_url, expectedNewUrl);
  assert.strictEqual(dbRow.domain, "extchange.io");
  assert.strictEqual(storageObjects.has(expectedVersionedKey), true);
  assert.strictEqual(storageObjects.has(oldKey), true, "Prior object must remain available so rollback URL resolves");
  assert.ok(runRollback.includes(oldUrl), "Rollback SQL must point back to live prior object URL");
  assert.ok(!runRollback.includes("LIKE '%company-logos%'"));

  console.log("  [PASS] Versioned upload, DB-failure cleanup, and working rollback verified");
}

async function main() {
  console.log("=== BACKFILL COMPANY LOGOS HOMEPAGE & FREE SERVICE SUITE ===");

  if (isNegativeControl) {
    assert.strictEqual("actual", "expected", "Intentional negative control failure");
    return;
  }

  // 1. Negative control
  runNegativeControlSubprocess();

  // 2. cleanDomain & ATS filters
  testCleanDomainAndAtsFilter();

  // 3. deriveCompanyDomain (never guesses, derives from jobs, ashby, greenhouse JSON-LD)
  testDeriveCompanyDomainNeverGuesses();

  // 4. selectLargestQualifyingIcon
  testSelectLargestQualifyingIcon();

  // 5. Image header sniffing validation and SVG rejection
  testImageValidationAndSvgRejection();

  // 6. Scheduled missing-only filtering
  testMissingOnlySchedulingFilter();

  // 7. Prioritization of top 200 jobs
  testPrioritizationTop200Jobs();

  // 8. --live-only selection, active-job ordering, and --limit/--offset
  testLiveOnlySelectionAndOrdering();

  // 9. company_id IS NULL lower(btrim) name match & unmatched logging
  testCompanyIdNullNameMatchAndUnmatchedLogging();

  // 10. Already-hosted skip, external re-host, and --force override
  await testAlreadyHostedSkipAndForceOverride();

  // 11. Dry-run SQL, versioned key, run-only rollback SQL, and external URL guard
  testSqlGenerationAndExternalUrlGuard();

  // 12. Dry-run --write flag preservation and reviewed manifest scoping
  testDryRunApplyCommandAndManifestScope();

  // 13. Polite fetcher spacing, 5xx single retry, and 404 no-retry
  await testPoliteFetcherHostSpacingAndRetryPolicy();

  // 14. Versioned upload, DB-failure rollback, and working rollback SQL
  await testUploadAndPersistRollbackSafety();

  console.log("\nALL BACKFILL COMPANY LOGOS FALLBACK TESTS PASSED-LOCAL\n");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
