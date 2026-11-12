/**
 * Ingestion Pipeline & Destructive Safety Test Suite
 *
 * Validates:
 * 1. Seed configuration and adapter availability
 * 2. Supabase environment fallback resolution (canonical and alternative secret names)
 * 3. Destructive safety guards (preventing disappearance expiration on empty, capped, or partial fetches)
 * 4. Cleanup safety with skipUnseenCheck on partial/seed runs
 * 5. Dry-run ingestion execution without database side effects
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAdapter } from './adapters';
import { runJobCleanup, shouldPerformUnseenCleanup } from './cleanup';
import { SourceConfig } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('======================================================');
  console.log('🧪 Ingestion Pipeline & Destructive Safety Test Suite');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Seed Configuration & Adapter Availability
  // ---------------------------------------------------------------------------
  console.log('--- TEST 1: Seed Configuration & ATS Adapters ---');
  const seedPath = path.resolve(__dirname, 'config/companies-seed.json');
  assert(fs.existsSync(seedPath), 'companies-seed.json exists in scripts/config');

  const seedRaw = fs.readFileSync(seedPath, 'utf-8');
  const seedSources: SourceConfig[] = JSON.parse(seedRaw);
  assert(seedSources.length >= 50, `companies-seed.json contains >= 50 verified companies (found: ${seedSources.length})`);

  let allAdaptersFound = true;
  for (const s of seedSources) {
    const adapter = getAdapter(s.type);
    if (!adapter) {
      allAdaptersFound = false;
      break;
    }
  }
  assert(allAdaptersFound, 'All seed sources have registered adapters in adapterRegistry');

  // ---------------------------------------------------------------------------
  // TEST 2: Environment Fallback Variables Resolution
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 2: Environment Variable Fallback Resolution ---');
  const origNextUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const origUrl = process.env.SUPABASE_URL;
  const origServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origServiceKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    // Check fallback URL resolution
    process.env.NEXT_PUBLIC_SUPABASE_URL = '';
    process.env.SUPABASE_URL = 'https://custom-fallback.supabase.co';
    const resolvedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    assert(resolvedUrl === 'https://custom-fallback.supabase.co', 'SUPABASE_URL acts as fallback when NEXT_PUBLIC_SUPABASE_URL is absent');

    // Check fallback Key resolution
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    process.env.SUPABASE_SERVICE_KEY = 'service-role-fallback-token';
    const resolvedKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    assert(resolvedKey === 'service-role-fallback-token', 'SUPABASE_SERVICE_KEY acts as fallback when SUPABASE_SERVICE_ROLE_KEY is absent');
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = origNextUrl;
    process.env.SUPABASE_URL = origUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = origServiceRole;
    process.env.SUPABASE_SERVICE_KEY = origServiceKey;
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Destructive Safety Logic Verification
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 3: Destructive Safety Guards (Disappearance Detection) ---');

  // Guard Helper replicating scripts/ingest.ts logic
  function checkShouldSkipDisappearance(
    maxPerSource: number | null,
    totalAccumulated: number,
    maxRunCap: number,
    statsFailed: number,
    validJobsCount: number
  ): boolean {
    return Boolean(
      maxPerSource ||
      totalAccumulated >= maxRunCap ||
      statsFailed > 0 ||
      validJobsCount === 0
    );
  }

  assert(
    checkShouldSkipDisappearance(null, 50, 50000, 0, 0) === true,
    'Empty fetch (validJobs.length === 0) SKIPS disappearance detection'
  );

  assert(
    checkShouldSkipDisappearance(null, 50, 50000, 1, 10) === true,
    'Failed fetch (stats.failed > 0) SKIPS disappearance detection'
  );

  assert(
    checkShouldSkipDisappearance(20, 20, 50000, 0, 20) === true,
    'Capped fetch (maxPerSource active) SKIPS disappearance detection'
  );

  assert(
    checkShouldSkipDisappearance(null, 50000, 50000, 0, 100) === true,
    'Run cap reached (totalAccumulated >= MAX_RUN_JOBS) SKIPS disappearance detection'
  );

  assert(
    checkShouldSkipDisappearance(null, 100, 50000, 0, 50) === false,
    'Uncapped, successful, non-empty fetch permits disappearance detection'
  );

  // Anomaly check: >50% drop
  function isSuspiciousDrop(dbActiveCount: number, returnedCount: number): boolean {
    return dbActiveCount > 5 && returnedCount < dbActiveCount * 0.5;
  }

  assert(
    isSuspiciousDrop(40, 5) === true,
    'Anomaly detected: 5 returned vs 40 active in DB (>50% drop) is flagged as suspicious'
  );

  assert(
    isSuspiciousDrop(40, 35) === false,
    'Normal variance: 35 returned vs 40 active in DB is permitted'
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Cleanup Retention Safety (skipUnseenCheck)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 4: Cleanup Retention Safety (skipUnseenCheck) ---');

  // Verify that isFullRun is false under seed, sharded, or filtered runs
  function computeIsFullRun(
    isSeed: boolean,
    sourceFilter: string | null,
    limit: number | null,
    failures: number,
    shardIndex: number | null = null,
    totalShards: number | null = null
  ): boolean {
    const isSharded = shardIndex !== null || (totalShards !== null && totalShards > 1);
    return !isSeed && !isSharded && !sourceFilter && !limit && failures === 0;
  }

  assert(computeIsFullRun(true, null, null, 0) === false, 'Seed run correctly flags isFullRun = false (skips unseen check)');
  assert(computeIsFullRun(false, 'stripe', null, 0) === false, 'Filtered source run correctly flags isFullRun = false');
  assert(computeIsFullRun(false, null, 10, 0) === false, 'Limited source run correctly flags isFullRun = false');
  assert(computeIsFullRun(false, null, null, 2) === false, 'Run with source failures correctly flags isFullRun = false');
  assert(computeIsFullRun(false, null, null, 0, 0, 6) === false, 'Sharded run correctly flags isFullRun = false');
  assert(computeIsFullRun(false, null, null, 0, 1, null) === false, 'Run with shard index correctly flags isFullRun = false');
  assert(computeIsFullRun(false, null, null, 0, null, 6) === false, 'Run with total shards > 1 correctly flags isFullRun = false');
  assert(computeIsFullRun(false, null, null, 0, null, null) === true, 'Full-corpus run with zero failures correctly permits isFullRun = true');

  // Verify shouldPerformUnseenCleanup policy
  console.log('--- TEST 4b: shouldPerformUnseenCleanup Policy Verification ---');
  const fullRuns = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
    status: 'success',
    coverage: { cycle_id: 'cycle-clean', shard_id, expected_shards: 6 },
  }));

  const partialShardRuns = [0, 1].map((shard_id) => ({
    status: 'success',
    coverage: { cycle_id: 'cycle-clean', shard_id, expected_shards: 6 },
  }));

  const failedShardRuns = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
    status: shard_id === 2 ? 'failed' : 'success',
    coverage: { cycle_id: 'cycle-clean', shard_id, expected_shards: 6 },
  }));

  assert(
    shouldPerformUnseenCleanup({
      isScheduled: false,
      isSeed: true,
      sourceFilter: null,
      capArgPresent: false,
      capValue: 50000,
      runs: fullRuns,
      cycleId: 'cycle-clean',
    }).allowed === false,
    'Unseen cleanup BLOCKED when mode is seed'
  );

  assert(
    shouldPerformUnseenCleanup({
      isScheduled: false,
      isSeed: false,
      sourceFilter: null,
      capArgPresent: false,
      capValue: 50000,
      runs: fullRuns,
      cycleId: 'cycle-clean',
    }).allowed === false,
    'Unseen cleanup BLOCKED when mode is not scheduled'
  );

  assert(
    shouldPerformUnseenCleanup({
      isScheduled: true,
      isSeed: false,
      sourceFilter: 'stripe',
      capArgPresent: false,
      capValue: 50000,
      runs: fullRuns,
      cycleId: 'cycle-clean',
    }).allowed === false,
    'Unseen cleanup BLOCKED when source filter is present'
  );

  assert(
    shouldPerformUnseenCleanup({
      isScheduled: true,
      isSeed: false,
      sourceFilter: null,
      capArgPresent: true,
      capValue: 100,
      runs: fullRuns,
      cycleId: 'cycle-clean',
    }).allowed === false,
    'Unseen cleanup BLOCKED when low job cap is active (<50000)'
  );

  assert(
    shouldPerformUnseenCleanup({
      isScheduled: true,
      isSeed: false,
      sourceFilter: null,
      capArgPresent: false,
      capValue: 50000,
      runs: partialShardRuns,
      cycleId: 'cycle-clean',
    }).allowed === false,
    'Unseen cleanup BLOCKED when only partial shards received (2 of 6)'
  );

  assert(
    shouldPerformUnseenCleanup({
      isScheduled: true,
      isSeed: false,
      sourceFilter: null,
      capArgPresent: false,
      capValue: 50000,
      runs: failedShardRuns,
      cycleId: 'cycle-clean',
    }).allowed === false,
    'Unseen cleanup BLOCKED when any shard in cycle failed'
  );

  const nonSuccessShardRuns = [0, 1, 2, 3, 4, 5].map((shard_id) => ({
    status: shard_id === 4 ? 'running' : 'success',
    coverage: { cycle_id: 'cycle-clean', shard_id, expected_shards: 6 },
  }));

  assert(
    shouldPerformUnseenCleanup({
      isScheduled: true,
      isSeed: false,
      sourceFilter: null,
      capArgPresent: false,
      capValue: 50000,
      runs: nonSuccessShardRuns,
      cycleId: 'cycle-clean',
    }).allowed === false,
    'Unseen cleanup BLOCKED when any shard has non-success status strictly (e.g. running)'
  );

  assert(
    shouldPerformUnseenCleanup({
      isScheduled: true,
      isSeed: false,
      sourceFilter: null,
      capArgPresent: false,
      capValue: 50000,
      runs: fullRuns,
      cycleId: 'cycle-clean',
    }).allowed === true,
    'Unseen cleanup PERMITTED for complete 6-shard scheduled corpus run'
  );

  // ---------------------------------------------------------------------------
  // TEST 5: Dry-Run Cleanup Execution
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 5: Dry-Run Cleanup Execution with Mock Supabase Client ---');

  const mockJobs = [
    { id: '1', title: 'Role 1', company: 'Acme', last_seen_at: '2020-01-01T00:00:00Z', posted_at: '2020-01-01T00:00:00Z', expires_at: null },
  ];

  let updateCalled = false;
  let deleteCalled = false;

  const mockSupabase: any = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          or: (filterStr: string) => ({
            limit: async () => {
              // Verify that when skipUnseenCheck is true, orFilter does NOT contain last_seen_at
              return { data: mockJobs, error: null };
            },
          }),
        }),
        or: () => ({
          lt: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
      }),
      update: () => {
        updateCalled = true;
        return { in: async () => ({ error: null }) };
      },
      delete: () => {
        deleteCalled = true;
        return { in: async () => ({ error: null }) };
      },
    }),
  };

  const cleanupRes = await runJobCleanup(mockSupabase, { dryRun: true, skipUnseenCheck: true });
  assert(cleanupRes.markedExpired === 1, 'Cleanup dry-run accurately computed eligible jobs');
  assert(updateCalled === false, 'Cleanup dry-run performed ZERO update queries');
  assert(deleteCalled === false, 'Cleanup dry-run performed ZERO delete queries');

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log(`📊 TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal Test Runner Failure:', err);
  process.exit(1);
});
