/**
 * Offline static test for the NOT VALID then VALIDATE pattern (Database
 * row "NOT VALID then VALIDATE"): migration 20261106o adds
 * jobs_salary_bounds_check to public.jobs as NOT VALID (no table scan,
 * immediate enforcement for new writes) with a separate, commented,
 * off-peak VALIDATE phase, lock semantics documented, an audit query in
 * db-health.sql, and a rollback block.
 * Run: npx tsx scripts/test-not-valid-validate-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const migrationPath = "supabase/migrations/20261106o_not_valid_validate_pattern.sql";
check("migration file exists", fs.existsSync(migrationPath));
const sql = fs.readFileSync(migrationPath, "utf8");

check(
  "migration marked NOT APPLIED with record command",
  sql.includes("STATUS: NOT APPLIED") &&
    sql.includes("record-migration.cjs 20261106o_not_valid_validate_pattern")
);
check(
  "constraint added with NOT VALID (phase 1 active)",
  /ALTER TABLE public\.jobs\s+ADD CONSTRAINT jobs_salary_bounds_check\s+CHECK \(salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max\)\s+NOT VALID;/i.test(sql)
);
check(
  "VALIDATE phase present and commented out (separate off-peak run)",
  /^\s*--\s*ALTER TABLE public\.jobs VALIDATE CONSTRAINT jobs_salary_bounds_check;/m.test(sql)
);
check(
  "no unconstrained inline CHECK on jobs in this migration (NOT VALID pattern only)",
  !/ADD CONSTRAINT jobs_salary_bounds_check[^;]*\)\s*;/i.test(sql.replace(/NOT VALID/i, ""))
);
check(
  "lock semantics documented (SHARE UPDATE EXCLUSIVE, no write blocking)",
  /SHARE UPDATE EXCLUSIVE/.test(sql) && /ACCESS EXCLUSIVE/.test(sql)
);
check(
  "documents that new writes are enforced immediately",
  /enforced immediately/i.test(sql)
);
check(
  "audit-before-validate instructions present",
  /audit query/i.test(sql) && /db-health\.sql section 16/.test(sql)
);
check(
  "constraint name not already used by an earlier migration",
  !fs.readdirSync("supabase/migrations").some(
    (f) => f !== "20261106o_not_valid_validate_pattern.sql" &&
      fs.readFileSync(`supabase/migrations/${f}`, "utf8").includes("jobs_salary_bounds_check")
  )
);
check("rollback documented", /ROLLBACK[\s\S]*DROP CONSTRAINT IF EXISTS jobs_salary_bounds_check/i.test(sql));

const health = fs.readFileSync("scripts/db-health.sql", "utf8");
check(
  "db-health has constraint validation review section",
  /16\. Constraint validation/.test(health) && health.includes("convalidated")
);
check(
  "db-health includes the violating-rows audit query",
  /salary_bounds_violations/.test(health)
);

const runner = fs.readFileSync("scripts/suite-runner.ts", "utf8");
check(
  "suite runner registers the policy test",
  runner.includes("scripts/test-not-valid-validate-policy.ts")
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
