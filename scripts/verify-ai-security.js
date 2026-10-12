require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const esbuild = require('esbuild');
const path = require('path');

// 1. Bundle Netlify function in memory
const netlifyBundled = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '../netlify/functions/ai.ts')],
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
  path.resolve(__dirname, '../netlify/functions/ai.ts')
);
const { handler: netlifyHandler } = netlifyModule.exports;

// 2. Bundle Next.js App Router API route in memory
const nextRouteBundled = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '../src/app/api/ai/route.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const nextModule = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', '__filename', nextRouteBundled.outputFiles[0].text)(
  nextModule,
  nextModule.exports,
  require,
  __dirname,
  path.resolve(__dirname, '../src/app/api/ai/route.ts')
);
const { POST: nextPostHandler } = nextModule.exports;

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
  console.log('DUAL ENDPOINT AI SECURITY & ENTITLEMENT VERIFICATION SUITE');
  console.log('Testing: [1] Netlify Function  [2] Next.js App Route /api/ai');
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

  // 1. Get tokens
  console.log('1. Authenticating test users...');
  const freeAuth = await getAuthToken(FREE_EMAIL);
  const proAuth = await getAuthToken(PRO_EMAIL);
  console.log(`- Free User ID: ${freeAuth.user.id}`);
  console.log(`- Pro User ID:  ${proAuth.user.id}\n`);

  async function invokeNetlify(token, body) {
    const event = {
      httpMethod: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    };
    const res = await netlifyHandler(event);
    let parsed = {};
    try { parsed = JSON.parse(res.body || '{}'); } catch {}
    return { statusCode: res.statusCode, body: parsed };
  }

  async function invokeNextRoute(token, body) {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const req = new Request('http://localhost:3000/api/ai', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const res = await nextPostHandler(req);
    const parsed = await res.json().catch(() => ({}));
    return { statusCode: res.status, body: parsed };
  }

  const endpoints = [
    { name: 'Netlify Function (netlify/functions/ai.ts)', invoke: invokeNetlify },
    { name: 'Next.js App Route (src/app/api/ai/route.ts)', invoke: invokeNextRoute },
  ];

  for (const ep of endpoints) {
    console.log(`\n>>> TESTING ENDPOINT: ${ep.name} <<<\n`);

    // TEST 1: Unauthenticated -> 401
    const unauthRes = await ep.invoke(null, { operation: 'cover_letter' });
    assert(unauthRes.statusCode === 401, `[${ep.name}] Unauthenticated returns 401`);
    assert(unauthRes.body.error?.includes('Unauthorized'), `[${ep.name}] Error indicates unauthorized`);

    // TEST 2: Logged-in non-Pro -> 403
    const freeRes = await ep.invoke(freeAuth.token, {
      operation: 'cover_letter',
      params: {
        candidate: { name: 'Free User', skills: ['React'] },
        job: { title: 'Developer', company: 'Acme' },
      },
    });
    assert(freeRes.statusCode === 403, `[${ep.name}] Free user returns 403 Forbidden`);
    assert(freeRes.body.isPro === false, `[${ep.name}] Response flags isPro: false`);
    assert(
      freeRes.body.error?.includes('CareerMonke Pro subscription required'),
      `[${ep.name}] Explains Pro requirement: "${freeRes.body.error}"`
    );

    // TEST 3: Invalid operation -> 400
    const invalidOpRes = await ep.invoke(proAuth.token, {
      operation: 'unsupported_op',
      params: { foo: 'bar' },
    });
    assert(invalidOpRes.statusCode === 400, `[${ep.name}] Unallowlisted operation returns 400`);
    assert(invalidOpRes.body.error?.includes('Invalid AI operation'), `[${ep.name}] Error states invalid operation`);

    // TEST 4: Arbitrary messages / raw model -> 400
    const rawMsgRes = await ep.invoke(proAuth.token, {
      model: 'arbitrary-llm',
      messages: [{ role: 'user', content: 'Say hello' }],
    });
    assert(rawMsgRes.statusCode === 400, `[${ep.name}] Arbitrary messages rejected with 400`);

    // TEST 5: Input token bounds -> 400
    const oversizedText = 'X'.repeat(50000);
    const oversizedRes = await ep.invoke(proAuth.token, {
      operation: 'resume_extraction',
      params: { rawText: oversizedText },
    });
    assert(oversizedRes.statusCode === 400, `[${ep.name}] Oversized payload returns 400`);
    assert(oversizedRes.body.error?.includes('exceeds maximum allowed token limit'), `[${ep.name}] Error explains bounds`);

    // TEST 6: Pro user valid execution (resume_extraction)
    const validExtractRes = await ep.invoke(proAuth.token, {
      operation: 'resume_extraction',
      params: {
        rawText: 'John Doe. Senior Software Architect. 8 years building distributed systems in Go and TypeScript at CloudScale Corp.',
      },
    });
    assert(validExtractRes.statusCode === 200, `[${ep.name}] Pro user execution returns 200 OK`);
    assert(validExtractRes.body.operation === 'resume_extraction', `[${ep.name}] Confirms operation resume_extraction`);
    assert(validExtractRes.body.model.includes('20b') || validExtractRes.body.model.includes('gpt-oss'), `[${ep.name}] Model enforced: ${validExtractRes.body.model}`);
  }

  // Quota Verification in Supabase
  console.log('\n>>> TESTING DURABLE SUPABASE QUOTA PERSISTENCE <<<');
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: subData } = await supabaseAdmin
    .from('subscriptions')
    .select('metadata')
    .eq('user_id', proAuth.user.id)
    .single();

  const today = new Date().toISOString().split('T')[0];
  const quotaExtract = subData?.metadata?.ai_usage?.[today]?.resume_extraction;
  assert(
    typeof quotaExtract === 'number' && quotaExtract >= 2,
    `Supabase durable quota counter accurately persisted: ${quotaExtract} calls recorded for ${today}`
  );

  console.log('\n================================================================');
  console.log(`DUAL SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
