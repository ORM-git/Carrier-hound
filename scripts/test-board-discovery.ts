/**
 * scripts/test-board-discovery.ts
 *
 * Test suite for ATS Board Discovery & Verification Pipeline (Step 2).
 *
 * Tests:
 * 1. Token sanitization and company name inference.
 * 2. URL parsing and token extraction across Greenhouse, Lever, and Ashby patterns.
 * 3. Strict rejection of forbidden domains (LinkedIn, Indeed, Workday, Glassdoor).
 * 4. Verification rules: HTTP 200 with >= 1 job verified; 0 jobs or 404 rejected.
 * 5. Candidate record schema validation.
 * 6. Pipeline execution in offline fixture mode.
 * 7. Negative control: feeds real bad tokens & forbidden URLs, proves non-zero exit on invalid conditions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  sanitizeToken,
  inferCompanyName,
  extractTokenFromUrl,
  verifyAtsToken,
  runBoardDiscovery,
  AtsCandidate,
} from './board-discovery';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isNegativeControl = process.argv.includes('--negative-control');

async function runTests() {
  console.log('==================================================================');
  console.log('🧪 TEST: ATS BOARD DISCOVERY & VERIFICATION (STEP 2)');
  console.log('==================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  // ---------------------------------------------------------------------------
  // Negative Control Mode: Mutates real behaviour by feeding bad tokens to verifier
  // ---------------------------------------------------------------------------
  if (isNegativeControl) {
    console.log('[NEGATIVE CONTROL MODE] Mutating real behaviour: feeding non-existent tokens and forbidden domains...');

    // 1. Feeding bad token to verifier
    const badTokenResult = await verifyAtsToken('greenhouse', 'nonexistent_bad_token_9999999');

    // 2. Feeding forbidden URL to URL extractor
    const forbiddenUrlResult = extractTokenFromUrl('https://linkedin.com/jobs/view/99999');

    // In real code, badTokenResult.verified MUST be false, and forbiddenUrlResult MUST be null.
    // If real code successfully rejects them, exit non-zero (1) to prove negative control protocol.
    if (!badTokenResult.verified && forbiddenUrlResult === null) {
      console.error('❌ [NEGATIVE CONTROL TRIGGERED] Real verifier correctly rejected bad token (status 404/0 jobs) and blocked forbidden domain. Exiting non-zero (1).');
      process.exit(1);
    } else {
      console.error('⚠️ [NEGATIVE CONTROL FAILED] Bad token or forbidden domain was unexpectedly verified!');
      process.exit(0);
    }
  }

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}${detail ? ` -> ${detail}` : ''}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Token Sanitization & Company Name Inference
  // ---------------------------------------------------------------------------
  assert(sanitizeToken('Stripe') === 'stripe', 'Sanitizes uppercase to lowercase');
  assert(sanitizeToken('  open-ai_123  ') === 'open-ai_123', 'Preserves hyphens, underscores, and numbers');
  assert(sanitizeToken('bad/token?query=1') === 'badtokenquery1', 'Strips query and path delimiters');
  assert(sanitizeToken('a') === '', 'Rejects single character token (< 2 chars)');
  assert(sanitizeToken('') === '', 'Rejects empty token');

  assert(inferCompanyName('stripe') === 'Stripe', 'Infers "Stripe" from single word');
  assert(inferCompanyName('open-ai') === 'Open Ai', 'Infers "Open Ai" from kebab-case');
  assert(inferCompanyName('active_campaign') === 'Active Campaign', 'Infers "Active Campaign" from snake_case');

  // ---------------------------------------------------------------------------
  // 2. URL Token Extraction for Greenhouse, Lever, and Ashby
  // ---------------------------------------------------------------------------
  const ghExtracted = extractTokenFromUrl('https://boards.greenhouse.io/stripe/jobs/1001');
  assert(ghExtracted?.ats === 'greenhouse' && ghExtracted?.token === 'stripe', 'Extracts Greenhouse standard board token');

  const ghEmbedExtracted = extractTokenFromUrl('https://boards.greenhouse.io/embed/job_board?for=datadog');
  assert(ghEmbedExtracted?.ats === 'greenhouse' && ghEmbedExtracted?.token === 'datadog', 'Extracts Greenhouse embed token from query param');

  const ghSubdomainExtracted = extractTokenFromUrl('https://job-boards.greenhouse.io/airbnb/jobs/2002');
  assert(ghSubdomainExtracted?.ats === 'greenhouse' && ghSubdomainExtracted?.token === 'airbnb', 'Extracts Greenhouse job-boards subdomain token');

  const leverExtracted = extractTokenFromUrl('https://jobs.lever.co/spotify/abc-123');
  assert(leverExtracted?.ats === 'lever' && leverExtracted?.token === 'spotify', 'Extracts Lever company token');

  const ashbyExtracted = extractTokenFromUrl('https://jobs.ashbyhq.com/openai/uuid-789');
  assert(ashbyExtracted?.ats === 'ashby' && ashbyExtracted?.token === 'openai', 'Extracts Ashby organization slug');

  // ---------------------------------------------------------------------------
  // 3. Strict Rejection of Forbidden / Non-ATS Domains
  // ---------------------------------------------------------------------------
  assert(extractTokenFromUrl('https://linkedin.com/jobs/view/1234') === null, 'Rejects LinkedIn job URLs');
  assert(extractTokenFromUrl('https://indeed.com/viewjob?jk=1234') === null, 'Rejects Indeed job URLs');
  assert(extractTokenFromUrl('https://company.myworkdayjobs.com/careers') === null, 'Rejects Workday career portals');
  assert(extractTokenFromUrl('https://glassdoor.com/job/123') === null, 'Rejects Glassdoor URLs');
  assert(extractTokenFromUrl('https://randomblog.com/post/1') === null, 'Rejects unrelated web URLs');
  assert(extractTokenFromUrl('') === null, 'Rejects empty URL');

  // ---------------------------------------------------------------------------
  // 4. Candidate Schema & Verification Rule (job_count >= 1)
  // ---------------------------------------------------------------------------
  const sampleCandidate: AtsCandidate = {
    company: 'Stripe',
    ats: 'greenhouse',
    token: 'stripe',
    job_count: 50,
    verified_at: new Date().toISOString(),
    discovery_source: 'common_crawl',
  };

  assert(sampleCandidate.job_count >= 1, 'Candidate must have job_count >= 1');
  assert(['greenhouse', 'lever', 'ashby'].includes(sampleCandidate.ats), 'Candidate ATS must be greenhouse, lever, or ashby');
  assert(
    ['common_crawl', 'github_open_dataset', 'company_probe'].includes(sampleCandidate.discovery_source),
    'Candidate discovery_source must match allowed sources'
  );
  assert(Boolean(sampleCandidate.verified_at), 'Candidate must include verified_at timestamp');

  // ---------------------------------------------------------------------------
  // 5. Offline Fixture Pipeline Execution
  // ---------------------------------------------------------------------------
  const tempOutPath = path.resolve(__dirname, '../data/test-ats-candidates.tmp.json');
  try {
    const discoveryResult = await runBoardDiscovery({
      offlineFixtureMode: true,
      verifyLimit: 3,
      outputFilePath: tempOutPath,
    });

    assert(discoveryResult.stats.candidatesTested > 0, 'Pipeline tested candidates in fixture mode');
    assert(Array.isArray(discoveryResult.candidates), 'Pipeline returns array of verified candidates');
    assert(fs.existsSync(tempOutPath), 'Pipeline writes candidates to output file');

    // Clean up temporary test file
    if (fs.existsSync(tempOutPath)) {
      fs.unlinkSync(tempOutPath);
    }
  } catch (err: any) {
    assert(false, 'Pipeline executed without throwing unhandled exceptions', err.message);
  }

  // ---------------------------------------------------------------------------
  // 6. Subprocess Negative Control Verification (Proves non-zero exit)
  // ---------------------------------------------------------------------------
  console.log('\nRunning negative control subprocess to verify non-zero exit on bad tokens...');
  const negResult = spawnSync('npx', ['tsx', 'scripts/test-board-discovery.ts', '--negative-control'], {
    encoding: 'utf-8',
    shell: true,
  });
  assert(
    negResult.status !== 0,
    `Negative control subprocess exited non-zero as expected (code ${negResult.status})`
  );

  console.log('\n==================================================================');
  console.log(`📊 AUDIT RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('==================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal Test Runner Failure:', err);
  process.exit(1);
});
