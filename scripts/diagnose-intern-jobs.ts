import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(url, key);

async function run() {
  const { data: internRows, error } = await supabase
    .from('jobs')
    .select('id, title, company, job_type, category')
    .or('title.ilike.%intern%,title.ilike.%co-op%,title.ilike.%coop%')
    .limit(30);

  if (error) {
    console.error('Error fetching intern jobs:', error);
    return;
  }

  console.log(`Found ${internRows?.length} sample intern/co-op jobs:`);
  for (const row of internRows || []) {
    console.log(`- [${row.job_type}] "${row.title}" @ ${row.company} (category: ${row.category})`);
  }

  // Count how many have job_type != 'internship'
  const { count: misclassifiedCount, error: countErr } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .or('title.ilike.%intern%,title.ilike.%co-op%,title.ilike.%coop%')
    .neq('job_type', 'internship');

  console.log('\nTotal misclassified intern/co-op jobs in DB (job_type != "internship"):', misclassifiedCount);
}

run();
