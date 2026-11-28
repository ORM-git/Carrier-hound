/**
 * Row 39: discovered_at is insert-only. No TS write to an existing row may send it, so an updated job keeps its
 * first discovered time and does not re-enter the daily digest window (src/lib/cron/dailyDigestCron.ts).
 * 1. updateExistingJobs with a fake client that records the UPDATE payload.
 * 2. Real ingest.ts main per scenario (legacy/canonical schema, verified column or not, dated or not, update and
 *    lookup failures) in a child process whose fetch is intercepted (same approach as test-source-date-legacy-cli.ts).
 *    Prints a request-count table per scenario. Models REST payloads only, not PostgreSQL defaults, constraints or
 *    triggers: mock responses are not real database proof. No DB, no network.
 * Run: npx tsx scripts/test-discovered-at-insert-only.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeDate } from './utils/sanitizer';

const here = path.dirname(fileURLToPath(import.meta.url));
const OLD_DISCOVERED = '2026-01-01T00:00:00.000Z';
const DATED_MS = 1760000000000;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}

function fakeClient(payloads: Record<string, unknown>[]): any {
  return {
    from: (table: string) =>
      table === 'jobs'
        ? { update: (p: Record<string, unknown>) => ({ eq: async () => { payloads.push(p); return { error: null }; } }) }
        : { upsert: async () => ({ error: null }) },
  };
}
const stats = (): any => ({ sourceName: 'fixture', inserted: 0, updated: 0, failed: 0, duplicateSkipped: 0 });

async function unit() {
  // Dynamic import: a static one would load ingest.ts before the CLI child sets argv.
  const { updateExistingJobs } = await import('./ingest');
  // The insert-path row builder sets discovered_at (ingest.ts hasVerifiedColumn branch), so update items carry it too.
  const payloads: Record<string, unknown>[] = [];
  const dated = { title: 'Engineer', discovered_at: '2026-11-27T00:00:00.000Z', posted_at: '2026-11-20T09:00:00Z' };
  const undated = { title: 'Engineer', discovered_at: '2026-11-27T00:00:00.000Z', posted_at: null };
  const s = stats();
  const err = await updateExistingJobs(fakeClient(payloads), [
    { id: 'dated', item: dated, original: {} as any },
    { id: 'undated', item: undated, original: {} as any },
  ], s, false, 0);
  const [p1, p2] = payloads;

  check('both updates succeed', err === null && s.updated === 2 && payloads.length === 2, { err, s });
  check('update payload has no discovered_at', !('discovered_at' in p1) && !('discovered_at' in p2), payloads);
  check('update payload still sets last_seen_at', typeof p1.last_seen_at === 'string' && typeof p2.last_seen_at === 'string');
  check('update payload still sets is_active true and status active',
    p1.is_active === true && p1.status === 'active' && p2.is_active === true && p2.status === 'active');
  check('known source date is still written normalized', p1.posted_at === normalizeDate(dated.posted_at), p1.posted_at);
  check('unknown source date is still omitted (does not erase a known posted_at)', !('posted_at' in p2), p2);
  check('caller item is not mutated', dated.discovered_at === '2026-11-27T00:00:00.000Z');
}

// CLI scenarios: one source with 60 Lever postings, so two write batches (ingest.ts batchSize 50). A per-row lookup
// or unbounded fanout shows up as a count that grows with rows instead of batches.
type Scenario = {
  name: string;
  verified: boolean; // jobs.verified present: the row builder then adds discovered_at
  canonical: boolean; // jobs.source_id present
  existing: number; // first N postings already stored
  dated: boolean; // source gives a valid posting date
  patchFail?: Record<string, 'transient' | 'permanent'>;
  lookupFail?: boolean;
  foreignIdentity?: boolean; // canonical: a stored row with the same source_job_id from another board
};
const N_JOBS = 60;
const OLD_SEEN = '2026-01-02T00:00:00.000Z';
const KNOWN_POSTED = '2025-12-01T00:00:00.000Z';
const SOURCE_ID = 'lever:fixture';
const sjid = (i: number) => `fixture-j${String(i).padStart(2, '0')}`;
const KINDS = ['probe', 'lookup', 'insert', 'upsert', 'update', 'retry', 'other'] as const;
type Kind = (typeof KINDS)[number];

async function child() {
  const root = process.env.CM_DA_DIR!;
  const sc: Scenario = JSON.parse(process.env.CM_DA_SCENARIO!);
  const stored = (id: string, i: number, extra: Record<string, unknown>) => ({ id, source: 'lever', source_job_id: sjid(i),
    posted_at: KNOWN_POSTED, discovered_at: OLD_DISCOVERED, last_seen_at: OLD_SEEN, is_active: true, status: 'active', title: 'Old title', ...extra });
  const rows: any[] = [];
  // Canonical: odd rows already carry this board's source_id, even rows are legacy rows with NULL source_id.
  for (let i = 0; i < sc.existing; i++) rows.push(stored(`row-${i}`, i, sc.canonical ? { source_id: i % 2 ? SOURCE_ID : null } : {}));
  if (sc.foreignIdentity) rows.push(stored('row-foreign', N_JOBS - 1, { source_id: 'lever:other-board', title: 'Other board' }));

  const requests: Array<{ kind: Kind; query: string; body: any }> = [];
  const patched = new Map<string, number>();
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const sameIdentity = (r: any, item: any) => r.source === item.source && r.source_job_id === item.source_job_id &&
    (!sc.canonical || r.source_id === item.source_id);
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
    if (url.hostname === 'api.lever.co') {
      return reply(Array.from({ length: N_JOBS }, (_, i) => ({ id: `j${String(i).padStart(2, '0')}`, text: 'Engineer',
        hostedUrl: `https://jobs.lever.co/fixture/j${i}`, ...(sc.dated ? { createdAt: DATED_MS } : {}) })));
    }
    if (url.hostname !== 'fixture.supabase.co') throw new Error(`Blocked network destination ${url.hostname}`);
    const table = url.pathname.replace('/rest/v1/', '');
    const select = url.searchParams.get('select') || '';
    const isProbe = method === 'GET' && url.searchParams.has('limit');
    const patchId = method === 'PATCH' && table === 'jobs' ? url.searchParams.get('id')!.slice(3) : '';
    let kind: Kind = 'other';
    if (isProbe) kind = 'probe';
    else if (table === 'jobs' && method === 'GET') kind = 'lookup';
    else if (table === 'jobs' && method === 'POST') kind = url.searchParams.has('on_conflict') ? 'upsert' : 'insert';
    else if (patchId) {
      patched.set(patchId, (patched.get(patchId) ?? 0) + 1);
      kind = patched.get(patchId)! > 1 ? 'retry' : 'update';
    }
    requests.push({ kind, query: url.search, body });

    if (isProbe) {
      const ok = table === 'jobs' && ((sc.verified && select === 'verified') || (sc.canonical && select === 'source_id'));
      if (ok) return reply([]);
      return table === 'jobs' ? reply({ code: '42703', message: 'fixture column absent' }, 400) : reply({ code: '42P01', message: 'fixture table absent' }, 404);
    }
    if (table === 'rpc/analyze_after_ingest' || table === 'company_boards') return reply(null);
    if (table !== 'jobs') return reply({ code: '42P01', message: 'fixture table absent' }, 404);
    if (method === 'GET') {
      if (sc.lookupFail) return reply({ code: 'XX000', message: 'fixture lookup refused' }, 500);
      const [col, eq] = [...url.searchParams.entries()].find(([k]) => k === 'source' || k === 'source_id')!;
      const ids = url.searchParams.get('source_job_id')!.slice(4, -1).split(',').map((id) => id.replace(/^"|"$/g, ''));
      return reply(rows.filter((r) => r[col] === eq.slice(3) && ids.includes(r.source_job_id)).map((r) => ({
        id: r.id, source: r.source, source_job_id: r.source_job_id, ...(select.includes('source_id') ? { source_id: r.source_id ?? null } : {}),
      })));
    }
    if (patchId) {
      const mode = sc.patchFail?.[patchId];
      if (mode === 'permanent' || (mode === 'transient' && patched.get(patchId) === 1)) {
        return reply({ code: '57014', message: 'fixture statement timeout' }, 500);
      }
      Object.assign(rows.find((r) => r.id === patchId)!, body);
      return reply(null);
    }
    if (method === 'POST') {
      const isUpsert = url.searchParams.has('on_conflict');
      const results = (Array.isArray(body) ? body : [body]).map((item: any) => {
        let row = rows.find((r) => sameIdentity(r, item));
        if (row && !isUpsert) throw new Error(`Fixture duplicate insert ${item.source_job_id}`);
        if (row) Object.assign(row, item);
        else { row = { id: `inserted-${item.source_job_id}`, ...item }; rows.push(row); }
        return { id: row.id, source_job_id: row.source_job_id };
      });
      return reply(new Headers(init?.headers).get('accept')?.includes('object') ? results[0] : results, 201);
    }
    throw new Error('Unexpected fixture method');
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL = 'https://fixture.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY = 'fixture-not-a-real-key';
  process.argv = [process.execPath, path.join(here, 'ingest.ts'), '--config', path.join(root, 'sources.json'), '--skip-cleanup', '--per-source', String(N_JOBS)];
  process.on('exit', () => fs.writeFileSync(path.join(root, 'out.json'), JSON.stringify({ rows, requests })));
  await import('./ingest');
}

function cli() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-discovered-at-'));
  const DATED_ISO = new Date(DATED_MS).toISOString();
  const table: string[] = [];
  const run = (sc: Scenario) => {
    fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify([{ id: 'fixture', name: 'Fixture', type: 'lever', target: 'fixture', enabled: true }]));
    fs.rmSync(path.join(root, 'out.json'), { force: true });
    const proc = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--fixture-child'], {
      cwd: path.join(here, '..'), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, CM_DA_DIR: root, CM_DA_SCENARIO: JSON.stringify(sc) },
    });
    const out = JSON.parse(fs.readFileSync(path.join(root, 'out.json'), 'utf8'));
    const count = Object.fromEntries(KINDS.map((k) => [k, out.requests.filter((r: any) => r.kind === k).length])) as Record<Kind, number>;
    table.push(`| ${sc.name} | ${KINDS.map((k) => count[k]).join(' | ')} | ${proc.status} |`);
    const bodies = (kind: Kind) => out.requests.filter((r: any) => r.kind === kind).flatMap((r: any) => (Array.isArray(r.body) ? r.body : [r.body]));
    const byId = (id: string) => out.rows.find((r: any) => r.id === id);
    const existingRows = Array.from({ length: sc.existing }, (_, i) => byId(`row-${i}`));
    const inserted = out.rows.filter((x: any) => String(x.id).startsWith('inserted-'));
    const log = (proc.stdout + proc.stderr).slice(-600);
    // Checks every scenario must pass.
    check(`${sc.name}: no update/retry body carries discovered_at`, [...bodies('update'), ...bodies('retry')].every((b: any) => !('discovered_at' in b)));
    check(`${sc.name}: no upsert body carries discovered_at`, bodies('upsert').every((b: any) => !('discovered_at' in b)));
    check(`${sc.name}: every existing row keeps its original discovered_at`, existingRows.every((x: any) => x.discovered_at === OLD_DISCOVERED),
      existingRows.filter((x: any) => x.discovered_at !== OLD_DISCOVERED).map((x: any) => x.id));
    check(`${sc.name}: no identity stored twice`, new Set(out.rows.map((x: any) => `${x.source_id ?? ''}|${x.source_job_id}`)).size === out.rows.length);
    return { proc, out, count, bodies, byId, existingRows, inserted, log };
  };

  try {
    let sc: Scenario = { name: 'S1 legacy+verified, 60 existing, dated', verified: true, canonical: false, existing: 60, dated: true };
    let r = run(sc);
    check(`${sc.name}: exit 0`, r.proc.status === 0, r.log);
    check(`${sc.name}: 2 lookup (1 per batch), 0 insert, 0 upsert, 60 update, 0 retry`,
      r.count.lookup === 2 && r.count.insert === 0 && r.count.upsert === 0 && r.count.update === 60 && r.count.retry === 0, r.count);
    check(`${sc.name}: last_seen_at advanced, active/status set, dated posted_at written`,
      r.existingRows.every((x: any) => x.last_seen_at > OLD_SEEN && x.is_active === true && x.status === 'active' && x.posted_at === DATED_ISO));

    sc = { name: 'S2 legacy+verified, 25 existing + 35 new, dated', verified: true, canonical: false, existing: 25, dated: true };
    r = run(sc);
    check(`${sc.name}: exit 0`, r.proc.status === 0, r.log);
    check(`${sc.name}: 2 lookup, 2 insert (1 per batch with new rows), 0 upsert, 25 update`,
      r.count.lookup === 2 && r.count.insert === 2 && r.count.upsert === 0 && r.count.update === 25 && r.count.retry === 0, r.count);
    check(`${sc.name}: 35 new rows inserted, each with a fresh discovered_at`,
      r.inserted.length === 35 && r.inserted.every((x: any) => typeof x.discovered_at === 'string' && x.discovered_at !== OLD_DISCOVERED));
    check(`${sc.name}: inserts carry the dated posted_at and active status`,
      r.inserted.every((x: any) => x.posted_at === DATED_ISO && x.is_active === true && x.status === 'active'));

    sc = { name: 'S3 legacy no verified, 25 existing + 35 new, dated', verified: false, canonical: false, existing: 25, dated: true };
    r = run(sc);
    check(`${sc.name}: exit 0`, r.proc.status === 0, r.log);
    check(`${sc.name}: bulk upsert kept (2, 1 per batch), 0 lookup/insert/update`,
      r.count.upsert === 2 && r.count.lookup === 0 && r.count.insert === 0 && r.count.update === 0, r.count);
    check(`${sc.name}: upsert targets (source, source_job_id)`,
      r.out.requests.filter((x: any) => x.kind === 'upsert').every((x: any) => x.query.includes('on_conflict=source%2Csource_job_id')));
    check(`${sc.name}: existing rows get the dated posted_at, new rows inserted`,
      r.existingRows.every((x: any) => x.posted_at === DATED_ISO && x.last_seen_at > OLD_SEEN) && r.inserted.length === 35);

    sc = { name: 'S4 legacy no verified, 25 existing + 35 new, undated', verified: false, canonical: false, existing: 25, dated: false };
    r = run(sc);
    check(`${sc.name}: exit 0`, r.proc.status === 0, r.log);
    check(`${sc.name}: 2 lookup, 2 insert, 0 upsert, 25 update`,
      r.count.lookup === 2 && r.count.insert === 2 && r.count.upsert === 0 && r.count.update === 25, r.count);
    check(`${sc.name}: update bodies omit posted_at, existing rows keep the known date`,
      r.bodies('update').every((b: any) => !('posted_at' in b)) && r.existingRows.every((x: any) => x.posted_at === KNOWN_POSTED));
    check(`${sc.name}: new undated rows insert explicit null posted_at`, r.inserted.length === 35 && r.bodies('insert').every((b: any) => b.posted_at === null));

    sc = { name: 'S5 legacy+verified, 25 existing + 35 new, undated', verified: true, canonical: false, existing: 25, dated: false };
    r = run(sc);
    check(`${sc.name}: exit 0`, r.proc.status === 0, r.log);
    check(`${sc.name}: 2 lookup, 2 insert, 25 update`, r.count.lookup === 2 && r.count.insert === 2 && r.count.update === 25, r.count);
    check(`${sc.name}: existing rows keep the known posted_at`, r.existingRows.every((x: any) => x.posted_at === KNOWN_POSTED));

    sc = { name: 'S6 canonical+verified, 25 existing + 35 new, dated, 1 other-board row', verified: true, canonical: true, existing: 25, dated: true, foreignIdentity: true };
    r = run(sc);
    check(`${sc.name}: exit 0`, r.proc.status === 0, r.log);
    check(`${sc.name}: 4 lookup (source_id + source per batch), 2 insert, 0 upsert, 25 update`,
      r.count.lookup === 4 && r.count.insert === 2 && r.count.upsert === 0 && r.count.update === 25, r.count);
    check(`${sc.name}: every insert/update carries this board's source_id`, [...r.bodies('insert'), ...r.bodies('update')].every((b: any) => b.source_id === SOURCE_ID));
    check(`${sc.name}: NULL-source_id legacy rows are matched and updated, not re-inserted`,
      r.existingRows.filter((_: any, i: number) => i % 2 === 0).every((x: any) => x.last_seen_at > OLD_SEEN));
    const foreign = r.byId('row-foreign');
    check(`${sc.name}: other board's row untouched (title, source_id, discovered_at)`,
      foreign.title === 'Other board' && foreign.source_id === 'lever:other-board' && foreign.discovered_at === OLD_DISCOVERED && foreign.last_seen_at === OLD_SEEN);
    check(`${sc.name}: that posting is inserted for this board`,
      r.out.rows.some((x: any) => x.source_job_id === sjid(N_JOBS - 1) && x.source_id === SOURCE_ID && String(x.id).startsWith('inserted-')));

    sc = { name: 'S7 legacy+verified, 25 existing, 1 transient + 1 permanent update failure', verified: true, canonical: false, existing: 25, dated: true,
      patchFail: { 'row-3': 'transient', 'row-7': 'permanent' } };
    r = run(sc);
    check(`${sc.name}: shard exits 1 on the permanent failure`, r.proc.status === 1, r.log);
    check(`${sc.name}: 25 update + exactly 2 retries (1 per failed row), 2 lookup`,
      r.count.update === 25 && r.count.retry === 2 && r.count.lookup === 2, r.count);
    check(`${sc.name}: transient row updated on retry, permanent row untouched`,
      r.byId('row-3').last_seen_at > OLD_SEEN && r.byId('row-7').last_seen_at === OLD_SEEN);

    sc = { name: 'S8 legacy+verified, 25 existing, identity lookup fails', verified: true, canonical: false, existing: 25, dated: true, lookupFail: true };
    r = run(sc);
    check(`${sc.name}: no insert, upsert, update or retry after the failed lookup`,
      r.count.insert === 0 && r.count.upsert === 0 && r.count.update === 0 && r.count.retry === 0, r.count);
    check(`${sc.name}: stored rows unchanged (25 rows, original last_seen_at)`,
      r.out.rows.length === 25 && r.out.rows.every((x: any) => x.last_seen_at === OLD_SEEN));
    check(`${sc.name}: failure is logged`, /jobs identity lookup failed/.test(r.proc.stdout + r.proc.stderr), r.log);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  console.log(`\nRequest counts per scenario (mock REST calls, 60 postings = 2 write batches):`);
  console.log(`| scenario | ${KINDS.join(' | ')} | exit |\n|${'---|'.repeat(KINDS.length + 2)}\n${table.join('\n')}`);
}

if (process.argv.includes('--fixture-child')) {
  child().catch((e) => { console.error(e); process.exitCode = 1; });
} else {
  unit().then(cli).then(() => {
    console.log(`${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
