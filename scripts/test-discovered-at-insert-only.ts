/**
 * Row 39: discovered_at is insert-only. No TS write to an existing row may send it, so an updated job keeps its
 * first discovered time and does not re-enter the daily digest window (src/lib/cron/dailyDigestCron.ts).
 * 1. updateExistingJobs with a fake client that records the UPDATE payload.
 * 2. Real ingest.ts main on the legacy schema (no source_id), fully dated batch, one existing row, via a child
 *    process whose fetch is intercepted (same approach as test-source-date-legacy-cli.ts). Models REST payloads
 *    only, not PostgreSQL defaults, constraints or triggers. No DB, no network.
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

// Child: legacy schema (source_id absent); jobs.verified present only when CM_DA_VERIFIED=1.
async function child() {
  const root = process.env.CM_DA_DIR!;
  const verified = process.env.CM_DA_VERIFIED === '1';
  const rows: any[] = [{ id: 'existing', source: 'lever', source_job_id: 'fixture-old', posted_at: null, discovered_at: OLD_DISCOVERED }];
  const requests: any[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
    if (url.hostname === 'api.lever.co') {
      return reply(['old', 'new'].map(id => ({ id, text: 'Engineer', hostedUrl: `https://jobs.lever.co/fixture/${id}`, createdAt: DATED_MS })));
    }
    if (url.hostname !== 'fixture.supabase.co') throw new Error(`Blocked network destination ${url.hostname}`);
    if (url.pathname === '/rest/v1/rpc/analyze_after_ingest') return reply(null);
    if (url.pathname === '/rest/v1/company_boards' && method === 'PATCH') return reply(null);
    if (url.pathname !== '/rest/v1/jobs') return reply({ code: '42P01', message: 'fixture table absent' }, 404);
    requests.push({ query: url.search, method, body });
    const select = url.searchParams.get('select');
    if (method === 'GET' && url.searchParams.has('limit')) {
      return verified && select === 'verified' ? reply([]) : reply({ code: '42703', message: 'fixture column absent' }, 400);
    }
    if (method === 'GET') {
      const ids = url.searchParams.get('source_job_id')?.slice(4, -1).split(',').map(id => id.replace(/^"|"$/g, '')) ?? [];
      return reply(rows.filter(r => ids.includes(r.source_job_id)).map(({ id, source, source_job_id }) => ({ id, source, source_job_id })));
    }
    if (method === 'PATCH') {
      Object.assign(rows.find(r => r.id === url.searchParams.get('id')?.slice(3))!, body);
      return reply(null);
    }
    if (method === 'POST') {
      const isUpsert = url.searchParams.has('on_conflict');
      const results = (Array.isArray(body) ? body : [body]).map((item: any) => {
        let row = rows.find(r => r.source === item.source && r.source_job_id === item.source_job_id);
        if (row && !isUpsert) throw new Error('Fixture duplicate insert');
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
  process.argv = [process.execPath, path.join(here, 'ingest.ts'), '--config', path.join(root, 'sources.json'), '--skip-cleanup', '--per-source', '2'];
  process.on('exit', () => fs.writeFileSync(path.join(root, `out-${verified ? 1 : 0}.json`), JSON.stringify({ rows, requests })));
  await import('./ingest');
}

function cli() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-discovered-at-'));
  try {
    fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify([{ id: 'fixture', name: 'Fixture', type: 'lever', target: 'fixture', enabled: true }]));
    const run = (verified: boolean) => {
      const proc = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--fixture-child'], {
        cwd: path.join(here, '..'), encoding: 'utf8', timeout: 30000,
        env: { ...process.env, CM_DA_DIR: root, CM_DA_VERIFIED: verified ? '1' : '0' },
      });
      const out = JSON.parse(fs.readFileSync(path.join(root, `out-${verified ? 1 : 0}.json`), 'utf8'));
      const writes = out.requests.filter((r: any) => r.method !== 'GET');
      const bodies = (r: any) => (Array.isArray(r.body) ? r.body : [r.body]);
      return { proc, out, writes, bodies, row: (id: string) => out.rows.find((r: any) => r.source_job_id === `fixture-${id}`) };
    };
    const expectedPosted = new Date(DATED_MS).toISOString();

    const v = run(true);
    check('[legacy+verified] CLI main exits 0', v.proc.status === 0, (v.proc.stdout + v.proc.stderr).slice(-800));
    const upserts = v.writes.filter((r: any) => r.method === 'POST' && r.query.includes('on_conflict'));
    check('[legacy+verified] no upsert carries discovered_at', upserts.every((r: any) => v.bodies(r).every((b: any) => !('discovered_at' in b))), upserts.map((r: any) => r.query));
    check('[legacy+verified] no write to the existing row carries discovered_at',
      v.writes.every((r: any) => r.method === 'PATCH' ? !('discovered_at' in r.body) : v.bodies(r).every((b: any) => b.source_job_id !== 'fixture-old' || !('discovered_at' in b))), v.writes);
    check('[legacy+verified] existing row keeps its original discovered_at', v.row('old')?.discovered_at === OLD_DISCOVERED, v.row('old'));
    check('[legacy+verified] new row still gets discovered_at on insert', typeof v.row('new')?.discovered_at === 'string' && v.row('new').discovered_at !== OLD_DISCOVERED, v.row('new'));
    check('[legacy+verified] dated posted_at written to both rows', v.row('old')?.posted_at === expectedPosted && v.row('new')?.posted_at === expectedPosted, [v.row('old')?.posted_at, v.row('new')?.posted_at]);

    const n = run(false);
    check('[legacy, no verified column] CLI main exits 0', n.proc.status === 0, (n.proc.stdout + n.proc.stderr).slice(-800));
    const nUpserts = n.writes.filter((r: any) => r.method === 'POST' && r.query.includes('on_conflict=source%2Csource_job_id'));
    check('[legacy, no verified column] fully dated batch still uses the bulk upsert', nUpserts.length === 1, n.writes.map((r: any) => `${r.method} ${r.query}`));
    check('[legacy, no verified column] bulk upsert payload has no discovered_at', nUpserts.every((r: any) => n.bodies(r).every((b: any) => !('discovered_at' in b))));
    check('[legacy, no verified column] dated posted_at written to both rows', n.row('old')?.posted_at === expectedPosted && n.row('new')?.posted_at === expectedPosted);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv.includes('--fixture-child')) {
  child().catch((e) => { console.error(e); process.exitCode = 1; });
} else {
  unit().then(cli).then(() => {
    console.log(`${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
