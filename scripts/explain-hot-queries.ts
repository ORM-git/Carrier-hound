/**
 * scripts/explain-hot-queries.ts
 *
 * Service-role READ-ONLY query plan capture script for CareerMonke hot queries.
 * Executes PostgreSQL EXPLAIN ONLY (strictly NEVER EXPLAIN ANALYZE and never any
 * DML/DDL/write operation) via PostgREST `.explain({ analyze: false })` and
 * writes one dated markdown file per catalog query under docs/perf/query-plans/.
 *
 * Usage:
 *   npx tsx scripts/explain-hot-queries.ts --dry-run
 *   npx tsx scripts/explain-hot-queries.ts [--date YYYY-MM-DD] [--query <id>]
 *
 * Required env (live capture only; --dry-run does not connect):
 *   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type HotQueryCategory =
  | "job-match-feed"
  | "digest-candidate-selection"
  | "reconciliation-aggregates"
  | "public-jobs-listing";

export interface HotQueryCatalogEntry {
  id: string;
  category: HotQueryCategory;
  name: string;
  description: string;
  sourceFiles: string[];
  sql: string;
  sampleParams: Array<{ name: string; value: string | number | boolean }>;
  expectedPlanSignals: string[];
  buildExplainRequest: (client: SupabaseClient<any, any, any>) => PromiseLike<{ data: any; error: any }>;
}

export const SAFE_EXPLAIN_OPTIONS = Object.freeze({
  analyze: false as const,
  verbose: true,
  format: "text" as const,
});

const FORBIDDEN_SQL_KEYWORDS =
  /\b(ANALYZE|INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|CALL|DO|COPY|VACUUM|REINDEX|CLUSTER|LOCK)\b/i;

/**
 * Validates that a catalog SQL statement is strictly a single READ-ONLY EXPLAIN
 * statement and never invokes EXPLAIN ANALYZE or any mutating keyword.
 */
export function assertExplainOnlySql(rawSql: string, queryId = "<unknown>"): string {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    throw new Error(`[explain-hot-queries] Query "${queryId}" has empty SQL`);
  }
  if (!/^EXPLAIN\b/i.test(trimmed)) {
    throw new Error(`[explain-hot-queries] Query "${queryId}" must start with EXPLAIN`);
  }
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error(`[explain-hot-queries] Query "${queryId}" must be a single SQL statement`);
  }
  if (FORBIDDEN_SQL_KEYWORDS.test(withoutTrailingSemicolon)) {
    const match = withoutTrailingSemicolon.match(FORBIDDEN_SQL_KEYWORDS);
    throw new Error(
      `[explain-hot-queries] Query "${queryId}" contains forbidden keyword "${match?.[0]}" (EXPLAIN ANALYZE and mutations are strictly prohibited)`
    );
  }
  return trimmed;
}

