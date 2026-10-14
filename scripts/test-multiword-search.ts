import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(url, key);

async function test() {
  const cleanQuery = 'Senior Procurement';
  const parts = cleanQuery.split(' ').filter((p) => p.length >= 2);

  // 1. Old OR query
  const oldClauses = [
    `title.ilike.%${cleanQuery}%`,
    `company.ilike.%${cleanQuery}%`,
    `location.ilike.%${cleanQuery}%`,
    `category.ilike.%${cleanQuery}%`,
    `description.ilike.%${cleanQuery}%`,
    ...parts.flatMap((p) => [`company.ilike.%${p}%`, `title.ilike.%${p}%`])
  ];
  const oldRes = await supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('is_active', true).eq('status', 'active').or(oldClauses.join(','));
  console.log('Old ANY-word query count for "Senior Procurement":', oldRes.count);

  // 2. New AND query
  let newQuery = supabase.from('jobs').select('id, title, company', { count: 'exact' }).eq('is_active', true).eq('status', 'active');
  for (const p of parts) {
    newQuery = newQuery.or(`title.ilike.%${p}%,company.ilike.%${p}%,location.ilike.%${p}%,category.ilike.%${p}%,description.ilike.%${p}%`);
  }
  const newRes = await newQuery.limit(20);
  console.log('New ALL-words (AND) query count for "Senior Procurement":', newRes.count);
  console.log('Sample matched jobs:');
  newRes.data?.slice(0, 10).forEach((j) => console.log(`- "${j.title}" @ ${j.company}`));
}

test();
