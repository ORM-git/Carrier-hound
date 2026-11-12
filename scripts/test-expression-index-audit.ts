/**
 * scripts/test-expression-index-audit.ts
 *
 * Offline static guard for docs/expression-index-audit.md.
 * Statically re-derives every query-side expression (WHERE / JOIN / ORDER / GIN /
 * FTS / pattern / functional) from query helper files and SQL migrations, and
 * verifies:
 * 1. Every derived expression is mapped in docs/expression-index-audit.md.
 * 2. Every cited serving index and owning migration actually exists in
 *    supabase/migrations/*.sql.
 * 3. Every GAP row in the coverage table appears in the Explicit Gaps Summary
 *    and matches the stated verdict count.
 * 4. Negative control (--negative-control) proves that an unmapped query-side
 *    expression injected through the exact same derivation + verifier path fails
 *    with exit code 1.
 */

import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const DOC_PATH = "docs/expression-index-audit.md";
const MIGRATIONS_DIR = "supabase/migrations";

export const INSPECTED_TS_FILES = [
  "src/app/api/jobs/search/route.ts",
  "src/lib/jobs/service.ts",
  "src/lib/api/jobs.ts",
  "src/app/api/jobs/suggest/route.ts",
  "src/app/api/jobs/top10/route.ts",
  "src/app/api/jobs/pro/route.ts",
  "src/app/api/ticker/route.ts",
  "src/app/api/stats/route.ts",
  "src/app/api/radar/route.ts",
  "src/components/JobRadarGlobe.tsx",
  "src/lib/countries.ts",
  "src/lib/cron/dailyDigestCron.ts",
  "src/lib/events/failedEvents.ts",
  "src/lib/auth/approval.ts",
  "src/lib/admin/earlyAccess.ts",
  "src/app/api/early-access/route.ts",
  "src/lib/account/deleteHandler.ts",
  "src/lib/admin/auth.ts",
  "src/lib/api/worldwide.ts",
];

export const INSPECTED_SQL_FILES = [
  "supabase/migrations/20261001_filter_upgrades.sql",
  "supabase/migrations/20261101_lock_scraper_metadata.sql",
  "supabase/migrations/20261107a_jobs_role_dedupe.sql",
];

export interface DerivedExpression {
  key: string;
  file: string;
  evidence: string;
}

export interface DocCoverageRow {
  key: string;
  table: string;
  expression: string;
  sites: string;
  servingIndex: string;
  owningMigration: string;
  status: string;
}

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

export function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*/gm, "");
}

function normalizeTable(raw: string): string {
  return raw === "jobs_public" ? "jobs" : raw;
}

