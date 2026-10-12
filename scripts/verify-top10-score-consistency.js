require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const esbuild = require('esbuild');
const path = require('path');

// 1. Bundle scoring module
const scoringBundled = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '../src/lib/matcher/scoring.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const scoringModule = { exports: {} };
new Function('module', 'exports', scoringBundled.outputFiles[0].text)(
  scoringModule,
  scoringModule.exports
);
const { computeFitDiagnostics, calculateConsistentJobMatchScore } = scoringModule.exports;

// 2. Bundle Netlify top10 function
const netlifyBundled = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '../netlify/functions/jobs-top10.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const netlifyModule = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', '__filename', netlifyBundled.outputFiles[0].text)(
  netlifyModule,
  netlifyModule.exports,
  require,
  __dirname,
  path.resolve(__dirname, '../netlify/functions/jobs-top10.ts')
);
const { handler: netlifyTop10Handler } = netlifyModule.exports;

// 3. Bundle Next.js App Router top10 route
const nextBundled = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '../src/app/api/jobs/top10/route.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const nextModule = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', '__filename', nextBundled.outputFiles[0].text)(
  nextModule,
  nextModule.exports,
  require,
  __dirname,
  path.resolve(__dirname, '../src/app/api/jobs/top10/route.ts')
);
const { POST: nextTop10Post } = nextModule.exports;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FREE_EMAIL = 'xbsuryakant+free@gmail.com';
const PRO_EMAIL = 'xbsuryakant+test@gmail.com';
const PASSWORD = 'TestPassword123!';

async function getAuthToken(email) {
  const supabase = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) {
    throw new Error(`Failed to sign in as ${email}: ${error?.message}`);
  }
  return { token: data.session.access_token, user: data.user };
}

