import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { computeFitDiagnostics, StandardJobScoringInput } from '../src/lib/matcher/scoring';
import { extractCandidateRelevanceTerms } from '../src/lib/jobs/service';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

async function testTop10DataAnalyst() {
  console.log('=== TEST 1: Entry Level Data Analyst Profile ===');
  const candidate = {
    headline: 'Entry Level Data Analyst',
    skills: ['SQL', 'Python', 'Excel', 'Tableau', 'Power BI', 'Data Analysis', 'Statistics'],
    location: 'Remote',
    experience: [{ role: 'Junior Data Analyst', startDate: '2023', endDate: '2024' }]
  };

  const terms = extractCandidateRelevanceTerms(candidate);
  let query = supabase
    .from('jobs')
    .select('id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, posted_at, first_seen_at')
    .eq('is_active', true)
    .eq('status', 'active');

  if (terms.length > 0) {
    query = query.or(terms.map((t) => `title.ilike.%${t}%`).join(','));
  }

  const { data: pool } = await query.order('posted_at', { ascending: false }).limit(120);

  const scored = (pool || []).map((row) => {
    const stdJob: StandardJobScoringInput = {
      id: row.id,
      title: row.title,
      company: row.company,
      location: row.location,
      remote: Boolean(row.remote),
      remote_scope: row.remote_scope,
      category: row.category,
      skills: row.skills || [],
      description: row.description || '',
    };
    const diagnostics = computeFitDiagnostics(candidate, stdJob);
    return { id: row.id, title: row.title, company: row.company, location: row.location, diagnostics, postedAt: row.posted_at };
  });

  // Sort
  scored.sort((a, b) => {
    if (b.diagnostics.score !== a.diagnostics.score) {
      return b.diagnostics.score - a.diagnostics.score;
    }
    return new Date(b.postedAt || 0).getTime() - new Date(a.postedAt || 0).getTime();
  });

  // Dedupe
  const seenDedupe = new Set<string>();
  const seenCompanyRole = new Set<string>();
  const deduped: typeof scored = [];

  for (const item of scored) {
    const normTitle = (item.title || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const normCompany = (item.company || '').trim().toLowerCase();
    const normLoc = (item.location || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const exactKey = `${normTitle}|${normCompany}|${normLoc}`;
    if (seenDedupe.has(exactKey)) continue;
    seenDedupe.add(exactKey);

    const baseTitle = normTitle.replace(/\([^)]*\)/g, '').trim();
    const companyRoleKey = `${baseTitle}|${normCompany}`;
    if (baseTitle.length >= 4 && seenCompanyRole.has(companyRoleKey)) continue;
    if (baseTitle.length >= 4) seenCompanyRole.add(companyRoleKey);

    deduped.push(item);
  }

  const top10 = deduped.slice(0, 10);
  console.log(`Pool: ${pool?.length}, Deduped: ${deduped.length}`);
  console.log('\nTop 10 Results:');
  top10.forEach((item, idx) => {
    console.log(`#${idx + 1} [${item.diagnostics.score}%] "${item.title}" @ ${item.company} (${item.location})`);
    console.log(`     Grade: ${item.diagnostics.scoreGrade} | Skills: ${item.diagnostics.breakdown.skillScore} | Title: ${item.diagnostics.breakdown.titleScore} | Exp: ${item.diagnostics.breakdown.experienceScore} | Adj: ${item.diagnostics.breakdown.seniorityAdjustment}`);
  });

  const fastlyCount = top10.filter((item) => item.company?.toLowerCase().includes('fastly')).length;
  console.log(`\nFastly occurrences in Top 10: ${fastlyCount} (expected: <= 1)`);

  const seniorAsNumber1 = top10[0]?.title.toLowerCase().includes('senior');
  console.log(`#1 title is Senior role: ${seniorAsNumber1} (expected: false)`);
}

async function run() {
  await testTop10DataAnalyst();
}
run();
