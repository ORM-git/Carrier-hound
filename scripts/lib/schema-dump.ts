/**
 * Schema Dump Generator and Freshness Checker (Database sheet: Schema dump freshness).
 *
 * Compiles the consolidated repository schema representation from all migration files
 * in supabase/migrations/ and provides verification utilities for CI checks.
 */

import * as fs from "fs";
import * as path from "path";

export const DEFAULT_MIGRATIONS_DIR = path.resolve("supabase/migrations");
export const DEFAULT_SCHEMA_DUMP_PATH = path.resolve("supabase/schema.generated.sql");

export interface SchemaDumpOptions {
  date?: string;
  migrationsDir?: string;
}

export interface FreshnessCheckResult {
  fresh: boolean;
  reasons: string[];
  expectedCount: number;
  actualCount: number;
  dumpDate: string | null;
  missingMigrations: string[];
}

/**
 * Reads all migration files in lexical order and produces a consolidated
 * schema representation with a dated freshness header.
 */
export function generateSchemaDump(options: SchemaDumpOptions = {}): string {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const date = options.date ?? new Date().toISOString().slice(0, 10);

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const lines: string[] = [
    "-- ==============================================================================",
    "-- CareerMonke Schema Representation (Generated from Migrations)",
    `-- Freshness Header: Generated on ${date}`,
    `-- Migrations Count: ${files.length}`,
    "-- DO NOT EDIT DIRECTLY. Regenerate using: npx tsx scripts/generate-schema-dump.ts",
    "-- ==============================================================================",
    "",
  ];

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, "utf8").trim();

    lines.push(
      "-- ------------------------------------------------------------------------------",
      `-- Migration: ${file}`,
      "-- ------------------------------------------------------------------------------",
      content,
      "",
      ""
    );
  }

  return lines.join("\n");
}

/**
 * Regenerates the schema dump file on disk.
 */
export function writeSchemaDump(
  dumpPath = DEFAULT_SCHEMA_DUMP_PATH,
  options: SchemaDumpOptions = {}
): void {
  const content = generateSchemaDump(options);
  const dir = path.dirname(dumpPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(dumpPath, content, "utf8");
}

/**
 * Checks whether the schema dump representation matches current migrations.
 */
export function checkSchemaDumpFreshness(
  dumpPath = DEFAULT_SCHEMA_DUMP_PATH,
  migrationsDir = DEFAULT_MIGRATIONS_DIR
): FreshnessCheckResult {
  const reasons: string[] = [];
  const missingMigrations: string[] = [];

  if (!fs.existsSync(dumpPath)) {
    return {
      fresh: false,
      reasons: [`Schema dump file does not exist at: ${dumpPath}`],
      expectedCount: 0,
      actualCount: 0,
      dumpDate: null,
      missingMigrations: [],
    };
  }

  if (!fs.existsSync(migrationsDir)) {
    return {
      fresh: false,
      reasons: [`Migrations directory does not exist at: ${migrationsDir}`],
      expectedCount: 0,
      actualCount: 0,
      dumpDate: null,
      missingMigrations: [],
    };
  }

  const dumpContent = fs.readFileSync(dumpPath, "utf8");

  // 1. Verify dated freshness header
  const headerMatch = dumpContent.match(/-- Freshness Header: Generated on ([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  if (!headerMatch) {
    reasons.push("Schema dump is missing a dated freshness header (-- Freshness Header: Generated on YYYY-MM-DD).");
  }
  const dumpDate = headerMatch ? headerMatch[1] : null;

  // 2. Verify migration count in header
  const countMatch = dumpContent.match(/-- Migrations Count: ([0-9]+)/);
  const headerCount = countMatch ? parseInt(countMatch[1], 10) : -1;

  // 3. Scan disk migrations
  const diskMigrations = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (headerCount !== diskMigrations.length) {
    reasons.push(
      `Migrations count mismatch: header specifies ${headerCount}, but found ${diskMigrations.length} files in ${migrationsDir}.`
    );
  }

  // 4. Verify each migration is present in the dump
  for (const migration of diskMigrations) {
    const marker = `-- Migration: ${migration}`;
    if (!dumpContent.includes(marker)) {
      missingMigrations.push(migration);
      reasons.push(`Migration ${migration} is missing from the consolidated schema dump.`);
    }
  }

  // 5. Verify byte-exact content parity when header is present
  if (dumpDate && reasons.length === 0) {
    const expectedContent = generateSchemaDump({ date: dumpDate, migrationsDir });
    if (dumpContent !== expectedContent) {
      reasons.push(
        "Consolidated schema dump content does not match current migration files. Run 'npx tsx scripts/generate-schema-dump.ts' to regenerate."
      );
    }
  }

  return {
    fresh: reasons.length === 0,
    reasons,
    expectedCount: diskMigrations.length,
    actualCount: headerCount,
    dumpDate,
    missingMigrations,
  };
}
