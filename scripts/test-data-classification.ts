/**
 * Offline static test for the data classification doc
 * (Backend row "Data Classification"): every public table created by a
 * migration must be named in docs/data-classification.md.
 * Run: npx tsx scripts/test-data-classification.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/data-classification.md", "utf8");

const tables = new Set<string>();
for (const f of fs.readdirSync("supabase/migrations")) {
  if (!f.endsWith(".sql")) continue;
  const sql = fs.readFileSync(`supabase/migrations/${f}`, "utf8");
  for (const m of sql.matchAll(/create table(?:\s+if not exists)?\s+(?:public\.)?([a-z_]+)\s*\(/gi)) {
    tables.add(m[1]);
  }
}

// A table may be documented under its live schema-qualified name
// (e.g. schema_migrations lives in supabase_migrations on the live DB).
const missing = [...tables].filter(
  (t) => !doc.includes(`\`${t}\``) && !doc.includes(`.${t}\``)
);
check(`doc names every migrated table (${tables.size} found)`, missing.length === 0);
if (missing.length) console.log("  missing:", missing.join(", "));

check("doc defines the PII class", /^- \*\*PII\*\*/m.test(doc));
check("doc defines the Internal class", /^- \*\*Internal\*\*/m.test(doc));
check("doc defines the Public class", /^- \*\*Public\*\*/m.test(doc));
check("doc covers the jobs table (created outside migrations)", doc.includes("`jobs`"));
check("doc covers the resumes storage bucket", doc.includes("`resumes` storage bucket"));
check("doc points at retention policy", doc.includes("retention-policy.md"));
check("doc points at export and deletion handlers", doc.includes("exportHandler.ts") && doc.includes("deleteHandler.ts"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
