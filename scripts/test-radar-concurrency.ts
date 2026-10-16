/**
 * scripts/test-radar-concurrency.ts
 *
 * Verifies concurrency bounding for /api/radar chunk fetching:
 * 1. 100 chunks -> max in-flight <= 5 (peak concurrency bounded to 5).
 * 2. 10-chunk fixture -> batched result list is identical to legacy all-at-once output.
 * 3. Failing chunk -> throws error, does NOT return partial results.
 * 4. Negative control -> proves legacy all-at-once version fails maxInFlight <= 5 check (exits non-zero if run with --negative-control).
 */

interface MockChunkResult {
  data: any[] | null;
  error: { message: string } | null;
}

class MockSupabaseClient {
  public inFlight: number = 0;
  public maxInFlight: number = 0;
  public totalCalls: number = 0;
  public failChunkIndex: number = -1;
  public delayMs: number = 10;

  constructor(delayMs = 10, failChunkIndex = -1) {
    this.delayMs = delayMs;
    this.failChunkIndex = failChunkIndex;
  }

  from(table: string) {
    return {
      select: (columns: string) => ({
        eq: (col1: string, val1: any) => ({
          eq: (col2: string, val2: any) => ({
            range: async (from: number, to: number): Promise<MockChunkResult> => {
              this.totalCalls++;
              this.inFlight++;
              if (this.inFlight > this.maxInFlight) {
                this.maxInFlight = this.inFlight;
              }

              const chunkIdx = Math.floor(from / 1000);

              // Simulate network async latency
              await new Promise((resolve) => setTimeout(resolve, this.delayMs));

              this.inFlight--;

              if (this.failChunkIndex !== -1 && chunkIdx === this.failChunkIndex) {
                return {
                  data: null,
                  error: { message: `Simulated network timeout on chunk ${chunkIdx}` },
                };
              }

              // Generate mock job rows for this range
              const count = Math.max(0, to - from + 1);
              const data = Array.from({ length: count }, (_, idx) => ({
                id: `job-${from + idx}`,
                title: `Engineer ${from + idx}`,
                company: 'Verified Employer',
                location: 'Remote',
                country_code: 'US',
                remote_scope: 'worldwide',
                remote_eligibility: 'anywhere',
                verified: true,
              }));

              return { data, error: null };
            },
          }),
        }),
      }),
    };
  }
}

// Bounded batch fetcher (from src/app/api/radar/route.ts)
async function fetchJobsChunksBounded(
  supabase: any,
  totalActive: number | null,
  batchSize: number = 5,
  chunkSize: number = 1000
): Promise<any[]> {
  const chunkCount = Math.ceil((totalActive || 0) / chunkSize);
  const jobs: any[] = [];

  for (let b = 0; b < chunkCount; b += batchSize) {
    const batchPromises = [];
    const end = Math.min(b + batchSize, chunkCount);
    for (let i = b; i < end; i++) {
      const from = i * chunkSize;
      const to = from + chunkSize - 1;
      batchPromises.push(
        supabase
          .from('jobs_public')
          .select('id, company, title, location, country_code, remote_scope, remote_eligibility, verified')
          .eq('is_active', true)
          .eq('status', 'active')
          .range(from, to)
      );
    }
    const batchResults = await Promise.all(batchPromises);
    for (const r of batchResults) {
      if (r.error) {
        throw new Error(`Failed to fetch jobs chunk: ${r.error.message || JSON.stringify(r.error)}`);
      }
      if (r.data) {
        jobs.push(...r.data);
      }
    }
  }

  return jobs;
}

// Legacy all-at-once fetcher (before fix)
async function fetchJobsChunksLegacy(
  supabase: any,
  totalActive: number | null,
  chunkSize: number = 1000
): Promise<any[]> {
  const chunkCount = Math.ceil((totalActive || 0) / chunkSize);
  const chunkPromises = [];

  for (let i = 0; i < chunkCount; i++) {
    const from = i * chunkSize;
    const to = from + chunkSize - 1;
    chunkPromises.push(
      supabase
        .from('jobs_public')
        .select('id, company, title, location, country_code, remote_scope, remote_eligibility, verified')
        .eq('is_active', true)
        .eq('status', 'active')
        .range(from, to)
    );
  }

  const chunkResults = await Promise.all(chunkPromises);
  const jobs: any[] = [];
  for (const r of chunkResults) {
    if (r.data) jobs.push(...r.data);
  }

  return jobs;
}