function findEnclosingTable(source: string, index: number): string {
  const windowStart = Math.max(0, index - 900);
  const snippet = source.slice(windowStart, index);

  // Match .from("table") or .from(targetTable) when targetTable is jobs/jobs_public
  let lastTable = "jobs";
  const fromRe = /\.from\(\s*(?:["'`]([a-zA-Z0-9_]+)["'`]|(targetTable))\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(snippet)) !== null) {
    lastTable = m[1] ? normalizeTable(m[1]) : "jobs";
  }
  return lastTable;
}

function mapCanonicalKey(table: string, col: string, op: string): string {
  if (table === "jobs") {
    if (col === "title" && op === "ilike") return "jobs.title:ilike";
    if (col === "title" && op === "imatch") return "jobs.title:imatch";
    if (col === "company" && op === "ilike") return "jobs.company:ilike";
    if (col === "location" && op === "ilike") return "jobs.location:ilike";
    if (col === "description" && op === "ilike") return "jobs.description:ilike";
    if (col === "category" && (op === "eq" || op === "in" || op === "ilike")) {
      return "jobs.category:eq_in_ilike";
    }
    if (col === "company_slug" && op === "ilike") return "jobs.company_slug:ilike";
    if (col === "salary_text" && op === "ilike") return "jobs.salary_text:ilike";
    if (col === "job_type" && (op === "eq" || op === "ilike")) {
      return "jobs.job_type:eq_ilike";
    }
    if (col === "source" && op === "ilike") return "jobs.source:ilike";
    if (col === "source_type" && op === "eq") return "jobs.source_type:eq";
    if (col === "country_code" && op === "eq") return "jobs.country_code:eq";
    if (col === "country" && op === "eq") return "jobs.country:eq";
    if (col === "remote_scope" && op === "eq") return "jobs.remote_scope:eq";
    if (col === "salary_min" && op === "gte") return "jobs.salary_min:gte";
    if (col === "created_at" && op === "gte") return "jobs.created_at:gte";
    if (col === "posted_at" && (op === "gte" || op === "lt" || op === "order")) {
      return "jobs.posted_at:range_order";
    }
    if (col === "first_seen_at" && (op === "gte" || op === "order")) {
      return "jobs.first_seen_at:range_order";
    }
    if (col === "discovered_at" && op === "order") return "jobs.discovered_at:order";
    if (
      (col === "is_active" || col === "status" || col === "verified") &&
      (op === "eq" || op === "order")
    ) {
      return "jobs.status_active_verified:eq";
    }
  }

  if (table === "companies") {
    if (col === "id" && op === "in") return "companies.id:in";
    if (col === "name" && op === "in") return "companies.name:in";
  }

  if (table === "worldwide_company_counts") {
    return "worldwide_company_counts.slug:select";
  }

  if (table === "email_suppressions") {
    if (col === "email" && op === "ilike") return "email_suppressions.email:ilike";
    if (col === "email" && (op === "in" || op === "upsert")) {
      return "email_suppressions.email:in_upsert";
    }
  }

  if (table === "early_access_approved" && col === "email" && op === "eq") {
    return "early_access_approved.email:eq";
  }
  if (table === "early_access_emails" && col === "email" && op === "eq") {
    return "early_access_emails.email:eq";
  }
  if (table === "blocked_users" && col === "user_id" && op === "eq") {
    return "blocked_users.user_id:eq";
  }

  return `${table}.${col}:${op}`;
}

export function deriveExpressionsFromTs(rawSource: string, filePath: string): DerivedExpression[] {
  const source = stripTsComments(rawSource);
  const found = new Map<string, DerivedExpression>();
  const add = (key: string, evidence: string) => {
    if (!found.has(key)) {
      found.set(key, { key, file: filePath, evidence });
    }
  };

  // 1. Direct chained PostgREST filter/order methods: .ilike("col", ...), .textSearch("col", ...), etc.
  const methodRe =
    /\.(ilike|like|imatch|textSearch|gte|order)\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(source)) !== null) {
    const opRaw = m[1];
    const col = m[2];
    // Ignore non-jobs operational tables unless explicitly tracked
    const table = findEnclosingTable(source, m.index);
    if (
      ![
        "jobs",
        "companies",
        "worldwide_company_counts",
        "email_suppressions",
        "early_access_approved",
        "early_access_emails",
        "blocked_users",
      ].includes(table)
    ) {
      continue;
    }
    const op = opRaw === "textSearch" ? "fts" : opRaw;
    // Do not flag non-search generic id tie-breaker alone unless paired with verified+posted_at
    if (table === "jobs" && col === "id" && op === "order") continue;
    const key = mapCanonicalKey(table, col, op);
    add(key, `.${opRaw}("${col}", ...)`);
  }

  // 2. Targeted equality / IN filters on tracked columns
  const eqInRe =
    /\.(eq|in)\(\s*["'`](category|country_code|country|remote_scope|job_type|source_type|is_active|status|verified|id|name|email|user_id)["'`]/g;
  while ((m = eqInRe.exec(source)) !== null) {
    const op = m[1];
    const col = m[2];
    const table = findEnclosingTable(source, m.index);
    if (
      table === "jobs" &&
      ["category", "country_code", "country", "remote_scope", "job_type", "source_type", "is_active", "status", "verified"].includes(col)
    ) {
      add(mapCanonicalKey("jobs", col, op), `.${op}("${col}", ...)`);
    } else if (table === "companies" && (col === "id" || col === "name") && op === "in") {
      add(mapCanonicalKey("companies", col, op), `.${op}("${col}", ...)`);
    } else if (table === "email_suppressions" && col === "email" && op === "in") {
      add("email_suppressions.email:in_upsert", `.in("email", ...)`);
    } else if (table === "early_access_approved" && col === "email" && op === "eq") {
      add("early_access_approved.email:eq", `.eq("email", ...)`);
    } else if (table === "early_access_emails" && col === "email" && op === "eq") {
      add("early_access_emails.email:eq", `.eq("email", ...)`);
    } else if (table === "blocked_users" && col === "user_id" && op === "eq") {
      add("blocked_users.user_id:eq", `.eq("user_id", ...)`);
    }
  }

  // 3. Upsert onConflict on email_suppressions
  const upsertEmailRe = /\.from\(\s*["'`]email_suppressions["'`]\s*\)[\s\S]{0,220}onConflict:\s*["'`]email["'`]/g;
  if (upsertEmailRe.test(source)) {
    add("email_suppressions.email:in_upsert", `email_suppressions.upsert(..., { onConflict: "email" })`);
  }

  // 4. Worldwide MV select
  if (/\.from\(\s*["'`]worldwide_company_counts["'`]\s*\)/.test(source)) {
    add("worldwide_company_counts.slug:select", `.from("worldwide_company_counts")`);
  }

  // 5. PostgREST .or(...) filter clause expressions inside string/template literals
  const postgrestExprRe =
    /(?:["'`]|[,(])([a-zA-Z_][a-zA-Z0-9_]*)\.(?:(not)\.)?(ilike|imatch|eq|fts)\./g;
  while ((m = postgrestExprRe.exec(source)) !== null) {
    const col = m[1];
    const op = m[3];
    // Filter out TypeScript / DOM identifiers that look like obj.eq.foo (there shouldn't be trailing dots unless PostgREST)
    if (
      ![
        "title",
        "company",
        "location",
        "description",
        "category",
        "company_slug",
        "salary_text",
        "job_type",
        "source",
        "source_type",
        "country_code",
        "country",
        "remote_scope",
        "remote_eligibility",
        "remote",
      ].includes(col) &&
      op === "eq"
    ) {
      continue;
    }
    if (col === "remote" || col === "remote_eligibility") continue;
    const key = mapCanonicalKey("jobs", col, op);
    add(key, `PostgREST clause "${col}.${m[2] ? "not." : ""}${op}..."`);
  }

  // 6. Composite verified + posted_at + id keyset/match sort
  if (
    /\.order\(\s*["'`]verified["'`]/.test(source) &&
    /\.order\(\s*["'`]posted_at["'`]/.test(source)
  ) {
    add(
      "jobs.keyset_sort:verified_posted_at_id",
      `.order("verified", ...) + .order("posted_at", ...)`
    );
  }

  return Array.from(found.values());
}

export function deriveExpressionsFromSql(rawSql: string, filePath: string): DerivedExpression[] {
  const sql = stripSqlComments(rawSql);
  const found = new Map<string, DerivedExpression>();
  const add = (key: string, evidence: string) => {
    if (!found.has(key)) {
      found.set(key, { key, file: filePath, evidence });
    }
  };

  if (/search_vector\s+tsvector\s+GENERATED\s+ALWAYS/i.test(sql)) {
    add("jobs.search_vector:fts", "search_vector tsvector GENERATED ALWAYS");
  }
  if (/LOWER\s*\(\s*TRIM\s*\(\s*j\.company\s*\)\s*\)\s*=\s*LOWER\s*\(\s*TRIM\s*\(\s*c\.name\s*\)\s*\)/i.test(sql)) {
    add(
      "jobs.company_lower_trim_join:expr",
      "LOWER(TRIM(j.company)) = LOWER(TRIM(c.name))"
    );
  }
  if (/j\.location\s+ILIKE\s+'%/i.test(sql)) {
    add("jobs.location:ilike", "j.location ILIKE '%...'");
  }
  if (/j\.remote_scope\s*=\s*'worldwide'/i.test(sql)) {
    add("jobs.remote_scope:eq", "j.remote_scope = 'worldwide'");
  }
  if (/public\.jobs_role_key\s*\(\s*(?:j\.)?company\s*,\s*(?:j\.)?title\s*,\s*(?:j\.)?location\s*\)/i.test(sql)) {
    add("jobs.role_key:expr", "public.jobs_role_key(company, title, location)");
  }
  if (/CREATE\s+MATERIALIZED\s+VIEW\s+public\.worldwide_company_counts/i.test(sql)) {
    add("worldwide_company_counts.slug:select", "worldwide_company_counts MV");
  }

  return Array.from(found.values());
}

export function parseAuditDoc(markdown: string): {
  verdictGapCount: number | null;
  rows: DocCoverageRow[];
  gapSummaryItems: string[];
} {
  const verdictMatch = markdown.match(/\*\*Verdict:\s*PARTIAL\s*[—-]\s*(\d+)\s*gaps?/i);
  const verdictGapCount = verdictMatch ? Number(verdictMatch[1]) : null;

  const rows: DocCoverageRow[] = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 7) continue;
    if (cells[0] === "Expression Key" || /^:?-+:?$/.test(cells[0])) continue;

    rows.push({
      key: cells[0].replace(/`/g, ""),
      table: cells[1].replace(/`/g, ""),
      expression: cells[2],
      sites: cells[3],
      servingIndex: cells[4],
      owningMigration: cells[5].replace(/`/g, ""),
      status: cells[6],
    });
  }

  const gapSummaryItems: string[] = [];
  const summarySection = markdown.split("## Explicit Gaps Summary")[1] || "";
  const summaryBody = summarySection.split("\n## ")[0] || "";
  const gapBulletRe = /^\d+\.\s+\*\*`([^`]+)`/gm;
  let gm: RegExpExecArray | null;
  while ((gm = gapBulletRe.exec(summaryBody)) !== null) {
    gapSummaryItems.push(gm[1]);
  }

  return { verdictGapCount, rows, gapSummaryItems };
}

export function loadMigrationIndexCatalog(): Map<string, Set<string>> {
  const catalog = new Map<string, Set<string>>();
  const migDir = path.join(ROOT, MIGRATIONS_DIR);
  for (const file of fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = stripSqlComments(fs.readFileSync(path.join(migDir, file), "utf8"));
    const names = new Set<string>();
    const idxRe =
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = idxRe.exec(sql)) !== null) {
      names.add(m[1]);
    }
    const conRe = /ADD\s+CONSTRAINT\s+([a-zA-Z0-9_]+)/gi;
    while ((m = conRe.exec(sql)) !== null) {
      names.add(m[1]);
    }
    catalog.set(file, names);
  }
  return catalog;
}

export function verifyAudit(options?: {
  extraTsFixture?: { filePath: string; content: string };
  docContent?: string;
}): string[] {
  const errors: string[] = [];
  const docText =
    options?.docContent ?? fs.readFileSync(path.join(ROOT, DOC_PATH), "utf8");
  const doc = parseAuditDoc(docText);

  if (doc.rows.length === 0) {
    errors.push(`${DOC_PATH} contains 0 parsed rows in Coverage Table`);
    return errors;
  }

  const derived = new Map<string, DerivedExpression[]>();
  const record = (items: DerivedExpression[]) => {
    for (const item of items) {
      const list = derived.get(item.key) || [];
      list.push(item);
      derived.set(item.key, list);
    }
  };

  for (const relPath of INSPECTED_TS_FILES) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      errors.push(`Missing inspected TS file: ${relPath}`);
      continue;
    }
    record(deriveExpressionsFromTs(fs.readFileSync(abs, "utf8"), relPath));
  }

  for (const relPath of INSPECTED_SQL_FILES) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      errors.push(`Missing inspected SQL file: ${relPath}`);
      continue;
    }
    record(deriveExpressionsFromSql(fs.readFileSync(abs, "utf8"), relPath));
  }

  if (options?.extraTsFixture) {
    record(
      deriveExpressionsFromTs(
        options.extraTsFixture.content,
        options.extraTsFixture.filePath
      )
    );
  }

  const docByKey = new Map(doc.rows.map((r) => [r.key, r]));

  // 1. Every derived expression from code & migrations must appear in the coverage table
  for (const [key, occurrences] of Array.from(derived.entries())) {
    if (!docByKey.has(key)) {
      const sample = occurrences[0];
      errors.push(
        `Derived query expression "${key}" (${sample.file}: ${sample.evidence}) is MISSING from ${DOC_PATH}`
      );
    }
  }

  // 2. No stale rows in doc that were not derived from code or migrations
  for (const row of doc.rows) {
    if (!derived.has(row.key)) {
      errors.push(
        `Stale coverage row "${row.key}" in ${DOC_PATH} was not derived from inspected source files`
      );
    }
  }

  // 3. Verify every cited serving index & owning migration actually exists
  const migrationCatalog = loadMigrationIndexCatalog();
  for (const row of doc.rows) {
    if (row.status === "GAP") {
      if (row.owningMigration !== "—") {
        errors.push(`GAP row "${row.key}" should have owning migration "—" (got "${row.owningMigration}")`);
      }
      continue;
    }

    const migrations = row.owningMigration
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (migrations.length === 0 || row.owningMigration === "—") {
      errors.push(`Non-GAP row "${row.key}" must cite an owning migration`);
      continue;
    }
    for (const mig of migrations) {
      if (!migrationCatalog.has(mig)) {
        errors.push(`Row "${row.key}" cites nonexistent migration "${mig}"`);
      }
    }

    // Backticked index/constraint identifiers in servingIndex column
    const citedIdxRe = /`([a-z][a-z0-9_]+)`/g;
    let im: RegExpExecArray | null;
    while ((im = citedIdxRe.exec(row.servingIndex)) !== null) {
      const ident = im[1];
      if (!/^(?:idx_|jobs_|applications_|company_)/.test(ident) && !/(?:_idx|_unique|_key|_lookup)$/.test(ident)) continue;
      const foundInCited = migrations.some((mig) =>
        migrationCatalog.get(mig)?.has(ident)
      );
      if (!foundInCited) {
        errors.push(
          `Row "${row.key}" cites index/constraint "${ident}" not declared in [${migrations.join(", ")}]`
        );
      }
    }
  }

  // 4. GAP rows match Explicit Gaps Summary and Verdict count
  const gapRows = doc.rows.filter((r) => r.status === "GAP");
  if (doc.verdictGapCount !== gapRows.length) {
    errors.push(
      `Verdict gap count (${doc.verdictGapCount}) does not match GAP row count (${gapRows.length})`
    );
  }
  const summarySet = new Set(doc.gapSummaryItems);
  for (const g of gapRows) {
    if (!summarySet.has(g.key)) {
      errors.push(`GAP row "${g.key}" missing from Explicit Gaps Summary section`);
    }
  }
  if (doc.gapSummaryItems.length !== gapRows.length) {
    errors.push(
      `Explicit Gaps Summary item count (${doc.gapSummaryItems.length}) != GAP rows (${gapRows.length})`
    );
  }

  return errors;
}

function runNegativeControl(): never {
  console.error("Running --negative-control with synthetic unmapped query expression...");
  const errors = verifyAudit({
    extraTsFixture: {
      filePath: "src/app/api/jobs/__fixture_unmapped__/route.ts",
      content: `
        const q = supabaseAdmin
          .from("jobs")
          .select("id")
          .eq("is_active", true)
          .ilike("skills_raw", "%rust%");
      `,
    },
  });

  if (errors.length === 0) {
    console.error("NEGATIVE CONTROL FAILED: unmapped query expression was NOT caught!");
    process.exit(0);
  }

  console.error(
    `NEGATIVE CONTROL PASSED: caught unmapped query expression with ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`
  );
  process.exit(1);
}

function main() {
  if (process.argv.includes("--negative-control")) {
    runNegativeControl();
  }

  console.log("=== Expression Index Audit Offline Guard Test ===");

  // 1. Check doc exists
  assert.ok(
    fs.existsSync(path.join(ROOT, DOC_PATH)),
    `Missing required audit doc: ${DOC_PATH}`
  );
  console.log(`  [PASS] 1. ${DOC_PATH} exists`);

  // 2. Run real codebase + migration derivation against docs/expression-index-audit.md
  const errors = verifyAudit();
  assert.strictEqual(
    errors.length,
    0,
    `Audit verification failed:\n  - ${errors.join("\n  - ")}`
  );

  const doc = parseAuditDoc(fs.readFileSync(path.join(ROOT, DOC_PATH), "utf8"));
  const gapCount = doc.rows.filter((r) => r.status === "GAP").length;
  console.log(
    `  [PASS] 2. All ${doc.rows.length} derived query expressions verified against ${DOC_PATH} (${gapCount} gaps confirmed)`
  );

  // 3. Negative control in-process check for new .textSearch("search_vector") usage
  const ftsErrors = verifyAudit({
    extraTsFixture: {
      filePath: "src/app/api/jobs/__fixture_fts__/route.ts",
      content: `supabase.from("jobs").select("id").textSearch("description_raw", "postgres");`,
    },
  });
  assert.ok(
    ftsErrors.some((e) => e.includes("jobs.description_raw:fts")),
    "Negative control must catch unmapped .textSearch() expression"
  );
  console.log("  [PASS] 3. In-process check catches unmapped .textSearch() expressions");

  // 4. Subprocess --negative-control must exit 1
  const child = spawnSync("npx", ["tsx", path.resolve(__filename), "--negative-control"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  assert.strictEqual(
    child.status,
    1,
    `Subprocess --negative-control must exit 1 (got ${child.status})`
  );
  assert.ok(
    child.stderr.includes("NEGATIVE CONTROL PASSED"),
    `Subprocess stderr must confirm negative control pass (got: ${child.stderr})`
  );
  console.log("  [PASS] 4. Subprocess --negative-control exited 1 and detected synthetic unmapped expression");

  console.log("\nALL EXPRESSION INDEX AUDIT CHECKS PASSED (PASS-LOCAL).");
}

main();
