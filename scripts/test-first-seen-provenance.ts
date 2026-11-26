/**
 * Checklist #38 audit: first-seen preservation and source-date provenance in the TS ingestion path.
 * Offline only: no DB, no network. The fake jobs table models write PAYLOAD semantics only
 * (INSERT fills column defaults; UPDATE / ON CONFLICT DO UPDATE touch only the columns sent).
 * It does NOT run any trigger. Every check tagged "[payload model]" is
 * builder/payload model only - the BEFORE UPDATE trigger jobs_touch_last_seen is not executed here and may override payload last_seen_at in the real database (20261116d:143-166).
 * Whether 20261116d is applied in production is UNKNOWN. Mock results here are NOT proof of
 * production database behavior. Proven code evidence is limited to the source-static check (1):
 * no TS ingest payload names first_seen_at, so it comes from the DB default on insert.
 *
 * Run: npx tsx scripts/test-first-seen-provenance.ts
 *
 * Missing/invalid source dates must remain null; no source posting time is synthesized.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { recordInsertFailure, updateExistingJobs } from './ingest';
import { normalizeDate } from './utils/sanitizer';
import { BambooHRAdapter } from './adapters/bamboohr';
import { JoinAdapter } from './adapters/join';
import { LeverAdapter } from './adapters/lever';
import { RemoteOKAdapter } from './adapters/remoteok';
import { ArbeitnowAdapter } from './adapters/arbeitnow';
import { lastRequestByDomain } from './utils/polite-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}

// [payload model] Column defaults on public.jobs (supabase/schema.sql: first_seen_at/last_seen_at/posted_at default now()).
const T1 = '2026-11-01T00:00:00.000Z';
function fakeJobsTable() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    insert(id: string, payload: Record<string, unknown>, now: string) {
      rows.set(id, { first_seen_at: now, last_seen_at: now, posted_at: now, created_at: now, ...payload, id });
    },
    // UPDATE ... SET <only the payload columns> (the payload shape PostgREST upsert ON CONFLICT DO UPDATE sends).
    // No BEFORE UPDATE trigger runs here: the real jobs_touch_last_seen may replace NEW.last_seen_at.
    merge(id: string, payload: Record<string, unknown>) {
      rows.set(id, { ...rows.get(id), ...payload });
    },
    client(): any {
      return {
        from: (table: string) =>
          table === 'jobs'
            ? { update: (payload: Record<string, unknown>) => ({ eq: async (_c: string, id: string) => { this.merge(id, payload); return { error: null }; } }) }
            : { upsert: async () => ({ error: null }) },
      };
    },
  };
}
const stats = (): any => ({ sourceName: 'fixture', inserted: 0, updated: 0, failed: 0, duplicateSkipped: 0 });

async function main() {
  const ingestSrc = fs.readFileSync(path.join(__dirname, 'ingest.ts'), 'utf8');

  // 1. PROVEN CODE EVIDENCE (source-static, grep-verified): no TS ingest payload (insert, legacy upsert, or update) ever names first_seen_at, so the DB default
  //    sets it on INSERT and no UPDATE / ON CONFLICT DO UPDATE can touch it.
  check('ingest.ts never writes first_seen_at (insert relies on DB default now())', !/first_seen_at/.test(ingestSrc));

  // 2. [payload model] First upsert sets first_seen_at; under the payload model a repeat run preserves the
  //    ORIGINAL value and the payload advances last_seen_at.
  //    builder/payload model only - the BEFORE UPDATE trigger jobs_touch_last_seen is not executed here and may override payload last_seen_at in the real database (20261116d:143-166).
  //    (Its branch 1 keeps a caller-supplied distinct last_seen_at; the pre-20261116d legacy trigger
  //    sets now() on every update. Real outcome is OPEN VERIFICATION (b) in the PR body.)
  const db = fakeJobsTable();
  db.insert('job-1', { source: 'greenhouse', source_job_id: 'gh-1', title: 'Engineer', posted_at: '2026-10-30T09:00:00.000Z' }, T1);
  check('[payload model] first insert sets first_seen_at from the default', db.rows.get('job-1')!.first_seen_at === T1);
  const repeatItem = { source: 'greenhouse', source_job_id: 'gh-1', title: 'Engineer II', posted_at: '2026-10-30T09:00:00.000Z', last_seen_at: T1 };
  const s = stats();
  const err = await updateExistingJobs(db.client(), [{ id: 'job-1', item: repeatItem, original: {} as any }], s, false, 0);
  const after = db.rows.get('job-1')!;
  check('repeat run update call succeeds (builder/payload level)', err === null && s.updated === 1, { err, s });
  check('[payload model] repeat run preserves the ORIGINAL first_seen_at', after.first_seen_at === T1, after.first_seen_at);
  check('[payload model] repeat-run payload advances last_seen_at past the first run (trigger not executed)', String(after.last_seen_at) > T1, after.last_seen_at);
  check('[payload model] repeat run applies the new source fields', after.title === 'Engineer II');

  // 3. [payload model] builder/payload model only - the BEFORE UPDATE trigger jobs_touch_last_seen is not executed here and may override payload last_seen_at in the real database (20261116d:143-166).
  //    Legacy schema (no source_id) upserts ON CONFLICT (source, source_job_id): the conflict row only
  //    receives the payload columns, which never include first_seen_at (claim 1).
  db.merge('job-1', { ...repeatItem, title: 'Engineer III', last_seen_at: new Date().toISOString() });
  check('[payload model] source-identity conflict (legacy upsert) keeps the original first_seen_at', db.rows.get('job-1')!.first_seen_at === T1);

  // 4. [payload model] for the row-state assertion: builder/payload model only - the BEFORE UPDATE trigger jobs_touch_last_seen is not executed here and may override payload last_seen_at in the real database (20261116d:143-166).
  //    The duplicate-skip counting is real code (recordInsertFailure). Exact Apply-URL conflict (23505 on jobs_apply_url_unique) is skipped with no write: recordInsertFailure
  //    takes no client, so the row that owns the URL keeps every timestamp.
  const owner = { ...db.rows.get('job-1')! };
  const dup = stats();
  recordInsertFailure(dup, { source_job_id: 'gh-2', apply_url: 'https://x/apply' }, { code: '23505', message: 'duplicate key value violates unique constraint "jobs_apply_url_unique"' });
  check('apply-URL conflict is a duplicate skip, not a failure', dup.duplicateSkipped === 1 && dup.failed === 0, dup);
  check('[payload model] apply-URL conflict leaves the owning row (and its first_seen_at) untouched', JSON.stringify(db.rows.get('job-1')) === JSON.stringify(owner));

  // 5. Timezone treatment of source dates (normalizeDate is the shared adapter parser).
  check('offset-qualified date converts to UTC', normalizeDate('2026-11-20T10:00:00+05:30') === '2026-11-20T04:30:00.000Z');
  check('date-only string is UTC midnight (ECMAScript rule)', normalizeDate('2026-11-20') === '2026-11-20T00:00:00.000Z');
  // ASSUMPTION, not a guarantee: an offset-less date-time is read in the RUNNER's local zone (ECMAScript),
  // so it is UTC only because CI runners run with TZ=UTC. The same input shifts under another TZ.
  const prevTz = process.env.TZ;
  process.env.TZ = 'UTC';
  const naiveUtc = normalizeDate('2026-11-20T10:00:00');
  process.env.TZ = 'Asia/Kolkata';
  const naiveIst = normalizeDate('2026-11-20T10:00:00');
  if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  check('naive date-time under TZ=UTC is read as UTC', naiveUtc === '2026-11-20T10:00:00.000Z', naiveUtc);
  check('naive date-time is runner-TZ dependent (TZ=Asia/Kolkata shifts it -5:30)', naiveIst === '2026-11-20T04:30:00.000Z', naiveIst);

  // 6. Regression for #761 parity: unknown source posting dates stay unknown, never the current run time.
  check('numeric epoch zero remains a real date', normalizeDate(0) === '1970-01-01T00:00:00.000Z');
  check('blank source date stays null', normalizeDate('   ') === null);
  check('invalid Date object stays null', normalizeDate(new Date(NaN)) === null);
  check('missing source date stays null (#761)', normalizeDate(null) === null, normalizeDate(null));
  check('invalid source date stays null (#761)', normalizeDate('not a date') === null, normalizeDate('not a date'));
  check('ingest.ts does not stamp ingestion time into posted_at (#761)', !/posted_at:\s*j\.posted_at\s*\|\|\s*new Date\(\)/.test(ingestSrc));

  check('ingest payload normalizes the source value (explicit null bypasses DB posting-date defaults)', /posted_at:\s*normalizeDate\(j\.posted_at\)/.test(ingestSrc));

  // 7. Real adapter entry points, with every HTTP request intercepted. No production requests or writes.
  const originalFetch = globalThis.fetch;
  const cases: Array<[string, any, (value: any) => any, string]> = [
    ['bamboohr', new BambooHRAdapter(), v => [{id: 1, title: 'Engineer', createdDate: v}], 'createdDate'],
    ['join', new JoinAdapter(), v => [{id: 1, title: 'Engineer', publishedAt: v}], 'publishedAt'],
    ['lever', new LeverAdapter(), v => [{id: '1', text: 'Engineer', hostedUrl: 'https://jobs.lever.co/fixture/1', createdAt: v}], 'createdAt'],
    ['remoteok', new RemoteOKAdapter(), v => [{id: 1, position: 'Engineer', company: 'Fixture', url: 'https://example.test/1', date: v}], 'date'],
    ['arbeitnow', new ArbeitnowAdapter(), v => ({data: [{title: 'Engineer', company_name: 'Fixture', url: 'https://example.test/1', created_at: v}]}), 'created_at'],
  ];
  try {
    for (const [type, adapter, fixture] of cases) {
      for (const mode of ['missing', 'invalid', 'valid'] as const) {
        const numeric = type === 'lever' || type === 'arbeitnow';
        const value = mode === 'missing' ? undefined : mode === 'invalid' ? 'not a date' : numeric ? (type === 'arbeitnow' ? 1760000000 : 1760000000000) : '2025-10-09T08:53:20Z';
        const payload = fixture(value);
        globalThis.fetch = async (url: any) => String(url).includes('robots.txt')
          ? new Response('User-agent: *\nAllow: /', {status: 200})
          : new Response(JSON.stringify(payload), {status: 200, headers: {'Content-Type': 'application/json'}});
        lastRequestByDomain.clear();
        const rows = await adapter.fetchJobs({id: 'fixture', name: 'Fixture', type, target: type === 'remoteok' || type === 'arbeitnow' ? 'https://fixture.example.test/api' : 'fixture', enabled: true});
        const expected = mode === 'valid' ? '2025-10-09T08:53:20.000Z' : null;
        check(`${type} ${mode} source date has honest posting timestamp`, rows.length === 1 && rows[0].posted_at === expected, rows[0]?.posted_at);
      }
    }
  } finally { globalThis.fetch = originalFetch; lastRequestByDomain.clear(); }
  // Real updateExistingJobs entry point preserves old source knowledge when a refresh is undated.
  await updateExistingJobs(db.client(), [{id: 'job-1', item: {posted_at: normalizeDate(null)}, original: {} as any}], stats(), false, 0);
  check('[payload model] undated repeat update preserves previous valid posting date', db.rows.get('job-1')!.posted_at === '2026-10-30T09:00:00.000Z');
  check('[payload model] undated repeat update preserves first_seen_at', db.rows.get('job-1')!.first_seen_at === T1);

  db.insert('undated', {posted_at: normalizeDate(null)}, T1);
  check('[payload model] new undated insert explicitly bypasses posted_at default', db.rows.get('undated')!.posted_at === null);
  for (const input of [null, undefined, 'not a date', '']) {
    await updateExistingJobs(db.client(), [{id: 'undated', item: {posted_at: input}, original: {} as any}, {id: 'job-1', item: {posted_at: input}, original: {} as any}], stats(), false, 0);
    check(`[payload model] unknown refresh ${String(input)} preserves known date and undated null`, db.rows.get('job-1')!.posted_at === '2026-10-30T09:00:00.000Z' && db.rows.get('undated')!.posted_at === null);
  }
  await updateExistingJobs(db.client(), [{id: 'job-1', item: {posted_at: '2026-11-02T10:00:00+05:30'}, original: {} as any}], stats(), false, 0);
  check('[payload model] valid refreshed source date updates canonically', db.rows.get('job-1')!.posted_at === '2026-11-02T04:30:00.000Z');
  check('undated legacy batches bypass conflict upsert for separate insert/update date semantics', /const useLegacyUpsert = !hasSourceIdColumn && jobsPayload\.every\(item => item\.posted_at !== null\)/.test(ingestSrc) && /if \(useLegacyUpsert && !upsertErr\)/.test(ingestSrc));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