export const HOT_QUERY_CATALOG: ReadonlyArray<HotQueryCatalogEntry> = [
  {
    id: "job-match-feed",
    category: "job-match-feed",
    name: "Job Match / Personalized Feed",
    description:
      "Active job prefiltering by title relevance terms sorted by posted_at DESC, id DESC for personalized Pro match feeds and filtered search.",
    sourceFiles: [
      "src/app/api/jobs/top10/route.ts",
      "src/app/api/jobs/search/route.ts",
      "src/lib/jobs/service.ts",
    ],
    sql: `EXPLAIN (FORMAT TEXT, VERBOSE)
SELECT id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at
FROM public.jobs
WHERE is_active = $1
  AND status = $2
  AND (title ILIKE $3 OR title ILIKE $4)
ORDER BY posted_at DESC NULLS LAST, id DESC
LIMIT $5;`,
    sampleParams: [
      { name: "$1 (is_active)", value: true },
      { name: "$2 (status)", value: "active" },
      { name: "$3 (term_1)", value: "%engineer%" },
      { name: "$4 (term_2)", value: "%typescript%" },
      { name: "$5 (limit)", value: 120 },
    ],
    expectedPlanSignals: [
      "Bitmap Index Scan on idx_jobs_title_trgm (trigram GIN) for 3+ char terms",
      "Watch for Seq Scan on public.jobs or expensive Sort nodes when keyset filters widen",
    ],
    buildExplainRequest: (client) =>
      client
        .from("jobs")
        .select(
          "id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, country_code, posted_at, first_seen_at"
        )
        .eq("is_active", true)
        .eq("status", "active")
        .or("title.ilike.%engineer%,title.ilike.%typescript%")
        .order("posted_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .limit(120)
        .explain(SAFE_EXPLAIN_OPTIONS),
  },
  {
    id: "digest-candidate-selection",
    category: "digest-candidate-selection",
    name: "Digest Candidate Selection",
    description:
      "Selects confirmed candidate profiles with non-null skills arrays for daily digest scoring.",
    sourceFiles: ["src/lib/cron/dailyDigestCron.ts"],
    sql: `EXPLAIN (FORMAT TEXT, VERBOSE)
SELECT user_id, name, email, headline, skills, experience_json, education_json, certifications, confirmed_at, updated_at
FROM public.candidate_profiles
WHERE skills IS NOT NULL
ORDER BY updated_at DESC
LIMIT $1;`,
    sampleParams: [{ name: "$1 (limit)", value: 500 }],
    expectedPlanSignals: [
      "Low-cost scan over public.candidate_profiles bounded by skills IS NOT NULL",
      "Check sort cost growth as candidate_profiles row count scales",
    ],
    buildExplainRequest: (client) =>
      client
        .from("candidate_profiles")
        .select(
          "user_id, name, email, headline, skills, experience_json, education_json, certifications, confirmed_at, updated_at"
        )
        .not("skills", "is", null)
        .order("updated_at", { ascending: false })
        .limit(500)
        .explain(SAFE_EXPLAIN_OPTIONS),
  },
  {
    id: "reconciliation-aggregates",
    category: "reconciliation-aggregates",
    name: "Reconciliation Parity Aggregates",
    description:
      "Scheduled reconciliation count parity check between raw public.jobs and public.jobs_public view.",
    sourceFiles: [
      "scripts/run-db-reconciliation.ts",
      "supabase/scripts/reconciliation.sql",
    ],
    sql: `EXPLAIN (FORMAT TEXT, VERBOSE)
SELECT
  COUNT(*) FILTER (WHERE is_active = $1 OR status = $2) AS expected_public_jobs,
  COUNT(*) FILTER (WHERE NOT (is_active = $1 OR status = $2)) AS inactive_raw_jobs
FROM public.jobs;`,
    sampleParams: [
      { name: "$1 (is_active)", value: true },
      { name: "$2 (status)", value: "active" },
    ],
    expectedPlanSignals: [
      "Index Only Scan or BitmapOr on jobs_is_active_idx / active partial indexes",
      "Flag Parallel Seq Scan timeouts on high row counts",
    ],
    buildExplainRequest: (client) =>
      client
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .or("is_active.eq.true,status.eq.active")
        .explain(SAFE_EXPLAIN_OPTIONS),
  },
  {
    id: "public-jobs-listing",
    category: "public-jobs-listing",
    name: "Public Jobs Listing",
    description:
      "Unauthenticated / free-tier paginated listing from public.jobs_public ordered by first_seen_at DESC, id DESC.",
    sourceFiles: [
      "src/lib/api/jobs.ts",
      "src/app/api/jobs/search/route.ts",
    ],
    sql: `EXPLAIN (FORMAT TEXT, VERBOSE)
SELECT id, title, location, remote, remote_scope, remote_eligibility, job_type, category, country_code, verified, posted_at, first_seen_at
FROM public.jobs_public
WHERE is_active = $1
  AND status = $2
  AND country_code = $3
ORDER BY first_seen_at DESC, id DESC
LIMIT $4 OFFSET $5;`,
    sampleParams: [
      { name: "$1 (is_active)", value: true },
      { name: "$2 (status)", value: "active" },
      { name: "$3 (country_code)", value: "US" },
      { name: "$4 (limit)", value: 25 },
      { name: "$5 (offset)", value: 0 },
    ],
    expectedPlanSignals: [
      "Index Scan Backward on jobs_active_list_covering_idx or Bitmap Index Scan on jobs_country_code_idx",
      "Verify status = 'active' predicate allows partial index usage underneath jobs_public",
    ],
    buildExplainRequest: (client) =>
      client
        .from("jobs_public")
        .select(
          "id, title, location, remote, remote_scope, remote_eligibility, job_type, category, country_code, verified, posted_at, first_seen_at"
        )
        .eq("is_active", true)
        .eq("status", "active")
        .eq("country_code", "US")
        .order("first_seen_at", { ascending: false })
        .order("id", { ascending: false })
        .range(0, 24)
        .explain(SAFE_EXPLAIN_OPTIONS),
  },
];

export interface CliOptions {
  dryRun: boolean;
  dateStamp: string;
  queryId?: string;
  outDir: string;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let help = false;
  let dateStamp = new Date().toISOString().slice(0, 10);
  let queryId: string | undefined;
  let outDir = "docs/perf/query-plans";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--date" && argv[i + 1]) {
      dateStamp = argv[++i];
    } else if (arg.startsWith("--date=")) {
      dateStamp = arg.slice("--date=".length);
    } else if (arg === "--query" && argv[i + 1]) {
      queryId = argv[++i];
    } else if (arg.startsWith("--query=")) {
      queryId = arg.slice("--query=".length);
    } else if (arg === "--out-dir" && argv[i + 1]) {
      outDir = argv[++i];
    } else if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length);
    }
  }

  return { dryRun, dateStamp, queryId, outDir, help };
}

