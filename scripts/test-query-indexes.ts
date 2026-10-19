/**
 * scripts/test-query-indexes.ts
 *
 * Verifies that all filter and sort columns utilized across CareerMonke production queries
 * have corresponding indexes defined in supabase/migrations/*.sql.
 *
 * Includes negative control verification via --negative-control.
 */

import fs from "fs";
import path from "path";

interface IndexDefinition {
  indexName: string;
  table: string;
  columns: string[];
  predicateColumns: string[];
  definition: string;
  file: string;
}

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

export function parseMigrationIndexes(): IndexDefinition[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const indexes: IndexDefinition[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");

    // Match full CREATE INDEX statements across multiple lines
    const regex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s+ON\s+([a-zA-Z0-9_.]+)([\s\S]*?);/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const indexName = match[1];
      const table = match[2].replace("public.", "").trim();
      const rest = match[3];

      // Extract indexed columns inside (...)
      const colMatch = rest.match(/\(([^)]+)\)/);
      const cols: string[] = [];
      if (colMatch) {
        cols.push(
          ...colMatch[1]
            .split(",")
            .map((c) =>
              c
                .trim()
                .replace(/\s+(DESC|ASC|NULLS\s+LAST|gin_trgm_ops)/gi, "")
                .replace(/USING\s+[a-zA-Z0-9_]+/gi, "")
                .replace(/^.*\./, "")
                .trim()
            )
            .filter(Boolean)
        );
      }

      // Extract predicate columns inside WHERE (...)
      const predCols: string[] = [];
      const whereMatch = rest.match(/WHERE\s+([\s\S]+)$/i);
      if (whereMatch) {
        const whereClause = whereMatch[1];
        if (whereClause.includes("status")) predCols.push("status");
        if (whereClause.includes("is_active")) predCols.push("is_active");
        if (whereClause.includes("source")) predCols.push("source");
        if (whereClause.includes("source_job_id")) predCols.push("source_job_id");
      }

      indexes.push({
        indexName,
        table,
        columns: cols,
        predicateColumns: predCols,
        definition: match[0].replace(/\s+/g, " ").trim(),
        file,
      });
    }
  }

  // Also include built-in primary key index for jobs table (id)
  indexes.push({
    indexName: "jobs_pkey",
    table: "jobs",
    columns: ["id"],
    predicateColumns: [],
    definition: "ALTER TABLE public.jobs ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);",
    file: "built-in / schema",
  });

  return indexes;
}

interface QuerySpec {
  name: string;
  source: string;
  columns: string[];
}

export const PRODUCTION_QUERIES: QuerySpec[] = [
  {
    name: "Query 1: Jobs List Feed",
    source: "src/lib/api/jobs.ts:92-93, 198-201 & src/lib/jobs/service.ts:245-250",
    columns: ["status", "is_active", "first_seen_at", "posted_at", "id"],
  },
  {
    name: "Query 2: Faceted Filter",
    source: "src/lib/api/jobs.ts:98-193 & netlify/functions/jobs-search.ts:200-235",
    columns: ["status", "is_active", "location", "category", "company", "country_code", "remote_scope", "salary_min"],
  },
  {
    name: "Query 3: Text Search (Trigram & Vector)",
    source: "src/lib/api/jobs.ts:94-96 & netlify/functions/jobs-search.ts:236-248",
    columns: ["status", "is_active", "title", "company", "location", "search_vector", "posted_at", "id"],
  },
  {
    name: "Query 4: Job Detail Lookup",
    source: "src/lib/jobs/service.ts:556-560 & netlify/functions/jobs-pro.ts:80-95",
    columns: ["id"],
  },
];

export function verifyQueryIndexes(queries: QuerySpec[], indexes: IndexDefinition[]): {
  success: boolean;
  indexedColumns: Record<string, string[]>;
  missingColumns: string[];
} {
  const jobsIndexes = indexes.filter((idx) => idx.table === "jobs");
  const indexedColumns: Record<string, string[]> = {};
  const missingColumns: string[] = [];

  for (const q of queries) {
    for (const col of q.columns) {
      if (indexedColumns[col]) continue;

      const matchingIndexes = jobsIndexes.filter((idx) => {
        // Direct column match
        if (idx.columns.includes(col)) return true;
        // Predicate column match (e.g. status or is_active in partial index WHERE clause)
        if (idx.predicateColumns.includes(col)) return true;
        // Schema alias / mapping matches
        if (col === "category" && idx.columns.includes("categories")) return true;
        if (col === "first_seen_at" && idx.columns.includes("discovered_at")) return true;
        return false;
      });

      if (matchingIndexes.length > 0) {
        indexedColumns[col] = matchingIndexes.map((i) => `${i.indexName} (${i.file})`);
      } else {
        missingColumns.push(col);
      }
    }
  }

  return {
    success: missingColumns.length === 0,
    indexedColumns,
    missingColumns,
  };
}

async function run() {
  const isNegativeControl = process.argv.includes("--negative-control");
  console.log("================================================================================");
  console.log("   CAREERMONKE QUERY INDEX VALIDATION TEST                                      ");
  if (isNegativeControl) {
    console.log("   MODE: NEGATIVE CONTROL (Simulating unindexed column in filter query)        ");
  }
  console.log("================================================================================\n");

  const indexes = parseMigrationIndexes();
  console.log(`Parsed ${indexes.length} index definitions across supabase/migrations/.\n`);

  const testQueries = isNegativeControl
    ? [
        ...PRODUCTION_QUERIES,
        {
          name: "Simulated Negative Control Query",
          source: "scripts/test-query-indexes.ts:simulated",
          columns: ["unindexed_fictitious_column"],
        },
      ]
    : PRODUCTION_QUERIES;

  const result = verifyQueryIndexes(testQueries, indexes);

  console.log("INDEX MAPPING PER COLUMN:");
  for (const [col, idxs] of Object.entries(result.indexedColumns)) {
    console.log(`  - [${col}]`);
    for (const idx of idxs) {
      console.log(`      * ${idx}`);
    }
  }

  if (result.missingColumns.length > 0) {
    console.error("\n❌ UNINDEXED COLUMNS DETECTED:");
    for (const col of result.missingColumns) {
      console.error(`  - ${col} (No index found in migrations!)`);
    }

    if (isNegativeControl) {
      console.log("\n✅ NEGATIVE CONTROL VERIFIED: Test successfully detected unindexed column and exited non-zero as expected.");
      process.exit(0);
    } else {
      process.exit(1);
    }
  }

  if (isNegativeControl) {
    console.error("\n❌ NEGATIVE CONTROL FAILED: Expected failure on unindexed column, but test passed!");
    process.exit(1);
  }

  console.log("\n================================================================================");
  console.log("VERDICT: PASS-LOCAL (All query filter/sort columns have confirmed migration indexes)");
  console.log("================================================================================");
}

if (require.main === module) {
  run().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
  });
}
