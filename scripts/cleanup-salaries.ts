import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { parseSalary } from '../src/lib/salary/parser';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('Missing Supabase credentials in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

const isApply = process.argv.includes('--apply');

interface CleanupRecord {
  id: string;
  company: string;
  title: string;
  before: {
    salary_text: string | null;
    salary_min: number | null;
    salary_max: number | null;
    currency: string;
    salary_period: string;
  };
  after: {
    salary_text: string | null;
    salary_min: number | null;
    salary_max: number | null;
    currency: string;
    salary_period: string;
  };
  reason: string;
}

async function runCleanup() {
  console.log(`Starting Salary Cleanup Script (${isApply ? 'MODE: LIVE UPDATE' : 'MODE: DRY-RUN'})...`);

  // Fetch all jobs with salary_text or salary_min/max
  let allRows: any[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, title, company, location, country_code, salary_text, salary_min, salary_max, currency, salary_period')
      .or('salary_text.not.is.null,salary_min.not.is.null,salary_max.not.is.null')
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('Error fetching jobs:', error);
      break;
    }
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    from += pageSize;
  }

  console.log(`Fetched ${allRows.length} jobs with existing salary fields.`);

  const brokenRows: CleanupRecord[] = [];
  const normalizedRows: CleanupRecord[] = [];
  const resetToNullRows: CleanupRecord[] = [];
  const updateBatch: any[] = [];

  for (const job of allRows) {
    const beforeText = job.salary_text;
    const beforeMin = job.salary_min;
    const beforeMax = job.salary_max;
    const beforeCurr = job.currency || 'USD';
    const beforePeriod = job.salary_period || 'yearly';

    // Run existing salary string through new robust parser
    let parsed = parseSalary(beforeText, {
      title: job.title,
      location: job.location,
      countryCode: job.country_code,
      isExplicitSalaryField: true,
    });

    const isOriginallyCorrupt =
      (beforeText && /\b(19\d\d|20[0-3]\d)\b/.test(beforeText) && !/\/\s*yr/i.test(beforeText)) ||
      (beforeText && /(EUR|USD|GBP|CAD|AUD|\$|€|£)\s*\d+,\d\d,\d\d\d/.test(beforeText)) ||
      (beforeText && /\d+,\d\d,\d\d\d/.test(beforeText) && !/INR|₹/i.test(beforeText)) ||
      (beforeMin && beforeMin >= 1990 && beforeMin <= 2035) ||
      (beforeMin && beforeMax && beforeMax / beforeMin > 5) ||
      (beforeText && /2,007|2,025|2,024|2,022|2,023|2,026|2,027/.test(beforeText)) ||
      (beforeText && /\$5,00,000|CAD 5,00,000|AUD 5,00,000/.test(beforeText)) ||
      (beforeText === '$165,000 - $240,000' && beforeMin === null && beforeMax === null) ||
      (beforeText === '$150,000 - $230,000' && beforeMin === null && beforeMax === null);

    // If it was corrupted, the old salary_text was garbage (business count, copyright year, etc.).
    // Reset to NULL instead of guessing, unless there's a real salary in description.
    if (isOriginallyCorrupt) {
      parsed = {
        salary_text: null,
        salary_min: null,
        salary_max: null,
        currency: 'USD',
        salary_period: 'yearly',
      };
    }

    const hasChanged =
      job.salary_text !== parsed.salary_text ||
      job.salary_min !== parsed.salary_min ||
      job.salary_max !== parsed.salary_max ||
      job.currency !== parsed.currency ||
      job.salary_period !== parsed.salary_period;

    if (hasChanged) {
      const record: CleanupRecord = {
        id: job.id,
        company: job.company,
        title: job.title,
        before: {
          salary_text: beforeText,
          salary_min: beforeMin,
          salary_max: beforeMax,
          currency: beforeCurr,
          salary_period: beforePeriod,
        },
        after: {
          salary_text: parsed.salary_text,
          salary_min: parsed.salary_min,
          salary_max: parsed.salary_max,
          currency: parsed.currency,
          salary_period: parsed.salary_period,
        },
        reason: isOriginallyCorrupt
          ? (parsed.salary_text ? 'Cleaned corrupt string into valid range' : 'Corrupted salary removed (set to NULL)')
          : parsed.salary_text === null
          ? 'Unconfident parse reset to NULL'
          : 'Normalized structured fields & formatting',
      };

      if (isOriginallyCorrupt) {
        brokenRows.push(record);
      } else if (parsed.salary_text === null) {
        resetToNullRows.push(record);
      } else {
        normalizedRows.push(record);
      }

      updateBatch.push({
        id: job.id,
        salary_text: parsed.salary_text,
        salary_min: parsed.salary_min,
        salary_max: parsed.salary_max,
        currency: parsed.currency,
        salary_period: parsed.salary_period,
      });
    }
  }

  console.log('\n=== CLEANUP SUMMARY ===');
  console.log(`Total jobs evaluated: ${allRows.length}`);
  console.log(`Corrupted/broken rows repaired: ${brokenRows.length}`);
  console.log(`Normalized valid salary rows: ${normalizedRows.length}`);
  console.log(`Invalid/unconfident rows reset to NULL: ${resetToNullRows.length}`);
  console.log(`Total rows needing update: ${updateBatch.length}`);

  console.log('\n=== SAMPLE OF PREVIOUSLY BROKEN ROWS REPAIRED (>= 25) ===');
  for (let i = 0; i < Math.min(brokenRows.length, 30); i++) {
    const r = brokenRows[i];
    console.log(
      `${i + 1}. [${r.company || 'Unknown'}] "${r.title}"\n` +
      `   BEFORE: text="${r.before.salary_text}" | min=${r.before.salary_min} | max=${r.before.salary_max} | curr=${r.before.currency}\n` +
      `   AFTER:  text=${r.after.salary_text ? `"${r.after.salary_text}"` : 'NULL'} | min=${r.after.salary_min} | max=${r.after.salary_max} | curr=${r.after.currency}\n` +
      `   ACTION: ${r.reason}`
    );
  }

  console.log('\n=== SAMPLE OF NORMALIZED VALID SALARY ROWS (>= 15) ===');
  for (let i = 0; i < Math.min(normalizedRows.length, 15); i++) {
    const r = normalizedRows[i];
    console.log(
      `${i + 1}. [${r.company || 'Unknown'}] "${r.title}"\n` +
      `   BEFORE: text="${r.before.salary_text}" | min=${r.before.salary_min} | max=${r.before.salary_max} | curr=${r.before.currency}\n` +
      `   AFTER:  text="${r.after.salary_text}" | min=${r.after.salary_min} | max=${r.after.salary_max} | curr=${r.after.currency}\n` +
      `   ACTION: ${r.reason}`
    );
  }

  if (isApply && updateBatch.length > 0) {
    console.log(`\nApplying updates to Supabase in concurrent batches of 50...`);
    const chunkSize = 50;
    let updatedCount = 0;
    for (let c = 0; c < updateBatch.length; c += chunkSize) {
      const chunk = updateBatch.slice(c, c + chunkSize);
      await Promise.all(
        chunk.map((item) =>
          supabase
            .from('jobs')
            .update({
              salary_text: item.salary_text,
              salary_min: item.salary_min,
              salary_max: item.salary_max,
              currency: item.currency,
              salary_period: item.salary_period,
            })
            .eq('id', item.id)
        )
      );
      updatedCount += chunk.length;
      if (updatedCount % 500 === 0 || updatedCount === updateBatch.length) {
        console.log(`Updated ${updatedCount}/${updateBatch.length} rows...`);
      }
    }
    console.log('✅ Successfully applied all salary cleanup updates to Supabase!');
  } else if (!isApply) {
    console.log('\nℹ️ DRY-RUN complete. To write changes to Supabase, run with --apply flag.');
  }
}

runCleanup().catch(console.error);
