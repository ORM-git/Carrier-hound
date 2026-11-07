#!/usr/bin/env node
/**
 * scripts/list-pending-migrations.cjs
 *
 * Machine-readable pending-apply list (Database row "Pending-apply markers").
 * Scans supabase/migrations and prints every migration whose header carries a
 * NOT APPLIED / PENDING APPLICATION marker, plus whether the header includes
 * a self-referencing record command (node scripts/record-migration.cjs <id>).
 *
 * Exits 1 when a marked migration lacks a valid self-referencing record
 * command, so the pending list can never silently become unactionable.
 *
 * Usage:
 *   node scripts/list-pending-migrations.cjs          # human-readable list
 *   node scripts/list-pending-migrations.cjs --json   # machine-readable
 */

"use strict";

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.resolve(__dirname, "../supabase/migrations");
const HEADER_LINES = 20;
const MARKER = /--\s*Status:\s*(NOT APPLIED|PENDING APPLICATION)/i;
const RECORD_RE = /record-migration\.cjs\s+([A-Za-z0-9_]+)/;

function scan() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const pending = [];
  const malformed = [];
  const appliedMarkers = [];
  for (const f of files) {
    const id = f.replace(/\.sql$/, "");
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    const header = src.split("\n").slice(0, HEADER_LINES).join("\n");
    if (/--\s*Status:\s*APPLIED/i.test(header)) {
      appliedMarkers.push(id);
      continue;
    }
    const m = header.match(MARKER);
    if (!m) continue;
    const r = header.match(RECORD_RE);
    const recordId = r ? r[1] : null;
    const ok = recordId === id;
    pending.push({ id, status: m[1].toUpperCase(), recordCommand: recordId, selfReferencing: ok });
    if (!ok) malformed.push(id);
  }
  return { pending, malformed, appliedMarkers, total: files.length };
}

const result = scan();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Scanned ${result.total} migrations in supabase/migrations/`);
  if (result.appliedMarkers.length) {
    console.log(`Marked APPLIED (${result.appliedMarkers.length}): ${result.appliedMarkers.join(", ")}`);
  }
  if (!result.pending.length) {
    console.log("No pending migrations: every migration is unmarked or marked APPLIED.");
  } else {
    console.log(`Pending apply (${result.pending.length}):`);
    for (const p of result.pending) {
      console.log(
        `  ${p.id}  [${p.status}]  record: ${
          p.selfReferencing ? `node scripts/record-migration.cjs ${p.id}` : p.recordCommand ? `MISMATCH (${p.recordCommand})` : "MISSING"
        }`
      );
    }
  }
  if (result.malformed.length) {
    console.error(`\nERROR: marked migrations without a self-referencing record command: ${result.malformed.join(", ")}`);
  }
}
process.exit(result.malformed.length ? 1 : 0);
