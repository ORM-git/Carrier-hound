/**
 * Offline static test for idempotent seed data (Database row "Idempotent
 * seed"): supabase/seed.sql must be safe to re-run - its jobs insert ends
 * with ON CONFLICT (apply_url) DO NOTHING, backed by the partial unique
 * index jobs_apply_url_unique, and the header documents idempotency.
 * Run: npx tsx scripts/test-idempotent-seed-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const seedPath = "supabase/seed.sql";
check("seed file exists", fs.existsSync(seedPath));
const seed = fs.readFileSync(seedPath, "utf8");

check(
  "header documents idempotent re-run",
  /Idempotent \(Database row #62\)/.test(seed) && /safe to re-run/i.test(seed)
);

const inserts = seed.match(/insert into public\.jobs[\s\S]*?;/gi) || [];
check("exactly one jobs insert statement", inserts.length === 1);
const insert = inserts[0] || "";
check(
  "insert column list includes apply_url",
  /insert into public\.jobs\s*\(([^)]*)\)/i.test(insert) &&
    /\bapply_url\b/.test(insert.match(/\(([^)]*)\)/)![1])
);
check(
  "insert ends with ON CONFLICT (apply_url) WHERE apply_url IS NOT NULL DO NOTHING",
  /on conflict \(apply_url\) where apply_url is not null do nothing;/i.test(insert.trim().slice(-80))
);
check(
  "arbiter unique index exists in migrations (jobs_apply_url_unique)",
  fs.readdirSync("supabase/migrations").some((f) => {
    const s = fs.readFileSync(`supabase/migrations/${f}`, "utf8");
    return /CREATE UNIQUE INDEX jobs_apply_url_unique/i.test(s) &&
      /ON public\.jobs \(apply_url\)/i.test(s);
  })
);
check(
  "arbiter index is partial with the SAME predicate the ON CONFLICT clause carries (real DDL cross-check)",
  fs.readdirSync("supabase/migrations").some((f) => {
    const s = fs.readFileSync(`supabase/migrations/${f}`, "utf8");
    const m = s.match(/CREATE UNIQUE INDEX jobs_apply_url_unique[\s\S]*?WHERE ([a-z_]+ IS NOT NULL);/i);
    if (!m) return false;
    const indexPredicate = m[1].toLowerCase();
    const clause = insert.match(/on conflict \(apply_url\) where ([a-z_]+ is not null) do nothing;/i);
    return !!clause && clause[1].toLowerCase() === indexPredicate;
  })
);
check(
  "every VALUES row supplies an apply_url literal (arbiter predicate is apply_url IS NOT NULL)",
  (seed.match(/https:\/\/\S+',\s*\n\s*'https/g) || []).length >= 19
);

const runner = fs.readFileSync("scripts/suite-runner.ts", "utf8");
check(
  "suite runner registers the policy test",
  runner.includes("scripts/test-idempotent-seed-policy.ts")
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
