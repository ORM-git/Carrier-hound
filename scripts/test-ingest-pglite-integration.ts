/**
 * Row 39 local-database integration test: the REAL scripts/ingest.ts main writes into a disposable local Postgres
 * (PGlite, in memory), and stored rows are read back with SQL.
 *
 * What is real here: ingest.ts and its write decisions, supabase-js / postgrest-js request building, and Postgres
 * storage, column defaults, CHECK/UNIQUE constraints and triggers, built by applying supabase/schema.sql plus every
 * supabase/migrations/*.sql file in the schema-dump order (scripts/lib/schema-dump.ts).
 * What is NOT real: PostgREST itself. A small HTTP-to-SQL shim below plays its part (eq/in filters, limit,
 * insert/upsert via json_populate_recordset, update by filter); it decides nothing about which rows to write.
 * Supabase platform pieces PGlite lacks (auth, storage, unaccent, some extensions) are test-only stubs or skipped
 * migrations, listed in SKIPPED_MIGRATIONS and STUBS. This is LOCAL proof only: it does not show which migrations
 * production has applied, production triggers/indexes as deployed, or capacity under real load.
 *
 * Data is synthetic (.example hosts). The ATS fetch is answered locally; any other network destination throws.
 * Run: npx tsx scripts/test-ingest-pglite-integration.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');

// Migrations that cannot run on PGlite and do not touch public.jobs write behaviour. Any OTHER failure fails the test.
const SKIPPED_MIGRATIONS: Record<string, string> = {
  '20261105c_database_safety.sql': 'needs pg_stat_statements (not in PGlite)',
  '20261108a_pg_cron_scheduled_jobs.sql': 'needs pg_cron (not in PGlite)',
  '20261119_onboarding_resume_profiles.sql': 'post-check on Supabase service_role TRUNCATE grant (resume tables only)',
};
const STUBS = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint,
    allowed_mime_types text[], owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid,
    metadata jsonb, created_at timestamptz DEFAULT now());
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS 'SELECT string_to_array(name, ''/'')';
  -- unaccent extension is not in PGlite: identity stand-in (only affects search text, not identity or dates)
  CREATE FUNCTION public.unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1';
`;

type Variant = 'legacy' | 'legacy-no-verified' | 'canonical';
type Scenario = { name: string; variant: Variant; jobs: number; existing: number; datedEvery: 1 | 2; lookupFail?: boolean };

const TARGET = 'example-co';
const OLD_DISCOVERED = '2026-01-01T00:00:00.000Z';
const OLD_SEEN = '2026-01-02T00:00:00.000Z';
const KNOWN_POSTED = '2025-12-01T00:00:00.000Z';
const DATED_MS = 1760000000000;
const DATED_ISO = new Date(DATED_MS).toISOString();
const sjid = (i: number) => `${TARGET}-j${String(i).padStart(2, '0')}`;
const applyUrl = (i: number) => `https://jobs.example/${TARGET}/j${String(i).padStart(2, '0')}`;

/** Split SQL on top-level semicolons (dollar-quote aware), for files PGlite must run one statement at a time. */
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let dollar: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)?.[0];
    if (tag && (dollar === null || dollar === tag)) { dollar = dollar === null ? tag : null; cur += tag; i += tag.length - 1; continue; }
    if (dollar === null && sql.startsWith('--', i)) { const nl = sql.indexOf('\n', i); const end = nl === -1 ? sql.length : nl; cur += sql.slice(i, end); i = end - 1; continue; }
    if (dollar === null && sql[i] === ';') { if (cur.trim()) out.push(cur); cur = ''; continue; }
    cur += sql[i];
  }
  if (cur.trim()) out.push(cur);
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim());
}

