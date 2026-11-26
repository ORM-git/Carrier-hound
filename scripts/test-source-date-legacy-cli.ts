/** Offline CLI-entrypoint fixture. All HTTP, including Supabase, is intercepted before ingest.ts loads.
 * Models REST payload semantics, NOT PostgreSQL constraints, defaults or triggers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const knownDate = '2025-10-09T08:53:20.000Z';
const initial = [
  { id: 'known', source: 'lever', source_job_id: 'fixture-known', posted_at: knownDate },
  { id: 'unknown', source: 'lever', source_job_id: 'fixture-unknown', posted_at: null },
];

async function child() {
  const root = process.env.CM_DATE_FIXTURE_DIR!;
  const mode = process.env.CM_DATE_FIXTURE_MODE!;
  const statePath = path.join(root, 'state.json');
  const rows: any[] = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const requests: any[] = [];
  const violations: string[] = [];
  let insertAttempts = 0;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ host: url.host, path: url.pathname, query: url.search, method, body });
    if (url.hostname === 'lever.co' && url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
    if (url.hostname === 'api.lever.co') {
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
      if (url.pathname !== '/v0/postings/fixture') throw new Error('Unexpected ATS path');
      return reply(['known', 'unknown', 'new'].map(id => ({ id, text: 'Engineer', hostedUrl: `https://jobs.lever.co/fixture/${id}`, createdAt: mode === 'dated' ? 1760000000000 : mode === 'repeat' ? 'invalid' : undefined })));
    }
    if (url.hostname !== 'fixture.supabase.co') {
      violations.push(url.hostname);
      throw new Error('Unexpected network destination, request blocked by fixture');
    }
    if (url.pathname === '/rest/v1/rpc/analyze_after_ingest') return reply(null);
    if (url.pathname === '/rest/v1/company_boards' && method === 'PATCH') return reply(null);
    if (url.pathname !== '/rest/v1/jobs') return reply({ code: '42P01', message: 'fixture table absent' }, 404);
    const select = url.searchParams.get('select');
    if (method === 'GET' && url.searchParams.has('limit')) {
      return reply({ code: '42703', message: 'fixture optional column absent' }, 400);
    }
    if (method === 'GET') {
      if (mode === 'lookup-error') return reply({ code: 'XX000', message: 'fixture lookup refused' }, 500);
      const source = url.searchParams.get('source')?.slice(3);
      const ids = url.searchParams.get('source_job_id')?.slice(4, -1).split(',').map(id => id.replace(/^"|"$/g, ''));
      if (!source || !ids || select !== 'id,source,source_job_id') throw new Error('Unexpected identity lookup');
      return reply(rows.filter(r => r.source === source && ids.includes(r.source_job_id)));
    }
    if (method === 'PATCH') {
      const id = url.searchParams.get('id')?.slice(3);
      const row = rows.find(r => r.id === id);
      if (!row) throw new Error('Unexpected update identity');
      Object.assign(row, body);
      return reply(null);
    }
    if (method === 'POST') {
      const incoming = Array.isArray(body) ? body : [body];
      const isUpsert = url.searchParams.has('on_conflict');
      if (!isUpsert) insertAttempts++;
      if (mode === 'fallback' && !isUpsert && insertAttempts === 1) return reply({ code: '23505', message: 'fixture batch conflict' }, 409);
      const results = incoming.map(item => {
        let row = rows.find(r => r.source === item.source && r.source_job_id === item.source_job_id);
        if (row && !isUpsert) throw new Error('Fixture duplicate insert');
        if (row) Object.assign(row, item);
        else { row = { id: `inserted-${item.source_job_id}`, ...item }; rows.push(row); }
        return { id: row.id, source_job_id: row.source_job_id };
      });
      const headers = new Headers(init?.headers);
      return reply(headers.get('accept')?.includes('object') ? results[0] : results, 201);
    }
    throw new Error('Unexpected fixture method');
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.co';
  process.env.SUPABASE_URL = 'https://fixture.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-not-a-real-key';
  process.env.SUPABASE_SERVICE_KEY = 'fixture-not-a-real-key';
  process.argv = [process.execPath, path.join(here, 'ingest.ts'), '--config', path.join(root, 'sources.json'), '--skip-cleanup', '--per-source', '3'];
  process.on('exit', () => {
    fs.writeFileSync(statePath, JSON.stringify(rows));
    fs.writeFileSync(path.join(root, `${mode}.json`), JSON.stringify({ requests, violations }));
  });
  await import('./ingest');
}

function parent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-source-date-cli-'));
  let passed = 0;
  const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${name}`); };
  try {
    fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify([{ id: 'fixture', name: 'Fixture', type: 'lever', target: 'fixture', enabled: true }]));
    const run = (mode: string, reset = false) => {
      if (reset) fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(initial));
      const proc = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--fixture-child'], {
        cwd: path.join(here, '..'), encoding: 'utf8', timeout: 20000,
        env: { ...process.env, CM_DATE_FIXTURE_DIR: root, CM_DATE_FIXTURE_MODE: mode },
      });
      assert.equal(proc.error, undefined, String(proc.error));
      const report = JSON.parse(fs.readFileSync(path.join(root, `${mode}.json`), 'utf8'));
      assert.deepEqual(report.violations, []);
      const rows = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      return { proc, rows, writes: report.requests.filter((r: any) => r.path === '/rest/v1/jobs' && r.method !== 'GET') };
    };
    const first = run('missing', true);
    check('real legacy CLI main completes undated batch', () => assert.equal(first.proc.status, 0, first.proc.stdout + first.proc.stderr));
    check('legacy mixed insert/update never uses conflict upsert', () => assert.ok(first.writes.every((r: any) => !r.query.includes('on_conflict'))));
    check('new legacy undated insert sends explicit null', () => assert.equal(first.writes.find((r: any) => r.method === 'POST').body[0].posted_at, null));
    check('legacy known row preserves source date', () => assert.equal(first.rows.find((r: any) => r.id === 'known').posted_at, knownDate));
    check('legacy existing unknown and new rows stay null', () => assert.ok(first.rows.filter((r: any) => r.id !== 'known').every((r: any) => r.posted_at === null)));
    check('legacy undated PATCH omits posting date', () => { const patches = first.writes.filter((r: any) => r.method === 'PATCH'); assert.equal(patches.length, 2); assert.ok(patches.every((r: any) => !Object.hasOwn(r.body, 'posted_at'))); });
    const repeat = run('repeat');
    check('invalid repeat CLI succeeds without duplicate inserts', () => { assert.equal(repeat.proc.status, 0, repeat.proc.stdout + repeat.proc.stderr); assert.equal(repeat.rows.length, 3); assert.equal(repeat.writes.filter((r: any) => r.method === 'POST').length, 0); });
    check('invalid repeat preserves known date and unknown nulls', () => assert.deepEqual(repeat.rows.map((r: any) => r.posted_at), [knownDate, null, null]));
    const dated = run('dated');
    check('fully dated legacy batch retains conflict upsert', () => { assert.equal(dated.proc.status, 0, dated.proc.stdout + dated.proc.stderr); assert.ok(dated.writes.some((r: any) => r.query.includes('on_conflict=source%2Csource_job_id'))); });
    check('valid source date updates all legacy rows canonically', () => assert.ok(dated.rows.every((r: any) => r.posted_at === knownDate)));
    const fallback = run('fallback', true);
    check('legacy insert batch failure uses single-row fallback', () => { assert.equal(fallback.proc.status, 0, fallback.proc.stdout + fallback.proc.stderr); assert.equal(fallback.writes.filter((r: any) => r.method === 'POST').length, 2); assert.equal(fallback.rows.length, 3); });
    check('fallback keeps undated new row explicit null', () => assert.equal(fallback.rows.find((r: any) => r.source_job_id === 'fixture-new').posted_at, null));
    const failed = run('lookup-error', true);
    check('failed legacy lookup refuses all guessed writes', () => { assert.equal(failed.writes.length, 0); assert.deepEqual(failed.rows, initial); assert.match(failed.proc.stdout + failed.proc.stderr, /jobs identity lookup failed/); });
    console.log(`${passed} legacy CLI checks passed. Payload model only, no database or external requests.`);
  } finally { if (process.env.KEEP_DATE_FIXTURE) console.log(root); else fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv.includes('--fixture-child')) child().catch(err => { console.error(err); process.exitCode = 1; });
else parent();
