/**
 * Offline test for optimistic locking (Database row "Optimistic Locking
 * (version column)"). Covers src/lib/db/optimisticLock.ts with an in-memory fake
 * that implements the version-guarded UPDATE the same way PostgREST filters do,
 * plus static checks on migration 20261107d_row_version_optimistic_lock.sql
 * (NOT APPLIED; live SQL and trigger behavior are unproven here).
 * Run: npx tsx scripts/test-row-version-lock.ts
 */
import * as fs from "fs";
import { updateWithVersion, VERSIONED_TABLES } from "../src/lib/db/optimisticLock";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

// In-memory table that mimics the migration: trigger bumps row_version on every UPDATE.
function fakeDb(rows: any[], opts: { failUpdate?: boolean; failRead?: boolean; throws?: boolean } = {}) {
  const log: string[] = [];
  return {
    log,
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let patch: any = null;
      let mode: "update" | "select" = "select";
      const q: any = {
        update(p: any) { patch = p; mode = "update"; log.push("update"); return q; },
        select() { return q; },
        eq(c: string, v: unknown) { filters.push([c, v]); return q; },
        maybeSingle() { return run(true); },
        then(res: any, rej: any) { return run(false).then(res, rej); },
      };
      function run(single: boolean): Promise<any> {
        if (opts.throws) return Promise.reject(new Error("net"));
        const hit = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        if (mode === "update") {
          if (opts.failUpdate) return Promise.resolve({ data: null, error: { message: "no such column: row_version" } });
          hit.forEach((r) => { Object.assign(r, patch); r.row_version = r.row_version + 1; });
          return Promise.resolve({ data: hit.map((r) => ({ ...r })), error: null });
        }
        log.push("read");
        if (opts.failRead) return Promise.resolve({ data: null, error: { message: "read fail" } });
        return Promise.resolve({ data: single ? (hit[0] ? { row_version: hit[0].row_version } : null) : hit, error: null });
      }
      return q;
    },
  };
}

async function main() {
  const rows = [{ id: "r1", user_id: "u1", file_name: "a.pdf", row_version: 1 }];
  const db = fakeDb(rows);
  const a = await updateWithVersion(db, "resumes", "r1", 1, { file_name: "b.pdf" });
  check("matching version: ok, new version returned, row changed", a.status === "ok" && (a as any).rowVersion === 2 && rows[0].file_name === "b.pdf");
  const b = await updateWithVersion(db, "resumes", "r1", 1, { file_name: "c.pdf" });
  check("stale version: stale with the current version, row NOT overwritten", b.status === "stale" && (b as any).currentVersion === 2 && rows[0].file_name === "b.pdf");
  const c = await updateWithVersion(db, "resumes", "missing", 1, { file_name: "x" });
  check("unknown key: not_found", c.status === "not_found");
  const d = await updateWithVersion(fakeDb([{ user_id: "u1", row_version: 4 }]), "user_preferences", "u1", 4, { remote_preference: "remote" });
  check("user_id keyed tables use user_id (user_preferences)", d.status === "ok" && (d as any).rowVersion === 5);
  const e = await updateWithVersion(fakeDb([], { failUpdate: true }), "resumes", "r1", 1, { file_name: "x" });
  check("column missing (migration not applied): error with message, no throw", e.status === "error" && /row_version/.test((e as any).message));
  const f = await updateWithVersion(fakeDb([{ id: "r1", row_version: 2 }], { failRead: true }), "resumes", "r1", 1, { file_name: "x" });
  check("read failure while classifying: error", f.status === "error");
  const g = await updateWithVersion(fakeDb([], { throws: true }), "resumes", "r1", 1, {});
  check("thrown network error becomes error result", g.status === "error");
  let threw = 0;
  try { await updateWithVersion(db, "subscriptions" as any, "x", 1, {}); } catch { threw++; }
  try { await updateWithVersion(db, "resumes", "r1", 0, {}); } catch { threw++; }
  try { await updateWithVersion(db, "resumes", "r1", 1.5, {}); } catch { threw++; }
  try { await updateWithVersion(db, "resumes", "r1", 1, { row_version: 9 }); } catch { threw++; }
  check("non-versioned table, bad expectedVersion, or patch setting row_version are rejected", threw === 4);
  check("no billing tables in the versioned set", Object.keys(VERSIONED_TABLES).every((t) => !/payment|subscription|plan|addon|credit|entitle/.test(t)));

  // Static checks against the real DDL.
  const sql = fs.readFileSync("supabase/migrations/20261107d_row_version_optimistic_lock.sql", "utf8");
  const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const tables = Object.keys(VERSIONED_TABLES);
  check("migration: NOT APPLIED header + record-migration command", /STATUS: NOT APPLIED/.test(sql) && /record-migration\.cjs 20261107d_row_version_optimistic_lock/.test(sql));
  check("migration: every helper table gets the column and a BEFORE UPDATE trigger", tables.every((t) => new RegExp(`ALTER TABLE public\\.${t}\\s+ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1`).test(code) && new RegExp(`create trigger trg_row_version_${t}\\s+before update on public\\.${t}`).test(code)));
  check("migration: no table outside the helper set is altered", (code.match(/ALTER TABLE public\.(\w+)/g) || []).length === tables.length);
  check("migration: trigger function bumps by exactly one, pinned search_path, revoked, service_role grant", /NEW\.row_version := OLD\.row_version \+ 1/.test(code) && /SET search_path = ''/.test(code) && /REVOKE ALL ON FUNCTION public\.bump_row_version\(\) FROM PUBLIC, anon, authenticated/.test(code) && /GRANT EXECUTE ON FUNCTION public\.bump_row_version\(\) TO service_role/.test(code));
  check("migration: trigger does not reject writes (no RAISE)", !/RAISE/.test(code));
  check("migration: rollback drops triggers, function and columns", tables.every((t) => new RegExp(`--\\s+DROP TRIGGER IF EXISTS trg_row_version_${t}`).test(sql) && new RegExp(`--\\s+ALTER TABLE public\\.${t} DROP COLUMN IF EXISTS row_version`).test(sql)) && /--\s+DROP FUNCTION IF EXISTS public\.bump_row_version\(\)/.test(sql));
  const doc = fs.readFileSync("docs/db-triggers.md", "utf8");
  check("docs/db-triggers.md lists all four row_version triggers", tables.every((t) => doc.indexOf(`trg_row_version_${t}`) !== -1));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
