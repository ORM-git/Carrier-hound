/**
 * scripts/test-16a-repair-aware.ts
 *
 * Rehearses #642's 20261116a (and its rollback) on POPULATED post-#645 + merged-#643 databases, reusing
 * the #643 rehearsal harness (scripts/test-10m-schema-step1-rehearsal.ts). In-process PGlite only; never
 * touches a network database.
 *
 * Baselines (production order: #645, then #643, then 16a):
 *   recon-incomplete / recon-complete  scoped #645 (owner-reported live state) + 16b
 *   full                               every repo migration except 16a (full #645 D/E/F) + 16b
 *
 * Per baseline: apply 16a -> catalog + every row unchanged except 16a's declared delta; re-apply is a
 * no-op; apply the rollback -> catalog + every row identical to pre-16a (data-preserving).
 * Flags: --explore (print the catalog diff 16a causes, no assertions), --migration=<path>.
 * Exit code: 0 = all checks passed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  MIG_DIR, TARGET, PLATFORM_STUBS, DRIFT_SHIM, BASELINES, type Baseline, type Db,
  allMigrations, applyChain, applySql, buildBaselineSchema, applyBaselineState, loadFixture,
  setUnavailableExtensions, check, checks,
} from "./test-10m-schema-step1-rehearsal";

const A16 = "20261116a_high_volume_ingestion_schema.sql";
export const ROLLBACK_16A = path.join(MIG_DIR, "..", "scripts", "rollback-20261116a.sql");
const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

/** Catalog + data fingerprint of everything 16a could touch. Key -> value; compare key by key. */
export async function catalog(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const add = async (prefix: string, sql: string) => {
    for (const r of (await db.query<{ k: string; v: string }>(sql)).rows) out[`${prefix} ${r.k}`] = String(r.v);
  };
  await add("col", `SELECT table_schema||'.'||table_name||'.'||column_name k, data_type||' null='||is_nullable||' default='||coalesce(column_default,'') v
                      FROM information_schema.columns WHERE table_schema IN ('public','internal_ingestion')`);
  await add("con", `SELECT n.nspname||'.'||c.relname||'.'||k.conname k, pg_get_constraintdef(k.oid)||' validated='||k.convalidated v
                      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE n.nspname IN ('public','internal_ingestion')`);
  await add("idx", `SELECT s.nspname||'.'||c.relname k, pg_get_indexdef(i.indexrelid)||' valid='||i.indisvalid v FROM pg_index i
                      JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname IN ('public','internal_ingestion')`);
  await add("fn", `SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' k,
                          md5(pg_get_functiondef(p.oid))||' acl='||coalesce(p.proacl::text,'') v
                     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','internal_ingestion') AND p.prokind IN ('f','p')`);
  await add("view", `SELECT schemaname||'.'||viewname k, md5(definition) v FROM pg_views WHERE schemaname IN ('public','internal_ingestion')`);
  await add("acl", `SELECT n.nspname||'.'||c.relname k, coalesce(c.relacl::text,'')||' rls='||c.relrowsecurity v FROM pg_class c
                      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','internal_ingestion') AND c.relkind IN ('r','v','m','p')`);
  await add("trg", `SELECT c.relname||'.'||t.tgname k, pg_get_triggerdef(t.oid) v FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`);
  return out;
}