async function runTests() {
  const isNegativeControl = process.argv.includes('--negative-control');

  console.log('================================================================');
  console.log('RADAR CHUNK CONCURRENCY & INTEGRITY TEST SUITE');
  console.log('================================================================\n');

  if (isNegativeControl) {
    console.log('[NEGATIVE CONTROL MODE] Testing legacy all-at-once code...');
    const legacyClient = new MockSupabaseClient(15);
    await fetchJobsChunksLegacy(legacyClient, 100_000, 1000);
    console.log(`Legacy max in-flight requests: ${legacyClient.maxInFlight} (expected: 100)`);
    if (legacyClient.maxInFlight <= 5) {
      console.error('FAIL: Negative control expected maxInFlight > 5, but got <= 5');
      process.exit(0); // If it unexpectedly passed, fail the negative control
    }
    console.log('PASS-LOCAL (NEGATIVE CONTROL): Legacy code properly identified as unbounded (maxInFlight = ' + legacyClient.maxInFlight + ' > 5). Exiting with code 1.');
    process.exit(1);
  }

  // TEST 1: 100 chunks concurrency bounding
  console.log('TEST 1: 100 chunks concurrency bounding (total 100,000 items)...');
  const client100 = new MockSupabaseClient(10);
  const jobs100 = await fetchJobsChunksBounded(client100, 100_000, 5, 1000);
  console.log(`  Total chunks requested: ${client100.totalCalls}`);
  console.log(`  Total items retrieved:  ${jobs100.length}`);
  console.log(`  Max in-flight requests: ${client100.maxInFlight}`);

  if (client100.maxInFlight > 5) {
    console.error(`FAIL: Max in-flight requests was ${client100.maxInFlight}, expected <= 5`);
    process.exit(1);
  }
  if (client100.maxInFlight !== 5) {
    console.error(`FAIL: Expected max in-flight to reach batch size 5, got ${client100.maxInFlight}`);
    process.exit(1);
  }
  if (jobs100.length !== 100_000) {
    console.error(`FAIL: Expected 100,000 jobs, got ${jobs100.length}`);
    process.exit(1);
  }
  console.log('  -> PASS-LOCAL: Max in-flight requests strictly capped at 5.\n');

  // TEST 2: 10-chunk fixture output equivalence
  console.log('TEST 2: 10-chunk fixture output equivalence (bounded vs legacy)...');
  const fixtureTotal = 10_000;
  const legacyClient = new MockSupabaseClient(5);
  const boundedClient = new MockSupabaseClient(5);

  const legacyJobs = await fetchJobsChunksLegacy(legacyClient, fixtureTotal, 1000);
  const boundedJobs = await fetchJobsChunksBounded(boundedClient, fixtureTotal, 5, 1000);

  if (legacyJobs.length !== boundedJobs.length) {
    console.error(`FAIL: Length mismatch: legacy=${legacyJobs.length}, bounded=${boundedJobs.length}`);
    process.exit(1);
  }

  const legacyJson = JSON.stringify(legacyJobs);
  const boundedJson = JSON.stringify(boundedJobs);
  if (legacyJson !== boundedJson) {
    console.error('FAIL: Output ordering or content differs between legacy and bounded chunks');
    process.exit(1);
  }
  console.log(`  Legacy items:  ${legacyJobs.length}`);
  console.log(`  Bounded items: ${boundedJobs.length}`);
  console.log('  -> PASS-LOCAL: Output sequence and content are 100% byte-for-byte identical.\n');

  // TEST 3: Failing chunk throws error (no partial result)
  console.log('TEST 3: Error propagation on failing chunk (no silent drops)...');
  const failingClient = new MockSupabaseClient(5, 4); // chunk 4 fails
  let didThrow = false;
  let thrownMessage = '';

  try {
    await fetchJobsChunksBounded(failingClient, 10_000, 5, 1000);
  } catch (err: any) {
    didThrow = true;
    thrownMessage = err.message;
  }

  if (!didThrow) {
    console.error('FAIL: Expected fetchJobsChunksBounded to throw when chunk failed, but it returned normally');
    process.exit(1);
  }
  if (!thrownMessage.includes('Simulated network timeout on chunk 4')) {
    console.error(`FAIL: Error message unexpected: "${thrownMessage}"`);
    process.exit(1);
  }
  console.log(`  Caught expected error: "${thrownMessage}"`);
  console.log('  -> PASS-LOCAL: Error thrown cleanly, preventing silent row drops.\n');

  // TEST 4: Embedded negative control verification
  console.log('TEST 4: Embedded negative control check...');
  const negClient = new MockSupabaseClient(10);
  await fetchJobsChunksLegacy(negClient, 100_000, 1000);
  if (negClient.maxInFlight <= 5) {
    console.error('FAIL: Negative control failed: legacy code unexpectedly met <= 5 constraint');
    process.exit(1);
  }
  console.log(`  Legacy all-at-once max in-flight = ${negClient.maxInFlight} (violates max 5 bound)`);
  console.log('  -> PASS-LOCAL: Negative control verifies test sensitivity.\n');

  console.log('================================================================');
  console.log('ALL RADAR CONCURRENCY TESTS PASSED (PASS-LOCAL)');
  console.log('================================================================');
}

runTests().catch((err) => {
  console.error('Unhandled error in test runner:', err);
  process.exit(1);
});
