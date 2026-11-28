/**
 * DIAGNOSTIC ONLY (not a required suite; changes nothing in the repo or any real database).
 * Replays supabase/migrations/*.sql into a throwaway in-memory PGlite database, in the order the repo documents:
 *   - docs/dr-runbook.md "Path B" step 4 and docs/rpo-rto-targets.md Scenario 4: every migration in sorted filename order;
 *   - scripts/lib/schema-dump.ts: the same sorted order for supabase/schema.generated.sql.
 * Statements are sent one at a time, as `psql -f` sends a file, so a failure has an exact file:line.
 *
 * Nothing is invented silently:
 *   - every stub and skip is declared below, printed in the report, and only applied when asked for;
 *   - --assume=<name> adds an explicitly named local stand-in (e.g. jobs_public) and is printed as an ASSUMPTION;
 *   - the first undeclared DDL error stops the replay (exit 1) with file, line, statement head and SQLSTATE;
 *   - a run that used any skip or assumption is reported as PARTIAL, never as a successful replay.
 * PGlite is Postgres 17 in WASM, not a Supabase project: platform schemas (auth, storage), roles and several extensions
 * do not exist there. This says nothing about which migrations production has applied.
 *
 * Usage (offline, no credentials, no network):
 *   npx tsx scripts/diagnose-migration-replay.ts [--baseline] [--platform-stubs] [--assume=jobs_public] [--json]
 *     --baseline        apply supabase/schema.sql first (docs/schema-drift-baseline.md "hand-run baseline")
 *     --platform-stubs  declared Supabase platform stand-ins + PGlite contrib extensions + declared skips
 *     --assume=a,b      add the named stand-ins from ASSUMPTIONS once public.jobs exists (reported as ASSUMPTION)
 *     --no-skip=f,g     run these SKIPPED_FILES anyway, to show the real error behind each skip
 *     --whole-file      send each file as one request (Supabase SQL Editor) instead of statement by statement (psql)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Supabase platform objects a real project provides and PGlite does not. Test stand-ins, shapes minimal. */
export const PLATFORM_STUBS: Array<{ object: string; sql: string }> = [
  { object: 'roles anon, authenticated, service_role, authenticator', sql: 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator;' },
  { object: 'schema auth, table auth.users', sql: 'CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);' },
  { object: 'functions auth.uid(), auth.role(), auth.jwt()', sql: `CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';` },
  { object: 'schema storage, tables storage.buckets / storage.objects, function storage.foldername()', sql: `CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[],
      owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb,
      created_at timestamptz DEFAULT now());
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS 'SELECT string_to_array(name, ''/'')';` },
  // A Supabase project grants ALL on new public tables to its API roles by default; migrations REVOKE from that baseline.
  { object: 'default privileges: ALL on new public tables/functions/sequences to anon, authenticated, service_role', sql: `
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;` },
];

/** Extensions Supabase offers that PGlite cannot load. Each CREATE EXTENSION for these is a declared, reported no-op. */
export const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  unaccent: 'stand-in public.unaccent(text) = identity (search text only)',
  pg_stat_statements: 'no stand-in; statements that use it fail and are reported',
  pg_cron: 'no stand-in; statements that use it fail and are reported',
};
const EXTENSION_STANDINS: Record<string, string> = {
  unaccent: `CREATE FUNCTION public.unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1';`,
};

/** Whole files skipped under --platform-stubs, with the evidence for why. Kept in step with the report. */
export const SKIPPED_FILES: Record<string, string> = {
  // Evidence: with only CREATE EXTENSION pg_cron no-op'd, line 44 fails: schema "cron" does not exist (cron.schedule).
  '20261108a_pg_cron_scheduled_jobs.sql': 'calls cron.schedule(), which needs the pg_cron extension (not in PGlite)',
};

/** Named local stand-ins for objects a migration uses before any migration creates them. Only with --assume. */
export const ASSUMPTIONS: Record<string, string> = {
  // 20261010_lock_paid_jobs_data.sql:9 later runs CREATE OR REPLACE VIEW starting with id, so this shape is compatible.
  jobs_public: 'CREATE VIEW public.jobs_public AS SELECT id FROM public.jobs;',
};

export type Stmt = { sql: string; line: number };

