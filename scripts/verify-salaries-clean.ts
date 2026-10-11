import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl!, serviceKey!);

async function main() {
  console.log('Running Post-Cleanup Database Integrity Audit...\n');

  let allJobsWithSalary: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, title, company, salary_text, salary_min, salary_max, currency, salary_period')
      .not('salary_text', 'is', null)
      .range(from, from + 999);

    if (error) {
      console.error('Fetch error:', error);
      break;
    }
    if (!data || data.length === 0) break;
    allJobsWithSalary = allJobsWithSalary.concat(data);
    from += 1000;
  }

  console.log(`Total live jobs with non-null salary_text: ${allJobsWithSalary.length}`);

  const anomalies: { issue: string; row: any }[] = [];

  for (const row of allJobsWithSalary) {
    const text = row.salary_text || '';
    const min = row.salary_min;
    const max = row.salary_max;
    const curr = row.currency;
    const period = row.salary_period;

    // 1. Min > Max
    if (min != null && max != null && min > max) {
      anomalies.push({ issue: 'min > max', row });
    }

    // 2. Corrupted calendar years in text
    if (/\b(19\d\d|20[0-3]\d)\b/.test(text) && !/\/\s*yr/i.test(text)) {
      anomalies.push({ issue: 'calendar year in text', row });
    }

    // 3. Mixed currency or mangled Indian grouping with foreign currency
    if (/(EUR|USD|GBP|CAD|AUD|\$|€|£)\s*\d+,\d\d,\d\d\d/.test(text)) {
      anomalies.push({ issue: 'mangled Indian digit grouping on foreign currency', row });
    }

    // 4. "EUR ... 50,00,000" or similar
    if (/2,007|2,025|2,024|2,022|2,023|2,026|2,027/.test(text)) {
      anomalies.push({ issue: 'corrupted year in salary string', row });
    }

    // 5. Absurd scale for yearly salary
    if (period === 'yearly') {
      if (curr === 'USD' || curr === 'EUR' || curr === 'GBP' || curr === 'CAD' || curr === 'AUD') {
        if (min != null && min < 15000) {
          anomalies.push({ issue: 'yearly salary < 15k', row });
        }
        if (max != null && max > 1500000) {
          anomalies.push({ issue: 'yearly salary > 1.5M', row });
        }
      }
      if (curr === 'INR') {
        if (min != null && min < 100000) {
          anomalies.push({ issue: 'INR yearly salary < 1 Lakh', row });
        }
        if (max != null && max > 35000000) {
          anomalies.push({ issue: 'INR yearly salary > 3.5 Crore', row });
        }
      }
    }

    // 6. Absurd ratio
    if (min != null && max != null && min > 0 && max / min > 5) {
      anomalies.push({ issue: 'absurd ratio max/min > 5x', row });
    }
  }

  console.log(`Audit result: ${anomalies.length} anomalies found out of ${allJobsWithSalary.length} active salary rows.`);

  if (anomalies.length > 0) {
    console.error('Anomalies found:');
    for (const a of anomalies.slice(0, 10)) {
      console.log(`[${a.issue}] ${a.row.company} - ${a.row.title}: ${a.row.salary_text}`);
    }
    process.exit(1);
  } else {
    console.log('✅ ZERO anomalies detected! All live salary rows are clean, well-scaled, and correctly structured.');
  }

  // Sample 20 active clean rows
  console.log('\nSample 20 live clean salary rows across various companies:');
  for (const j of allJobsWithSalary.slice(0, 20)) {
    console.log(` - [${j.company}] "${j.title}" -> ${j.salary_text} (${j.currency}, ${j.salary_period})`);
  }
}

main().catch(console.error);
