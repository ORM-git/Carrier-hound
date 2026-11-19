/**
 * scripts/test-10m-schema-step1-rehearsal.ts
 *
 * Disposable rehearsal of PR #643 (20261116b_ten_million_system_design_schema.sql) on a POPULATED schema
 * built from this repo's own migration chain (supabase/schema.sql + every migration, incl. the #645
 * D/E/F repair), inside an in-process PGlite (real PostgreSQL compiled to WASM). Never touches a network
 * database and never reads credentials.
 *
 * Scenarios
 *   A. production order   : baseline + all migrations except 16b, populate, apply 16b, apply 16b again
 *   B. filename order     : 16b applied in its sorted slot (before #645 D/E/F), populated before 16b
 *   C. failure / retry    : 16b with an injected error before COMMIT -> must leave the DB untouched; retry
 *   D. negative control   : --negative-control tampers with the post-migration DB; the checks must catch it
 *
 * Flags
 *   --negative-control     exit non-zero if the tamper is detected (expected), zero would mean blind checks
 *   --migration=<path>     rehearse a different 16b file (e.g. the unrepaired original from PR #643 head)
 *   --json=<path>          also write the machine-readable results
 *
 * Exit code: 0 = every check passed; 1 = at least one check failed (details printed).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";

const ROOT = path.resolve(__dirname, "..");
const MIG_DIR = path.join(ROOT, "supabase/migrations");
const TARGET = "20261116b_ten_million_system_design_schema.sql";
const FIXTURE = path.join(ROOT, "scripts/fixtures/10m-schema-step1-populated.sql");

const args = process.argv.slice(2);
const NEGATIVE = args.includes("--negative-control");
const migrationArg = args.find((a) => a.startsWith("--migration="));
const jsonArg = args.find((a) => a.startsWith("--json="));
const TARGET_PATH = migrationArg ? path.resolve(migrationArg.slice("--migration=".length)) : path.join(MIG_DIR, TARGET);

type Check = { scenario: string; name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const notes: Record<string, unknown> = {};
const check = (scenario: string, name: string, ok: boolean, detail?: string) => {
  checks.push({ scenario, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${detail ? ` :: ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------------------------------
// Supabase platform stubs. Only what the repo's migrations reference; recorded as UNVERIFIED in the doc.
// ---------------------------------------------------------------------------------------------------
const PLATFORM_STUBS = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE authenticator NOLOGIN; CREATE ROLE supabase_admin NOLOGIN;
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
  -- pg_cron is not available in WASM: record schedule calls only (UNVERIFIED)
  CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
  CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
    INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
    ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $$;
  CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = job_name RETURNING true $$;
  CREATE SCHEMA extensions;
  -- Supabase default privileges on public (what the platform grants to API roles on new objects)
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`;

/**
 * Production columns that NO repo migration creates (added out of band; no production schema snapshot
 * exists in the repo). Only what the migration chain itself references. UNVERIFIED against production.
 */
const DRIFT_SHIM = `
  ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS category text;
  ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS country text;
  -- 20261001_filter_upgrades grants on jobs_public, which the repo only creates later (20261010, CREATE OR
  -- REPLACE). Production had it already; a prefix-compatible placeholder lets 20261010 replace it as written.
  CREATE VIEW public.jobs_public AS SELECT id FROM public.jobs;
`;

/** Migrations that pg_cron owns entirely are skipped (UNVERIFIED); the rest must apply cleanly. */
const CRON_ONLY = new Set<string>([]);