const DATA_TABLES = ["jobs", "companies", "job_descriptions", "saved_jobs"];
/** Columns per table, to fingerprint data over a FIXED column set (a new empty column is not a data change). */
export async function columnsOf(db: Db): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of DATA_TABLES) {
    out[t] = (await db.query<{ c: string }>(`SELECT column_name c FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t])).rows.map((r) => r.c);
  }
  return out;
}
/** md5 of every row over the given columns, plus row counts and last_seen_at (freshness). */
export async function dataFp(db: Db, cols: Record<string, string[]>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of DATA_TABLES) {
    const key = t === "job_descriptions" ? "job_id" : "id";
    const list = cols[t].map((c) => `"${c}"`).join(", ");
    const r = await db.query<{ j: string; n: string }>(`SELECT count(*) n, coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.${key}), '') j FROM (SELECT ${list} FROM public.${t}) x`);
    out[`data public.${t}`] = `${r.rows[0].n} rows ${md5(r.rows[0].j)}`;
  }
  return out;
}

const marked = async (db: Db) => (await db.query<{ k: string }>(
  `SELECT c.relname||'.'||a.attname k FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('jobs','companies') AND a.attnum>0 AND NOT a.attisdropped
      AND col_description(a.attrelid,a.attnum)='added by 20261116a' ORDER BY 1`)).rows.map((r) => r.k);

export function diff(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].sort().filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? "<absent>"} -> ${b[k] ?? "<absent>"}`);
}

async function newDb(): Promise<Db & { _raw: any }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const { unaccent } = await import("@electric-sql/pglite/contrib/unaccent");
  const raw = new PGlite({ extensions: { pg_trgm, pgcrypto, unaccent } });
  return { exec: async (s: string) => { await raw.exec(s); }, query: (s: string, p?: unknown[]) => raw.query(s, p as any[]) as any, _raw: raw };
}

/** Populated #645 baseline (scoped or full, never 16a) with merged #643 (16b) on top. */
export async function post645Plus643(kind: Baseline) {
  const db = await newDb();
  await db.exec(PLATFORM_STUBS);
  await db.exec(fs.readFileSync(path.join(MIG_DIR, "..", "schema.sql"), "utf8"));
  await db.exec(DRIFT_SHIM);
  const failed = kind === "full"
    ? await applyChain(db, allMigrations().filter((f) => f !== TARGET && f !== A16), kind)
    : await buildBaselineSchema(db, kind);
  if (failed.length) throw new Error(`${kind} baseline failed: ${failed.join("; ")}`);
  await loadFixture(db);
  await applyBaselineState(db, kind);
  await applySql(db, TARGET, fs.readFileSync(path.join(MIG_DIR, TARGET), "utf8"));
  return db;
}

async function run(db: Db, sql: string): Promise<string | null> {
  try { await db.exec(sql); return null; } catch (e: any) { try { await db.exec("ROLLBACK"); } catch {} return String(e?.message || e).slice(0, 300); }
}

