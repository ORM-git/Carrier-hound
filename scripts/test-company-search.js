require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const client = createClient(url, key);

async function testSearch(term) {
  const clean = term.replace(/[%_(),"'`;\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const orClause = `title.ilike.%${clean}%,company.ilike.%${clean}%,location.ilike.%${clean}%,category.ilike.%${clean}%`;
  const { data, count, error } = await client
    .from('jobs')
    .select('id, title, company, location', { count: 'exact' })
    .eq('is_active', true)
    .eq('status', 'active')
    .or(orClause)
    .limit(5);

  console.log(`Search for "${term}":`, { count, error: error?.message, sample: data?.map(j => ({ title: j.title, company: j.company })) });
}

async function run() {
  await testSearch('Supabase');
  await testSearch('OpenAI');
  await testSearch('Frontend');
  await testSearch('Stripe (US)');
}
run();
