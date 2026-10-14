import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

async function checkDuplicates() {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, company, title, location, is_active')
    .limit(10000);

  if (error) {
    console.error('Error fetching jobs:', error.message);
    return;
  }

  const counts = new Map<string, Array<{ id: string; location: string }>>();
  for (const j of jobs || []) {
    const norm = `${(j.company || '').toLowerCase().trim()}:::${(j.title || '').toLowerCase().trim()}:::${(j.location || '').toLowerCase().trim()}`;
    const list = counts.get(norm) || [];
    list.push({ id: j.id, location: j.location });
    counts.set(norm, list);
  }

  const duplicates = [...counts.entries()].filter(([_, list]) => list.length > 1);
  console.log(`Found ${duplicates.length} duplicate groups in 10,000 jobs!`);
  for (const [key, list] of duplicates.slice(0, 10)) {
    console.log(`- ${key}: ${list.length} occurrences (IDs: ${list.map(x => x.id).join(', ')})`);
  }
}

checkDuplicates();
