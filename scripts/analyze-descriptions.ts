import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

async function analyzeDescriptions() {
  const { count: totalCount } = await supabase.from('jobs').select('*', { count: 'exact', head: true });
  console.log('Total jobs:', totalCount);

  // Check how many have short descriptions
  const { data: sample, error } = await supabase
    .from('jobs')
    .select('id, title, company, description, apply_url, source')
    .limit(1000);

  let stubs = 0;
  let full = 0;
  let nulls = 0;

  for (const j of sample || []) {
    if (!j.description) {
      nulls++;
    } else if (j.description.includes('Apply directly via employer careers portal') || j.description.length < 150) {
      stubs++;
    } else {
      full++;
    }
  }

  console.log(`In 1000 sample jobs: nulls=${nulls}, stubs=${stubs}, full=${full}`);
  const stubSample = sample?.filter(j => !j.description || j.description.includes('Apply directly') || j.description.length < 150).slice(0, 5);
  console.log('Sample stubs:', stubSample?.map(s => ({ title: s.title, company: s.company, source: s.source, desc: s.description, url: s.apply_url })));
}

analyzeDescriptions();