export function formatPlanMarkdown(params: {
  entry: HotQueryCatalogEntry;
  dateStamp: string;
  planText: string;
}): string {
  const { entry, dateStamp, planText } = params;
  const paramLines = entry.sampleParams
    .map((p) => `- \`${p.name}\`: \`${JSON.stringify(p.value)}\``)
    .join("\n");
  const signalLines = entry.expectedPlanSignals.map((s) => `- ${s}`).join("\n");

  return [
    `# Query Plan Capture: ${entry.name} (\`${entry.id}\`)`,
    "",
    `- **Captured Date**: ${dateStamp}`,
    `- **Category**: \`${entry.category}\``,
    `- **Mode**: \`EXPLAIN\` only (\`analyze: false\`, read-only)`,
    `- **Code Sources**: ${entry.sourceFiles.map((f) => `\`${f}\``).join(", ")}`,
    "",
    `## Purpose`,
    "",
    entry.description,
    "",
    `## Parameterized SQL (EXPLAIN Only)`,
    "",
    "```sql",
    entry.sql.trim(),
    "```",
    "",
    "### Sample Parameters",
    "",
    paramLines,
    "",
    "## Captured Plan",
    "",
    "```text",
    planText.trim(),
    "```",
    "",
    "## Review Checklist Signals",
    "",
    signalLines,
    "",
  ].join("\n");
}

function printDryRun(entries: ReadonlyArray<HotQueryCatalogEntry>, outDir: string, dateStamp: string): void {
  console.log("=== explain-hot-queries (--dry-run: no DB connection made) ===");
  console.log(`Planned output dir: ${outDir}`);
  console.log(`Capture date: ${dateStamp}`);
  console.log(`Catalog entries: ${entries.length}\n`);

  for (const entry of entries) {
    assertExplainOnlySql(entry.sql, entry.id);
    console.log(`--- [${entry.id}] ${entry.name} (${entry.category}) ---`);
    console.log(`Sources: ${entry.sourceFiles.join(", ")}`);
    console.log(
      `Sample Params: ${entry.sampleParams.map((p) => `${p.name}=${JSON.stringify(p.value)}`).join(", ")}`
    );
    console.log(`Target File: ${path.posix.join(outDir.replace(/\\/g, "/"), `${dateStamp}-${entry.id}.md`)}`);
    console.log(entry.sql);
    console.log("");
  }
}

async function runLiveCapture(
  entries: ReadonlyArray<HotQueryCatalogEntry>,
  opts: CliOptions
): Promise<void> {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error(
      "Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL. Use --dry-run to inspect SQL without connecting."
    );
    process.exit(2);
  }

  for (const entry of entries) {
    assertExplainOnlySql(entry.sql, entry.id);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const absOutDir = path.resolve(process.cwd(), opts.outDir);
  fs.mkdirSync(absOutDir, { recursive: true });

  let failures = 0;

  for (const entry of entries) {
    const res = await entry.buildExplainRequest(supabase);
    if (res.error) {
      failures++;
      console.error(
        `[ERROR] ${entry.id}: ${res.error.message || JSON.stringify(res.error)}`
      );
      continue;
    }

    const planText =
      typeof res.data === "string"
        ? res.data
        : JSON.stringify(res.data, null, 2);

    const fileName = `${opts.dateStamp}-${entry.id}.md`;
    const filePath = path.join(absOutDir, fileName);
    const markdown = formatPlanMarkdown({
      entry,
      dateStamp: opts.dateStamp,
      planText,
    });
    fs.writeFileSync(filePath, markdown, "utf8");
    console.log(`[CAPTURED] ${entry.id} -> ${path.join(opts.outDir, fileName)}`);
  }

  if (failures > 0) {
    console.error(
      `\n${failures} query plan(s) could not be captured via PostgREST .explain(). Verify db_plan_enabled on PostgREST or run the printed EXPLAIN SQL read-only in the Supabase SQL Editor.`
    );
    process.exit(1);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: npx tsx scripts/explain-hot-queries.ts [--dry-run] [--date YYYY-MM-DD] [--query <id>] [--out-dir docs/perf/query-plans]"
    );
    process.exit(0);
  }

  const selected = opts.queryId
    ? HOT_QUERY_CATALOG.filter((e) => e.id === opts.queryId)
    : HOT_QUERY_CATALOG;

  if (selected.length === 0) {
    console.error(`Unknown --query id: ${opts.queryId}`);
    process.exit(2);
  }

  if (opts.dryRun) {
    printDryRun(selected, opts.outDir, opts.dateStamp);
    return;
  }

  await runLiveCapture(selected, opts);
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.basename(process.argv[1]) === "explain-hot-queries.ts";

if (isMain) {
  main().catch((err) => {
    console.error("[explain-hot-queries] Fatal:", err);
    process.exit(1);
  });
}
