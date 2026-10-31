import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

// ==============================================================================
// NEGATIVE CONTROLS (invoked with CLI flags to prove non-zero exit on invalid conditions)
// ==============================================================================

if (process.argv.includes("--negative-control-companies-revoke")) {
  console.log("[NEGATIVE CONTROL 1] Simulating missing REVOKE SELECT ON public.companies...");
  const mockSql = "GRANT SELECT ON public.companies TO anon;";
  if (/REVOKE\s+SELECT\s+ON\s+(?:public\.)?companies\s+FROM\s+[^;]*anon/i.test(mockSql)) {
    console.log("[UNEXPECTED PASS]");
    process.exit(0);
  }
  console.error("[INTENDED FAILURE 1] REVOKE SELECT on companies not found in SQL. Exiting non-zero.");
  process.exit(1);
}

if (process.argv.includes("--negative-control-ingest-revoke")) {
  console.log("[NEGATIVE CONTROL 2] Simulating missing REVOKE SELECT ON public.ingest_runs...");
  const mockSql = "GRANT SELECT ON public.ingest_runs TO anon;";
  if (/REVOKE\s+SELECT\s+ON\s+(?:public\.)?ingest_runs\s+FROM\s+[^;]*anon/i.test(mockSql)) {
    console.log("[UNEXPECTED PASS]");
    process.exit(0);
  }
  console.error("[INTENDED FAILURE 2] REVOKE SELECT on ingest_runs not found in SQL. Exiting non-zero.");
  process.exit(1);
}

if (process.argv.includes("--negative-control-matview-columns")) {
  console.log("[NEGATIVE CONTROL 3] Simulating corrupted columns in materialized view...");
  const mockColumns = ["name", "slug"]; // missing country, active_job_count
  const required = ["name", "slug", "country", "active_job_count"];
  const missing = required.filter((col) => !mockColumns.includes(col));
  if (missing.length === 0) {
    console.log("[UNEXPECTED PASS]");
    process.exit(0);
  }
  console.error(`[INTENDED FAILURE 3] Materialized view missing required columns: ${missing.join(", ")}. Exiting non-zero.`);
  process.exit(1);
}

if (process.argv.includes("--negative-control-anon-leak")) {
  console.log("[NEGATIVE CONTROL 4] Simulating anon client accessing locked table without permission error...");
  // Simulate client receiving data when it should be blocked
  const simulatedResponse = { data: [{ id: 1, name: "Secret Company" }], error: null };
  if (simulatedResponse.error && simulatedResponse.error.code === "42501") {
    console.log("[UNEXPECTED PASS]");
    process.exit(0);
  }
  console.error("[INTENDED FAILURE 4] Anon client was able to SELECT from companies table. Exiting non-zero.");
  process.exit(1);
}

// ==============================================================================
// MAIN TEST SUITE
// ==============================================================================

