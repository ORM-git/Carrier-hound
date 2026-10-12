require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function sanitizeSearchQuery(input) {
  if (!input) return "";
  return input
    .replace(/[%_(),"'`;\\$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function test(term) {
  const clean = sanitizeSearchQuery(term);
  const parts = clean.split(' ').filter(p => p.length >= 2);
  
  // Base clauses for the whole query
  const clauses = [
    `title.ilike.%${clean}%`,
    `company.ilike.%${clean}%`,
    `location.ilike.%${clean}%`,
    `category.ilike.%${clean}%`,
    `description.ilike.%${clean}%`
  ];
  
  // If user searched for multiple words, also match individual significant words against title and company
  if (parts.length > 1) {
    for (const p of parts) {
      clauses.push(`company.ilike.%${p}%`);
      clauses.push(`title.ilike.%${p}%`);
    }
  }
  
  const orStr = clauses.join(',');
  const { count, error } = await c.from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .eq('status', 'active')
    .or(orStr);
    
  console.log(`Search "${term}": count = ${count}, error = ${error?.message}`);
}

async function run() {
  await test('Supabase');
  await test('OpenAI');
  await test('Stripe');
  await test('OpenAI Software Engineer');
  await test('Senior Frontend');
  await test('Special characters: %_()\'"');
}

run();
