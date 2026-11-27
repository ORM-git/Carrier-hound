/**
 * Row 39: discovered_at is insert-only. updateExistingJobs (the TS update path) must not send it, so an updated job
 * keeps its first discovered time and does not re-enter the daily digest window (src/lib/cron/dailyDigestCron.ts).
 * Offline: fake supabase client that records the UPDATE payload. No DB, no network.
 * Run: npx tsx scripts/test-discovered-at-insert-only.ts
 */
import { updateExistingJobs } from './ingest';
import { normalizeDate } from './utils/sanitizer';

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

async function main() {
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

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
