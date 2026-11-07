/**
 * Repo-vs-live drift row (Database sheet): schema.sql is the hand-run
 * baseline and today covers only jobs/profiles; all other tables come from
 * migrations. This guard keeps the drift explicit and one-directional:
 * every migration-created table must be in schema.sql or listed in
 * docs/schema-drift-baseline.md, the doc must not carry stale entries, and
 * the uncovered-table count must never rise above the recorded baseline.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const MIGRATIONS = "supabase/migrations";
const SCHEMA = "supabase/schema.sql";
const DOC = "docs/schema-drift-baseline.md";

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;

function migrationTables(): { table: string; file: string }[] {
  const out: { table: string; file: string }[] = [];
  const seen = new Set<string>();
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    CREATE_TABLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TABLE.exec(sql)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push({ table: m[1], file });
      }
    }
  }
  return out;
}

function schemaTables(): Set<string> {
  const sql = fs.readFileSync(SCHEMA, "utf8").toLowerCase();
  const out = new Set<string>();
  CREATE_TABLE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREATE_TABLE.exec(sql)) !== null) out.add(m[1]);
  return out;
}

function docEntries() {
  const doc = fs.readFileSync(DOC, "utf8");
  const block = doc.match(/```guard\n([\s\S]*?)```/);
  expect(block, "docs/schema-drift-baseline.md must contain a ```guard block").toBeTruthy();
  const lines = block![1].split("\n").map((l) => l.trim()).filter(Boolean);
  const countLine = lines.find((l) => l.startsWith("baseline-count:"));
  const baseline = parseInt(countLine!.split(":")[1].trim(), 10);
  const entries = lines
    .filter((l) => l.startsWith("table:"))
    .map((l) => {
      const parts = l.replace(/^table:\s*/, "").split("|").map((p) => p.trim());
      return { table: parts[0], file: parts[1] };
    });
  return { baseline, entries };
}

describe("schema drift baseline", () => {
  it("every migration-created table is in schema.sql or in the baseline doc", () => {
    const covered = schemaTables();
    const { entries } = docEntries();
    for (const { table, file } of migrationTables()) {
      if (covered.has(table)) continue;
      const entry = entries.find((e) => e.table === table);
      expect(
        entry,
        `table ${table} (${file}) is in neither schema.sql nor docs/schema-drift-baseline.md`
      ).toBeTruthy();
    }
  });

  it("baseline doc entries still match migrations (no stale entries) and cite the owning file", () => {
    const live = migrationTables();
    for (const e of docEntries().entries) {
      const hit = live.find((t) => t.table === e.table);
      expect(hit, `doc lists ${e.table} but no migration creates it`).toBeTruthy();
      expect(hit!.file).toBe(e.file);
    }
  });

  it("uncovered-table count never rises above the baseline", () => {
    const covered = schemaTables();
    const uncovered = migrationTables().filter((t) => !covered.has(t.table)).length;
    expect(uncovered).toBeLessThanOrEqual(docEntries().baseline);
  });
});
