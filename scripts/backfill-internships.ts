import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(url, key);

export function isInternshipTitle(title: string = '', rawType: string = ''): boolean {
  if (!title && !rawType) return false;
  const cleanTitle = title.replace(/\b(international|internals?|cooperative)\b/gi, ' ');
  const cleanRaw = rawType.replace(/\b(international|internals?|cooperative)\b/gi, ' ');
  const combined = `${cleanTitle} ${cleanRaw}`;

  const isIntern = /\b(intern|interns|internship|internships|co-op|coop|trainee|trainees|apprentice|apprenticeship)\b/i.test(combined);
  if (!isIntern) return false;

  if (/\b(director|head|vp|vice president|manager)\s+of\s+.*intern/i.test(title)) {
    return false;
  }

  return true;
}

async function run() {
  console.log('--- Step 1: Identifying misclassified intern jobs in database ---');

  // Fetch all jobs where title might contain intern or co-op or trainee or apprentice
  const { data: candidates, error } = await supabase
    .from('jobs')
    .select('id, title, job_type, company')
    .or('title.ilike.%intern%,title.ilike.%co-op%,title.ilike.%coop%,title.ilike.%trainee%,title.ilike.%apprentice%');

  if (error) {
    console.error('Fetch error:', error);
    return;
  }

  const toUpdateToInternship: string[] = [];
  const falsePositives: string[] = [];

  for (const row of candidates || []) {
    if (isInternshipTitle(row.title, row.job_type)) {
      if (row.job_type !== 'internship') {
        toUpdateToInternship.push(row.id);
        console.log(`[TO FIX -> internship] "${row.title}" @ ${row.company} (current: ${row.job_type})`);
      }
    } else {
      if (row.job_type === 'internship') {
        falsePositives.push(row.id);
        console.log(`[FALSE POSITIVE -> job] "${row.title}" @ ${row.company} (current: internship)`);
      }
    }
  }

  console.log(`\nFound ${toUpdateToInternship.length} genuine internship jobs currently marked as non-internship.`);
  console.log(`Found ${falsePositives.length} false positives marked as internship.\n`);

  if (toUpdateToInternship.length > 0) {
    console.log(`Backfilling ${toUpdateToInternship.length} jobs to job_type = 'internship'...`);
    const batchSize = 50;
    for (let i = 0; i < toUpdateToInternship.length; i += batchSize) {
      const batchIds = toUpdateToInternship.slice(i, i + batchSize);
      const { error: updateErr } = await supabase
        .from('jobs')
        .update({ job_type: 'internship' })
        .in('id', batchIds);
      if (updateErr) {
        console.error('Update batch error:', updateErr);
      }
    }
    console.log('✅ Backfill to internship complete!');
  }

  if (falsePositives.length > 0) {
    console.log(`Correcting ${falsePositives.length} false positives to job_type = 'job'...`);
    const { error: fpErr } = await supabase
      .from('jobs')
      .update({ job_type: 'job' })
      .in('id', falsePositives);
    if (fpErr) {
      console.error('FP update error:', fpErr);
    }
    console.log('✅ False positives corrected!');
  }
}

run();
