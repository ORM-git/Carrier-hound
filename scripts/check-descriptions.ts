import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

async function checkDescriptions() {
  const { data: descTable, error: err1 } = await supabase.from('job_descriptions').select('job_id, description_text').limit(5);
  console.log('job_descriptions table sample count:', descTable?.length, 'error:', err1?.message);
  if (descTable && descTable.length > 0) {
    console.log('job_descriptions sample len:', descTable[0].description_text?.length);
  }

  const { data: jobsTable, error: err2 } = await supabase.from('jobs').select('id, title, company, description').limit(5);
  console.log('jobs table sample:', jobsTable?.map(j => ({
    title: j.title,
    company: j.company,
    descLen: j.description?.length,
    descSnippet: j.description?.slice(0, 100)
  })));
}

checkDescriptions();
