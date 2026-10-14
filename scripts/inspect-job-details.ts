import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { extractSkillsFromJob } from '../src/lib/matcher/scoring';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

async function inspect() {
  const { data: jobs } = await supabase
    .from('jobs')
    .select('id, title, company, skills, description')
    .ilike('title', '%Data Analyst%')
    .limit(5);

  for (const j of jobs || []) {
    console.log('--- Job:', j.title, '@', j.company);
    console.log('skills column:', j.skills);
    console.log('description length:', j.description?.length);
    console.log('description sample:', j.description?.slice(0, 200));
    console.log('extracted skills:', extractSkillsFromJob(j));
  }
}
inspect();