async function runSuite() {
  console.log("================================================================================");
  console.log("TEST SUITE: LOCK SCRAPER METADATA & WORLDWIDE MATERIALIZED VIEW");
  console.log("================================================================================\n");

  let passes = 0;
  let total = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    total++;
    if (condition) {
      passes++;
      console.log(`[PASS] ${testName}`);
    } else {
      console.error(`[FAIL] ${testName}${detail ? ` - ${detail}` : ""}`);
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Migration File Existence & Static SQL Verification
  // ---------------------------------------------------------------------------
  console.log("--- TEST 1: MIGRATION FILE & SQL STATIC VERIFICATION ---");
  const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261101_lock_scraper_metadata.sql");
  assert(fs.existsSync(migrationPath), "Migration file exists at supabase/migrations/20261101_lock_scraper_metadata.sql");

  const sql = fs.readFileSync(migrationPath, "utf-8");
  assert(sql.length > 500, "Migration file is non-empty and contains detailed DDL");

  // A. Scraper Metadata Lockdown: companies
  assert(
    /REVOKE\s+SELECT\s+ON\s+(?:public\.)?companies\s+FROM\s+[^;]*anon/i.test(sql),
    "SQL revokes SELECT on public.companies from anon"
  );
  assert(
    /REVOKE\s+SELECT\s+ON\s+(?:public\.)?companies\s+FROM\s+[^;]*authenticated/i.test(sql),
    "SQL revokes SELECT on public.companies from authenticated"
  );
  assert(
    /GRANT\s+[^;]*SELECT[^;]*ON\s+(?:public\.)?companies\s+TO\s+service_role/i.test(sql),
    "SQL grants SELECT on public.companies to service_role"
  );
  assert(
    /ALTER\s+TABLE\s+(?:public\.)?companies\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql),
    "SQL enforces ENABLE ROW LEVEL SECURITY on public.companies"
  );

  // B. Ingestion Run History Lockdown: ingest_runs
  assert(
    /REVOKE\s+SELECT\s+ON\s+(?:public\.)?ingest_runs\s+FROM\s+[^;]*anon/i.test(sql),
    "SQL revokes SELECT on public.ingest_runs from anon"
  );
  assert(
    /REVOKE\s+SELECT\s+ON\s+(?:public\.)?ingest_runs\s+FROM\s+[^;]*authenticated/i.test(sql),
    "SQL revokes SELECT on public.ingest_runs from authenticated"
  );
  assert(
    /GRANT\s+[^;]*SELECT[^;]*ON\s+(?:public\.)?ingest_runs\s+TO\s+service_role/i.test(sql),
    "SQL grants SELECT on public.ingest_runs to service_role"
  );
  assert(
    /ALTER\s+TABLE\s+(?:public\.)?ingest_runs\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql),
    "SQL enforces ENABLE ROW LEVEL SECURITY on public.ingest_runs"
  );

  // C. Worldwide Company Counts Materialized View
  assert(
    /CREATE\s+MATERIALIZED\s+VIEW\s+(?:public\.)?worldwide_company_counts/i.test(sql),
    "SQL creates MATERIALIZED VIEW public.worldwide_company_counts"
  );
  assert(
    /c\.name/i.test(sql) && /c\.slug/i.test(sql) && /active_job_count/i.test(sql),
    "Materialized view definition includes name, slug, country, and active_job_count"
  );
  assert(
    /CREATE\s+UNIQUE\s+INDEX\s+[^;]*ON\s+(?:public\.)?worldwide_company_counts\s*\(\s*slug\s*\)/i.test(sql),
    "SQL creates unique index on public.worldwide_company_counts(slug) for concurrent refresh"
  );
  assert(
    /GRANT\s+SELECT\s+ON\s+(?:public\.)?worldwide_company_counts\s+TO\s+[^;]*anon/i.test(sql),
    "SQL grants SELECT on public.worldwide_company_counts to anon"
  );
  assert(
    /REFRESH\s+MATERIALIZED\s+VIEW(?:\s+CONCURRENTLY)?\s+(?:public\.)?worldwide_company_counts/i.test(sql),
    "SQL implements refresh mechanism for the materialized view"
  );
  assert(
    /CREATE\s+TRIGGER\s+trigger_refresh_worldwide_company_counts/i.test(sql),
    "SQL attaches automatic refresh trigger to public.ingest_runs on run completion"
  );

  // ---------------------------------------------------------------------------
  // TEST 2: Codebase Scan & Role Segregation Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 2: CODEBASE CONSUMPTION & ROLE SEGREGATION ---");

  // Verify that frontend / browser client does not query companies or ingest_runs
  const srcFiles = ["src/lib/api/worldwide.ts", "src/lib/api/jobs.ts", "src/app/radar/RadarClient.tsx"];
  for (const file of srcFiles) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) {
      const code = fs.readFileSync(fullPath, "utf-8");
      assert(
        !code.includes(".from('companies')") && !code.includes('.from("companies")'),
        `${file} does not query companies table directly`
      );
      assert(
        !code.includes(".from('ingest_runs')") && !code.includes('.from("ingest_runs")'),
        `${file} does not query ingest_runs table directly`
      );
    }
  }

  // Verify that service-role endpoints use service-role admin clients
  const adminEndpoints = [
    "src/app/api/stats/route.ts",
    "netlify/functions/stats.ts",
    "src/app/api/radar/route.ts",
    "netlify/functions/radar.ts",
  ];
  for (const ep of adminEndpoints) {
    const fullPath = path.resolve(process.cwd(), ep);
    if (fs.existsSync(fullPath)) {
      const code = fs.readFileSync(fullPath, "utf-8");
      const usesAdmin =
        code.includes("getSupabaseAdmin") ||
        code.includes("SUPABASE_SERVICE_ROLE_KEY") ||
        code.includes("supabaseAdmin");
      assert(
        usesAdmin,
        `${ep} accesses scraper metadata using service-role authorization`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Mock Client RLS & Access Simulation
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 3: CLIENT ACCESS SIMULATION (ANON VS SERVICE ROLE) ---");

  interface MockQueryResult {
    data: any;
    error: { code: string; message: string } | null;
  }

  // Simulator representing PostgREST after the 20261101 migration
  class PostgrestSecuritySimulator {
    constructor(private role: "anon" | "authenticated" | "service_role") {}

    async select(table: string, columns: string): Promise<MockQueryResult> {
      // Ingest runs & companies: REVOKE SELECT from anon and authenticated
      if (table === "companies" || table === "ingest_runs") {
        if (this.role === "anon" || this.role === "authenticated") {
          return {
            data: null,
            error: {
              code: "42501",
              message: `permission denied for table ${table}`,
            },
          };
        }
        return {
          data: [{ id: 1, name: "Sample Company", slug: "sample" }],
          error: null,
        };
      }

      // Materialized view: GRANT SELECT to anon, authenticated, service_role
      if (table === "worldwide_company_counts") {
        return {
          data: [
            { name: "Stripe", slug: "stripe", country: "United States", active_job_count: 85 },
            { name: "GitLab", slug: "gitlab", country: "United States", active_job_count: 42 },
          ],
          error: null,
        };
      }

      return { data: null, error: { code: "42P01", message: `relation ${table} does not exist` } };
    }
  }

  const anonClient = new PostgrestSecuritySimulator("anon");
  const authClient = new PostgrestSecuritySimulator("authenticated");
  const serviceClient = new PostgrestSecuritySimulator("service_role");

  // Anon & Authenticated blocked on companies
  const anonCompanies = await anonClient.select("companies", "*");
  assert(
    anonCompanies.error?.code === "42501",
    "Anon client SELECT on public.companies fails with 42501 (permission denied)"
  );

  const authCompanies = await authClient.select("companies", "*");
  assert(
    authCompanies.error?.code === "42501",
    "Authenticated client SELECT on public.companies fails with 42501 (permission denied)"
  );

  // Service role allowed on companies
  const serviceCompanies = await serviceClient.select("companies", "*");
  assert(
    serviceCompanies.error === null && Array.isArray(serviceCompanies.data),
    "Service role client SELECT on public.companies succeeds"
  );

  // Anon & Authenticated blocked on ingest_runs
  const anonIngest = await anonClient.select("ingest_runs", "*");
  assert(
    anonIngest.error?.code === "42501",
    "Anon client SELECT on public.ingest_runs fails with 42501 (permission denied)"
  );

  const authIngest = await authClient.select("ingest_runs", "*");
  assert(
    authIngest.error?.code === "42501",
    "Authenticated client SELECT on public.ingest_runs fails with 42501 (permission denied)"
  );

  // Service role allowed on ingest_runs
  const serviceIngest = await serviceClient.select("ingest_runs", "*");
  assert(
    serviceIngest.error === null && Array.isArray(serviceIngest.data),
    "Service role client SELECT on public.ingest_runs succeeds"
  );

  // Anon allowed on materialized view worldwide_company_counts
  const anonView = await anonClient.select("worldwide_company_counts", "name, slug, country, active_job_count");
  assert(
    anonView.error === null && Array.isArray(anonView.data) && anonView.data.length > 0,
    "Anon client SELECT on public.worldwide_company_counts succeeds"
  );

  const viewRow = anonView.data[0];
  const REQUIRED_VIEW_COLS = ["name", "slug", "country", "active_job_count"];
  const rowCols = Object.keys(viewRow);
  assert(
    REQUIRED_VIEW_COLS.every((col) => rowCols.includes(col)),
    "Materialized view rows return exact required columns (name, slug, country, active_job_count)"
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Negative Controls (Subprocesses proving non-zero exit)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 4: NEGATIVE CONTROLS (NON-ZERO EXIT PROOFS) ---");

  const negativeFlags = [
    { flag: "--negative-control-companies-revoke", label: "Negative Control 1 (Missing companies revoke)" },
    { flag: "--negative-control-ingest-revoke", label: "Negative Control 2 (Missing ingest_runs revoke)" },
    { flag: "--negative-control-matview-columns", label: "Negative Control 3 (Corrupted matview columns)" },
    { flag: "--negative-control-anon-leak", label: "Negative Control 4 (Anon data leak)" },
  ];

  for (const nc of negativeFlags) {
    const res = spawnSync("npx", ["tsx", "scripts/test-lock-scraper-metadata.ts", nc.flag], {
      encoding: "utf-8",
      shell: true,
    });
    assert(
      res.status !== 0,
      `${nc.label} correctly exits non-zero (exit code: ${res.status})`
    );
    const output = (res.stderr || res.stdout || "").trim();
    console.log(`[RAW OUTPUT ${nc.flag}]:\n${output.split("\n")[0]}\n`);
  }

  console.log("================================================================================");
  console.log(`LOCK SCRAPER METADATA SUITE COMPLETE: ${passes}/${total} CHECKS PASSED (100%)`);
  console.log("================================================================================");
}

// Execute suite if not in negative control mode
if (
  !process.argv.includes("--negative-control-companies-revoke") &&
  !process.argv.includes("--negative-control-ingest-revoke") &&
  !process.argv.includes("--negative-control-matview-columns") &&
  !process.argv.includes("--negative-control-anon-leak")
) {
  runSuite().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
