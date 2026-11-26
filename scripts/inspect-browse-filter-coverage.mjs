// READ-ONLY owner check for the browse-filter contract (PR body): runtime column lists and population counts.
// Only `select ... limit 1` and head:true counts. No writes, no RPC, no DDL.
// Run: node scripts/inspect-browse-filter-coverage.mjs   (reads .env.local: NEXT_PUBLIC_SUPABASE_URL + a service/read key)
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const key = process.env.SUPABASE_READONLY_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, key, { auth: { persistSession: false } });

// Video fields with no column in the repo: report whether production has anything like them.
const WANTED = /visa|h1b|sponsor|clearance|citizen|stage|funding|staffing|agency|industry|lat|lon|geo/i;

async function columns(table) {
  const { data, error } = await db.from(table).select("*").limit(1);
  if (error) return `ERROR ${error.message}`;
  const cols = Object.keys(data?.[0] || {}).sort();
  const hits = cols.filter((c) => WANTED.test(c));
  return `${cols.join(", ")}\n   candidate video-field columns: ${hits.length ? hits.join(", ") : "none"}`;
}
async function count(label, build, table = "jobs", active = true) {
  let q = db.from(table).select("*", { count: "exact", head: true });
  if (active) q = q.eq("is_active", true).eq("status", "active");
  const { count: n, error } = await build(q);
  console.log(`${label}: ${error ? "ERROR " + (error.message || error.code) : n}`);
}

for (const t of ["jobs", "jobs_public", "companies", "job_descriptions"]) console.log(`COLUMNS ${t}: ${await columns(t)}`);
console.log("--- active jobs (is_active=true, status=active)");
await count("total", (q) => q);
await count("role_category not null", (q) => q.not("role_category", "is", null));
for (const rc of ["SDE", "AI_ML", "CLOUD", "DATA", "OTHER"]) await count(`role_category=${rc}`, (q) => q.eq("role_category", rc));
await count("min_experience_years not null", (q) => q.not("min_experience_years", "is", null));
await count("max_experience_years not null", (q) => q.not("max_experience_years", "is", null));
for (const s of ["entry", "mid", "senior", "staff", "lead", "director", "unknown"]) await count(`seniority=${s}`, (q) => q.eq("seniority", s));
await count("seniority null", (q) => q.is("seniority", null));
await count("salary_min not null", (q) => q.not("salary_min", "is", null));
await count("salary_min not null, salary_period null", (q) => q.not("salary_min", "is", null).is("salary_period", null));
await count("salary_min not null, currency null", (q) => q.not("salary_min", "is", null).is("currency", null));
for (const c of ["USD", "EUR", "GBP", "INR", "CAD", "AUD"]) await count(`salary_min not null, currency=${c}`, (q) => q.not("salary_min", "is", null).eq("currency", c));
await count("company_id not null", (q) => q.not("company_id", "is", null));
await count("department not null", (q) => q.not("department", "is", null));
await count("job_descriptions rows", (q) => q, "job_descriptions", false);
await count("job_descriptions skills non-empty", (q) => q.not("skills", "is", null).neq("skills", "{}"), "job_descriptions", false);
