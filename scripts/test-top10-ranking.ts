import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { extractCandidateRelevanceTerms } from '../src/lib/jobs/service';
import { computeFitDiagnostics } from '../src/lib/matcher/scoring';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

const candidate = {
  name: 'Alex Rivera',
  headline: 'Entry Level Data Analyst',
  summary: 'Passionate entry-level data analyst skilled in SQL, Python, Excel, Tableau, and Power BI.',
  location: 'Remote',
  confirmedAt: new Date().toISOString(),
  skills: ['SQL', 'Python', 'Excel', 'Tableau', 'Power BI', 'Data Analysis', 'Statistics'],
  experience: [
    {
      company: 'Campus Data Lab',
      role: 'Junior Data Analyst',
      startDate: '2023',
      endDate: '2024'
    }
  ]
};

async function test() {
  const relevanceTerms = extractCandidateRelevanceTerms(candidate);
  console.log('Relevance terms:', relevanceTerms);

  let query = supabase
    .from('jobs')
    .select('id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, remote_eligibility, job_type, category, country, posted_at, first_seen_at')
    .eq('is_active', true)
    .eq('status', 'active');

  if (relevanceTerms.length > 0) {
    const orClauses = relevanceTerms.map((t) => `title.ilike.%${t}%`).join(',');
    query = query.or(orClauses);
  }

  const { data: candidatePool, error } = await query
    .order('posted_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Query error:', error);
    return;
  }

  console.log(`Pool size: ${candidatePool?.length}`);
  
  // Fastly jobs in pool:
  const fastly = candidatePool?.filter(j => j.company?.toLowerCase().includes('fastly'));
  console.log('Fastly jobs found in pool:', fastly?.map(j => ({ id: j.id, title: j.title, company: j.company, location: j.location })));

  // Score jobs
  const scored = (candidatePool || []).map((j) => {
    const diag = computeFitDiagnostics(candidate, {
      id: j.id,
      title: j.title,
      company: j.company,
      location: j.location,
      remote: j.remote,
      remote_scope: j.remote_scope,
      category: j.category,
      skills: j.skills || [],
      description: j.description || ''
    });
    return { id: j.id, title: j.title, company: j.company, location: j.location, score: diag.score, breakdown: diag.breakdown };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log('\nTop 15 jobs BEFORE deduplication & seniority fix:');
  scored.slice(0, 15).forEach((s, i) => {
    console.log(`#${i + 1} [${s.score}%] ${s.title} @ ${s.company} (${s.location})`);
    console.log(`     skills=${s.breakdown.skillScore}, title=${s.breakdown.titleScore}, exp=${s.breakdown.experienceScore}, remote=${s.breakdown.remoteScore}`);
  });
}

test();