/** Split SQL into top-level statements with their 1-based start line. Aware of '...', "...", $tag$...$tag$, -- and block comments. */
export function splitSql(text: string): Stmt[] {
  const out: Stmt[] = [];
  let cur = '';
  let curLine = 0;
  let line = 1;
  let i = 0;
  const push = () => { if (cur.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) out.push({ sql: cur.trim(), line: curLine }); cur = ''; curLine = 0; };
  const take = (s: string) => {
    if (!curLine && s.trim()) curLine = line;
    cur += s;
    line += (s.match(/\n/g) || []).length;
    i += s.length;
  };
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];
    if (rest.startsWith('--')) { const nl = rest.indexOf('\n'); const s = nl === -1 ? rest : rest.slice(0, nl); cur += s; i += s.length; continue; }
    if (rest.startsWith('/*')) { const end = rest.indexOf('*/'); const s = end === -1 ? rest : rest.slice(0, end + 2); cur += s; line += (s.match(/\n/g) || []).length; i += s.length; continue; }
    const tag = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
    if (tag) { const end = rest.indexOf(tag, tag.length); take(end === -1 ? rest : rest.slice(0, end + tag.length)); continue; }
    if (ch === "'" || ch === '"') {
      let j = 1;
      while (j < rest.length) { if (rest[j] === ch) { if (rest[j + 1] === ch) { j += 2; continue; } break; } j++; }
      take(rest.slice(0, j + 1));
      continue;
    }
    if (ch === ';') { i++; push(); continue; }
    take(ch);
  }
  push();
  return out;
}

export type Category = 'ordering-or-dependency-gap' | 'supabase-platform-object' | 'unsupported-extension' | 'concurrent-index-in-transaction' | 'other';

