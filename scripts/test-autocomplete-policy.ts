/**
 * Offline static test for the Autocomplete / Prefix Search row (Backend
 * sheet): GET /api/jobs/suggest is a public, masked, rate-limited prefix
 * endpoint, and migration 20261106k ships pg_trgm + the title GIN index
 * in the standard NOT-APPLIED envelope.
 * Run: npx tsx scripts/test-autocomplete-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const routePath = "src/app/api/jobs/suggest/route.ts";
check("suggest route file exists", fs.existsSync(routePath));
const route = fs.existsSync(routePath) ? fs.readFileSync(routePath, "utf8") : "";

check("route runs on the edge runtime", /export const runtime = "edge"/.test(route));
check("route only reads the masked jobs_public view", route.includes('.from("jobs_public")'));
check("route never selects paid fields (company/salary/description/apply)",
  !/select\([^)]*(company|salary|description|apply)/i.test(route));
check("route validates query length (2-40, chosen default)",
  route.includes("MIN_QUERY_LEN") && route.includes("MAX_QUERY_LEN"));
check("route prefix-matches title with ilike", route.includes('.ilike("title"'));
check("ilike metacharacters are escaped", route.includes("escapeIlike"));
check("route is rate-limited via the shared store", route.includes("checkSharedRateLimit"));
check("rate limit is a labeled chosen default", /Chosen defaults/.test(route));
check("route is wrapped in measureRouteBudget", route.includes('measureRouteBudget("/api/jobs/suggest"'));
check("errors are no-store 503/429, never stack traces", route.includes('"no-store"'));

const migPath = "supabase/migrations/20261106k_autocomplete_pg_trgm.sql";
check("migration file exists", fs.existsSync(migPath));
const mig = fs.existsSync(migPath) ? fs.readFileSync(migPath, "utf8") : "";
check("migration is marked NOT APPLIED with record command",
  mig.includes("NOT APPLIED") && mig.includes("record-migration.cjs 20261106k_autocomplete_pg_trgm"));
check("migration enables pg_trgm", /create extension if not exists pg_trgm/i.test(mig));
check("migration adds GIN trigram index on jobs(title)",
  /create index if not exists jobs_title_trgm_idx[\s\S]*using gin \(title gin_trgm_ops\)/i.test(mig));
check("migration documents rollback", /ROLLBACK:/i.test(mig));

const docPath = "docs/autocomplete.md";
check("docs/autocomplete.md exists", fs.existsSync(docPath));
const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
check("doc states endpoint works before the migration is applied", /without (this |the )?migration|before the migration/i.test(doc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
