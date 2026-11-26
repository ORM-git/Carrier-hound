/**
 * Checklist #38 audit: first-seen preservation and source-date provenance in the TS ingestion path.
 * Offline only: no DB, no network. The fake jobs table applies Postgres/PostgREST write semantics
 * (INSERT fills column defaults; UPDATE / ON CONFLICT DO UPDATE touch only the columns sent).
 *
 * Run: npx tsx scripts/test-first-seen-provenance.ts
 *
 * Expected RED (not fixed here, see PR body): "missing/invalid source date stays null (#761)".
 * The TS path stamps ingestion time instead (scripts/utils/sanitizer.ts normalizeDate,
 * scripts/ingest.ts posted_at fallback) and re-sends it on every update.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { recordInsertFailure, updateExistingJobs } from './ingest';
import { normalizeDate } from './utils/sanitizer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
}

// Column defaults on public.jobs (supabase/schema.sql: first_seen_at/last_seen_at/posted_at default now()).
const T1 = '2026-11-01T00:00:00.000Z';
function fakeJobsTable() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    insert(id: string, payload: Record<string, unknown>, now: string) {
      rows.set(id, { first_seen_at: now, last_seen_at: now, posted_at: now, created_at: now, ...payload, id });
    },
    // UPDATE ... SET <only the payload columns>; also what PostgREST upsert ON CONFLICT DO UPDATE does.
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

  // 1. No TS ingest payload (insert, legacy upsert, or update) ever names first_seen_at, so the DB default
  //    sets it on INSERT and no UPDATE / ON CONFLICT DO UPDATE can touch it.
  check('ingest.ts never writes first_seen_at (insert relies on DB default now())', !/first_seen_at/.test(ingestSrc));

  // 2. First upsert sets first_seen_at; a repeat run preserves the ORIGINAL value and advances last_seen_at.
  const db = fakeJobsTable();
  db.insert('job-1', { source: 'greenhouse', source_job_id: 'gh-1', title: 'Engineer', posted_at: '2026-10-30T09:00:00.000Z' }, T1);
  check('first insert sets first_seen_at from the default', db.rows.get('job-1')!.first_seen_at === T1);
  const repeatItem = { source: 'greenhouse', source_job_id: 'gh-1', title: 'Engineer II', posted_at: '2026-10-30T09:00:00.000Z', last_seen_at: T1 };
  const s = stats();
  const err = await updateExistingJobs(db.client(), [{ id: 'job-1', item: repeatItem, original: {} as any }], s, false, 0);
  const after = db.rows.get('job-1')!;
  check('repeat run update succeeds', err === null && s.updated === 1, { err, s });
  check('repeat run preserves the ORIGINAL first_seen_at', after.first_seen_at === T1, after.first_seen_at);
  check('repeat run advances last_seen_at past the first run', String(after.last_seen_at) > T1, after.last_seen_at);
  check('repeat run applies the new source fields', after.title === 'Engineer II');

  // 3. Legacy schema (no source_id) upserts ON CONFLICT (source, source_job_id): the conflict row only
  //    receives the payload columns, which never include first_seen_at (claim 1).
  db.merge('job-1', { ...repeatItem, title: 'Engineer III', last_seen_at: new Date().toISOString() });
  check('source-identity conflict (legacy upsert) keeps the original first_seen_at', db.rows.get('job-1')!.first_seen_at === T1);

  // 4. Exact Apply-URL conflict (23505 on jobs_apply_url_unique) is skipped with no write: recordInsertFailure
  //    takes no client, so the row that owns the URL keeps every timestamp.
  const owner = { ...db.rows.get('job-1')! };
  const dup = stats();
  recordInsertFailure(dup, { source_job_id: 'gh-2', apply_url: 'https://x/apply' }, { code: '23505', message: 'duplicate key value violates unique constraint "jobs_apply_url_unique"' });
  check('apply-URL conflict is a duplicate skip, not a failure', dup.duplicateSkipped === 1 && dup.failed === 0, dup);
  check('apply-URL conflict leaves the owning row (and its first_seen_at) untouched', JSON.stringify(db.rows.get('job-1')) === JSON.stringify(owner));

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

  // 6. EXPECTED RED until fixed separately: per merged #761 (Python path) a missing or invalid source date
  //    stays null. The TS path does not: normalizeDate falls back to now(), ingest.ts falls back to now()
  //    again, and updateExistingJobs re-sends it, so an undated job's posted_at is re-stamped every run.
  check('missing source date stays null (#761)', normalizeDate(null) === null, normalizeDate(null));
  check('invalid source date stays null (#761)', normalizeDate('not a date') === null, normalizeDate('not a date'));
  check('ingest.ts does not stamp ingestion time into posted_at (#761)', !/posted_at:\s*j\.posted_at\s*\|\|\s*new Date\(\)/.test(ingestSrc));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