async function main() {
  const args = process.argv.slice(2);
  const explore = args.includes("--explore");
  const migArg = args.find((a) => a.startsWith("--migration="));
  const sql16a = fs.readFileSync(migArg ? path.resolve(migArg.slice(12)) : path.join(MIG_DIR, A16), "utf8");
  setUnavailableExtensions(["pg_cron", "pg_stat_statements"]);

  for (const kind of BASELINES) {
    const scn = kind;
    console.log(`\n=== ${scn}: #645 + #643 populated, then 16a ===`);
    const db = await post645Plus643(kind);
    const cols0 = await columnsOf(db);
    const before = await catalog(db);
    const data0 = await dataFp(db, cols0);
    const err = await run(db, sql16a);
    const after = await catalog(db);
    if (explore) {
      console.log(err ? `  16a ERROR: ${err}` : "  16a applied");
      for (const d of diff({ ...before, ...data0 }, { ...after, ...(await dataFp(db, await columnsOf(db))) })) console.log(`  ~ ${d}`);
      await db._raw.close();
      continue;
    }
    check(scn, "16a applies on populated #645 + #643", err === null, err ?? undefined);

    // 1. Only additive columns; every function, view, constraint (incl. validation), index, ACL, trigger identical
    const delta = diff(before, after);
    const added = await marked(db);
    const unexpected = delta.filter((d) => !added.some((m) => d.startsWith(`col public.${m}:`) && d.includes(": <absent> -> ")));
    check(scn, "16a changes nothing but the columns it adds", unexpected.length === 0, unexpected.slice(0, 4).join("; ") || `added: ${added.join(", ") || "none"}`);
    check(scn, "every 16a-added column is marked", delta.length === added.length, `${delta.length} catalog changes, ${added.length} marked`);
    if (kind === "full") check(scn, "full #645 already has every column: 16a adds nothing", added.length === 0, added.join(", "));
    else check(scn, "scoped #645: 16a adds exactly jobs.canonical_domain", JSON.stringify(added) === JSON.stringify(["jobs.canonical_domain"]), added.join(", "));
    check(scn, "every row, column value and last_seen_at unchanged", JSON.stringify(await dataFp(db, cols0)) === JSON.stringify(data0));
    const fn = await db.query<{ d: string }>(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.oid = to_regprocedure('public.compute_job_dedupe_hash(text,text,text,text)')`);
    if (kind === "full") check(scn, "compute_job_dedupe_hash still delegates to compute_job_similarity_hash_v2", /compute_job_similarity_hash_v2/.test(fn.rows[0]?.d ?? ""));
    const partial = await db.query<{ d: string }>(`SELECT pg_get_indexdef('public.idx_companies_category'::regclass) d`);
    check(scn, "idx_companies_category definition untouched", partial.rows[0].d === before["idx public.idx_companies_category"]?.replace(/ valid=.*$/, ""), partial.rows[0].d);

    // 2. Idempotent re-apply
    const reErr = await run(db, sql16a);
    const cols1 = await columnsOf(db);
    const data1 = await dataFp(db, cols1);
    const again = await catalog(db);
    check(scn, "re-applying 16a is a no-op", reErr === null && diff(after, again).length === 0 && JSON.stringify(await marked(db)) === JSON.stringify(added),
      reErr ?? diff(after, again).slice(0, 3).join("; "));

    const rollbackSql = fs.readFileSync(ROLLBACK_16A, "utf8");
    if (added.length) {
      // 3. A 16a column that received data is kept by the rollback; nothing else moves
      const [t, c] = added[0].split(".");
      await db.exec(`BEGIN; SET LOCAL careermonke.skip_touch_last_seen = 'on';
        UPDATE public.${t} SET ${c} = 'ingested.example' WHERE id = (SELECT id FROM public.${t} ORDER BY id LIMIT 1); COMMIT;`);
      const withData = await dataFp(db, cols1);
      const rbErr = await run(db, rollbackSql);
      check(scn, "rollback keeps a 16a column that holds data", rbErr === null && JSON.stringify(await marked(db)) === JSON.stringify(added), rbErr ?? undefined);
      check(scn, "rollback with data: every row and value identical", JSON.stringify(await dataFp(db, cols1)) === JSON.stringify(withData));
      check(scn, "rollback with data: catalog unchanged", diff(again, await catalog(db)).length === 0);
      await db.exec(`BEGIN; SET LOCAL careermonke.skip_touch_last_seen = 'on'; UPDATE public.${t} SET ${c} = NULL WHERE ${c} IS NOT NULL; COMMIT;`);
    }
    // 4. Rollback of an empty 16a column returns the catalog to exactly the pre-16a state
    const rbErr2 = await run(db, rollbackSql);
    check(scn, "rollback applies", rbErr2 === null, rbErr2 ?? undefined);
    const final = diff(before, await catalog(db));
    check(scn, "after rollback: catalog identical to pre-16a (#645 + #643 objects intact)", final.length === 0, final.slice(0, 4).join("; ") || undefined);
    check(scn, "after rollback: every pre-16a row and value identical", JSON.stringify(await dataFp(db, cols0)) === JSON.stringify(data0));
    check(scn, "rollback is repeatable", (await run(db, rollbackSql)) === null && diff(before, await catalog(db)).length === 0);
    await db._raw.close();
  }
  if (!explore) {
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    process.exit(failed ? 1 : 0);
  }
}

if (require.main === module) main().catch((e) => { console.error("ERROR:", e?.message || e); process.exit(1); });
