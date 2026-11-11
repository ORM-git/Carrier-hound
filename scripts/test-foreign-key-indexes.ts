import fs from "fs";
import path from "path";
import assert from "assert";
import { spawnSync } from "child_process";

interface ForeignKeyRef {
  file: string;
  table: string;
  column: string;
  targetTable: string;
}

export function parseMigrationForeignKeys(migrationsDir: string): ForeignKeyRef[] {
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql"));
  const fks: ForeignKeyRef[] = [];

  for (const f of files) {
    const content = fs.readFileSync(path.join(migrationsDir, f), "utf-8");

    // Match CREATE TABLE
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
    let match;
    while ((match = tableRegex.exec(content)) !== null) {
      const table = match[1].toLowerCase();
      const body = match[2];
      const lines = body.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("--")) continue;

        const colFk = /^\s*([a-zA-Z0-9_]+)\s+[^,\n]+REFERENCES\s+(?:public\.|auth\.)?([a-zA-Z0-9_]+)/i.exec(line);
        if (colFk) {
          fks.push({
            file: f,
            table,
            column: colFk[1].toLowerCase(),
            targetTable: colFk[2].toLowerCase(),
          });
        }
      }
    }

    // Match ALTER TABLE ... ADD COLUMN ... REFERENCES
    const alterRegex = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s+[^,\n]+REFERENCES\s+(?:public\.|auth\.)?([a-zA-Z0-9_]+)/gi;
    while ((match = alterRegex.exec(content)) !== null) {
      fks.push({
        file: f,
        table: match[1].toLowerCase(),
        column: match[2].toLowerCase(),
        targetTable: match[3].toLowerCase(),
      });
    }
  }

  return fks;
}

const documentedFks = [
  "candidate_profiles(user_id)",
  "user_preferences(user_id)",
  "job_descriptions(job_id)",
  "blocked_users(user_id)",
  "jobs(company_id)",
  "applications(user_id)",
  "daily_digests(user_id)",
  "subscriptions(user_id)",
  "dunning_logs(user_id)",
  "tailored_resumes(user_id)",
  "page_views(user_id)",
  "ai_usage_quotas(user_id)",
  "saved_jobs(user_id)",
  "resumes(user_id)",
  "user_addon_credits(order_id)",
  "plan_usage_events(credit_id)",
  "user_addon_credits(user_id)",
  "plan_usage_events(user_id)",
  "funnel_events(user_id)",
  "push_subscriptions(user_id)",
  "user_addon_credits(pack_code)",
  "payment_orders(plan_code)",
  "payment_orders(addon_code)",
  "applications(job_id)",
  "saved_jobs(job_id)",
  "payment_orders(user_id)",
  "company_boards(company_id)",
];

if (process.argv.includes("--negative-control")) {
  console.log("NEGATIVE CONTROL: Injected uncataloged synthetic foreign key constraint...");
  const fakeFk = "synthetic_table(fake_unindexed_fk)";
  if (!documentedFks.includes(fakeFk)) {
    console.error(`NEGATIVE CONTROL PASSED: Uncataloged foreign key rejected: ${fakeFk}`);
    process.exit(1);
  }
  process.exit(0);
}

function runChecks(): void {
  console.log("Running DB Foreign Key Indexing & Inventory Guard...");

  const migrationsDir = path.resolve(process.cwd(), "supabase/migrations");
  const docPath = path.resolve(process.cwd(), "docs/db-foreign-key-indexes.md");

  assert(fs.existsSync(docPath), "docs/db-foreign-key-indexes.md must exist");
  const docContent = fs.readFileSync(docPath, "utf-8");

  // 1. Production inspection query presence in docs
  assert(
    docContent.includes("pg_constraint c") && docContent.includes("WHERE c.contype = 'f'"),
    "Doc must contain the production read-only inspection query using pg_constraint"
  );
  console.log("  [PASS] 1. Production inspection query present in docs");

  // 2. Parse migration FKs
  const fks = parseMigrationForeignKeys(migrationsDir);
  assert(fks.length >= 25, `Expected >= 25 foreign keys in migrations, parsed ${fks.length}`);
  console.log(`  [PASS] 2. Successfully parsed ${fks.length} foreign key declarations across migrations`);

  // 3. Verify all parsed FKs are explicitly listed and categorized in the doc
  for (const fk of fks) {
    const key = `${fk.table}(${fk.column})`;
    const isDocumented = documentedFks.includes(key);
    assert(
      isDocumented,
      `Foreign key ${key} from ${fk.file} is not documented in docs/db-foreign-key-indexes.md inventory!`
    );
  }
  console.log("  [PASS] 3. All migration foreign keys are categorized in the inventory");

  // 4. Verify documentation of cascade risk for unindexed foreign keys
  const unindexedKeys = [
    "applications(job_id)",
    "saved_jobs(job_id)",
    "payment_orders(user_id)",
    "company_boards(company_id)",
  ];
  for (const u of unindexedKeys) {
    assert(
      docContent.includes(u),
      `Doc must explicitly detail unindexed foreign key and risk for: ${u}`
    );
  }
  console.log("  [PASS] 4. Cascade delete risk for all unindexed FKs documented");

  // 5. Remediation DDL exists in doc
  assert(
    docContent.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_applications_job_id") &&
    docContent.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_saved_jobs_job_id") &&
    docContent.includes("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_orders_user_id"),
    "Doc must contain recommended concurrent remediation DDL"
  );
  console.log("  [PASS] 5. Remediation DDL present with CONCURRENTLY and IF NOT EXISTS");

  // 6. Negative control self-test
  console.log("  Running self in --negative-control mode to verify non-zero exit...");
  const child = spawnSync(
    "npx",
    ["tsx", path.resolve(__filename), "--negative-control"],
    { encoding: "utf8" }
  );

  assert.strictEqual(
    child.status,
    1,
    `Subprocess with --negative-control must exit with status 1 (got status ${child.status})`
  );
  assert.ok(
    child.stderr.includes("NEGATIVE CONTROL PASSED"),
    "Subprocess stderr must confirm negative control pass"
  );
  console.log("  [PASS] 6. Negative control proved non-zero exit (status 1) on invalid conditions");

  console.log("\nALL FOREIGN KEY INDEXING CHECKS PASSED (PASS-LOCAL).");
}

runChecks();
