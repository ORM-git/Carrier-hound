import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function check() {
  if (process.env.TEST_DB !== '1') {
    console.log('[SKIPPED] scripts/test-insert.ts: Set TEST_DB=1 to run throwaway upsert check against a test database. Skipping to protect production data.');
    process.exit(0);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const testId = `__test_insert_marker_${Date.now()}`;
  const testApplyUrl = `https://example.invalid/test-insert/${testId}`;

  try {
    const { error: insertErr } = await supabase.from('jobs').insert([
      {
        id: testId,
        source: 'test_marker',
        source_job_id: testId,
        title: 'Throwaway Insert Test',
        company: 'Test Marker Corp',
        location: 'Remote',
        apply_url: testApplyUrl,
        is_active: false,
        status: 'expired',
      },
    ]);

    if (insertErr) {
      throw new Error(`Initial throwaway insert failed: ${insertErr.message}`);
    }

    const { error: upsertErr } = await supabase.from('jobs').upsert(
      [
        {
          id: testId,
          source: 'test_marker',
          source_job_id: testId,
          title: 'Updated Throwaway Title Test',
          company: 'Test Marker Corp',
          location: 'Remote',
          apply_url: testApplyUrl,
          is_active: false,
          status: 'expired',
        },
      ],
      { onConflict: 'apply_url' }
    );

    console.log('Upsert on apply_url result:', { error: upsertErr?.message, code: upsertErr?.code });
    if (upsertErr) {
      process.exit(1);
    }
  } finally {
    await supabase.from('jobs').delete().eq('id', testId);
    console.log('Cleaned up throwaway test row:', testId);
  }
}

check().catch((err) => {
  console.error(err);
  process.exit(1);
});
