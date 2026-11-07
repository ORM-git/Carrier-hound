/**
 * Offline static test for the resume storage boundary (Backend row #70,
 * Upload Type & Size Validation): migration 20261106s aligns the
 * `resumes` bucket file_size_limit / allowed_mime_types with the code
 * contract in src/lib/resume/parser.ts (the real constants, not copies)
 * and re-asserts the owner-path INSERT policy on storage.objects.
 * Run: npx tsx scripts/test-storage-bucket-limits-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const migrationPath = "supabase/migrations/20261106s_resume_bucket_limits.sql";
check("migration file exists", fs.existsSync(migrationPath));
const sql = fs.readFileSync(migrationPath, "utf8");

check(
  "migration marked NOT APPLIED with record command",
  sql.includes("STATUS: NOT APPLIED") &&
    sql.includes("record-migration.cjs 20261106s_resume_bucket_limits")
);

// The bucket limit must equal the real code constant, not a copied number.
const parserSrc = fs.readFileSync("src/lib/resume/parser.ts", "utf8");
const m = parserSrc.match(/MAX_RESUME_UPLOAD_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
check("code contract constant is readable from parser.ts", !!m);
const codeMax = m ? Number(m[1]) * Number(m[2]) * Number(m[3]) : -1;
check(
  "bucket file_size_limit equals MAX_RESUME_UPLOAD_BYTES",
  codeMax > 0 && new RegExp(`file_size_limit = ${codeMax}`).test(sql)
);

check(
  "bucket mime list covers every extension the code accepts",
  ["application/pdf",
   "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
   "text/plain",
   "text/markdown"]
    .every((t) => sql.includes(`'${t}'`)) &&
    /allowed_mime_types = ARRAY\[/.test(sql)
);

check(
  "owner-path INSERT policy on storage.objects (re-)asserted",
  /CREATE POLICY "Owner can insert own resume files"[\s\S]*ON storage\.objects[\s\S]*FOR INSERT[\s\S]*bucket_id = 'resumes'[\s\S]*\(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/.test(sql)
);

check("rollback documented with the prior 20261031 values", /ROLLBACK[\s\S]*5242880[\s\S]*application\/msword/i.test(sql));

// Cross-check the code contract itself still enforces the same constant.
const storageSrc = fs.readFileSync("src/lib/resume/storage.ts", "utf8");
check(
  "server-side upload validation references the shared constant",
  /MAX_RESUME_UPLOAD_BYTES/.test(storageSrc) &&
    /ALLOWED_RESUME_EXTENSIONS/.test(storageSrc)
);

const runner = fs.readFileSync("scripts/suite-runner.ts", "utf8");
check(
  "suite runner registers the policy test",
  runner.includes("scripts/test-storage-bucket-limits-policy.ts")
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
