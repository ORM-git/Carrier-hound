import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
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

async function run() {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, title, company, location, salary_text, salary_min, salary_max, currency, salary_period, description, skills, apply_url, remote, remote_scope, category, country, posted_at, first_seen_at')
    .eq('is_active', true)
    .eq('status', 'active')
    .ilike('title', '%Data Analyst%')
    .limit(100);

  if (error) {
    console.error('Error fetching jobs:', error);
    return;
  }

  console.log(`Found ${jobs?.length} Data Analyst jobs in DB.`);
  const scored = jobs.map((j) => {
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
    return { title: j.title, company: j.company, score: diag.score, breakdown: diag.breakdown, skillsEvidenced: diag.jobRequiredSkills, matched: diag.matchedSkills };
  });

  scored.sort((a, b) => b.score - a.score);
  console.log('\nTop 10 Data Analyst scored jobs currently:');
  scored.slice(0, 10).forEach((s, idx) => {
    console.log(`#${idx + 1} [${s.score}%] "${s.title}" @ ${s.company}`);
    console.log(`    Breakdown: skills=${s.breakdown.skillScore}, title=${s.breakdown.titleScore}, exp=${s.breakdown.experienceScore}, remote=${s.breakdown.remoteScore}`);
    console.log(`    Matched: ${s.matched.join(', ')} / Evidenced: ${s.skillsEvidenced.join(', ')}`);
  });
}

run();