async function buildDb(variant: Variant) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto } });
  await db.exec(STUBS);
  await db.exec(fs.readFileSync(path.join(repo, 'supabase/schema.sql'), 'utf8'));
  // 20261001_filter_upgrades grants on jobs_public, which no earlier file creates (20261010 does, via CREATE OR
  // REPLACE starting with id). Placeholder so the chain replays from empty; 20261010 then defines the real view.
  await db.exec('CREATE VIEW public.jobs_public AS SELECT id FROM public.jobs;');
  const dir = path.join(repo, 'supabase/migrations');
  const failed: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (SKIPPED_MIGRATIONS[file]) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS unaccent;/gi, '');
    try {
      if (/\bCONCURRENTLY\b/i.test(sql)) for (const stmt of splitSql(sql)) await db.exec(stmt);
      else await db.exec(sql);
    } catch (e: any) {
      failed.push(`${file}: ${String(e.message).slice(0, 120)}`);
      try { await db.exec('ROLLBACK'); } catch { /* no open transaction */ }
    }
  }
  if (failed.length) throw new Error(`Unexpected migration failures:\n${failed.join('\n')}`);
  // Production applied-state is unknown (20261116a/d NOT applied per the owner). Test-only DDL models the older shapes.
  // CASCADE removes only: idx_jobs_source_id_source_job_id_uniq (source_id); jobs_verified_status_idx, the verified
  // default and the jobs_public view (verified). None is on the ingest write path.
  if (variant !== 'canonical') await db.exec('ALTER TABLE public.jobs DROP COLUMN source_id CASCADE;');
  if (variant === 'legacy-no-verified') await db.exec('ALTER TABLE public.jobs DROP COLUMN verified CASCADE;');
  return db;
}

