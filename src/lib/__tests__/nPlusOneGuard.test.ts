/**
 * N+1 Queries row (Database sheet): systematic regression guard. Brace-aware
 * scan of route handlers and src/lib for a Supabase await inside a loop
 * body; every hit must be classified in docs/db-n-plus-one.md (bounded
 * fan-out with justification, or a flagged follow-up), and every doc entry
 * must still match live code. The Oct 11 profile-fetch storm (79 reads per
 * request) is the incident this guard exists to prevent recurring.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as glob from "glob";

const LOOP_RE = /\b(for\s*\([^)]*\)\s*\{|for\s+await\s*\(|while\s*\(|\.forEach\()/;
const QUERY_RE = /await\b.*(\.from\(|\.rpc\(|supabaseAdmin|supabase\.)/;

function stripStrings(line: string): string {
  return line
    .replace(/`[^`]*`/g, "``")
    .replace(/"[^"\\]*"/g, '""')
    .replace(/'[^'\\]*'/g, "''");
}

interface Hit { file: string; loopHeader: string; }

function scan(): Hit[] {
  const files = [
    ...glob.sync("src/app/api/**/route.ts"),
    ...glob.sync("src/lib/**/*.ts"),
  ].filter((f) => !f.includes("__tests__") && !f.endsWith(".test.ts"));
  const hits: Hit[] = [];
  for (const rawFile of files) {
    const file = rawFile.replace(/\\/g, "/");
    const lines = fs.readFileSync(file, "utf8").split("\n").map(stripStrings);
    for (let i = 0; i < lines.length; i++) {
      if (!LOOP_RE.test(lines[i])) continue;
      let depth = 0, started = false, end = -1;
      for (let j = i; j < Math.min(lines.length, i + 300); j++) {
        for (const ch of lines[j]) {
          if (ch === "{") { depth++; started = true; }
          else if (ch === "}") depth--;
        }
        if (started && depth <= 0) { end = j; break; }
      }
      if (end < 0) continue;
      for (let k = i; k <= end; k++) {
        if (QUERY_RE.test(lines[k])) {
          const header = lines[i].trim().replace(/\s*\{\s*$/, "");
          hits.push({ file, loopHeader: header });
          break;
        }
      }
    }
  }
  return hits;
}

function docEntries(): { file: string; header: string }[] {
  const doc = fs.readFileSync("docs/db-n-plus-one.md", "utf8");
  const block = doc.match(/```guard\n([\s\S]*?)```/);
  expect(block, "docs/db-n-plus-one.md must contain a ```guard block").toBeTruthy();
  return block![1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("pattern:"))
    .map((l) => {
      const parts = l.replace(/^pattern:\s*/, "").split("|").map((p) => p.trim());
      return { file: parts[0], header: parts[1] };
    });
}

describe("N+1 query guard", () => {
  it("every loop+await-query pattern in code is classified in the doc", () => {
    const doc = docEntries();
    for (const hit of scan()) {
      const entry = doc.find((e) => e.file === hit.file && hit.loopHeader.startsWith(e.header));
      expect(
        entry,
        `unclassified N+1 pattern: ${hit.file} loop \`${hit.loopHeader}\` - classify it in docs/db-n-plus-one.md or fix the query`
      ).toBeTruthy();
    }
  });

  it("every doc classification still matches live code (no stale baseline)", () => {
    const hits = scan();
    for (const e of docEntries()) {
      const hit = hits.find((h) => h.file === e.file && h.loopHeader.startsWith(e.header));
      expect(hit, `docs/db-n-plus-one.md entry ${e.file} \`${e.header}\` no longer matches code`).toBeTruthy();
    }
  });
});
