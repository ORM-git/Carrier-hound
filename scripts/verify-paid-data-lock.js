const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing Supabase env credentials');
  process.exit(1);
}

const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log('='.repeat(80));
  console.log('VERIFYING PAID-DATA LEAK FIX AT DATABASE LAYER');
  console.log('='.repeat(80));

  let leakClosed = false;
  let publicViewWorking = false;

  // 1. Check anonymous GET to raw /rest/v1/jobs
  console.log('\n--- 1. Testing Anonymous Access to Raw public.jobs Table ---');
  const { data: rawData, error: rawError } = await anonClient
    .from('jobs')
    .select('id, company, salary_text, apply_url, description')
    .limit(3);

  if (rawError) {
    console.log('[PASS] Anonymous REST request to raw `jobs` was DENIED!');
    console.log(`Status / Code: ${rawError.code} - ${rawError.message}`);
    leakClosed = true;
  } else {
    console.error('[FAIL] LEAK STILL ACTIVE! Anonymous request read ' + rawData.length + ' rows from raw `jobs` table.');
    console.error('First row company:', rawData[0]?.company);
    leakClosed = false;
  }

  // 2. Check anonymous access to public.jobs_public view
  console.log('\n--- 2. Testing Anonymous Access to Safe public.jobs_public View ---');
  const { data: viewData, error: viewError } = await anonClient
    .from('jobs_public')
    .select('id, title, company, location, salary_text, apply_url, description')
    .limit(3);

  if (viewError) {
    console.error('[PENDING] public.jobs_public view returned error:', viewError.message);
    console.error('Note: Migration 20261010_lock_paid_jobs_data.sql must be applied in Supabase SQL editor.');
    publicViewWorking = false;
  } else {
    console.log(`[PASS] Anonymous access to \`jobs_public\` returned ${viewData.length} preview rows.`);
    const sample = viewData[0];
    console.log('Sample preview row:');
    console.log(`  - Title: "${sample?.title}"`);
    console.log(`  - Company: "${sample?.company}" (expected: "Verified Employer")`);
    console.log(`  - Salary: ${sample?.salary_text} (expected: null)`);
    console.log(`  - Apply URL: ${sample?.apply_url} (expected: null)`);
    console.log(`  - Description: ${sample?.description} (expected: null)`);

    const isMasked =
      sample?.company === 'Verified Employer' &&
      sample?.salary_text === null &&
      sample?.apply_url === null &&
      sample?.description === null;

    if (isMasked) {
      console.log('[PASS] All paid fields are strictly masked in jobs_public view!');
      publicViewWorking = true;
    } else {
      console.error('[FAIL] Sensitive columns were not properly masked!');
      publicViewWorking = false;
    }
  }

  console.log('\n' + '='.repeat(80));
  if (leakClosed && publicViewWorking) {
    console.log('ALL VERIFICATIONS PASSED: RAW JOBS LOCKED & PUBLIC VIEW OPERATIONAL');
  } else {
    console.log('AWAITING MIGRATION EXECUTION IN SUPABASE SQL EDITOR');
  }
  console.log('='.repeat(80));
}

main().catch(console.error);
