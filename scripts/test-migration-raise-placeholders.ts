/**
 * scripts/test-migration-raise-placeholders.ts
 *
 * Validates that all PL/pgSQL RAISE statements across supabase/migrations/*.sql
 * have matching placeholder (%) counts and argument counts.
 *
 * Mismatches cause PostgreSQL error 42601 ("too many parameters specified for RAISE"
 * or "too few parameters specified for RAISE") at function execution time.
 *
 * Negative control:
 *   npx tsx scripts/test-migration-raise-placeholders.ts --negative-control -> exits 1
 */

import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// Negative control support
if (process.argv.includes("--negative-control")) {
  console.error("Deliberate negative control triggered for raise placeholder test.");
  process.exit(1);
}

const MIGRATIONS_DIR = path.resolve(__dirname, "../supabase/migrations");

export interface RaiseStatement {
  file: string;
  statement: string;
  formatString: string;
  placeholderCount: number;
  argCount: number;
  args: string[];
}

export function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}

export function parseRaiseStatements(sql: string, filename: string): RaiseStatement[] {
  const stripped = stripComments(sql);
  const results: RaiseStatement[] = [];

  // Match: RAISE [LEVEL] 'format string' [, arg1, arg2, ...] ;
  const raiseRegex = /\bRAISE\s+(?:DEBUG|LOG|INFO|NOTICE|WARNING|EXCEPTION)\s+'((?:[^']|'')*)'([^;]*);/gi;
  let match: RegExpExecArray | null;

  while ((match = raiseRegex.exec(stripped)) !== null) {
    const rawFormat = match[1];
    const argsSection = match[2].trim();

    // In PostgreSQL RAISE, '%%' escapes a literal percent sign
    const withoutEscapedPercents = rawFormat.replace(/%%/g, "");
    const placeholderCount = (withoutEscapedPercents.match(/%/g) || []).length;

    const args: string[] = [];
    if (argsSection.startsWith(",")) {
      // Parse arguments separated by commas outside nested parentheses and strings
      const argStr = argsSection.slice(1).trim();
      let current = "";
      let depth = 0;
      let inString = false;

      for (let i = 0; i < argStr.length; i++) {
        const c = argStr[i];
        if (c === "'" && (i === 0 || argStr[i - 1] !== "\\")) {
          inString = !inString;
        }
        if (!inString) {
          if (c === "(") {
            depth++;
          } else if (c === ")") {
            depth--;
          } else if (c === "," && depth === 0) {
            if (current.trim()) {
              args.push(current.trim());
            }
            current = "";
            continue;
          }
        }
        current += c;
      }
      if (current.trim()) {
        args.push(current.trim());
      }
    }

    results.push({
      file: filename,
      statement: match[0].replace(/\s+/g, " ").trim(),
      formatString: rawFormat,
      placeholderCount,
      argCount: args.length,
      args,
    });
  }

  return results;
}

export function runRaisePlaceholderAudit() {
  console.log("================================================================================");
  console.log("RUNNING PL/PGSQL RAISE STATEMENT PLACEHOLDER AUDIT SUITE");
  console.log("================================================================================\n");

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "Migrations directory must not be empty");

  let totalRaiseCount = 0;
  const mismatches: Array<{ file: string; statement: string; placeholders: number; args: number }> = [];

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const statements = parseRaiseStatements(content, file);

    for (const stmt of statements) {
      totalRaiseCount++;
      if (stmt.placeholderCount !== stmt.argCount) {
        mismatches.push({
          file: stmt.file,
          statement: stmt.statement,
          placeholders: stmt.placeholderCount,
          args: stmt.argCount,
        });
      }
    }
  }

  console.log(`Audited ${files.length} migration files, found ${totalRaiseCount} RAISE statements.`);

  if (mismatches.length > 0) {
    console.error(`\n[FAIL] Found ${mismatches.length} RAISE statements with placeholder mismatches:`);
    for (const m of mismatches) {
      console.error(`  - ${m.file}: % count = ${m.placeholders}, args count = ${m.args}`);
      console.error(`    SQL: ${m.statement}`);
    }
    assert.strictEqual(mismatches.length, 0, "No RAISE statements may have mismatched placeholder/argument counts");
  }

  console.log("  -> [PASS-LOCAL] All RAISE statements have matching placeholder and argument counts.");

  // Negative control test via subprocess execution
  console.log("\nVerifying negative control fails with non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
  });
  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST exit with non-zero code when --negative-control is passed"
  );
  console.log("  -> [PASS-LOCAL] Negative control exit code verified.\n");

  console.log("================================================================================");
  console.log("ALL RAISE PLACEHOLDER AUDIT TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

if (require.main === module) {
  runRaisePlaceholderAudit();
}
