import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

async function benchmark() {
  const t0 = Date.now();
  const { data: pool500 } = await supabase
    .from('jobs')
    .select('id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, posted_at, first_seen_at')
    .eq('is_active', true)
    .eq('status', 'active')
    .or('title.ilike.%Data Analyst%,title.ilike.%data%')
    .order('posted_at', { ascending: false })
    .limit(500);
  const t1 = Date.now();
  console.log(`500 rows took: ${t1 - t0}ms (rows: ${pool500?.length})`);

  const t2 = Date.now();
  const { data: pool100 } = await supabase
    .from('jobs')
    .select('id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, posted_at, first_seen_at')
    .eq('is_active', true)
    .eq('status', 'active')
    .or('title.ilike.%Data Analyst%,title.ilike.%data%')
    .order('posted_at', { ascending: false })
    .limit(100);
  const t3 = Date.now();
  console.log(`100 rows took: ${t3 - t2}ms (rows: ${pool100?.length})`);
}

benchmark();
