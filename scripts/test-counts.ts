import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

async function testCounts() {
  const { count: descCount } = await supabase
    .from('job_descriptions')
    .select('job_id', { count: 'exact', head: true })
    .gte('description_text', 'a') // non-null
    .not('description_text', 'ilike', '%Apply directly via employer careers portal%');

  console.log('Non-stub in job_descriptions count approx:', descCount);
}

testCounts();