/** Split SQL into statements for files that must run outside a transaction (CONCURRENTLY). */
function splitStatements(sql: string): string[] {
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

/** Extensions WASM PostgreSQL cannot load. Only their CREATE EXTENSION line is skipped (UNVERIFIED). */
const UNAVAILABLE_EXTENSIONS = ["pg_cron", "pg_stat_statements"];
const skippedExtensionLines: string[] = [];

async function applyFile(db: PGlite, file: string, sql: string) {
  for (const ext of UNAVAILABLE_EXTENSIONS) {
    const re = new RegExp(`CREATE\\s+EXTENSION\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${ext}"?[^;]*;`, "gi");
    if (re.test(sql)) {
      skippedExtensionLines.push(`${file}: CREATE EXTENSION ${ext}`);
      sql = sql.replace(re, `-- [rehearsal] skipped CREATE EXTENSION ${ext} (not available in WASM PostgreSQL)`);
    }
  }
  if (/\bCONCURRENTLY\b/i.test(sql.replace(/--.*$/gm, ""))) {
    for (const stmt of splitStatements(sql)) await db.exec(stmt);
  } else {
    await db.exec(sql);
  }
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto, unaccent } });
  await db.exec(PLATFORM_STUBS);
  await db.exec(fs.readFileSync(path.join(ROOT, "supabase/schema.sql"), "utf8"));
  await db.exec(DRIFT_SHIM);
  return db;
}

const allMigrations = () => fs.readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();

async function applyChain(db: PGlite, files: string[], label: string): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) {
    if (CRON_ONLY.has(f)) continue;
    try {
      await applyFile(db, f, fs.readFileSync(path.join(MIG_DIR, f), "utf8"));
    } catch (e: any) {
      failed.push(`${f}: ${String(e?.message || e).slice(0, 200)}`);
      try { await db.exec("ROLLBACK"); } catch {}
    }
  }
  if (failed.length) console.log(`  [${label}] chain failures:\n    ${failed.join("\n    ")}`);
  return failed;
}


// ===================================================================================================
// Snapshot: everything that must survive 20261116b unchanged
// ===================================================================================================
const BASE_TABLES = ["jobs", "companies", "job_descriptions", "saved_jobs"] as const;
const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

type Snapshot = {
  counts: Record<string, number>;
  checksums: Record<string, string>; // over the ORIGINAL column list only
  lastSeen: string;
  columns: Record<string, string[]>; // public tables/views: ordered name:type
  indexes: Record<string, { def: string; valid: boolean }>;
  jobTriggers: string[];
  queries: Record<string, string>;
  acl: Record<string, string>; // relation / function -> owner + acl
};

