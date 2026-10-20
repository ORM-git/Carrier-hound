import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { resolveLocation } from '../src/lib/geo/cities';
import * as fs from 'fs';
import * as path from 'path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(url, key);

async function run() {
  console.log('Fetching all active jobs from table `jobs` using service key...');

  const { count: totalActive } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true)
    .eq('status', 'active');

  const total = totalActive ?? 0;
  console.log(`Total active jobs in DB: ${total}`);

  const chunkSize = 1000;
  const chunkCount = Math.ceil(total / chunkSize);
  const chunkPromises = [];

  for (let i = 0; i < chunkCount; i++) {
    const from = i * chunkSize;
    const to = from + chunkSize - 1;
    chunkPromises.push(
      supabase
        .from('jobs')
        .select('id, company, location, country_code, remote_scope, remote_eligibility')
        .eq('is_active', true)
        .eq('status', 'active')
        .range(from, to)
    );
  }

  const results = await Promise.all(chunkPromises);
  const jobs: any[] = [];
  for (const r of results) {
    if (r.data) jobs.push(...r.data);
  }

  console.log(`Fetched ${jobs.length} jobs.`);

  const companyCounts: Record<string, number> = {};
  let totalWorldwideJobs = 0;

  for (const j of jobs) {
    const resolved = resolveLocation(j.location, j.country_code, j.remote_scope, j.remote_eligibility);
    if (resolved.type === 'worldwide_remote') {
      totalWorldwideJobs++;
      const company = (j.company || 'Unknown').trim();
      companyCounts[company] = (companyCounts[company] || 0) + 1;
    }
  }

  console.log(`Total worldwide remote jobs across corpus: ${totalWorldwideJobs}`);

  const sortedCompanies = Object.entries(companyCounts)
    .filter(([name, count]) => count > 0 && name.toLowerCase() !== 'unknown' && name.toLowerCase() !== 'verified employer')
    .map(([name, count]) => ({
      id: `comp-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      jobCount: count,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    }))
    .sort((a, b) => b.jobCount - a.jobCount);

  console.log(`Total real companies hiring worldwide-remote: ${sortedCompanies.length}`);
  console.log('Top 25 worldwide companies:');
  sortedCompanies.slice(0, 25).forEach((c) => console.log(`- ${c.name}: ${c.jobCount} worldwide-remote roles`));

  // Write to src/data/companies.json
  const targetPath = path.resolve(__dirname, '../src/data/companies.json');
  fs.writeFileSync(targetPath, JSON.stringify(sortedCompanies, null, 2), 'utf-8');
  console.log(`Saved ${sortedCompanies.length} companies to ${targetPath}`);
}

run();
