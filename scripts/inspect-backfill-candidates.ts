import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

async function inspectCandidates() {
  // Sample 500 jobs with null or stub description
  const { data: stubs } = await supabase
    .from('jobs')
    .select('id, title, company, source, source_job_id, apply_url, description')
    .or('description.is.null,description.ilike.%Apply directly via employer careers portal%')
    .limit(100);

  console.log(`Fetched ${stubs?.length} sample stub jobs.`);
  if (!stubs || stubs.length === 0) return;

  const stubIds = stubs.map(s => s.id);
  const { data: descs } = await supabase
    .from('job_descriptions')
    .select('job_id, description_text')
    .in('job_id', stubIds);

  const descMap = new Map((descs || []).map(d => [d.job_id, d.description_text]));

  let hasGoodDescInTable = 0;
  let stubInBoth = 0;
  let sourcesCount: Record<string, number> = {};

  for (const s of stubs) {
    sourcesCount[s.source] = (sourcesCount[s.source] || 0) + 1;
    const desc = descMap.get(s.id);
    if (desc && desc.length > 200 && !desc.includes('Apply directly via employer careers portal')) {
      hasGoodDescInTable++;
    } else {
      stubInBoth++;
    }
  }

  console.log(`In 100 sample stubs:`);
  console.log(`- Has good description in job_descriptions table: ${hasGoodDescInTable}`);
  console.log(`- Stub/null in both tables: ${stubInBoth}`);
  console.log(`- Sources breakdown:`, sourcesCount);
}

inspectCandidates();