/** PostgREST-shaped HTTP -> SQL over PGlite. Supports only what ingest.ts sends; anything else throws. */
function postgrestShim(db: any, sc: Scenario, log: Array<{ table: string; method: string; status: number; code?: string }>) {
  const ident = (s: string) => {
    const t = s.trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`Shim refuses identifier ${JSON.stringify(t)}`);
    return `"${t}"`;
  };
  const reserved = new Set(['select', 'limit', 'order', 'offset', 'on_conflict', 'columns']);
  const where = (params: URLSearchParams, args: unknown[]) => {
    const conds: string[] = [];
    for (const [k, v] of params.entries()) {
      if (reserved.has(k)) continue;
      if (v.startsWith('eq.')) { args.push(v.slice(3)); conds.push(`${ident(k)}::text = $${args.length}`); }
      else if (v.startsWith('in.(') && v.endsWith(')')) {
        args.push(v.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')));
        conds.push(`${ident(k)}::text = ANY($${args.length}::text[])`);
      } else throw new Error(`Shim does not support filter ${k}=${v}`);
    }
    return conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  };
  const reply = (body: unknown, status: number) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  return async (url: URL, method: string, body: any, headers: Headers): Promise<Response> => {
    const table = url.pathname.replace('/rest/v1/', '');
    const p = url.searchParams;
    const record = (status: number, code?: string) => log.push({ table, method, status, code });
    try {
      if (table.startsWith('rpc/')) {
        const fn = table.slice(4);
        const exists = (await db.query(`SELECT 1 FROM pg_proc WHERE proname = $1`, [fn])).rows.length > 0;
        if (!exists) { record(404, 'PGRST202'); return reply({ code: 'PGRST202', message: `Could not find the function public.${fn}` }, 404); }
        await db.query(`SELECT public.${ident(fn)}()`);
        record(200);
        return reply(null, 200);
      }
      const t = `public.${ident(table)}`;
      const cols = (p.get('select') || '*').split(',').map((c) => (c.trim() === '*' ? '*' : ident(c))).join(', ');
      const args: unknown[] = [];
      const single = headers.get('accept')?.includes('vnd.pgrst.object');
      let sql: string;
      if (method === 'GET' || method === 'HEAD') {
        if (sc.lookupFail && table === 'jobs' && !p.has('limit')) { record(503, 'FIXTURE'); return reply({ code: 'XX000', message: 'fixture: identity lookup unavailable' }, 503); }
        sql = `SELECT ${cols} FROM ${t}${where(p, args)}${p.has('limit') ? ` LIMIT ${Number(p.get('limit'))}` : ''}`;
      } else if (method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const keys = p.get('columns') ? p.get('columns')!.split(',').map((c) => c.replace(/"/g, '')) : Object.keys(rows[0] ?? {});
        const k = keys.map(ident).join(', ');
        args.push(JSON.stringify(rows));
        sql = `INSERT INTO ${t} (${k}) SELECT ${k} FROM json_populate_recordset(NULL::${t}, $1::json)`;
        if (p.has('on_conflict')) {
          const target = p.get('on_conflict')!.split(',').map(ident).join(', ');
          const ignore = (headers.get('prefer') || '').includes('ignore-duplicates');
          const set = keys.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ');
          sql += ignore ? ` ON CONFLICT (${target}) DO NOTHING` : ` ON CONFLICT (${target}) DO UPDATE SET ${set}`;
        }
        sql += ` RETURNING ${cols}`;
      } else if (method === 'PATCH') {
        const keys = Object.keys(body);
        const k = keys.map(ident).join(', ');
        args.push(JSON.stringify(body));
        const w = where(p, args);
        sql = `UPDATE ${t} SET (${k}) = (SELECT ${k} FROM json_populate_record(NULL::${t}, $1::json))${w} RETURNING ${cols}`;
      } else throw new Error(`Shim does not support ${method}`);
      const res = await db.query(`WITH r AS (${sql}) SELECT coalesce(json_agg(r), '[]'::json) AS j FROM r`, args);
      const data = res.rows[0].j as any[];
      record(method === 'POST' ? 201 : 200);
      if (single) return data.length === 1 ? reply(data[0], 200) : reply({ code: 'PGRST116', message: `${data.length} rows` }, 406);
      return reply(data, method === 'POST' ? 201 : 200);
    } catch (e: any) {
      if (/^Shim /.test(e.message)) throw e;
      const code = e.code || 'XX000';
      const status = code === '23505' ? 409 : code === '42P01' ? 404 : 400;
      record(status, code);
      return reply({ code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null }, status);
    }
  };
}

async function child() {
  const root = process.env.CM_PG_DIR!;
  const sc: Scenario = JSON.parse(process.env.CM_PG_SCENARIO!);
  const db = await buildDb(sc.variant);
  const { buildSourceId } = await import('../src/lib/jobs/highVolumeEnrichment');
  const SOURCE_ID = buildSourceId('lever', TARGET);
  const canonical = sc.variant === 'canonical';

  // Seed: existing rows for this board, plus rows that belong to other identities and must never be touched.
  const seed = async (row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    await db.query(`INSERT INTO public.jobs (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  };
  const base = { company: 'Example Co', title: 'Old title', location: 'Example City', posted_at: KNOWN_POSTED,
    discovered_at: OLD_DISCOVERED, first_seen_at: OLD_DISCOVERED, last_seen_at: OLD_SEEN, is_active: true, status: 'active' };
  for (let i = 0; i < sc.existing; i++) {
    await seed({ ...base, source: 'lever', source_job_id: sjid(i), apply_url: applyUrl(i),
      ...(canonical ? { source_id: i % 2 ? SOURCE_ID : null } : {}) });
  }
  // Same source_job_id text as one of our postings, but another vendor: legacy lookup is keyed on source.
  await seed({ ...base, title: 'Other vendor', source: 'greenhouse', source_job_id: sjid(1), apply_url: 'https://jobs.example/other-vendor/1' });
  // Another Lever board.
  await seed({ ...base, title: 'Other board', source: 'lever', source_job_id: 'other-board-j01', apply_url: 'https://jobs.example/other-board/1',
    ...(canonical ? { source_id: buildSourceId('lever', 'other-board') } : {}) });
  const before = (await db.query(`SELECT row_to_json(j) AS r FROM public.jobs j ORDER BY source, source_job_id`)).rows.map((x: any) => x.r);

  const shimLog: Array<{ table: string; method: string; status: number; code?: string }> = [];
  const shim = postgrestShim(db, sc, shimLog);
  const runStart = new Date().toISOString();
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
    if (url.hostname === 'api.lever.co' && url.pathname === `/v0/postings/${TARGET}`) {
      return new Response(JSON.stringify(Array.from({ length: sc.jobs }, (_, i) => ({
        id: `j${String(i).padStart(2, '0')}`, text: `Engineer ${i}`, hostedUrl: applyUrl(i),
        ...(i % sc.datedEvery === 0 ? { createdAt: DATED_MS } : {}) }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.hostname !== 'db.example') throw new Error(`Blocked network destination ${url.hostname}`);
    return shim(url, method, init?.body ? JSON.parse(String(init.body)) : null, new Headers(init?.headers));
  };

  fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify([{ id: TARGET, name: 'Example Co', type: 'lever', target: TARGET, enabled: true }]));
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL = 'http://db.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY = 'synthetic-not-a-key';
  process.argv = [process.execPath, path.join(here, 'ingest.ts'), '--config', path.join(root, 'sources.json'), '--skip-cleanup', '--per-source', String(sc.jobs)];

  // ingest.ts runs main() on import and may call process.exit; read the database back before the process ends.
  let done = false;
  const realExit = process.exit.bind(process);
  const finish = async (code: number) => {
    if (done) return;
    done = true;
    const after = (await db.query(`SELECT row_to_json(j) AS r FROM public.jobs j ORDER BY source, source_job_id`)).rows.map((x: any) => x.r);
    fs.writeFileSync(path.join(root, 'out.json'), JSON.stringify({ before, after, shimLog, runStart, sourceId: SOURCE_ID, code }));
    realExit(code);
  };
  (process as any).exit = (code?: number) => { void finish(code ?? 0); };
  process.on('beforeExit', () => { void finish(process.exitCode ? Number(process.exitCode) : 0); });
  await import('./ingest');
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 600)}`}`); }
}

function parent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ingest-pglite-'));
  const summary: string[] = [];
  const run = (sc: Scenario) => {
    fs.rmSync(path.join(root, 'out.json'), { force: true });
    const proc = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--child'], {
      cwd: repo, encoding: 'utf8', timeout: 240000, env: { ...process.env, CM_PG_DIR: root, CM_PG_SCENARIO: JSON.stringify(sc) },
    });
    if (!fs.existsSync(path.join(root, 'out.json'))) throw new Error(`${sc.name}: child produced no output\n${(proc.stdout + proc.stderr).slice(-2000)}`);
    const out = JSON.parse(fs.readFileSync(path.join(root, 'out.json'), 'utf8'));
    const t = (x: string | null) => (x === null ? null : new Date(x).toISOString());
    const find = (rows: any[], source: string, id: string) => rows.filter((r) => r.source === source && r.source_job_id === id);
    const jobsWrites = out.shimLog.filter((l: any) => l.table === 'jobs' && l.method !== 'GET');
    summary.push(`| ${sc.name} | ${out.before.length} | ${out.after.length} | ${out.shimLog.filter((l: any) => l.table === 'jobs' && l.method === 'POST').length} | ${out.shimLog.filter((l: any) => l.table === 'jobs' && l.method === 'PATCH').length} | ${jobsWrites.filter((l: any) => l.status >= 400).map((l: any) => l.code).join(' ') || '-'} | ${out.code} |`);
    return { proc, out, t, find, log: (proc.stdout + proc.stderr).slice(-1500) };
  };
  const otherIdentitiesUntouched = (name: string, r: ReturnType<typeof run>) => {
    for (const [source, id] of [['greenhouse', sjid(1)], ['lever', 'other-board-j01']] as const) {
      const b = r.find(r.out.before, source, id);
      const a = r.find(r.out.after, source, id);
      check(`${name}: ${source}/${id} (other identity) is byte-identical after the run`, a.length === 1 && JSON.stringify(a[0]) === JSON.stringify(b[0]), { before: b, after: a });
    }
  };
  const datesAndDiscovery = (name: string, r: ReturnType<typeof run>, sc: Scenario) => {
    const ours = (rows: any[]) => rows.filter((x) => x.source === 'lever' && x.source_job_id.startsWith(`${TARGET}-`));
    const idx = (x: any) => Number(x.source_job_id.slice(-2));
    const existing = ours(r.out.after).filter((x) => idx(x) < sc.existing);
    const fresh = ours(r.out.after).filter((x) => idx(x) >= sc.existing);
    const dated = (x: any) => idx(x) % sc.datedEvery === 0;
    check(`${name}: one stored row per posting (${sc.jobs})`, ours(r.out.after).length === sc.jobs, ours(r.out.after).length);
    check(`${name}: existing rows keep their original discovered_at`, existing.length === sc.existing && existing.every((x) => r.t(x.discovered_at) === OLD_DISCOVERED),
      existing.filter((x) => r.t(x.discovered_at) !== OLD_DISCOVERED).map((x) => [x.source_job_id, x.discovered_at]));
    check(`${name}: new rows have a discovered_at from this run (payload or column default)`,
      fresh.length === sc.jobs - sc.existing && fresh.every((x) => x.discovered_at !== null && r.t(x.discovered_at)! >= r.t(r.out.runStart)!), fresh.map((x) => x.discovered_at));
    check(`${name}: existing dated rows take the source posted_at`, existing.filter(dated).every((x) => r.t(x.posted_at) === DATED_ISO));
    check(`${name}: existing undated rows keep the known posted_at`, existing.filter((x) => !dated(x)).every((x) => r.t(x.posted_at) === KNOWN_POSTED),
      existing.filter((x) => !dated(x) && r.t(x.posted_at) !== KNOWN_POSTED).map((x) => [x.source_job_id, x.posted_at]));
    check(`${name}: new dated rows take the source posted_at`, fresh.filter(dated).every((x) => r.t(x.posted_at) === DATED_ISO));
    check(`${name}: new undated rows store NULL posted_at (not the column default)`, fresh.filter((x) => !dated(x)).every((x) => x.posted_at === null),
      fresh.filter((x) => !dated(x)).map((x) => x.posted_at));
    check(`${name}: existing rows refreshed (last_seen_at advanced, active)`, existing.every((x) => r.t(x.last_seen_at)! > OLD_SEEN && x.is_active === true && x.status === 'active'));
    check(`${name}: first_seen_at of existing rows unchanged`, existing.every((x) => r.t(x.first_seen_at) === OLD_DISCOVERED));
    return { existing, fresh };
  };

  try {
    let sc: Scenario = { name: 'P1 legacy schema + verified, 1 batch, 20 existing + 20 new, even postings dated', variant: 'legacy', jobs: 40, existing: 20, datedEvery: 2 };
    let r = run(sc);
    check(`${sc.name}: exit 0`, r.out.code === 0, r.log);
    datesAndDiscovery(sc.name, r, sc);
    otherIdentitiesUntouched(sc.name, r);

    sc = { name: 'P2 legacy schema + verified, 2 batches, 25 existing + 35 new, all dated', variant: 'legacy', jobs: 60, existing: 25, datedEvery: 1 };
    r = run(sc);
    check(`${sc.name}: exit 0`, r.out.code === 0, r.log);
    datesAndDiscovery(sc.name, r, sc);
    otherIdentitiesUntouched(sc.name, r);

    sc = { name: 'P3 legacy schema without verified, 25 existing + 35 new, all dated (bulk upsert path)', variant: 'legacy-no-verified', jobs: 60, existing: 25, datedEvery: 1 };
    r = run(sc);
    check(`${sc.name}: exit 0`, r.out.code === 0, r.log);
    check(`${sc.name}: bulk upsert succeeded against the real (source, source_job_id) key`,
      r.out.shimLog.some((l: any) => l.table === 'jobs' && l.method === 'POST' && l.status === 201), r.out.shimLog.filter((l: any) => l.table === 'jobs'));
    datesAndDiscovery(sc.name, r, sc);
    otherIdentitiesUntouched(sc.name, r);

    sc = { name: 'P4 canonical schema (source_id), 1 batch, 20 existing + 20 new, even postings dated', variant: 'canonical', jobs: 40, existing: 20, datedEvery: 2 };
    r = run(sc);
    check(`${sc.name}: exit 0`, r.out.code === 0, r.log);
    const { existing, fresh } = datesAndDiscovery(sc.name, r, sc);
    otherIdentitiesUntouched(sc.name, r);
    check(`${sc.name}: NULL-source_id legacy rows were matched (updated, now carry this board's source_id)`,
      existing.every((x) => x.source_id === r.out.sourceId), existing.map((x) => x.source_id));
    check(`${sc.name}: new rows carry this board's source_id`, fresh.every((x) => x.source_id === r.out.sourceId));

    sc = { name: 'P5 legacy schema + verified, identity lookup fails', variant: 'legacy', jobs: 40, existing: 20, datedEvery: 2, lookupFail: true };
    r = run(sc);
    check(`${sc.name}: no INSERT/UPSERT/UPDATE reached public.jobs`, r.out.shimLog.every((l: any) => !(l.table === 'jobs' && l.method !== 'GET')),
      r.out.shimLog.filter((l: any) => l.table === 'jobs' && l.method !== 'GET'));
    check(`${sc.name}: every stored row is byte-identical (no guessed inserts, no updates)`, JSON.stringify(r.out.after) === JSON.stringify(r.out.before));
    check(`${sc.name}: failure is logged`, /jobs identity lookup failed/.test(r.proc.stdout + r.proc.stderr), r.log);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  console.log('\n| scenario | rows before | rows after | jobs POST | jobs PATCH | jobs write errors | exit |\n|---|---|---|---|---|---|---|');
  console.log(summary.join('\n'));
  console.log(`Skipped migrations: ${Object.entries(SKIPPED_MIGRATIONS).map(([f, why]) => `${f} (${why})`).join('; ')}`);
  console.log(`${passed} passed, ${failed} failed. Local PGlite proof only; PostgREST is a shim; production schema/triggers/capacity not verified.`);
  if (failed > 0) process.exit(1);
}

if (process.argv.includes('--child')) child().catch((e) => { console.error(e); process.exit(1); });
else parent();