async function originalColumns(db: PGlite): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of BASE_TABLES) {
    const r = await db.query<{ c: string }>(
      `select column_name c from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [t]);
    out[t] = r.rows.map((x) => x.c);
  }
  return out;
}

async function snapshot(db: PGlite, cols: Record<string, string[]>): Promise<Snapshot> {
  const counts: Record<string, number> = {};
  const checksums: Record<string, string> = {};
  for (const t of BASE_TABLES) {
    counts[t] = Number((await db.query<{ n: string }>(`select count(*) n from public.${t}`)).rows[0].n);
    const list = cols[t].map((c) => `"${c}"`).join(", ");
    const key = t === "job_descriptions" ? "job_id" : "id";
    const r = await db.query<{ j: string }>(`select coalesce(string_agg(row_to_json(x)::text, '|' order by x.${key}), '') j from (select ${list} from public.${t}) x`);
    checksums[t] = md5(r.rows[0].j);
  }
  const ls = await db.query<{ j: string }>(`select coalesce(string_agg(id::text || '=' || coalesce(last_seen_at::text, 'null'), ',' order by id), '') j from public.jobs`);
  const columns: Record<string, string[]> = {};
  const c = await db.query<{ t: string; c: string; ty: string }>(
    `select table_name t, column_name c, data_type ty from information_schema.columns where table_schema='public' order by table_name, ordinal_position`);
  for (const r of c.rows) (columns[r.t] ||= []).push(`${r.c}:${r.ty}`);
  const indexes: Record<string, { def: string; valid: boolean }> = {};
  const ix = await db.query<{ n: string; d: string; v: boolean }>(
    `select c.relname n, pg_get_indexdef(i.indexrelid) d, i.indisvalid v from pg_index i join pg_class c on c.oid = i.indexrelid
       join pg_namespace s on s.oid = c.relnamespace where s.nspname in ('public', 'internal_ingestion')`);
  for (const r of ix.rows) indexes[r.n] = { def: r.d, valid: r.v };
  const tr = await db.query<{ n: string }>(`select tgname n from pg_trigger where tgrelid = 'public.jobs'::regclass and not tgisinternal order by 1`);
  const q = async (sql: string) => md5(JSON.stringify((await db.query(sql)).rows));
  const queries = {
    jobs_public_feed: await q(`select id, title, location, remote from public.jobs_public order by id`),
    active_by_category: await q(`select category, count(*) n from public.jobs where is_active group by 1 order by 1 nulls first`),
    saved_join: await q(`select s.user_id, j.title from public.saved_jobs s join public.jobs j on j.id = s.job_id order by 1, 2`),
    descriptions_join: await q(`select j.id, d.description_text from public.jobs j join public.job_descriptions d on d.job_id = j.id order by 1`),
    cross_vendor_ids: await q(`select source_job_id, count(distinct source) n from public.jobs group by 1 having count(distinct source) > 1 order by 1`),
  };
  const acl: Record<string, string> = {};
  const rel = await db.query<{ n: string; o: string; a: string | null; rls: boolean }>(
    `select n.nspname || '.' || c.relname n, pg_get_userbyid(c.relowner) o, c.relacl::text a, c.relrowsecurity rls from pg_class c
       join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'internal_ingestion') and c.relkind in ('r', 'v', 'm')`);
  for (const r of rel.rows) acl[r.n] = `${r.o}|${r.a}|rls=${r.rls}`;
  const fn = await db.query<{ n: string; o: string; a: string | null; sd: boolean; cfg: string | null }>(
    `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' n, pg_get_userbyid(p.proowner) o,
       p.proacl::text a, p.prosecdef sd, p.proconfig::text cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'internal_ingestion')`);
  for (const r of fn.rows) acl[r.n] = `${r.o}|${r.a}|secdef=${r.sd}|cfg=${r.cfg}`;
  return { counts, checksums, lastSeen: md5(ls.rows[0].j), columns, indexes, jobTriggers: tr.rows.map((r) => r.n), queries, acl };
}

/** Human-readable list of what differs between two snapshots (empty = identical). */
function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const out: string[] = [];
  for (const sect of ["counts", "checksums", "queries"] as const)
    for (const k of new Set([...Object.keys(a[sect]), ...Object.keys(b[sect])]))
      if ((a[sect] as any)[k] !== (b[sect] as any)[k]) out.push(`${sect}.${k}`);
  if (a.lastSeen !== b.lastSeen) out.push("last_seen_at");
  for (const t of new Set([...Object.keys(a.columns), ...Object.keys(b.columns)]))
    if (JSON.stringify(a.columns[t]) !== JSON.stringify(b.columns[t])) out.push(`columns.${t}`);
  for (const n of new Set([...Object.keys(a.indexes), ...Object.keys(b.indexes)]))
    if (JSON.stringify(a.indexes[n]) !== JSON.stringify(b.indexes[n])) out.push(`index.${n}`);
  if (JSON.stringify(a.jobTriggers) !== JSON.stringify(b.jobTriggers)) out.push("jobs triggers");
  for (const n of new Set([...Object.keys(a.acl), ...Object.keys(b.acl)]))
    if (a.acl[n] !== b.acl[n]) out.push(`acl.${n}: ${a.acl[n]} -> ${b.acl[n]}`);
  return out;
}

// ===================================================================================================
// Applying 20261116b with timing and a lock capture before COMMIT
// ===================================================================================================
type ApplyResult = { ok: boolean; ms: number; error?: string; locks: string[] };

async function applyTarget(db: PGlite, sql: string, inject?: string): Promise<ApplyResult> {
  const lastCommit = sql.search(/COMMIT;\s*(--[^\n]*\n|\s)*$/i) >= 0 ? sql.lastIndexOf("COMMIT;") : -1;
  const body = lastCommit >= 0 ? sql.slice(0, lastCommit) : sql;
  const t0 = performance.now();
  try {
    await db.exec(body + (inject ? `\n${inject}\n` : ""));
    const locks = await db.query<{ r: string; m: string }>(
      `select coalesce(c.relname, l.locktype) r, l.mode m from pg_locks l left join pg_class c on c.oid = l.relation
        where l.pid = pg_backend_pid() and l.granted and (c.relname is null or c.relname in ('jobs', 'companies', 'job_descriptions', 'saved_jobs'))
        and l.locktype = 'relation' order by 1, 2`);
    if (lastCommit >= 0) await db.exec("COMMIT");
    return { ok: true, ms: Math.round(performance.now() - t0), locks: locks.rows.map((r) => `${r.r}:${r.m}`) };
  } catch (e: any) {
    try { await db.exec("ROLLBACK"); } catch {}
    return { ok: false, ms: Math.round(performance.now() - t0), error: String(e?.message || e).slice(0, 300), locks: [] };
  }
}

// ===================================================================================================
// Comparisons and behavioral checks
// ===================================================================================================
function compareUnchanged(scn: string, before: Snapshot, after: Snapshot) {
  for (const t of BASE_TABLES) {
    check(scn, `row count unchanged: ${t}`, before.counts[t] === after.counts[t], `${before.counts[t]} -> ${after.counts[t]}`);
    check(scn, `checksum of original columns unchanged: ${t}`, before.checksums[t] === after.checksums[t]);
  }
  check(scn, "jobs.last_seen_at preserved for every row", before.lastSeen === after.lastSeen);
  for (const [t, cols] of Object.entries(before.columns)) {
    const now = after.columns[t] || [];
    check(scn, `column order/types preserved: ${t}`, cols.every((c, i) => now[i] === c),
      cols.find((c, i) => now[i] !== c) ? `first diff ${cols.find((c, i) => now[i] !== c)} vs ${now[cols.findIndex((c, i) => now[i] !== c)]}` : undefined);
  }
  const changedIdx = Object.entries(before.indexes).filter(([n, v]) => !after.indexes[n] || after.indexes[n].def !== v.def);
  check(scn, "pre-existing index definitions unchanged", changedIdx.length === 0, changedIdx.map(([n]) => n).join(", ") || undefined);
  const invalid = Object.entries(after.indexes).filter(([, v]) => !v.valid).map(([n]) => n);
  check(scn, "every index is valid (indisvalid)", invalid.length === 0, invalid.join(", ") || undefined);
  const newTriggers = after.jobTriggers.filter((t) => !before.jobTriggers.includes(t));
  check(scn, "no new triggers on public.jobs (no automatic merge/expiry)", newTriggers.length === 0, newTriggers.join(", ") || undefined);
  for (const [k, v] of Object.entries(before.queries)) check(scn, `app query result unchanged: ${k}`, after.queries[k] === v);
  const aclChanged = Object.entries(before.acl).filter(([n, v]) => after.acl[n] !== undefined && after.acl[n] !== v).map(([n]) => n);
  check(scn, "owners/grants/RLS of pre-existing relations & functions unchanged", aclChanged.length === 0, aclChanged.join(", ") || undefined);
}

async function asRole<T>(db: PGlite, role: string, sub: string | null, fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
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

async function behaviorChecks(scn: string, db: PGlite) {
  // Destructive dedupe: #645 dropped this UNIQUE index on purpose (advisory similarity hash, never unique)
  const destructive = await db.query(`select 1 from pg_indexes where schemaname='public' and indexname='idx_jobs_active_dedupe_hash_uniq'`);
  check(scn, "#645 containment kept: no UNIQUE idx_jobs_active_dedupe_hash_uniq on public.jobs", destructive.rows.length === 0);

  // Same posting arriving from another vendor must insert (no unique failure) and must not merge/expire anything
  await db.exec("BEGIN");
  try {
    const before = Number((await db.query<{ n: string }>(`select count(*) n from public.jobs where is_active and dedupe_hash = 'simhash-pair-1'`)).rows[0].n);
    await db.exec(`INSERT INTO public.jobs (company, title, location, source, source_job_id, source_id, dedupe_hash, is_active, status, apply_url)
                   VALUES ('Acme Corp', 'Software Engineer #1', 'Remote (Worldwide)', 'workable', '1', 'src-workable', 'simhash-pair-1', true, 'active', 'https://apply.example.invalid/workable/1')`);
    const after = Number((await db.query<{ n: string }>(`select count(*) n from public.jobs where is_active and dedupe_hash = 'simhash-pair-1'`)).rows[0].n);
    check(scn, "cross-source duplicate posting inserts and nothing is merged/expired", after === before + 1, `${before} -> ${after}`);
  } catch (e: any) {
    check(scn, "cross-source duplicate posting inserts and nothing is merged/expired", false, String(e.message).slice(0, 160));
  } finally {
    await db.exec("ROLLBACK");
  }

  // Source-key uniqueness: same vendor + same external id rejected; same id on another vendor allowed (fixture)
  await db.exec("BEGIN");
  let rejected = false;
  try {
    await db.exec(`INSERT INTO public.jobs (company, title, location, source, source_job_id) VALUES ('X', 'dup', 'Remote', 'greenhouse', '1')`);
  } catch { rejected = true; }
  await db.exec("ROLLBACK");
  check(scn, "same-vendor duplicate external id rejected", rejected);
  const cross = await db.query<{ n: string }>(`select count(*) n from (select source_job_id from public.jobs group by 1 having count(distinct source) > 1) x`);
  check(scn, "cross-vendor identical external ids coexist", Number(cross.rows[0].n) > 0, `${cross.rows[0].n} ids`);

  // internal_ingestion isolation
  const priv = await db.query<{ a: boolean; u: boolean; s: boolean }>(
    `select has_schema_privilege('anon', 'internal_ingestion', 'USAGE') a, has_schema_privilege('authenticated', 'internal_ingestion', 'USAGE') u,
            has_schema_privilege('service_role', 'internal_ingestion', 'USAGE') s`);
  check(scn, "internal_ingestion: no USAGE for anon/authenticated, USAGE for service_role",
    !priv.rows[0].a && !priv.rows[0].u && priv.rows[0].s, JSON.stringify(priv.rows[0]));
  for (const role of ["anon", "authenticated"]) {
    const r = await asRole(db, role, "00000000-0000-4000-8000-0000000000a1", () => db.query(`select * from internal_ingestion.ingestion_sources limit 1`));
    check(scn, `internal_ingestion.ingestion_sources denied to ${role}`, !r.ok, r.error);
  }
  const svc = await asRole(db, "service_role", null, () => db.query(`select count(*) from internal_ingestion.ingestion_sources`));
  check(scn, "internal_ingestion.ingestion_sources readable by service_role", svc.ok, svc.error);

  // Paid-field masking on job_postings_public + raw job_postings blocked for API roles
  await db.exec(`BEGIN`);
  try {
    const cols = (await db.query<{ c: string }>(`select column_name c from information_schema.columns where table_schema='public' and table_name='job_postings'`)).rows.map((r) => r.c);
    notes["job_postings_columns"] = cols;
    const need = ["company_name", "title"].filter((c) => !cols.includes(c));
    if (need.length) throw new Error(`job_postings missing ${need.join(",")}`);
    await db.exec(`SAVEPOINT p; INSERT INTO public.job_postings (title, company_name, salary_min, salary_max, direct_apply_url, status)
                   SELECT 'Masking probe', 'Real Employer Ltd', 100, 200, 'https://apply.example.invalid/x', 'active'
                   WHERE false`); // shape probe only (column names)
  } catch (e: any) {
    notes["job_postings_shape"] = String(e.message).slice(0, 200);
  } finally {
    await db.exec(`ROLLBACK`);
  }
  for (const role of ["anon", "authenticated"]) {
    const raw = await asRole(db, role, "00000000-0000-4000-8000-0000000000a1", async () =>
      (await db.query<{ n: string }>(`select count(*) n from public.job_postings`)).rows[0].n);
    check(scn, `raw public.job_postings not readable by ${role}`, !raw.ok || raw.value === "0", raw.error || `rows=${raw.value}`);
  }
  const view = await db.query<{ c: string }>(`select column_name c from information_schema.columns where table_schema='public' and table_name='job_postings_public'`);
  notes["job_postings_public_columns"] = view.rows.map((r) => r.c);
  const viewDef = await db.query<{ d: string }>(`select pg_get_viewdef('public.job_postings_public'::regclass, true) d`).catch(() => ({ rows: [{ d: "" }] }));
  const def = viewDef.rows[0]?.d || "";
  check(scn, "job_postings_public masks company/salary/apply url (view definition)",
    /Verified Employer/i.test(def) && !/\bdirect_apply_url\b(?!\s*,?\s*NULL)/i.test(def.replace(/NULL::text AS direct_apply_url/gi, "")),
    def ? undefined : "view missing");

  // saved_jobs RLS: a user sees only their own rows
  const own = await asRole(db, "authenticated", "00000000-0000-4000-8000-0000000000a1", async () =>
    (await db.query<{ u: string }>(`select distinct user_id::text u from public.saved_jobs`)).rows.map((r) => r.u));
  check(scn, "saved_jobs RLS: authenticated user sees only own rows",
    own.ok && (own.value || []).every((u) => u === "00000000-0000-4000-8000-0000000000a1"), own.error || JSON.stringify(own.value));
  const anonSaved = await asRole(db, "anon", null, async () => (await db.query<{ n: string }>(`select count(*) n from public.saved_jobs`)).rows[0].n);
  check(scn, "saved_jobs RLS: anon sees no rows", !anonSaved.ok || anonSaved.value === "0", anonSaved.error || `rows=${anonSaved.value}`);

  // Canonical identity type: #643 declares jobs.source_id uuid FK -> internal_ingestion.ingestion_sources
  const sid = await db.query<{ t: string }>(`select data_type t from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='source_id'`);
  const fk = await db.query(`select 1 from pg_constraint where conrelid='public.jobs'::regclass and contype='f' and pg_get_constraintdef(oid) like '%internal_ingestion.ingestion_sources%'`);
  notes[`${scn}:jobs.source_id`] = { type: sid.rows[0]?.t, fkToIngestionSources: fk.rows.length > 0 };
  check(scn, "jobs.source_id is the uuid FK to internal_ingestion.ingestion_sources that #643 declares",
    sid.rows[0]?.t === "uuid" && fk.rows.length > 0, `type=${sid.rows[0]?.t}, fk=${fk.rows.length > 0}`);

  // Redundant unique structures on (source, source_job_id)
  const dupKeys = await db.query<{ n: string }>(
    `select c.relname n from pg_index i join pg_class c on c.oid = i.indexrelid where i.indrelid = 'public.jobs'::regclass and i.indisunique
       and pg_get_indexdef(i.indexrelid) ~ '\\(source, source_job_id\\)'`);
  notes[`${scn}:unique_on_source_source_job_id`] = dupKeys.rows.map((r) => r.n);
}

// ===================================================================================================
// Scenarios
// ===================================================================================================
async function populatedProductionOrder(): Promise<PGlite> {
  const db = await freshDb();
  const failed = await applyChain(db, allMigrations().filter((f) => f !== TARGET), "base");
  if (failed.length) throw new Error(`base chain failed: ${failed.join("; ")}`);
  await db.exec(fs.readFileSync(FIXTURE, "utf8"));
  return db;
}

async function main() {
  const targetSql = fs.readFileSync(TARGET_PATH, "utf8");
  const t0 = performance.now();
  const db = await populatedProductionOrder();
  notes.db_version = (await db.query<{ v: string }>("select version() v")).rows[0].v;
  notes.migration_file = path.relative(ROOT, TARGET_PATH);
  notes.migration_md5 = md5(targetSql);
  notes.base_setup_ms = Math.round(performance.now() - t0);
  const cols = await originalColumns(db);
  const before = await snapshot(db, cols);
  notes.fixture_counts = before.counts;
  notes.skipped_extension_lines = skippedExtensionLines;

  // ---- A. production order: run once, then twice -----------------------------------------------
  console.log("\n=== A. production order (post-#645), populated, apply 20261116b ===");
  const first = await applyTarget(db, targetSql);
  notes.A_first_run = { ok: first.ok, ms: first.ms, error: first.error, locks: first.locks };
  check("A", "20261116b applies on the populated post-#645 schema", first.ok, first.error ?? `${first.ms} ms`);
  if (first.ok) {
    const after1 = await snapshot(db, cols);
    compareUnchanged("A", before, after1);
    await behaviorChecks("A", db);
    const second = await applyTarget(db, targetSql);
    notes.A_second_run = { ok: second.ok, ms: second.ms, error: second.error };
    check("A", "second run of 20261116b succeeds (idempotent)", second.ok, second.error ?? `${second.ms} ms`);
    const after2 = await snapshot(db, cols);
    const drift = diffSnapshots(after1, after2);
    notes.A_second_run_drift = drift;
    check("A", "second run changes nothing (snapshot identical)", drift.length === 0, drift.slice(0, 6).join("; ") || undefined);

    if (NEGATIVE) {
      console.log("\n=== D. negative control: tamper after migration, checks must catch it ===");
      await db.exec(`UPDATE public.jobs SET last_seen_at = timestamptz '2020-01-01' WHERE id = '00000000-0000-4000-8000-000000000001';
                     GRANT USAGE ON SCHEMA internal_ingestion TO anon;
                     ALTER TABLE public.saved_jobs DISABLE ROW LEVEL SECURITY;`);
      const before2 = checks.length;
      compareUnchanged("D", after2, await snapshot(db, cols));
      await behaviorChecks("D", db);
      // Only failures the tamper caused count: a D check that also failed in A is a pre-existing finding.
      const failedInA = new Set(checks.slice(0, before2).filter((c) => c.scenario === "A" && !c.ok).map((c) => c.name));
      const caught = checks.slice(before2).filter((c) => !c.ok && !failedInA.has(c.name)).map((c) => c.name);
      console.log(`\nNEGATIVE CONTROL: ${caught.length} check(s) caught the tamper: ${caught.join("; ")}`);
      finish(caught.length > 0 ? 1 : 0, caught.length > 0 ? "negative control detected (expected non-zero exit)" : "NEGATIVE CONTROL NOT DETECTED: checks are blind");
      return;
    }
  }

  // ---- C. intentional failure, then retry ------------------------------------------------------
  console.log("\n=== C. intentional failure before COMMIT, then retry ===");
  const dbC = await populatedProductionOrder();
  const colsC = await originalColumns(dbC);
  const beforeC = await snapshot(dbC, colsC);
  const failed = await applyTarget(dbC, targetSql, "SELECT 1 / 0; -- rehearsal: injected failure");
  check("C", "injected failure aborts the migration", !failed.ok, failed.error);
  const afterFail = await snapshot(dbC, colsC);
  const driftC = diffSnapshots(beforeC, afterFail);
  check("C", "failed run leaves the database exactly as before (atomic rollback)", driftC.length === 0, driftC.slice(0, 6).join("; ") || undefined);
  const noSchema = await dbC.query(`select 1 from information_schema.schemata where schema_name = 'internal_ingestion'`);
  check("C", "no partial objects after failure (internal_ingestion absent)", noSchema.rows.length === 0);
  const retry = await applyTarget(dbC, targetSql);
  check("C", "retry after failure has the same outcome as a first run", retry.ok === first.ok, retry.error ?? `${retry.ms} ms`);

  // ---- B. filename order: 16b in its sorted slot, before #645 D/E/F ----------------------------
  console.log("\n=== B. filename order (16b before #645 16d/e/f) ===");
  const dbB = await freshDb();
  const all = allMigrations();
  const idx = all.indexOf(TARGET);
  const preFail = await applyChain(dbB, all.slice(0, idx), "B-pre");
  const midB = await applyTarget(dbB, targetSql);
  const postFail = await applyChain(dbB, all.slice(idx + 1), "B-post");
  notes.B = { pre_failures: preFail, target_ok: midB.ok, target_error: midB.error, post_failures: postFail };
  check("B", "filename order: chain + 20261116b + #645 D/E/F all apply", preFail.length === 0 && midB.ok && postFail.length === 0,
    [...preFail, midB.error, ...postFail].filter(Boolean).join(" | ") || undefined);
  if (preFail.length === 0 && midB.ok && postFail.length === 0) {
    try {
      await dbB.exec(fs.readFileSync(FIXTURE, "utf8"));
      check("B", "same fixture loads in filename order", true);
    } catch (e: any) {
      try { await dbB.exec("ROLLBACK"); } catch {}
      check("B", "same fixture loads in filename order", false, String(e.message).slice(0, 160));
    }
    const finalA = await snapshot(db, cols);
    const finalB = await snapshot(dbB, cols);
    const diffCols = Object.keys({ ...finalA.columns, ...finalB.columns })
      .filter((t) => JSON.stringify(finalA.columns[t]) !== JSON.stringify(finalB.columns[t]));
    const diffIdx = Object.keys({ ...finalA.indexes, ...finalB.indexes })
      .filter((n) => finalA.indexes[n]?.def !== finalB.indexes[n]?.def);
    notes.order_dependent_differences = { columns: diffCols.map((t) => ({ table: t, production: finalA.columns[t]?.filter((c) => !finalB.columns[t]?.includes(c)), filename: finalB.columns[t]?.filter((c) => !finalA.columns[t]?.includes(c)) })), indexes: diffIdx.map((n) => ({ index: n, production: finalA.indexes[n]?.def ?? null, filename: finalB.indexes[n]?.def ?? null })) };
    check("B", "production order and filename order converge to the same schema", diffCols.length === 0 && diffIdx.length === 0,
      `${diffCols.length} table(s) and ${diffIdx.length} index(es) differ`);
  }

  finish(checks.some((c) => !c.ok) ? 1 : 0);
}

function finish(code: number, message?: string) {
  const failedChecks = checks.filter((c) => !c.ok);
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify({ notes }, null, 2));
  console.log(`${checks.length - failedChecks.length} passed, ${failedChecks.length} failed${message ? ` (${message})` : ""}`);
  if (jsonArg) fs.writeFileSync(path.resolve(jsonArg.slice("--json=".length)), JSON.stringify({ checks, notes }, null, 2));
  process.exit(code);
}

if (args.includes("--probe-chain")) {
  (async () => {
    const db = await freshDb();
    console.log((await db.query<{ v: string }>("select version() v")).rows[0].v);
    const failed = await applyChain(db, allMigrations().filter((f) => f !== TARGET), "probe");
    console.log(`probe: ${allMigrations().length - 1 - failed.length} applied, ${failed.length} failed`);
    process.exit(failed.length ? 1 : 0);
  })();
} else if (require.main === module) {
  main().catch((e) => {
    console.error("REHEARSAL ERROR:", e?.message || e);
    process.exit(1);
  });
}

export { freshDb, applyChain, allMigrations, TARGET, FIXTURE };
