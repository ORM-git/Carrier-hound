/**
 * DB Triggers row (Database sheet): the trigger map in docs/db-triggers.md
 * must stay in lockstep with the migrations so trigger usage can never
 * drift unmapped again. Scans every migration for `create trigger`
 * (case-insensitive) and requires each one - and no stale extras - in the
 * doc's machine-readable guard block.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const MIGRATIONS = "supabase/migrations";
const DOC = "docs/db-triggers.md";

const CREATE_TRIGGER = /create\s+trigger\s+([a-z_][a-z0-9_]*)\s+(?:before|after|instead)/gi;
const ON_TABLE = /\bon\s+(?:public\.)?([a-z_][a-z0-9_]*)/i;

function migrationTriggers() {
  const found: { name: string; file: string; table: string }[] = [];
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    CREATE_TRIGGER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TRIGGER.exec(sql)) !== null) {
      const tail = sql.slice(m.index, m.index + 400);
      const t = tail.match(ON_TABLE);
      found.push({ name: m[1], file, table: t ? t[1] : "" });
    }
  }
  return found;
}

function docEntries() {
  const doc = fs.readFileSync(DOC, "utf8");
  const block = doc.match(/```guard\n([\s\S]*?)```/);
  expect(block, "docs/db-triggers.md must contain a ```guard block").toBeTruthy();
  return block![1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("trigger:"))
    .map((l) => {
      const parts = l.replace(/^trigger:\s*/, "").split("|").map((p) => p.trim());
      return { name: parts[0], file: parts[1], table: parts[2] };
    });
}

describe("db triggers map", () => {
  it("every CREATE TRIGGER in migrations is mapped in the doc, with its file and table", () => {
    const doc = docEntries();
    for (const trig of migrationTriggers()) {
      const entry = doc.find((e) => e.name === trig.name);
      expect(entry, `trigger ${trig.name} (${trig.file}) missing from docs/db-triggers.md`).toBeTruthy();
      expect(entry!.file).toBe(trig.file);
      expect(entry!.table).toBe(trig.table);
    }
  });

  it("doc carries no stale triggers that migrations no longer declare", () => {
    const live = new Set(migrationTriggers().map((t) => t.name));
    for (const e of docEntries()) {
      expect(live.has(e.name), `docs/db-triggers.md lists ${e.name} but no migration declares it`).toBe(true);
    }
  });

  it("mapped count matches the live trigger count", () => {
    expect(docEntries().length).toBe(migrationTriggers().length);
  });
});
