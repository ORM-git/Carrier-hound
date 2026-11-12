/**
 * Offline test & static guard for client schema validation coverage under src/lib/api/.
 *
 * Run with: npx tsx scripts/test-client-schema-coverage.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ClientSchemaValidationError,
  parseSearchJobsFacetRows,
  parseSearchJobsRows,
  parseWorldwideCompanyRows,
} from "../src/lib/api/clientSchemas";
import { searchJobs } from "../src/lib/api/jobs";
import { getWorldwideCompanies } from "../src/lib/api/worldwide";
import { WORLDWIDE_COMPANIES } from "../src/data/companies";

function assertThrowsSchemaError(fn: () => unknown, expectedSchema: string, label: string) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof ClientSchemaValidationError,
    `${label}: expected ClientSchemaValidationError, got ${String(caught)}`
  );
  assert.equal(caught.name, "ClientSchemaValidationError", `${label}: error.name mismatch`);
  assert.equal(caught.schema, expectedSchema, `${label}: error.schema mismatch`);
  assert.ok(caught.reason.length > 0, `${label}: expected non-empty reason`);
}

async function assertRejectsSchemaError(
  fn: () => Promise<unknown>,
  expectedSchema: string,
  label: string
) {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof ClientSchemaValidationError,
    `${label}: expected ClientSchemaValidationError rejection, got ${String(caught)}`
  );
  assert.equal(caught.schema, expectedSchema, `${label}: error.schema mismatch`);
}

function testSearchJobsRowValidator() {
  // Valid full + minimal rows
  const valid = parseSearchJobsRows([
    {
      id: "job-1",
      title: "Staff Engineer",
      company: "Acme",
      location: "Remote",
      date: "2026-11-12",
      first_seen_at: "2026-11-12T00:00:00Z",
      salary_text: "$180k - $220k",
      category: "software",
      remote: true,
      remote_scope: "remote",
      country_code: "US",
      country: "United States",
      job_type: "full-time",
      apply_url: "https://example.com/apply/1",
    },
    {
      id: "job-2",
      title: "Designer",
      company: "Beta",
      location: null,
      remote: null,
      apply_url: undefined,
    },
  ]);
  assert.equal(valid.length, 2);
  assert.equal(valid[0].id, "job-1");
  assert.equal(valid[1].location, null);
  assert.deepEqual(parseSearchJobsRows([]), []);

  // Malformed payloads
  assertThrowsSchemaError(() => parseSearchJobsRows(null), "searchJobs.rows", "jobs null");
  assertThrowsSchemaError(() => parseSearchJobsRows({ rows: [] }), "searchJobs.rows", "jobs non-array object");
  assertThrowsSchemaError(() => parseSearchJobsRows(["not-an-object"]), "searchJobs.rows", "jobs string item");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ title: "Dev", company: "Acme" }]), "searchJobs.rows", "jobs missing id");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "   ", title: "Dev", company: "Acme" }]), "searchJobs.rows", "jobs blank id");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: 42, company: "Acme" }]), "searchJobs.rows", "jobs numeric title");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: "Dev", company: null }]), "searchJobs.rows", "jobs null company");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: "Dev", company: "Acme", remote: "yes" }]), "searchJobs.rows", "jobs string remote");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: "Dev", company: "Acme", location: 123 }]), "searchJobs.rows", "jobs numeric location");
  assertThrowsSchemaError(() => parseSearchJobsRows([{ id: "1", title: "Dev", company: "Acme", apply_url: {} }]), "searchJobs.rows", "jobs object apply_url");
}

function testSearchJobsFacetValidator() {
  const valid = parseSearchJobsFacetRows([
    { category: "software", country: "United States" },
    { category: null, country: undefined },
    {},
  ]);
  assert.equal(valid.length, 3);
  assert.equal(valid[0].category, "software");
  assert.equal(valid[1].category, null);
  assert.deepEqual(parseSearchJobsFacetRows([]), []);

  assertThrowsSchemaError(() => parseSearchJobsFacetRows("bad"), "searchJobs.facets", "facets string");
  assertThrowsSchemaError(() => parseSearchJobsFacetRows({}), "searchJobs.facets", "facets object");
  assertThrowsSchemaError(() => parseSearchJobsFacetRows([null]), "searchJobs.facets", "facets null row");
  assertThrowsSchemaError(() => parseSearchJobsFacetRows([{ category: 101 }]), "searchJobs.facets", "facets numeric category");
  assertThrowsSchemaError(() => parseSearchJobsFacetRows([{ country: ["US"] }]), "searchJobs.facets", "facets array country");
}

function testWorldwideCompanyValidator() {
  const valid = parseWorldwideCompanyRows([
    { name: "Stripe", slug: "stripe", country: "United States", active_job_count: 85 },
    { name: "GitLab", slug: "gitlab", country: null, active_job_count: "42" },
    { name: "Linear", slug: "linear", active_job_count: 0 },
  ]);
  assert.equal(valid.length, 3);
  assert.equal(valid[0].active_job_count, 85);
  assert.equal(valid[1].active_job_count, 42);
  assert.equal(valid[1].country, null);
  assert.deepEqual(parseWorldwideCompanyRows([]), []);

  assertThrowsSchemaError(() => parseWorldwideCompanyRows({}), "worldwideCompanyCounts.rows", "worldwide non-array");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([null]), "worldwideCompanyCounts.rows", "worldwide null row");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "", active_job_count: 5 }]), "worldwideCompanyCounts.rows", "worldwide empty slug");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: 123, slug: "stripe", active_job_count: 5 }]), "worldwideCompanyCounts.rows", "worldwide numeric name");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", country: 99, active_job_count: 5 }]), "worldwideCompanyCounts.rows", "worldwide numeric country");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", active_job_count: -1 }]), "worldwideCompanyCounts.rows", "worldwide negative count");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", active_job_count: Number.NaN }]), "worldwideCompanyCounts.rows", "worldwide NaN count");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", active_job_count: "not-a-num" }]), "worldwideCompanyCounts.rows", "worldwide non-numeric string count");
  assertThrowsSchemaError(() => parseWorldwideCompanyRows([{ name: "Stripe", slug: "stripe", active_job_count: null }]), "worldwideCompanyCounts.rows", "worldwide null count");
}

async function testCallSiteWiring() {
  function mockJobsClient(mainPayload: { data: any; count: number; error: any }, facetPayload: { data: any }) {
    let callIndex = 0;
    const chain: any = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      or: () => chain,
      ilike: () => chain,
      in: () => chain,
      gte: () => chain,
      order: () => chain,
      range: () => Promise.resolve(mainPayload),
      limit: () => {
        callIndex++;
        return Promise.resolve(facetPayload);
      },
      then: (resolve: (v: any) => void) => {
        callIndex++;
        return resolve(callIndex === 1 ? mainPayload : facetPayload);
      },
    };
    return chain;
  }

  // Valid searchJobs call
  const okClient = mockJobsClient(
    {
      data: [
        {
          id: "job-ok-1",
          title: "Backend Engineer",
          company: "Stripe",
          location: "Remote",
          category: "software",
          remote: true,
          country: "United States",
          apply_url: "https://stripe.com/jobs/1",
        },
      ],
      count: 1,
      error: null,
    },
    { data: [{ category: "software", country: "United States" }] }
  );
  const okRes = await searchJobs({}, okClient);
  assert.equal(okRes.jobs.length, 1);
  assert.equal(okRes.jobs[0].id, "job-ok-1");
  assert.equal(okRes.facets.categories.software, 1);

  // Malformed primary rows in searchJobs -> throws ClientSchemaValidationError
  await assertRejectsSchemaError(
    () =>
      searchJobs(
        {},
        mockJobsClient(
          { data: [{ id: "job-bad", title: 123, company: "Stripe" }], count: 1, error: null },
          { data: [] }
        )
      ),
    "searchJobs.rows",
    "searchJobs rejects malformed job row"
  );

  // Malformed facet rows in searchJobs -> throws ClientSchemaValidationError
  await assertRejectsSchemaError(
    () =>
      searchJobs(
        {},
        mockJobsClient(
          { data: [], count: 0, error: null },
          { data: [{ category: 404, country: "US" }] }
        )
      ),
    "searchJobs.facets",
    "searchJobs rejects malformed facet row"
  );

  // Worldwide valid + fallback + malformed
  const okWorldwideClient = {
    from: () => ({
      select: () =>
        Promise.resolve({
          data: [{ name: "Stripe", slug: "stripe", country: "United States", active_job_count: 17 }],
          error: null,
        }),
    }),
  };
  const wwOk = await getWorldwideCompanies(okWorldwideClient);
  assert.equal(wwOk.find((c) => c.slug === "stripe")?.jobCount, 17);

  const errWorldwideClient = {
    from: () => ({
      select: () => Promise.resolve({ data: null, error: { code: "42P01", message: "missing" } }),
    }),
  };
  const wwFallback = await getWorldwideCompanies(errWorldwideClient);
  assert.equal(wwFallback.length, WORLDWIDE_COMPANIES.length);

  const badWorldwideClient = {
    from: () => ({
      select: () =>
        Promise.resolve({
          data: [{ name: "Stripe", slug: "stripe", active_job_count: "bad" }],
          error: null,
        }),
    }),
  };
  await assertRejectsSchemaError(
    () => getWorldwideCompanies(badWorldwideClient),
    "worldwideCompanyCounts.rows",
    "getWorldwideCompanies rejects malformed count"
  );
}

const EXEMPT_OR_SERVER_MODULES = new Set([
  "clientSchemas.ts", // validator module itself
  "retryFetch.ts", // generic transport wrapper, does not parse JSON or hold a schema
  "sharedRateLimit.ts", // server-only rate limiter using SUPABASE_SERVICE_ROLE_KEY
  "stats.ts", // explicitly exempted by task scope (already calls parseStatsResponse; PR #546)
]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

export function auditApiModuleSource(fileName: string, source: string): string | null {
  const clean = stripComments(source);

  if (fileName === "retryFetch.ts") {
    if (/\.(json|from|rpc)\s*\(/.test(clean)) {
      return `${fileName}: transport wrapper unexpectedly parses JSON or queries Supabase`;
    }
    return null;
  }

  if (fileName === "sharedRateLimit.ts") {
    if (/\bfetch\s*\(/.test(clean)) {
      return `${fileName}: server-side rate limiter unexpectedly calls fetch()`;
    }
    return null;
  }

  if (fileName === "stats.ts") {
    if (!/\bparseStatsResponse\s*\(/.test(clean)) {
      return `${fileName}: expected parseStatsResponse call`;
    }
    return null;
  }

  if (EXEMPT_OR_SERVER_MODULES.has(fileName)) {
    return null;
  }

  const fetchCallMatches =
    clean.match(/\b(?:fetch|fetchWithRetry)\s*\(|(?<!\b(?:Array|Buffer))\.(?:from|rpc)\s*\(/g) ?? [];
  if (fetchCallMatches.length === 0) {
    return null;
  }

  const importsValidator = /from\s+["'](?:\.\/clientSchemas|@\/lib\/api\/clientSchemas)["']/.test(clean);
  if (!importsValidator) {
    return `${fileName}: contains ${fetchCallMatches.length} fetch/query call(s) without importing ./clientSchemas`;
  }

  const validationCallMatches =
    clean.match(/\bparse[A-Z][A-Za-z0-9_]*\s*\(/g) ?? [];
  if (validationCallMatches.length < fetchCallMatches.length) {
    return `${fileName}: found ${fetchCallMatches.length} fetch/query call(s) but only ${validationCallMatches.length} schema validator call(s)`;
  }

  return null;
}

function testStaticCoverage() {
  const repoRoot = path.resolve(__dirname, "..");
  const apiDir = path.join(repoRoot, "src", "lib", "api");
  const docPath = path.join(repoRoot, "docs", "client-schema-validation.md");

  assert.ok(fs.existsSync(docPath), "docs/client-schema-validation.md must exist");
  const docText = fs.readFileSync(docPath, "utf8");

  const entries = fs.readdirSync(apiDir, { withFileTypes: true });
  const tsFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => e.name)
    .sort();

  assert.ok(tsFiles.length >= 10, `Expected src/lib/api/*.ts files, found ${tsFiles.length}`);

  const failures: string[] = [];
  for (const fileName of tsFiles) {
    assert.ok(
      docText.includes(`src/lib/api/${fileName}`),
      `docs/client-schema-validation.md must document src/lib/api/${fileName}`
    );
    const source = fs.readFileSync(path.join(apiDir, fileName), "utf8");
    const err = auditApiModuleSource(fileName, source);
    if (err) failures.push(err);
  }
  assert.deepEqual(failures, [], `Static coverage check failed:\n${failures.join("\n")}`);

  // Negative controls proving the static scanner rejects unvalidated fetch paths
  const unvalidatedHttp = auditApiModuleSource(
    "syntheticHttp.ts",
    `export async function load() { const r = await fetch("/api/example"); return r.json(); }`
  );
  assert.ok(unvalidatedHttp !== null, "Static scanner must fail on unvalidated fetch()");

  const unvalidatedPartial = auditApiModuleSource(
    "syntheticMultiQuery.ts",
    `import { parseSearchJobsRows } from "./clientSchemas";
     export async function load(sb: any) {
       const a = await sb.from("a").select("*");
       parseSearchJobsRows(a.data);
       const b = await sb.from("b").select("*");
       return b.data;
     }`
  );
  assert.ok(
    unvalidatedPartial !== null,
    "Static scanner must fail when a second query lacks a validator call"
  );
}

async function main() {
  testSearchJobsRowValidator();
  testSearchJobsFacetValidator();
  testWorldwideCompanyValidator();
  await testCallSiteWiring();
  testStaticCoverage();
  console.log("[PASS] test-client-schema-coverage: all fixture, wiring, and static checks passed.");
}

main().catch((err) => {
  console.error("[FAIL] test-client-schema-coverage:", err);
  process.exit(1);
});
