/**
 * scripts/test-10m-schema-step1-rehearsal.ts
 *
 * Disposable rehearsal of PR #643 (20261116b_ten_million_system_design_schema.sql) on POPULATED schemas
 * rebuilt from this repo's own migration chain. Engine-neutral core (also used by the real-PostgreSQL
 * runner scripts/test-10m-schema-step1-postgres.ts); this file's CLI runs it on in-process PGlite.
 * Never touches a network database and never reads credentials.
 *
 * Baselines (production order = everything except 16b, then 16b):
 *   recon-incomplete  RECONSTRUCTED owner-reported post-#645 state (NOT a live snapshot): live text
 *                     jobs.source_id + companies.category, scoped D (touch_job_last_seen, similarity hash v2
 *                     function + column only), E canonical identity index, valid PARTIAL idx_companies_category,
 *                     F installed; active rows hashed, progress only for the hash phase (NOT complete)
 *   recon-complete    same, every F phase recorded and every row hashed
 *   full              every repo migration incl. #645 D/E/F in full (extra scenario)
 *   filename          fresh database, 16b in its sorted slot before #645 D/E/F
 *
 * Flags: --negative-control (tamper after migrating; must exit non-zero), --migration=<path> (rehearse another
 * 16b file, e.g. the original from PR #643 as a control), --json=<path> (machine-readable results).
 * Exit code: 0 = every check passed; 1 = at least one check failed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = path.resolve(__dirname, "..");
export const MIG_DIR = path.join(ROOT, "supabase/migrations");
export const TARGET = "20261116b_ten_million_system_design_schema.sql";
const D_FILE = "20261116d_repair_642_identity_and_similarity_safety.sql";
const E_FILE = "20261116e_repair_642_concurrent_indexes.sql";
const F_FILE = "20261116f_repair_642_batch_backfill.sql";
export const FIXTURE = path.join(ROOT, "scripts/fixtures/10m-schema-step1-populated.sql");

/** Minimal engine interface: PGlite and node-postgres both satisfy it through tiny adapters. */
export interface Db {
  exec(sql: string): Promise<void>;
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type Check = { scenario: string; name: string; ok: boolean; detail?: string };
export const checks: Check[] = [];
export const notes: Record<string, any> = {};
export function check(scenario: string, name: string, ok: boolean, detail?: string) {
  checks.push({ scenario, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${detail ? ` :: ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------------------------------
// Supabase platform stubs (UNVERIFIED against production; documented in docs/10m-schema-step1-rehearsal.md)
// ---------------------------------------------------------------------------------------------------
export const PLATFORM_STUBS = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
  END $$;
  GRANT anon, authenticated, service_role TO authenticator;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
    raw_app_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), email_confirmed_at timestamptz);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint,
    allowed_mime_types text[], created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid,
    metadata jsonb, created_at timestamptz DEFAULT now());
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  INSERT INTO storage.buckets (id, name, public) VALUES ('resumes', 'resumes', false);
  -- pg_cron is not available here: record schedule calls only (UNVERIFIED)
  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
  CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
    INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
    ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $$;
  CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = job_name RETURNING true $$;
  CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`;

/**
 * Production objects that NO repo migration creates before they are used (added out of band; there is no
 * production schema snapshot in the repo). UNVERIFIED against production.
 */
export const DRIFT_SHIM = `
  ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS category text;
  ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS country text;
  -- 20261001_filter_upgrades grants on jobs_public, which the repo only creates later (20261010, CREATE OR
  -- REPLACE). Production had it already; a prefix-compatible placeholder lets 20261010 replace it as written.
  CREATE VIEW public.jobs_public AS SELECT id FROM public.jobs;
`;

/** Live columns the owner-reported production has without #645 D section 4 (RECONSTRUCTED). */
const RECON_LIVE_COLUMNS = `
  ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS source_id text;      -- live text board key, e.g. 'greenhouse:stripe'
  ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS category text;  -- backs the owner-reported partial index
`;

/** Split SQL into statements (dollar quotes, strings and comments aware). */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "", i = 0, dollar: string | null = null, inLine = false, inBlock = false, inStr = false;
  while (i < sql.length) {
    const c = sql[i], n2 = sql.slice(i, i + 2);
    if (inLine) { cur += c; if (c === "\n") inLine = false; i++; continue; }
    if (inBlock) { cur += c; if (n2 === "*/") { cur += "/"; i += 2; inBlock = false; continue; } i++; continue; }
    if (dollar) { if (sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; } cur += c; i++; continue; }
    if (inStr) { cur += c; if (c === "'") inStr = false; i++; continue; }
    if (n2 === "--") { inLine = true; cur += c; i++; continue; }
    if (n2 === "/*") { inBlock = true; cur += c; i++; continue; }
    if (c === "'") { inStr = true; cur += c; i++; continue; }
    if (c === "$") { const m = sql.slice(i).match(/^\$[A-Za-z_]*\$/); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (c === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; i++; continue; }
    cur += c; i++;
  }
  if (cur.replace(/--.*$/gm, "").trim()) out.push(cur.trim());
  return out.filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}
const stripComments = (s: string) => s.replace(/--.*$/gm, "").trim();

export const skippedExtensionLines: string[] = [];
/** Extensions the engine cannot load: only their CREATE EXTENSION line is skipped (UNVERIFIED). */
export let unavailableExtensions = ["pg_cron", "pg_stat_statements"];
export function setUnavailableExtensions(list: string[]) { unavailableExtensions = list; }

export async function applySql(db: Db, label: string, sql: string) {
  for (const ext of unavailableExtensions) {
    const re = new RegExp(`CREATE\\s+EXTENSION\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${ext}"?[^;]*;`, "gi");
    if (re.test(sql)) {
      if (!skippedExtensionLines.includes(`${label}: ${ext}`)) skippedExtensionLines.push(`${label}: ${ext}`);
      sql = sql.replace(re, `-- [rehearsal] skipped CREATE EXTENSION ${ext}`);
    }
  }
  if (/\bCONCURRENTLY\b/i.test(stripComments(sql))) {
    for (const stmt of splitStatements(sql)) await db.exec(stmt);
  } else {
    await db.exec(sql);
  }
}

export const allMigrations = () => fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
const readMig = (f: string) => fs.readFileSync(path.join(MIG_DIR, f), "utf8");

export async function applyChain(db: Db, files: string[], label: string, target?: string): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) {
    try {
      await applySql(db, f, f === TARGET && target !== undefined ? target : readMig(f));
    } catch (e: any) {
      failed.push(`${f}: ${String(e?.message || e).slice(0, 200)}`);
      try { await db.exec("ROLLBACK"); } catch {}
    }
  }
  if (failed.length) console.log(`  [${label}] chain failures:\n    ${failed.join("\n    ")}`);
  return failed;
}

// ---------------------------------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------------------------------
export type Baseline = "recon-incomplete" | "recon-complete" | "full";
export const BASELINES: Baseline[] = ["recon-incomplete", "recon-complete", "full"];

/** Scoped D: only the touch_job_last_seen replacement, the v2 similarity function and its column. */
function scopedDStatements(): string[] {
  // Anchored at the statement start so D's preflight DO block (which mentions these names) is not picked up
  const keep = [/^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.touch_job_last_seen\s*\(/i, /^(DROP|CREATE)\s+TRIGGER\s+(IF\s+EXISTS\s+)?jobs_touch_last_seen\b/i,
    /^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.compute_job_similarity_hash_v2\s*\(/i, /^ALTER\s+TABLE\s+public\.jobs\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+similarity_hash_v2\b/i];
  const stmts = splitStatements(readMig(D_FILE)).filter((s) => keep.some((re) => re.test(stripComments(s))));
  if (stmts.length !== 5) throw new Error(`scoped D extraction expected 5 statements, got ${stmts.length}`);
  return stmts;
}

/** Schema for a baseline, before the fixture. Returns chain failures (must be empty). */
export async function buildBaselineSchema(db: Db, kind: Baseline): Promise<string[]> {
  if (kind === "full") return applyChain(db, allMigrations().filter((f) => f !== TARGET), kind);
  const failed = await applyChain(db, allMigrations().filter((f) => ![TARGET, D_FILE, E_FILE, F_FILE].includes(f)), kind);
  try {
    await db.exec(RECON_LIVE_COLUMNS);
    for (const s of scopedDStatements()) await db.exec(s);
    // E: the valid canonical identity index, built exactly as 20261116e builds it
    const eIdx = splitStatements(readMig(E_FILE)).find((s) => /CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+idx_jobs_source_id_source_job_id_uniq/i.test(stripComments(s)));
    if (!eIdx) throw new Error("E canonical index statement not found");
    await db.exec(eIdx);
    // Owner-reported valid PARTIAL companies(category) index
    await db.exec(`CREATE INDEX idx_companies_category ON public.companies (category) WHERE category IS NOT NULL`);
    // F installed (progress table + procedure); its CALL is modelled per baseline after the fixture
    await db.exec(readMig(F_FILE).replace(/^\s*CALL\s+public\.repair_645_run_resumable_backfill\s*\([^)]*\)\s*;/im, "-- [rehearsal] CALL modelled separately"));
  } catch (e: any) {
    failed.push(`reconstruction: ${String(e?.message || e).slice(0, 200)}`);
  }
  return failed;
}

/** Data-dependent post-#645 state, after the fixture is loaded. */
export async function applyBaselineState(db: Db, kind: Baseline | "filename") {
  if (kind === "full" || kind === "filename") {
    await db.exec(`CALL public.repair_645_run_resumable_backfill(500)`);
    // With D in full, compute_job_dedupe_hash delegates to the v2 similarity hash, so a fully migrated DB
    // carries dedupe_hash = similarity hash; the 16 cross-source pairs therefore share one dedupe_hash.
    await db.exec(`BEGIN; SET LOCAL careermonke.skip_touch_last_seen = 'on';
                   UPDATE public.jobs SET dedupe_hash = similarity_hash_v2 WHERE dedupe_hash IS NULL AND similarity_hash_v2 IS NOT NULL; COMMIT;`);
    return;
  }
  // F phase 3 exactly as 20261116f runs it: active rows only, liveness untouched
  const fill = (where: string) => `
    BEGIN;
    SET LOCAL careermonke.skip_touch_last_seen = 'on';
    UPDATE public.jobs SET similarity_hash_v2 = public.compute_job_similarity_hash_v2(company, title, COALESCE(country_code, country), location)
     WHERE ${where} AND similarity_hash_v2 IS NULL;
    COMMIT;`;
  await db.exec(fill("is_active = TRUE"));
  const activeRows = Number((await db.query<{ n: string }>(`SELECT count(*) n FROM public.jobs WHERE is_active`)).rows[0].n);
  if (kind === "recon-incomplete") {
    // Active missing hashes = 0, but the other F phases never completed: full progress NOT assumed
    await db.exec(`INSERT INTO public.repair_645_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at)
                   VALUES ('jobs_similarity_hash_v2', ${activeRows}, ${activeRows % 500}, timestamptz '2026-11-17 00:00:00+00')`);
  } else {
    await db.exec(fill("TRUE"));
    await db.exec(`INSERT INTO public.repair_645_backfill_progress (phase, total_rows_updated, last_batch_rows, updated_at) VALUES
      ('companies_canonical_domain', 0, 0, timestamptz '2026-11-17 00:00:00+00'),
      ('jobs_source_priority', 0, 0, timestamptz '2026-11-17 00:00:00+00'),
      ('jobs_similarity_hash_v2', ${activeRows}, ${activeRows % 500}, timestamptz '2026-11-17 00:00:00+00')`);
  }
}

export async function loadFixture(db: Db) {
  await db.exec(fs.readFileSync(FIXTURE, "utf8"));
}

// ---------------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------------
const BASE_TABLES = ["jobs", "companies", "job_descriptions", "saved_jobs"] as const;
const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

export type Snapshot = {
  counts: Record<string, number>;
  checksums: Record<string, string>;
  lastSeen: string;
  fState: string;
  columns: Record<string, string[]>;
  indexes: Record<string, { def: string; valid: boolean }>;
  jobTriggers: string[];
  queries: Record<string, string>;
  acl: Record<string, string>;
};

export async function originalColumns(db: Db): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of BASE_TABLES) {
    const r = await db.query<{ c: string }>(
      `SELECT column_name c FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [t]);
    out[t] = r.rows.map((x) => x.c);
  }
  return out;
}

export async function snapshot(db: Db, cols: Record<string, string[]>): Promise<Snapshot> {
  const counts: Record<string, number> = {};
  const checksums: Record<string, string> = {};
  for (const t of BASE_TABLES) {
    counts[t] = Number((await db.query<{ n: string }>(`SELECT count(*) n FROM public.${t}`)).rows[0].n);
    const list = cols[t].map((c) => `"${c}"`).join(", ");
    const key = t === "job_descriptions" ? "job_id" : "id";
    const r = await db.query<{ j: string }>(`SELECT coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY x.${key}), '') j FROM (SELECT ${list} FROM public.${t}) x`);
    checksums[t] = md5(r.rows[0].j);
  }
  const ls = await db.query<{ j: string }>(`SELECT coalesce(string_agg(id::text || '=' || coalesce(last_seen_at::text, 'null'), ',' ORDER BY id), '') j FROM public.jobs`);
  const hasF = (await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='repair_645_backfill_progress'`)).rows.length > 0;
  const hasHash = (await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs' AND column_name='similarity_hash_v2'`)).rows.length > 0;
  const fRows = hasF ? (await db.query(`SELECT phase, total_rows_updated, last_batch_rows, updated_at::text u FROM public.repair_645_backfill_progress ORDER BY phase`)).rows : [];
  const hashes = hasHash ? (await db.query<{ j: string }>(`SELECT coalesce(string_agg(id::text || '=' || coalesce(similarity_hash_v2, 'null'), ',' ORDER BY id), '') j FROM public.jobs`)).rows[0].j : "";
  const columns: Record<string, string[]> = {};
  const c = await db.query<{ t: string; c: string; ty: string }>(
    `SELECT table_name t, column_name c, data_type ty FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
  for (const r of c.rows) (columns[r.t] ||= []).push(`${r.c}:${r.ty}`);
  const indexes: Record<string, { def: string; valid: boolean }> = {};
  const ix = await db.query<{ n: string; d: string; v: boolean }>(
    `SELECT c.relname n, pg_get_indexdef(i.indexrelid) d, i.indisvalid v FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname IN ('public', 'internal_ingestion') ORDER BY 1`);
  for (const r of ix.rows) indexes[r.n] = { def: r.d, valid: r.v };
  const tr = await db.query<{ n: string }>(`SELECT tgname n FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND NOT tgisinternal ORDER BY 1`);
  const q = async (sql: string) => md5(JSON.stringify((await db.query(sql)).rows));
  const queries = {
    jobs_public_feed: await q(`SELECT id, title, location, remote FROM public.jobs_public ORDER BY id`),
    active_by_category: await q(`SELECT category, count(*) n FROM public.jobs WHERE is_active GROUP BY 1 ORDER BY 1 NULLS FIRST`),
    saved_join: await q(`SELECT s.user_id, j.title FROM public.saved_jobs s JOIN public.jobs j ON j.id = s.job_id ORDER BY 1, 2`),
    descriptions_join: await q(`SELECT j.id, d.description_text FROM public.jobs j JOIN public.job_descriptions d ON d.job_id = j.id ORDER BY 1`),
    cross_vendor_ids: await q(`SELECT source_job_id, count(DISTINCT source) n FROM public.jobs GROUP BY 1 HAVING count(DISTINCT source) > 1 ORDER BY 1`),
  };
  const acl: Record<string, string> = {};
  const rel = await db.query<{ n: string; o: string; a: string | null; rls: boolean }>(
    `SELECT n.nspname || '.' || c.relname n, pg_get_userbyid(c.relowner) o, c.relacl::text a, c.relrowsecurity rls FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'internal_ingestion') AND c.relkind IN ('r', 'v', 'm')`);
  for (const r of rel.rows) acl[r.n] = `${r.o}|${r.a}|rls=${r.rls}`;
  const nsp = await db.query<{ n: string; a: string | null }>(`SELECT nspname n, nspacl::text a FROM pg_namespace WHERE nspname IN ('public', 'internal_ingestion')`);
  for (const r of nsp.rows) acl[`schema:${r.n}`] = String(r.a);
  const fn = await db.query<{ n: string; o: string; a: string | null; sd: boolean; cfg: string | null }>(
    `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' n, pg_get_userbyid(p.proowner) o,
       p.proacl::text a, p.prosecdef sd, p.proconfig::text cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'internal_ingestion')`);
  for (const r of fn.rows) acl[r.n] = `${r.o}|${r.a}|secdef=${r.sd}|cfg=${r.cfg}`;
  return { counts, checksums, lastSeen: md5(ls.rows[0].j), fState: md5(JSON.stringify(fRows) + hashes), columns, indexes,
    jobTriggers: tr.rows.map((r) => r.n), queries, acl };
}

/** What differs between two snapshots (empty = identical). Compares key by key, never by serialization order. */
export function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const out: string[] = [];
  for (const sect of ["counts", "checksums", "queries"] as const)
    for (const k of new Set([...Object.keys(a[sect]), ...Object.keys(b[sect])]))
      if ((a[sect] as any)[k] !== (b[sect] as any)[k]) out.push(`${sect}.${k}`);
  if (a.lastSeen !== b.lastSeen) out.push("last_seen_at");
  if (a.fState !== b.fState) out.push("#645 F state (progress rows / similarity hashes)");
  for (const t of new Set([...Object.keys(a.columns), ...Object.keys(b.columns)]))
    if (JSON.stringify(a.columns[t]) !== JSON.stringify(b.columns[t])) out.push(`columns.${t}`);
  for (const n of new Set([...Object.keys(a.indexes), ...Object.keys(b.indexes)]))
    if (JSON.stringify(a.indexes[n]) !== JSON.stringify(b.indexes[n])) out.push(`index.${n}`);
  if (JSON.stringify(a.jobTriggers) !== JSON.stringify(b.jobTriggers)) out.push("jobs triggers");
  for (const n of new Set([...Object.keys(a.acl), ...Object.keys(b.acl)]))
    if (a.acl[n] !== b.acl[n]) out.push(`acl.${n}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Applying 16b (timing + own lock capture before COMMIT)
// ---------------------------------------------------------------------------------------------------
export type ApplyResult = { ok: boolean; ms: number; error?: string; locks: string[] };

export function splitFinalCommit(sql: string): { body: string; hasCommit: boolean } {
  const i = sql.lastIndexOf("COMMIT;");
  const tail = i >= 0 ? stripComments(sql.slice(i + "COMMIT;".length)) : "x";
  return i >= 0 && tail === "" ? { body: sql.slice(0, i), hasCommit: true } : { body: sql, hasCommit: false };
}

export async function applyTarget(db: Db, sql: string, inject?: string): Promise<ApplyResult> {
  const { body, hasCommit } = splitFinalCommit(sql);
  const t0 = performance.now();
  try {
    await applySql(db, TARGET, body + (inject ? `\n${inject}\n` : ""));
    const locks = await db.query<{ r: string; m: string }>(
      `SELECT coalesce(c.relname, l.locktype) r, l.mode m FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = pg_backend_pid() AND l.granted AND l.locktype = 'relation'
          AND c.relname IN ('jobs', 'companies', 'job_descriptions', 'saved_jobs') ORDER BY 1, 2`);
    if (hasCommit) await db.exec("COMMIT");
    return { ok: true, ms: Math.round(performance.now() - t0), locks: locks.rows.map((r) => `${r.r}:${r.m}`) };
  } catch (e: any) {
    try { await db.exec("ROLLBACK"); } catch {}
    return { ok: false, ms: Math.round(performance.now() - t0), error: String(e?.message || e).slice(0, 300), locks: [] };
  }
}

// ---------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------
export function compareUnchanged(scn: string, before: Snapshot, after: Snapshot) {
  for (const t of BASE_TABLES) {
    check(scn, `row count unchanged: ${t}`, before.counts[t] === after.counts[t], `${before.counts[t]} -> ${after.counts[t]}`);
    check(scn, `checksum of original columns unchanged: ${t}`, before.checksums[t] === after.checksums[t]);
  }
  check(scn, "jobs.last_seen_at preserved for every row", before.lastSeen === after.lastSeen);
  check(scn, "#645 F state unchanged (progress rows, similarity hashes)", before.fState === after.fState);
  const colDiff = Object.entries(before.columns).filter(([t, cols]) => !cols.every((c, i) => (after.columns[t] || [])[i] === c)).map(([t]) => t);
  check(scn, "column order/types of every pre-existing public relation preserved", colDiff.length === 0, colDiff.join(", ") || undefined);
  const changedIdx = Object.entries(before.indexes).filter(([n, v]) => !after.indexes[n] || after.indexes[n].def !== v.def).map(([n]) => n);
  check(scn, "pre-existing index definitions unchanged (incl. #645 E and partial idx_companies_category)", changedIdx.length === 0, changedIdx.join(", ") || undefined);
  const invalid = Object.entries(after.indexes).filter(([, v]) => !v.valid).map(([n]) => n);
  check(scn, "every index is valid (indisvalid)", invalid.length === 0, invalid.join(", ") || undefined);
  const newTriggers = after.jobTriggers.filter((t) => !before.jobTriggers.includes(t));
  check(scn, "no new triggers on public.jobs (no automatic merge/expiry)", newTriggers.length === 0, newTriggers.join(", ") || undefined);
  const qDiff = Object.keys(before.queries).filter((k) => after.queries[k] !== before.queries[k]);
  check(scn, "app query results unchanged (feed, categories, saved_jobs join, descriptions join, cross-vendor ids)", qDiff.length === 0, qDiff.join(", ") || undefined);
  const aclChanged = Object.entries(before.acl).filter(([n, v]) => after.acl[n] !== undefined && after.acl[n] !== v).map(([n]) => n);
  check(scn, "owners/grants/RLS of pre-existing schemas, relations and functions unchanged", aclChanged.length === 0, aclChanged.join(", ") || undefined);
}

async function asRole<T>(db: Db, role: string, sub: string | null, fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${sub ?? ""}', true), set_config('request.jwt.claim.role', '${role}', true);`);
  try {
    const value = await fn();
    await db.exec("ROLLBACK");
    return { ok: true, value };
  } catch (e: any) {
    try { await db.exec("ROLLBACK"); } catch {}
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** Runs fn inside a transaction that is always rolled back; returns fn's value or the error. */
async function inRollback<T>(db: Db, fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  await db.exec("BEGIN");
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    try { await db.exec("ROLLBACK"); } catch {}
  }
}

const n = async (db: Db, sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0].n);

export async function behaviorChecks(scn: string, db: Db) {
  // --- jobs identity: canonical key unique, similarity advisory, no merge machinery ---------------------
  check(scn, "#645 containment kept: no idx_jobs_active_dedupe_hash_uniq",
    (await db.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_jobs_active_dedupe_hash_uniq'`)).rows.length === 0);
  check(scn, "no merge_job_by_dedupe_priority function or trigger",
    (await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'merge_job_by_dedupe_priority' UNION ALL SELECT 1 FROM pg_trigger WHERE tgname ILIKE '%merge%dedupe%'`)).rows.length === 0);
  const canon = await db.query<{ d: string; v: boolean }>(
    `SELECT pg_get_indexdef(i.indexrelid) d, i.indisvalid v FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_jobs_source_id_source_job_id_uniq'`);
  check(scn, "canonical UNIQUE (source_id, source_job_id) present and valid",
    canon.rows.length === 1 && canon.rows[0].v && /UNIQUE/.test(canon.rows[0].d), canon.rows[0]?.d);

  const pair = await inRollback(db, async () => {
    const hash = (await db.query<{ h: string | null }>(`SELECT similarity_hash_v2 h FROM public.jobs WHERE id = '00000000-0000-4000-8000-000000000001'`)).rows[0]?.h;
    const before = await n(db, `SELECT count(*) n FROM public.jobs WHERE is_active AND similarity_hash_v2 = '${hash}'`);
    await db.exec(`INSERT INTO public.jobs (company, title, location, source, source_job_id, source_id, similarity_hash_v2, dedupe_hash, is_active, status, apply_url)
                   SELECT company, title, location, 'workable', 'wk-1', 'workable:fixture-company-x', similarity_hash_v2, similarity_hash_v2, true, 'active', 'https://apply.example.invalid/workable/1'
                   FROM public.jobs WHERE id = '00000000-0000-4000-8000-000000000001'`);
    const after = await n(db, `SELECT count(*) n FROM public.jobs WHERE is_active AND similarity_hash_v2 = '${hash}'`);
    return { hash, before, after };
  });
  check(scn, "same posting from another board inserts; nothing merged or expired",
    pair.ok && !!pair.value?.hash && pair.value.before >= 2 && pair.value.after === pair.value.before + 1,
    pair.error || `hash ${pair.value?.hash ? "set" : "MISSING"}, active same-hash ${pair.value?.before} -> ${pair.value?.after}`);
  const dupCanon = await inRollback(db, () => db.exec(
    `INSERT INTO public.jobs (company, title, location, source, source_job_id, source_id) SELECT company, title, location, 'other-vendor', source_job_id, source_id FROM public.jobs WHERE id = '00000000-0000-4000-8000-000000000001'`));
  check(scn, "duplicate canonical (source_id, source_job_id) rejected", !dupCanon.ok, dupCanon.error?.slice(0, 90));
  check(scn, "same-vendor duplicate external id rejected (legacy key)",
    !(await inRollback(db, () => db.exec(`INSERT INTO public.jobs (company, title, location, source, source_job_id) VALUES ('X', 'dup', 'Remote', 'greenhouse', '1')`))).ok);
  check(scn, "cross-vendor identical external ids coexist",
    (await n(db, `SELECT count(*) n FROM (SELECT source_job_id FROM public.jobs GROUP BY 1 HAVING count(DISTINCT source) > 1) x`)) > 0);

  // --- jobs.source_id stays the text board key; registry link is a separate uuid FK ------------------
  const sid = (await db.query<{ t: string }>(`SELECT data_type t FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs' AND column_name='source_id'`)).rows[0]?.t;
  const reg = (await db.query<{ t: string }>(`SELECT data_type t FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs' AND column_name='source_registry_id'`)).rows[0]?.t;
  const regFk = (await db.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='public.jobs'::regclass AND contype='f' AND pg_get_constraintdef(oid) LIKE '%source_registry_id%'`)).rows[0]?.d;
  const sidFk = (await db.query(`SELECT 1 FROM pg_constraint WHERE conrelid='public.jobs'::regclass AND contype='f' AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (source_id)%'`)).rows.length;
  check(scn, "jobs.source_id is text with no FK (live board key, never cast)", sid === "text" && sidFk === 0, `type=${sid}, fk=${sidFk}`);
  check(scn, "jobs.source_registry_id is uuid FK -> internal_ingestion.ingestion_sources ON DELETE SET NULL",
    reg === "uuid" && !!regFk && /internal_ingestion\.ingestion_sources\(id\)/.test(regFk) && /ON DELETE SET NULL/.test(regFk), `type=${reg}, fk=${regFk}`);
  const map = await inRollback(db, async () => {
    // register the board key of an existing job (e.g. 'greenhouse:fixture-company-5') as an ingestion source
    const key = (await db.query<{ k: string }>(`SELECT source_id k FROM public.jobs WHERE id = '00000000-0000-4000-8000-000000000004'`)).rows[0].k;
    await db.exec(`INSERT INTO internal_ingestion.ingestion_sources (id, name, slug, source_type)
                   VALUES ('00000000-0000-4000-8000-00000000f001', 'Registered board', '${key}', 'ats')`);
    await db.exec(`UPDATE public.jobs j SET source_registry_id = s.id FROM internal_ingestion.ingestion_sources s WHERE s.slug = j.source_id`);
    const expected = await n(db, `SELECT count(*) n FROM public.jobs WHERE source_id = '${key}'`);
    const mapped = await n(db, `SELECT count(*) n FROM public.jobs WHERE source_registry_id = '00000000-0000-4000-8000-00000000f001'`);
    const wrong = await n(db, `SELECT count(*) n FROM public.jobs WHERE source_registry_id IS NOT NULL AND source_id <> '${key}'`);
    await db.exec(`DELETE FROM internal_ingestion.ingestion_sources WHERE id = '00000000-0000-4000-8000-00000000f001'`);
    const afterDelete = await n(db, `SELECT count(*) n FROM public.jobs WHERE source_registry_id IS NOT NULL`);
    const jobsAfterDelete = await n(db, `SELECT count(*) n FROM public.jobs WHERE source_id = '${key}'`);
    return { key, expected, mapped, wrong, afterDelete, jobsAfterDelete };
  });
  const mv = map.value;
  check(scn, "slug = source_id maps board-key jobs to the registry; deleting the source only clears the link",
    map.ok && !!mv && mv.expected > 0 && mv.mapped === mv.expected && mv.wrong === 0 && mv.afterDelete === 0 && mv.jobsAfterDelete === mv.expected,
    map.error || JSON.stringify(mv));
  const bogus = await inRollback(db, () => db.exec(`UPDATE public.jobs SET source_registry_id = '00000000-0000-4000-8000-0000000000ff' WHERE id = '00000000-0000-4000-8000-000000000002'`));
  check(scn, "unknown registry uuid rejected by the FK", !bogus.ok, bogus.error?.slice(0, 90));

  // --- job_postings identity ------------------------------------------------------------------------
  const jp = await inRollback(db, async () => {
    await db.exec(`INSERT INTO internal_ingestion.ingestion_sources (id, name, slug, source_type) VALUES
      ('00000000-0000-4000-8000-00000000f0a1', 'Board A', 'greenhouse:board-a', 'ats'),
      ('00000000-0000-4000-8000-00000000f0b2', 'Board B', 'lever:board-b', 'ats')`);
    await db.exec(`INSERT INTO public.job_postings (source_id, external_id, title, company_name, dedupe_hash, is_active) VALUES
      ('00000000-0000-4000-8000-00000000f0a1', 'ext-1', 'Same Posting', 'Same Co', 'simhash-same', true),
      ('00000000-0000-4000-8000-00000000f0b2', 'ext-1', 'Same Posting', 'Same Co', 'simhash-same', true)`);
    const sameHash = await n(db, `SELECT count(*) n FROM public.job_postings WHERE dedupe_hash = 'simhash-same' AND is_active`);
    let dupRejected = false;
    await db.exec(`SAVEPOINT d`);
    try { await db.exec(`INSERT INTO public.job_postings (source_id, external_id, title, company_name) VALUES ('00000000-0000-4000-8000-00000000f0a1', 'ext-1', 'Dup', 'Same Co')`); }
    catch { dupRejected = true; }
    await db.exec(`ROLLBACK TO SAVEPOINT d`);
    const upsert = `INSERT INTO public.job_postings (source_id, external_id, title, company_name) VALUES ('00000000-0000-4000-8000-00000000f0a1', 'ext-1', 'Same Posting (updated)', 'Same Co')
      ON CONFLICT (source_id, external_id) WHERE source_id IS NOT NULL AND external_id IS NOT NULL DO UPDATE SET title = EXCLUDED.title`;
    await db.exec(upsert);
    await db.exec(upsert);
    const afterUpsert = await n(db, `SELECT count(*) n FROM public.job_postings WHERE source_id = '00000000-0000-4000-8000-00000000f0a1' AND external_id = 'ext-1'`);
    const title = (await db.query<{ t: string }>(`SELECT title t FROM public.job_postings WHERE source_id = '00000000-0000-4000-8000-00000000f0a1' AND external_id = 'ext-1'`)).rows[0].t;
    const stillActive = await n(db, `SELECT count(*) n FROM public.job_postings WHERE is_active`);
    // deleting a posting must not delete a user's saved job or a job description (SET NULL, not CASCADE)
    const pid = (await db.query<{ id: string }>(`SELECT id FROM public.job_postings WHERE source_id = '00000000-0000-4000-8000-00000000f0b2'`)).rows[0].id;
    const saved = (await db.query<{ id: string; job: string }>(`SELECT id, job_id job FROM public.saved_jobs ORDER BY id LIMIT 1`)).rows[0];
    await db.exec(`UPDATE public.saved_jobs SET job_posting_id = '${pid}' WHERE id = '${saved.id}'`);
    await db.exec(`UPDATE public.job_descriptions SET posting_id = '${pid}' WHERE job_id = (SELECT job_id FROM public.job_descriptions ORDER BY job_id LIMIT 1)`);
    const descBefore = await n(db, `SELECT count(*) n FROM public.job_descriptions`);
    await db.exec(`DELETE FROM public.job_postings WHERE id = '${pid}'`);
    const savedKept = await n(db, `SELECT count(*) n FROM public.saved_jobs WHERE id = '${saved.id}' AND job_posting_id IS NULL AND job_id = '${saved.job}'`);
    const descAfter = await n(db, `SELECT count(*) n FROM public.job_descriptions`);
    return { sameHash, dupRejected, afterUpsert, title, stillActive, savedKept, descKept: descAfter === descBefore && descBefore > 0 };
  });
  const jv = jp.value;
  check(scn, "job_postings: two boards with the same similarity hash coexist", jp.ok && jv?.sameHash === 2, jp.error || `rows=${jv?.sameHash}`);
  check(scn, "job_postings: duplicate canonical (source_id, external_id) rejected", jp.ok && jv?.dupRejected === true, jp.error);
  check(scn, "job_postings: ON CONFLICT upsert on the canonical key is idempotent", jp.ok && jv?.afterUpsert === 1 && jv?.title === "Same Posting (updated)", jp.error || JSON.stringify(jv));
  check(scn, "job_postings: nothing silently expired", jp.ok && jv?.stillActive === 2, jp.error || `active=${jv?.stillActive}`);
  check(scn, "deleting a posting keeps the user's saved_jobs row and the job description (SET NULL)", jp.ok && jv?.savedKept === 1 && jv?.descKept === true, jp.error || JSON.stringify(jv));
  check(scn, "no UNIQUE index on job_postings.dedupe_hash",
    (await db.query(`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 'public.job_postings'::regclass AND i.indisunique AND pg_get_indexdef(i.indexrelid) LIKE '%(dedupe_hash)%'`)).rows.length === 0);

  // --- isolation, masking, RLS ----------------------------------------------------------------------
  const priv = (await db.query<{ a: boolean; u: boolean; s: boolean }>(
    `SELECT has_schema_privilege('anon', 'internal_ingestion', 'USAGE') a, has_schema_privilege('authenticated', 'internal_ingestion', 'USAGE') u,
            has_schema_privilege('service_role', 'internal_ingestion', 'USAGE') s`)).rows[0];
  check(scn, "internal_ingestion: no USAGE for anon/authenticated, USAGE for service_role", !priv.a && !priv.u && priv.s, JSON.stringify(priv));
  for (const role of ["anon", "authenticated"]) {
    const r = await asRole(db, role, "00000000-0000-4000-8000-0000000000a1", () => db.query(`SELECT * FROM internal_ingestion.ingestion_sources LIMIT 1`));
    check(scn, `internal_ingestion.ingestion_sources denied to ${role}`, !r.ok, r.error);
    const raw = await asRole(db, role, "00000000-0000-4000-8000-0000000000a1", async () => n(db, `SELECT count(*) n FROM public.job_postings`));
    check(scn, `raw public.job_postings not readable by ${role}`, !raw.ok || raw.value === 0, raw.error || `rows=${raw.value}`);
  }
  check(scn, "internal_ingestion.ingestion_sources readable by service_role", (await asRole(db, "service_role", null, () => db.query(`SELECT count(*) FROM internal_ingestion.ingestion_sources`))).ok);
  const masked = await inRollback(db, async () => {
    await db.exec(`INSERT INTO public.job_postings (title, company_name, company_slug, salary_min, salary_max, salary_text, direct_apply_url, raw_payload, is_active)
                   VALUES ('Masking probe', 'Real Employer Ltd', 'real-employer', 100, 200, '₹100-200', 'https://apply.example.invalid/x', '{"k":"v"}', true)`);
    await db.exec(`SET LOCAL ROLE anon`);
    return (await db.query<any>(`SELECT company_name, company_slug, salary_min, salary_max, direct_apply_url, raw_payload FROM public.job_postings_public WHERE title = 'Masking probe'`)).rows[0];
  });
  const m = masked.value;
  check(scn, "job_postings_public (as anon) masks company/salary/apply url/raw payload",
    masked.ok && !!m && m.company_name === "Verified Employer" && m.company_slug === null && m.salary_min === null && m.salary_max === null && m.direct_apply_url === null && m.raw_payload === null,
    masked.error || JSON.stringify(m));
  const own = await asRole(db, "authenticated", "00000000-0000-4000-8000-0000000000a1", async () =>
    (await db.query<{ u: string }>(`SELECT DISTINCT user_id::text u FROM public.saved_jobs`)).rows.map((r) => r.u));
  check(scn, "saved_jobs RLS: authenticated user sees only own rows",
    own.ok && (own.value || []).length > 0 && (own.value || []).every((u) => u === "00000000-0000-4000-8000-0000000000a1"), own.error || JSON.stringify(own.value));
  const anonSaved = await asRole(db, "anon", null, async () => n(db, `SELECT count(*) n FROM public.saved_jobs`));
  check(scn, "saved_jobs RLS: anon sees no rows", !anonSaved.ok || anonSaved.value === 0, anonSaved.error || `rows=${anonSaved.value}`);

  // --- recorded, not asserted ---------------------------------------------------------------------------
  notes[`${scn}:unique_on_source_source_job_id`] = (await db.query<{ n: string }>(
    `SELECT c.relname n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = 'public.jobs'::regclass AND i.indisunique
       AND pg_get_indexdef(i.indexrelid) ~ '\\(source, source_job_id\\)' ORDER BY 1`)).rows.map((r) => r.n);
  notes[`${scn}:idx_companies_category`] = (await db.query<{ d: string }>(`SELECT indexdef d FROM pg_indexes WHERE indexname = 'idx_companies_category'`)).rows[0]?.d;
}

/** Types, constraints and FKs of the relations 16b creates or extends: the cross-order contract. */
export async function structureOf(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const tables = ["jobs", "companies", "job_postings", "job_descriptions", "saved_jobs", "ai_generations", "consent_logs", "user_age_attestations"];
  const cols = await db.query<{ s: string; t: string; c: string; ty: string; nul: string; def: string | null }>(
    `SELECT table_schema s, table_name t, column_name c, data_type ty, is_nullable nul, column_default def FROM information_schema.columns
      WHERE (table_schema = 'public' AND table_name = ANY($1)) OR table_schema = 'internal_ingestion'`, [tables]);
  for (const r of cols.rows) out[`col ${r.s}.${r.t}.${r.c}`] = `${r.ty} null=${r.nul} default=${r.def}`;
  const cons = await db.query<{ s: string; t: string; n: string; d: string }>(
    `SELECT n.nspname s, c.relname t, k.conname n, pg_get_constraintdef(k.oid) d FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (n.nspname = 'public' AND c.relname = ANY($1)) OR n.nspname = 'internal_ingestion'`, [tables]);
  for (const r of cons.rows) out[`con ${r.s}.${r.t}.${r.n}`] = r.d;
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Rollback: executes the EXACT documented scripts (supabase/scripts/rollback-20261116b-*.sql)
// ---------------------------------------------------------------------------------------------------
export const ROLLBACK_DISABLE = path.join(ROOT, "supabase/scripts/rollback-20261116b-disable.sql");
export const ROLLBACK_REMOVE = path.join(ROOT, "supabase/scripts/rollback-20261116b-remove-if-empty.sql");
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const API_ROLES = ["anon", "authenticated", "service_role"];

/** Everything attached to a given set of relations: indexes, constraints, policies, effective privileges, RLS, triggers. */
async function objectState(db: Db, relations: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const rels = (await db.query<{ q: string; oid: number; rls: boolean; force: boolean; kind: string }>(
    `SELECT n.nspname || '.' || c.relname q, c.oid, c.relrowsecurity rls, c.relforcerowsecurity force, c.relkind::text kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname || '.' || c.relname = ANY($1)`, [relations])).rows;
  for (const r of rels) {
    if (r.kind === "r" || r.kind === "p") out[`rls ${r.q}`] = `${r.rls},${r.force}`;
    for (const role of API_ROLES)
      for (const priv of PRIVS)
        out[`priv ${r.q} ${role} ${priv}`] = String((await db.query<{ v: boolean }>(`SELECT has_table_privilege($1, $2::oid, $3) v`, [role, r.oid, priv])).rows[0].v);
  }
  const oids = rels.map((r) => r.oid);
  for (const r of (await db.query<{ t: string; i: string; d: string }>(
    `SELECT tc.relname t, ic.relname i, pg_get_indexdef(i.indexrelid) d FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class tc ON tc.oid = i.indrelid WHERE i.indrelid = ANY($1::oid[])`, [oids])).rows) out[`index ${r.t}.${r.i}`] = r.d;
  for (const r of (await db.query<{ t: string; k: string; d: string }>(
    `SELECT c.relname t, k.conname k, pg_get_constraintdef(k.oid) d FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      WHERE k.conrelid = ANY($1::oid[]) AND k.contype <> 'n'`, [oids])).rows) out[`constraint ${r.t}.${r.k}`] = r.d;
  for (const r of (await db.query<{ t: string; p: string; d: string }>(
    `SELECT c.relname t, p.polname p, p.polcmd::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || '|' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') d
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.polrelid = ANY($1::oid[])`, [oids])).rows) out[`policy ${r.t}.${r.p}`] = r.d;
  for (const r of (await db.query<{ t: string; g: string }>(
    `SELECT c.relname t, tg.tgname g FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid WHERE tg.tgrelid = ANY($1::oid[]) AND NOT tg.tgisinternal`, [oids])).rows)
    out[`trigger ${r.t}.${r.g}`] = "1";
  return out;
}

/** Exact ACL per relation: every (grantee, privilege, grant option, grantor) item, NULL ACL expanded to its default. */
export async function aclItems(db: Db, relations: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of (await db.query<{ q: string; a: string }>(
    `SELECT n.nspname || '.' || c.relname q,
            (SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || '=' || x.p, ',' ORDER BY x.grantee, x.p)
               FROM (SELECT a.grantee, string_agg(CASE a.privilege_type WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w'
                       WHEN 'DELETE' THEN 'd' WHEN 'TRUNCATE' THEN 'D' WHEN 'REFERENCES' THEN 'x' WHEN 'TRIGGER' THEN 't' WHEN 'MAINTAIN' THEN 'm'
                       ELSE a.privilege_type END || CASE WHEN a.is_grantable THEN '*' ELSE '' END, '' ORDER BY a.privilege_type)
                       || '/' || pg_get_userbyid(a.grantor) p
                       FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a GROUP BY a.grantee, a.grantor) x) a
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname || '.' || c.relname = ANY($1)`, [relations])).rows)
    out[r.q] = r.a ?? "";
  return out;
}

async function relationsNow(db: Db): Promise<string[]> {
  return (await db.query<{ q: string }>(
    `SELECT n.nspname || '.' || c.relname q FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'internal_ingestion') AND c.relkind IN ('r', 'p', 'v', 'm')`)).rows.map((r) => r.q);
}

const diffMaps = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);

/** md5 over the data written into objects 20261116b created (new tables + new columns on old tables). */
async function newDataChecksum(db: Db, created: string[]): Promise<string> {
  const parts: string[] = [];
  for (const q of created.filter((x) => x !== "internal_ingestion.schema_migration_provenance").sort()) {
    const kind = (await db.query<{ k: string }>(`SELECT c.relkind::text k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname || '.' || c.relname = $1`, [q])).rows[0]?.k;
    if (kind !== "r") continue;
    parts.push(q + "=" + (await db.query<{ j: string }>(`SELECT coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text), '') j FROM ${q} t`)).rows[0].j);
  }
  for (const [t, cols] of [["public.jobs", "id, source_registry_id"], ["public.saved_jobs", "id, job_posting_id"], ["public.job_descriptions", "job_id, posting_id"]] as const)
    parts.push(t + "=" + (await db.query<{ j: string }>(`SELECT coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text), '') j FROM (SELECT ${cols} FROM ${t}) t`)).rows[0].j);
  return md5(parts.join("\n"));
}

async function runFile(db: Db, file: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.exec(fs.readFileSync(file, "utf8"));
    return { ok: true };
  } catch (e: any) {
    try { await db.exec("ROLLBACK"); } catch {}
    return { ok: false, error: String(e?.message || e).slice(0, 240) };
  }
}

export async function rollbackScenario(engine: Engine, kind: Baseline, targetSql: string) {
  const scn = `R:${kind}`;
  console.log(`\n=== ${scn}: documented rollback scripts on the populated baseline ===`);
  const db = await populatedProductionOrder(engine, kind, `rollback-${kind}`);
  try {
    await rollbackSteps(scn, db, targetSql);
  } catch (e: any) {
    check(scn, "rollback scenario completed", false, String(e?.message || e).slice(0, 200));
  } finally {
    await engine.close(db);
  }
}

async function rollbackSteps(scn: string, db: Db, targetSql: string) {
  // A production variant whose saved_jobs grants / RLS differ from what 20261116b sets, so the migration
  // changes them and the disable script has to restore the exact prior state from the provenance record.
  // The variant carries grant options (anon SELECT WITH GRANT OPTION, which 16b revokes; service_role REFERENCES
  // WITH GRANT OPTION, which 16b's GRANT ALL widens) so the restore must reproduce is_grantable exactly.
  await db.exec(`GRANT SELECT ON public.saved_jobs TO anon WITH GRANT OPTION;
    GRANT REFERENCES ON public.saved_jobs TO service_role WITH GRANT OPTION;
    ALTER TABLE public.saved_jobs NO FORCE ROW LEVEL SECURITY;`);
  const cols = await originalColumns(db);
  const preRelations = await relationsNow(db);
  const s0 = await snapshot(db, cols);
  const pre0 = await objectState(db, preRelations);
  const acl0 = await aclItems(db, preRelations);
  check(scn, "ACL fixture has grant options on a pre-existing table", /(^|,)anon=[^,/]*r\*/.test(acl0["public.saved_jobs"] ?? "") && /(^|,)service_role=[^,/]*x\*/.test(acl0["public.saved_jobs"] ?? ""),
    acl0["public.saved_jobs"]);

  const applied = await applyTarget(db, targetSql);
  check(scn, "20261116b applies", applied.ok, applied.error);
  if (!applied.ok) return;

  // Provenance must name exactly the relations the migration created
  const created = (await relationsNow(db)).filter((q) => !preRelations.includes(q)).sort();
  const prov = (await db.query<{ q: string }>(
    `SELECT schema_name || '.' || object_name q FROM internal_ingestion.schema_migration_provenance
      WHERE migration = '20261116b' AND kind = 'relation' AND detail IN ('r', 'p', 'v', 'm') ORDER BY 1`)).rows.map((r) => r.q);
  check(scn, "provenance records exactly the relations 20261116b created", JSON.stringify(prov) === JSON.stringify(created),
    `${created.length} created, ${prov.length} recorded`);
  const addedCols = await n(db, `SELECT count(*) n FROM internal_ingestion.schema_migration_provenance p WHERE p.migration = '20261116b' AND p.kind = 'column'
      AND NOT EXISTS (SELECT 1 FROM internal_ingestion.schema_migration_provenance x WHERE x.migration = p.migration AND x.kind = 'relation'
                        AND x.schema_name = p.schema_name AND x.object_name = p.object_name)`);
  const priorRows = await n(db, `SELECT count(*) n FROM internal_ingestion.schema_migration_provenance WHERE kind IN ('prior_acl', 'prior_rls')`);
  notes[`${scn}:provenance`] = { created_relations: created.length, added_columns_on_existing_tables: addedCols, prior_acl_rls: priorRows };
  check(scn, "provenance recorded the prior grants/RLS of pre-existing tables 20261116b changed", priorRows >= 2, `${priorRows} rows`);

  // New data in the new objects
  const key = (await db.query<{ k: string }>(`SELECT source_id k FROM public.jobs WHERE id = '00000000-0000-4000-8000-000000000004'`)).rows[0].k;
  await db.exec(`
    INSERT INTO internal_ingestion.ingestion_sources (id, name, slug, source_type) VALUES ('00000000-0000-4000-8000-00000000e001', 'Registered board', '${key}', 'ats');
    UPDATE public.jobs j SET source_registry_id = s.id FROM internal_ingestion.ingestion_sources s WHERE s.slug = j.source_id;
    INSERT INTO public.job_postings (id, source_id, external_id, title, company_name, dedupe_hash) VALUES
      ('00000000-0000-4000-8000-00000000e101', '00000000-0000-4000-8000-00000000e001', 'p-1', 'Posting one', 'Board Co', 'h-1'),
      ('00000000-0000-4000-8000-00000000e102', '00000000-0000-4000-8000-00000000e001', 'p-2', 'Posting two', 'Board Co', 'h-1');
    UPDATE public.saved_jobs SET job_posting_id = '00000000-0000-4000-8000-00000000e101' WHERE id = (SELECT id FROM public.saved_jobs ORDER BY id LIMIT 1);
    INSERT INTO public.consent_logs (session_id, consent_type, granted) VALUES ('rollback-session', 'cookies', true);`);
  const newData = await newDataChecksum(db, created);
  const mapped = await n(db, `SELECT count(*) n FROM public.jobs WHERE source_registry_id IS NOT NULL`);
  const s1 = await snapshot(db, cols);
  check(scn, "writing new data did not touch original data", diffSnapshots(s0, s1).filter((d) => /^(counts|checksums|last_seen|#645|queries)/.test(d)).length === 0);

  // Sensitivity: the same comparison must SEE what 20261116b changed on pre-existing tables
  const changedByMigration = diffMaps(pre0, await objectState(db, preRelations));
  notes[`${scn}:preexisting_attributes_changed_by_20261116b`] = changedByMigration.length;
  check(scn, "comparison is sensitive: 20261116b visibly changed pre-existing tables before rollback", changedByMigration.length > 0,
    `${changedByMigration.length} attributes, e.g. ${changedByMigration.slice(0, 3).join("; ")}`);

  // Level 2 before Level 1 must refuse
  const early = await runFile(db, ROLLBACK_REMOVE);
  check(scn, "remove-if-empty refuses before disable", !early.ok && /disable/i.test(early.error || ""), early.error);

  // Level 1 must fail closed, changing nothing, on an ACL shape it cannot restore exactly: a grant whose
  // grantor is not the owner (service_role regrants through a grant option; REVOKE would need CASCADE)
  await db.exec(`GRANT SELECT ON public.saved_jobs TO service_role WITH GRANT OPTION;
    SET ROLE service_role; GRANT SELECT ON public.saved_jobs TO anon; RESET ROLE;`);
  const odd = { state: await objectState(db, preRelations), acl: await aclItems(db, await relationsNow(db)), data: await newDataChecksum(db, created) };
  const unsupported = await runFile(db, ROLLBACK_DISABLE);
  check(scn, "disable refuses an unsupported ACL shape (grantor is not the owner)", !unsupported.ok && /unsupported ACL shape/.test(unsupported.error || ""), unsupported.error?.slice(0, 160));
  const oddAfter = { state: await objectState(db, preRelations), acl: await aclItems(db, await relationsNow(db)), data: await newDataChecksum(db, created) };
  const oddDiff = [...diffMaps(odd.state, oddAfter.state), ...diffMaps(odd.acl, oddAfter.acl)];
  check(scn, "refused disable changed nothing (constraints, policies, indexes, exact ACLs, RLS, data)",
    oddDiff.length === 0 && odd.data === oddAfter.data
      && (await n(db, `SELECT count(*) n FROM internal_ingestion.schema_migration_provenance WHERE kind = 'state'`)) === 0, oddDiff.slice(0, 5).join("; ") || undefined);
  await db.exec(`SET ROLE service_role; REVOKE SELECT ON public.saved_jobs FROM anon; RESET ROLE;
    REVOKE GRANT OPTION FOR SELECT ON public.saved_jobs FROM service_role;`);

  // Level 1
  const t0 = performance.now();
  const dis = await runFile(db, ROLLBACK_DISABLE);
  notes[`${scn}:disable_ms`] = Math.round(performance.now() - t0);
  check(scn, "documented disable script succeeds", dis.ok, dis.error);
  const s2 = await snapshot(db, cols);
  const dataDiff = diffSnapshots(s0, s2).filter((d) => /^(counts|checksums|last_seen|#645|queries)/.test(d));
  check(scn, "disable: original data unchanged (counts, checksums, last_seen_at, #645 state, app queries)", dataDiff.length === 0, dataDiff.join("; ") || undefined);
  check(scn, "disable: new data preserved (new tables, registry links, saved_jobs posting links, consent rows)", (await newDataChecksum(db, created)) === newData);
  const preNow = await objectState(db, preRelations);
  const preDiff = diffMaps(pre0, preNow);
  check(scn, "disable: pre-existing tables' indexes, constraints, policies, privileges, RLS and triggers equal pre-20261116b", preDiff.length === 0, preDiff.slice(0, 5).join("; ") || `${Object.keys(pre0).length} attributes compared`);
  const aclDiff = diffMaps(acl0, await aclItems(db, preRelations));
  check(scn, "disable: exact prior ACL items restored (grantee, privilege, grant option, grantor)", aclDiff.length === 0,
    aclDiff.slice(0, 5).join("; ") || `${Object.keys(acl0).length} relations; saved_jobs ${acl0["public.saved_jobs"]}`);
  const apiLeft = (await db.query<{ q: string }>(
    `SELECT n.nspname || '.' || c.relname q FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname || '.' || c.relname = ANY($1) AND (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
         OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))`, [created])).rows.map((r) => r.q);
  check(scn, "disable: no anon/authenticated access to any relation 20261116b created", apiLeft.length === 0, apiLeft.join(", ") || undefined);
  check(scn, "disable: columns added to pre-existing tables are kept (no DROP COLUMN)",
    (await n(db, `SELECT count(*) n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'source_registry_id'`)) === 1
      && (await n(db, `SELECT count(*) n FROM public.jobs WHERE source_registry_id IS NOT NULL`)) === mapped);
  const again = await runFile(db, ROLLBACK_DISABLE);
  check(scn, "disable is idempotent (second run succeeds, changes nothing)", again.ok && diffMaps(preNow, await objectState(db, preRelations)).length === 0, again.error);

  // Level 2 with data present must refuse atomically
  const relsBefore = await relationsNow(db);
  const refused = await runFile(db, ROLLBACK_REMOVE);
  check(scn, "remove-if-empty refuses while new data exists (names the blocking tables/columns)", !refused.ok && /data would be lost/.test(refused.error || ""), refused.error?.slice(0, 160));
  check(scn, "refused removal changed nothing", JSON.stringify((await relationsNow(db)).sort()) === JSON.stringify(relsBefore.sort())
    && (await newDataChecksum(db, created)) === newData);

  // Operator clears the new data, then Level 2 succeeds
  await db.exec(`
    UPDATE public.saved_jobs SET job_posting_id = NULL WHERE job_posting_id IS NOT NULL;
    UPDATE public.jobs SET source_registry_id = NULL WHERE source_registry_id IS NOT NULL;
    UPDATE public.job_descriptions SET posting_id = NULL WHERE posting_id IS NOT NULL;
    DELETE FROM public.job_postings; DELETE FROM public.consent_logs; DELETE FROM internal_ingestion.ingestion_sources;`);
  const rem = await runFile(db, ROLLBACK_REMOVE);
  check(scn, "remove-if-empty succeeds once the new objects are empty", rem.ok, rem.error);
  const left = (await relationsNow(db)).filter((q) => !preRelations.includes(q));
  check(scn, "remove: only the provenance record remains of the created relations", JSON.stringify(left) === JSON.stringify(["internal_ingestion.schema_migration_provenance"]), left.join(", "));
  const s3 = await snapshot(db, cols);
  const dataDiff3 = diffSnapshots(s0, s3).filter((d) => /^(counts|checksums|last_seen|#645|queries)/.test(d));
  check(scn, "remove: original data unchanged", dataDiff3.length === 0, dataDiff3.join("; ") || undefined);
  const preDiff3 = diffMaps(pre0, await objectState(db, preRelations));
  check(scn, "remove: pre-existing objects equal pre-20261116b", preDiff3.length === 0, preDiff3.slice(0, 5).join("; ") || undefined);
  const aclDiff3 = diffMaps(acl0, await aclItems(db, preRelations));
  check(scn, "remove: exact prior ACL items still in place", aclDiff3.length === 0, aclDiff3.slice(0, 5).join("; ") || undefined);

  // Re-enable
  const re = await applyTarget(db, targetSql);
  check(scn, "re-applying 20261116b after removal re-enables it", re.ok, re.error ?? `${re.ms} ms`);
  const fk = await n(db, `SELECT count(*) n FROM pg_constraint WHERE conrelid = 'public.jobs'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%source_registry_id%internal_ingestion.ingestion_sources%'`);
  check(scn, "re-apply recreated the registry FK and cleared the rollback state", fk === 1
    && (await n(db, `SELECT count(*) n FROM internal_ingestion.schema_migration_provenance WHERE kind = 'state'`)) === 0);
}

// ---------------------------------------------------------------------------------------------------
// Scenario driver (engine-neutral)
// ---------------------------------------------------------------------------------------------------
export type Engine = { name: string; newDb: (label: string) => Promise<Db>; close: (db: Db) => Promise<void> };

export async function populatedProductionOrder(engine: Engine, kind: Baseline, label: string, fixture?: (db: Db) => Promise<void>): Promise<Db> {
  const db = await engine.newDb(label);
  await db.exec(PLATFORM_STUBS);
  await db.exec(fs.readFileSync(path.join(ROOT, "supabase/schema.sql"), "utf8"));
  await db.exec(DRIFT_SHIM);
  const failed = await buildBaselineSchema(db, kind);
  if (failed.length) throw new Error(`${kind} baseline failed: ${failed.join("; ")}`);
  await (fixture ?? loadFixture)(db);
  await applyBaselineState(db, kind);
  return db;
}

export async function runScenarios(engine: Engine, targetSql: string, opts: { negative: boolean }) {
  notes.engine = engine.name;
  notes.migration_md5 = crypto.createHash("md5").update(targetSql).digest("hex");
  const finals: Record<string, Record<string, string>> = {};
  let structBefore: Record<string, string> = {};

  for (const kind of BASELINES) {
    const scn = `A:${kind}`;
    console.log(`\n=== ${scn}: populated production order, apply 20261116b ===`);
    const t0 = performance.now();
    const db = await populatedProductionOrder(engine, kind, kind);
    notes[`${scn}:setup_ms`] = Math.round(performance.now() - t0);
    if (!notes.db_version) notes.db_version = (await db.query<{ v: string }>("SELECT version() v")).rows[0].v;
    const cols = await originalColumns(db);
    const before = await snapshot(db, cols);
    notes[`${scn}:fixture_counts`] = before.counts;
    notes[`${scn}:active_missing_similarity_hash`] = await n(db, `SELECT count(*) n FROM public.jobs WHERE is_active AND similarity_hash_v2 IS NULL`);
    notes[`${scn}:f_progress_phases`] = (await db.query<{ p: string }>(`SELECT phase p FROM public.repair_645_backfill_progress ORDER BY 1`)).rows.map((r) => r.p);
    if (kind === "recon-incomplete") structBefore = await structureOf(db);
    const first = await applyTarget(db, targetSql);
    notes[`${scn}:first_run`] = first;
    check(scn, "20261116b applies on the populated baseline", first.ok, first.error ?? `${first.ms} ms`);
    if (!first.ok) { await engine.close(db); continue; }
    const after1 = await snapshot(db, cols);
    compareUnchanged(scn, before, after1);
    await behaviorChecks(scn, db);
    const second = await applyTarget(db, targetSql);
    notes[`${scn}:second_run`] = { ok: second.ok, ms: second.ms, error: second.error };
    check(scn, "second apply succeeds", second.ok, second.error ?? `${second.ms} ms`);
    const drift = diffSnapshots(after1, await snapshot(db, cols));
    check(scn, "second apply changes nothing", drift.length === 0, drift.slice(0, 6).join("; ") || undefined);
    finals[kind] = await structureOf(db);

    if (opts.negative && kind === "recon-incomplete") {
      console.log(`\n=== D: negative control (real row / freshness / ACL tampering after the migration) ===`);
      const base = await snapshot(db, cols);
      await db.exec(`UPDATE public.companies SET name = name || ' (tampered)' WHERE slug = 'fixture-company-1';
                     BEGIN; SET LOCAL careermonke.skip_touch_last_seen = 'off';
                     UPDATE public.jobs SET last_seen_at = timestamptz '2020-01-01' WHERE id = '00000000-0000-4000-8000-000000000003'; COMMIT;
                     DELETE FROM public.saved_jobs WHERE user_id = '00000000-0000-4000-8000-0000000000a3' AND job_id = '00000000-0000-4000-8000-000000000031';
                     GRANT USAGE ON SCHEMA internal_ingestion TO anon;
                     GRANT SELECT ON public.job_postings TO anon;`);
      const mark = checks.length;
      compareUnchanged("D", base, await snapshot(db, cols));
      await behaviorChecks("D", db);
      const failedInA = new Set(checks.slice(0, mark).filter((c) => c.scenario === scn && !c.ok).map((c) => c.name));
      const caught = checks.slice(mark).filter((c) => !c.ok && !failedInA.has(c.name)).map((c) => c.name);
      notes.negative_control_caught = caught;
      console.log(`\nNEGATIVE CONTROL: ${caught.length} check(s) caught the tampering:\n  - ${caught.join("\n  - ")}`);
      await engine.close(db);
      return { negativeCaught: caught.length };
    }
    await engine.close(db);
  }

  // ---- R. documented rollback scripts (reconstructed and full baselines) ---------------------------
  for (const kind of ["recon-incomplete", "full"] as const) await rollbackScenario(engine, kind, targetSql);

  // ---- C. intentional failure then retry ---------------------------------------------------------
  console.log("\n=== C: intentional failure before COMMIT, then retry (recon-incomplete) ===");
  const dbC = await populatedProductionOrder(engine, "recon-incomplete", "failure");
  const colsC = await originalColumns(dbC);
  const beforeC = await snapshot(dbC, colsC);
  const failedRun = await applyTarget(dbC, targetSql, "SELECT 1 / 0; -- rehearsal: injected failure");
  check("C", "injected failure aborts the migration", !failedRun.ok, failedRun.error);
  const driftC = diffSnapshots(beforeC, await snapshot(dbC, colsC));
  check("C", "failed run leaves the database exactly as before (atomic rollback)", driftC.length === 0, driftC.slice(0, 6).join("; ") || undefined);
  check("C", "no partial objects after failure (internal_ingestion absent)",
    (await dbC.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'internal_ingestion'`)).rows.length === 0);
  const retry = await applyTarget(dbC, targetSql);
  check("C", "retry after the failure succeeds", retry.ok, retry.error ?? `${retry.ms} ms`);
  await engine.close(dbC);

  // ---- B. filename order ---------------------------------------------------------------------------
  console.log("\n=== B: filename order (16b before #645 D/E/F), fresh database ===");
  const dbB = await engine.newDb("filename");
  await dbB.exec(PLATFORM_STUBS);
  await dbB.exec(fs.readFileSync(path.join(ROOT, "supabase/schema.sql"), "utf8"));
  await dbB.exec(DRIFT_SHIM);
  const fails = await applyChain(dbB, allMigrations(), "filename", targetSql);
  check("B", "filename order: every migration incl. 16b and #645 D/E/F applies", fails.length === 0, fails.join(" | ") || undefined);
  let fixtureOk = false;
  try { await loadFixture(dbB); await applyBaselineState(dbB, "filename"); fixtureOk = true; }
  catch (e: any) { try { await dbB.exec("ROLLBACK"); } catch {} check("B", "same fixture loads in filename order", false, String(e.message).slice(0, 160)); }
  if (fixtureOk) {
    check("B", "same fixture loads in filename order", true);
    await behaviorChecks("B", dbB);
  }
  finals.filename = await structureOf(dbB);
  await engine.close(dbB);

  // ---- Cross-order contract: identical types / constraints / FKs ----------------------------------
  // 16b's contract = every column/constraint 16b adds or changes on the reconstructed baseline, plus
  // jobs.source_id. "(x IS NULL OR <check>)" and "<check>" are the same CHECK (a NULL result passes).
  const norm = (v: string | undefined) => v?.replace(/^CHECK \(\(\((\w+) IS NULL\) OR \((.+)\)\)\)/, "CHECK (($2))");
  const ref = finals["recon-incomplete"];
  const comparison: Record<string, any> = {};
  if (ref) {
    const contract = Object.keys(ref).filter((k) => ref[k] !== structBefore[k] || k === "col public.jobs.source_id");
    notes.contract_size = contract.length;
    for (const other of Object.keys(finals).filter((k) => k !== "recon-incomplete")) {
      const o = finals[other];
      const missing = contract.filter((k) => !(k in o));
      const differ = contract.filter((k) => k in o && norm(ref[k]) !== norm(o[k]));
      comparison[other] = { contract: contract.length, missing, differ: differ.map((k) => `${k}: ${ref[k]} | ${o[k]}`) };
      if (other === "full") {
        // extra scenario: #645 D in full defines some of these columns/constraints first; reported, not failed
        console.log(`  INFO [X] recon-incomplete vs full: ${differ.length} contract difference(s), ${missing.length} missing${differ.length ? ": " + differ.join("; ") : ""}`);
        continue;
      }
      check("X", `recon-incomplete vs ${other}: every 16b column/constraint/FK present`, missing.length === 0, missing.slice(0, 4).join("; ") || `${contract.length} contract entries`);
      check("X", `recon-incomplete vs ${other}: identical types, constraints and FKs`, differ.length === 0, differ.slice(0, 3).join("; ") || undefined);
    }
  }
  notes.cross_order = comparison;
  return { negativeCaught: -1 };
}

export function finish(code: number, message?: string, jsonPath?: string) {
  const failed = checks.filter((c) => !c.ok);
  console.log("\n=== RESULT ===");
  console.log(`${checks.length - failed.length} passed, ${failed.length} failed${message ? ` (${message})` : ""}`);
  if (jsonPath) fs.writeFileSync(path.resolve(jsonPath), JSON.stringify({ checks, notes, skippedExtensionLines }, null, 2));
  process.exit(code);
}

// ---------------------------------------------------------------------------------------------------
// PGlite CLI
// ---------------------------------------------------------------------------------------------------
async function pgliteMain() {
  const args = process.argv.slice(2);
  const migrationArg = args.find((a) => a.startsWith("--migration="));
  const jsonArg = args.find((a) => a.startsWith("--json="));
  const negative = args.includes("--negative-control");
  const targetPath = migrationArg ? path.resolve(migrationArg.slice("--migration=".length)) : path.join(MIG_DIR, TARGET);
  notes.migration_file = path.relative(ROOT, targetPath);
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const { unaccent } = await import("@electric-sql/pglite/contrib/unaccent");
  setUnavailableExtensions(["pg_cron", "pg_stat_statements"]);
  const engine: Engine = {
    name: "PGlite (in-process WASM PostgreSQL, single connection)",
    newDb: async () => {
      const raw = new PGlite({ extensions: { pg_trgm, pgcrypto, unaccent } });
      return { exec: async (s: string) => { await raw.exec(s); }, query: (s: string, p?: unknown[]) => raw.query(s, p as any[]) as any, _raw: raw } as Db;
    },
    close: async (db) => { await (db as any)._raw.close(); },
  };
  const { negativeCaught } = await runScenarios(engine, fs.readFileSync(targetPath, "utf8"), { negative });
  if (negative) {
    finish(negativeCaught > 0 ? 1 : 0, negativeCaught > 0 ? "negative control detected (expected non-zero exit)" : "NEGATIVE CONTROL NOT DETECTED: checks are blind", jsonArg?.slice("--json=".length));
  }
  finish(checks.some((c) => !c.ok) ? 1 : 0, undefined, jsonArg?.slice("--json=".length));
}

if (require.main === module) {
  pgliteMain().catch((e) => {
    console.error("REHEARSAL ERROR:", e?.message || e);
    process.exit(1);
  });
}