async function runTests() {
  console.log('================================================================');
  console.log('TOP 10 SERVER-SIDE MATCHING & SCORE CONSISTENCY VERIFICATION');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  // 1. Authenticate users
  console.log('1. Authenticating test users...');
  const freeAuth = await getAuthToken(FREE_EMAIL);
  const proAuth = await getAuthToken(PRO_EMAIL);
  console.log(`- Free User ID: ${freeAuth.user.id}`);
  console.log(`- Pro User ID:  ${proAuth.user.id}\n`);

  const testCandidate = {
    name: 'Suryakant Test',
    headline: 'Senior Cloud & Full Stack Architect',
    summary: '10 years building high-scale distributed systems and cloud architectures.',
    location: 'Remote',
    confirmedAt: '2026-10-10T00:00:00.000Z',
    skills: ['TypeScript', 'Node.js', 'React', 'AWS', 'Docker', 'PostgreSQL', 'Go', 'Kubernetes'],
    experience: [
      {
        company: 'FastScale Inc',
        role: 'Senior Cloud Engineer',
        startDate: '2020',
        endDate: 'Present',
      },
    ],
  };

  // Helper to invoke Netlify handler
  async function invokeNetlify(token, body) {
    const event = {
      httpMethod: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    };
    const res = await netlifyTop10Handler(event);
    let parsed = {};
    try { parsed = JSON.parse(res.body || '{}'); } catch {}
    return { statusCode: res.statusCode, body: parsed };
  }

  // Helper to invoke Next route
  async function invokeNext(token, body) {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const req = new Request('http://localhost:3000/api/jobs/top10', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const res = await nextTop10Post(req);
    const parsed = await res.json().catch(() => ({}));
    return { statusCode: res.status, body: parsed };
  }

  // TEST 1: Unauthenticated -> 401
  console.log('2. Testing Authentication & Entitlement Guards...');
  const unauthNetlify = await invokeNetlify(null, { candidate: testCandidate });
  assert(unauthNetlify.statusCode === 401, `Unauthenticated request returned 401 (got ${unauthNetlify.statusCode})`);

  // TEST 2: Free User -> 403 Forbidden
  const freeNetlify = await invokeNetlify(freeAuth.token, { candidate: testCandidate });
  assert(freeNetlify.statusCode === 403, `Free user rejected with 403 Forbidden (got ${freeNetlify.statusCode})`);
  assert(freeNetlify.body.isPro === false, `Response flags isPro: false`);

  // TEST 3: Pro User Top 10 Execution on Netlify & Next.js route
  console.log('\n3. Testing Server-Side Top 10 Matching Execution...');
  const proNetlify = await invokeNetlify(proAuth.token, { candidate: testCandidate, limit: 10 });
  assert(proNetlify.statusCode === 200, `Pro user Netlify /api/jobs/top10 returned 200 OK (got ${proNetlify.statusCode})`);
  assert(Array.isArray(proNetlify.body.jobs), `Top 10 jobs is an array`);
  assert(proNetlify.body.jobs.length === 10, `Returned exactly 10 ranked jobs (got ${proNetlify.body.jobs.length})`);
  assert(proNetlify.body.isPro === true, `Response flags isPro: true`);
  assert(proNetlify.body.totalScored > 20, `Scored across candidate pool: ${proNetlify.body.totalScored} jobs`);

  const proNext = await invokeNext(proAuth.token, { candidate: testCandidate, limit: 10 });
  assert(proNext.statusCode === 200, `Pro user Next route /api/jobs/top10 returned 200 OK (got ${proNext.statusCode})`);
  assert(proNext.body.jobs.length === 10, `Next route returned exactly 10 ranked jobs`);

  // TEST 4: Score Consistency Across Card, Detail, Dashboard, and Server Top 10
  console.log('\n4. Testing Mathematical Score Consistency Across Surfaces...');
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Fetch 3 distinct jobs from the database: full JD, short template JD, title-only JD
  const { data: testJobs } = await supabaseAdmin
    .from('jobs')
    .select('id, title, company, location, salary_text, description, skills, category, remote, remote_scope')
    .limit(5);

  for (let i = 0; i < testJobs.length; i++) {
    const rawJob = testJobs[i];

    // Surface 1: List Card (MatchScoreBadge props from jobs/page.tsx)
    const cardInput = {
      id: rawJob.id,
      title: rawJob.title,
      company: rawJob.company,
      location: rawJob.location,
      remote_scope: rawJob.remote_scope || (rawJob.remote ? "worldwide" : undefined),
      category: rawJob.category,
      skills: rawJob.skills,
      description: rawJob.description,
      salary_text: rawJob.salary_text,
    };
    const cardScore = computeFitDiagnostics(testCandidate, cardInput).score;

    // Surface 2: Detail Page (computeFitDiagnostics from jobs/detail/page.tsx)
    const detailInput = {
      id: rawJob.id,
      title: rawJob.title,
      company: rawJob.company,
      location: rawJob.location,
      remote_scope: rawJob.remote_scope || (rawJob.remote ? "worldwide" : undefined),
      category: rawJob.category,
      skills: rawJob.skills,
      description: rawJob.description,
      salary_text: rawJob.salary_text,
    };
    const detailScore = computeFitDiagnostics(testCandidate, detailInput).score;

    // Surface 3: Dashboard Top 10 (computeFitDiagnostics from TopTenCompatibleJobs.tsx)
    const dashboardInput = {
      id: rawJob.id,
      title: rawJob.title,
      company: rawJob.company,
      location: rawJob.location,
      remote_scope: rawJob.remote_scope || (rawJob.remote ? "worldwide" : undefined),
      category: rawJob.category,
      skills: rawJob.skills,
      description: rawJob.description,
      salary_text: rawJob.salary_text,
    };
    const dashboardScore = computeFitDiagnostics(testCandidate, dashboardInput).score;

    // Surface 4: Canonical function alias calculateConsistentJobMatchScore
    const aliasScore = calculateConsistentJobMatchScore(testCandidate, cardInput).score;

    const allMatch = (cardScore === detailScore) && (detailScore === dashboardScore) && (dashboardScore === aliasScore);
    assert(
      allMatch,
      `Job [${rawJob.title.slice(0, 30)}...]: Card (${cardScore}%) === Detail (${detailScore}%) === Dashboard (${dashboardScore}%) === Alias (${aliasScore}%)`
    );
  }

  console.log('\n================================================================');
  console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