/** Heuristic classification from the SQLSTATE and message; printed as a classification, not as proof. */
export function classify(code: string, message: string): Category {
  if (/extension "[^"]+" is not available|could not open extension control file/i.test(message)) return 'unsupported-extension';
  if (/\b(schema|function|relation) "?(cron|pg_stat_statements)\b/i.test(message)) return 'unsupported-extension';
  if (/CONCURRENTLY cannot (run|be executed) inside a transaction block/i.test(message)) return 'concurrent-index-in-transaction';
  if (/\b(schema|relation|function|role) "?(auth|storage|realtime|vault|extensions|supabase_\w+|authenticator|anon|authenticated|service_role)\b/i.test(message)) {
    return 'supabase-platform-object';
  }
  if (['42P01', '42703', '42883', '42704', '3F000'].includes(code)) return 'ordering-or-dependency-gap';
  return 'other';
}

export type ReplayReport = {
  mode: { baseline: boolean; platformStubs: boolean; assume: string[]; noSkip: string[]; wholeFile: boolean };
  stubsApplied: string[];
  extensionNoOps: Array<{ file: string; line: number; extension: string }>;
  filesSkipped: Array<{ file: string; reason: string }>;
  assumptions: string[];
  filesApplied: number;
  filesTotal: number;
  statementsRun: number;
  firstError: null | { file: string; line: number; statement: string; code: string; message: string; category: Category };
  status: 'COMPLETE' | 'PARTIAL' | 'STOPPED';
};

export async function replay(opts: { baseline?: boolean; platformStubs?: boolean; assume?: string[]; noSkip?: string[]; wholeFile?: boolean } = {}): Promise<ReplayReport> {
  const { PGlite } = await import('@electric-sql/pglite');
  const extensions: Record<string, any> = {};
  if (opts.platformStubs) {
    extensions.pg_trgm = (await import('@electric-sql/pglite/contrib/pg_trgm')).pg_trgm;
    extensions.pgcrypto = (await import('@electric-sql/pglite/contrib/pgcrypto')).pgcrypto;
  }
  const db = new PGlite({ extensions });
  const report: ReplayReport = {
    mode: { baseline: !!opts.baseline, platformStubs: !!opts.platformStubs, assume: opts.assume ?? [], noSkip: opts.noSkip ?? [], wholeFile: !!opts.wholeFile },
    stubsApplied: [], extensionNoOps: [], filesSkipped: [], assumptions: [],
    filesApplied: 0, filesTotal: 0, statementsRun: 0, firstError: null, status: 'COMPLETE',
  };
  if (opts.platformStubs) {
    for (const s of PLATFORM_STUBS) { await db.exec(s.sql); report.stubsApplied.push(s.object); }
    for (const [ext, sql] of Object.entries(EXTENSION_STANDINS)) { await db.exec(sql); report.stubsApplied.push(`extension ${ext}: ${UNSUPPORTED_EXTENSIONS[ext]}`); }
  }
  const files: Array<{ name: string; rel: string }> = [];
  if (opts.baseline) files.push({ name: 'schema.sql', rel: 'supabase/schema.sql' });
  const dir = path.join(repo, 'supabase/migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) files.push({ name: f, rel: `supabase/migrations/${f}` });
  report.filesTotal = files.length;

  let assumed = false;
  const applyAssumptions = async () => {
    if (assumed) return;
    assumed = true;
    for (const name of opts.assume ?? []) {
      if (!ASSUMPTIONS[name]) throw new Error(`Unknown --assume=${name}; declared: ${Object.keys(ASSUMPTIONS).join(', ')}`);
      await db.exec(ASSUMPTIONS[name]);
      report.assumptions.push(`${name}: ${ASSUMPTIONS[name]}`);
    }
  };
  // Assumptions stand in for objects the live database had before the migration chain; add them once public.jobs exists.
  const jobsExists = async () => (await db.query(`SELECT to_regclass('public.jobs') IS NOT NULL AS ok`)).rows[0] as any;

  for (const f of files) {
    if (opts.platformStubs && SKIPPED_FILES[f.name] && !(opts.noSkip ?? []).includes(f.name)) { report.filesSkipped.push({ file: f.rel, reason: SKIPPED_FILES[f.name] }); continue; }
    if ((opts.assume ?? []).length && !assumed && (await jobsExists()).ok) await applyAssumptions();
    const text = fs.readFileSync(path.join(repo, f.rel), 'utf8');
    // --whole-file: one request per file, as the Supabase SQL Editor sends it (implicit transaction; no per-line position).
    const extOf = (sql: string) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim().match(/^CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i)?.[1];
    const isNoOp = (ext?: string) => !!(opts.platformStubs && ext && UNSUPPORTED_EXTENSIONS[ext] !== undefined);
    let whole = text;
    if (opts.wholeFile) {
      for (const st of splitSql(text)) {
        const ext = extOf(st.sql);
        if (isNoOp(ext)) { whole = whole.replace(st.sql, `-- [diagnostic no-op] CREATE EXTENSION ${ext}`); report.extensionNoOps.push({ file: f.rel, line: st.line, extension: ext! }); }
      }
    }
    const stmts = opts.wholeFile ? [{ sql: whole, line: 1 }] : splitSql(text);
    for (const st of stmts) {
      const ext = opts.wholeFile ? undefined : extOf(st.sql);
      if (isNoOp(ext)) { report.extensionNoOps.push({ file: f.rel, line: st.line, extension: ext! }); continue; }
      try {
        await db.exec(st.sql);
        report.statementsRun++;
      } catch (e: any) {
        const code = String(e.code || '');
        const message = String(e.message || e);
        report.firstError = { file: f.rel, line: st.line, statement: st.sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().slice(0, 200), code, message, category: classify(code, message) };
        report.status = 'STOPPED';
        try { await db.exec('ROLLBACK'); } catch { /* nothing open */ }
        await db.close();
        return report;
      }
    }
    if ((opts.assume ?? []).length && !assumed && (await jobsExists()).ok) await applyAssumptions();
    report.filesApplied++;
  }
  await db.close();
  if (report.filesSkipped.length || report.assumptions.length || report.extensionNoOps.length) report.status = 'PARTIAL';
  return report;
}

function print(r: ReplayReport) {
  console.log(`Migration replay diagnostic (PGlite, in memory) baseline=${r.mode.baseline} platformStubs=${r.mode.platformStubs} assume=[${r.mode.assume.join(',')}] noSkip=[${r.mode.noSkip.join(',')}] wholeFile=${r.mode.wholeFile}`);
  for (const s of r.stubsApplied) console.log(`  STUB        ${s}`);
  for (const s of r.filesSkipped) console.log(`  SKIP FILE   ${s.file} - ${s.reason}`);
  for (const s of r.extensionNoOps) console.log(`  NO-OP       ${s.file}:${s.line} CREATE EXTENSION ${s.extension} - ${UNSUPPORTED_EXTENSIONS[s.extension]}`);
  for (const s of r.assumptions) console.log(`  ASSUMPTION  ${s}`);
  console.log(`  files applied ${r.filesApplied}/${r.filesTotal}, statements run ${r.statementsRun}`);
  if (r.firstError) {
    const e = r.firstError;
    console.log(`  FIRST ERROR ${e.file}${r.mode.wholeFile ? ' (whole file)' : `:${e.line}`} [${e.code}] ${e.message}`);
    console.log(`              category (heuristic): ${e.category}`);
    console.log(`              statement: ${e.statement}`);
  }
  console.log(`STATUS: ${r.status}${r.status === 'PARTIAL' ? ' (skips/stubs/assumptions above were used; this is not a clean replay)' : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const assume = argv.filter((a) => a.startsWith('--assume=')).flatMap((a) => a.slice(9).split(',').filter(Boolean));
  const noSkip = argv.filter((a) => a.startsWith('--no-skip=')).flatMap((a) => a.slice(10).split(',').filter(Boolean));
  replay({ baseline: argv.includes('--baseline'), platformStubs: argv.includes('--platform-stubs'), assume, noSkip, wholeFile: argv.includes('--whole-file') })
    .then((r) => { if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2)); else print(r); process.exit(r.status === 'STOPPED' ? 1 : 0); })
    .catch((e) => { console.error(e); process.exit(2); });
}
