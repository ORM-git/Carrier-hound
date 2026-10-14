import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { normalizeSkillToTokens, doesSkillMatch, calculateYearsOfExperience } from '../src/lib/matcher/scoring';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://szakevhxhwpeskidvtfs.supabase.co';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(url, key);

const DOMAIN_SKILL_TAXONOMY: Record<string, { patterns: RegExp; skills: string[] }> = {
  data_analytics: {
    patterns: /\b(data analyst|business analyst|bi analyst|analytics|reporting analyst|data analysis|insights analyst)\b/i,
    skills: ["sql", "python", "r", "excel", "tableau", "power bi", "data analysis", "statistics", "pandas", "looker", "bi", "reporting", "etl", "snowflake", "bigquery"]
  },
  data_engineering: {
    patterns: /\b(data engineer|etl developer|pipeline engineer|big data)\b/i,
    skills: ["python", "sql", "spark", "kafka", "airflow", "aws", "gcp", "snowflake", "etl", "databricks", "postgresql"]
  },
  frontend: {
    patterns: /\b(frontend|front-end|ui developer|web developer|react developer)\b/i,
    skills: ["javascript", "typescript", "react", "html", "css", "tailwind", "next.js", "vue", "redux", "ui"]
  },
  backend: {
    patterns: /\b(backend|back-end|api developer|server engineer)\b/i,
    skills: ["python", "node.js", "java", "golang", "c#", "postgresql", "sql", "docker", "aws", "rest api", "graphql"]
  },
  machine_learning: {
    patterns: /\b(machine learning|ml engineer|ai engineer|data scientist|nlp|computer vision)\b/i,
    skills: ["python", "machine learning", "deep learning", "pytorch", "tensorflow", "scikit-learn", "sql", "ai", "pandas"]
  },
  devops_cloud: {
    patterns: /\b(devops|sre|site reliability|cloud engineer|platform engineer|infrastructure)\b/i,
    skills: ["docker", "kubernetes", "aws", "gcp", "azure", "terraform", "ci/cd", "linux", "git"]
  },
  qa_testing: {
    patterns: /\b(qa|quality assurance|test engineer|automation engineer|sdet)\b/i,
    skills: ["selenium", "cypress", "jest", "automation", "python", "javascript", "testing", "qa"]
  },
  security: {
    patterns: /\b(security|threat|soc|cybersecurity|infosec|incident response)\b/i,
    skills: ["cybersecurity", "security", "threat", "siem", "soc", "incident response", "network security", "compliance"]
  },
  product_management: {
    patterns: /\b(product manager|product owner|technical product)\b/i,
    skills: ["product management", "agile", "scrum", "jira", "roadmap", "user research", "analytics", "sql"]
  }
};

type SeniorityLevel = "intern" | "entry" | "mid" | "senior" | "lead";

function detectCandidateSeniority(candidate: any): SeniorityLevel {
  const headline = (candidate.headline || "").toLowerCase();
  const summary = (candidate.summary || "").toLowerCase();
  const years = calculateYearsOfExperience(candidate.experience);

  if (/\b(intern|internship|co-op|coop)\b/i.test(headline)) return "intern";
  if (
    /\b(entry|entry-level|junior|jr\.?|associate|graduate|grad|new grad|fresher|apprentice|trainee)\b/i.test(headline) ||
    (/\b(entry|entry-level|junior|fresher|new grad)\b/i.test(summary) && years <= 2)
  ) {
    return "entry";
  }
  if (/\b(lead|principal|staff|director|head of|vp|architect)\b/i.test(headline)) return "lead";
  if (/\b(senior|sr\.?)\b/i.test(headline)) return "senior";

  if (years <= 1.5) return "entry";
  if (years >= 5) return "senior";
  return "mid";
}

function detectJobSeniority(title: string): SeniorityLevel {
  const t = (title || "").toLowerCase();
  if (/\b(intern|internship|co-op|coop)\b/i.test(t)) return "intern";
  if (/\b(lead|principal|staff|director|head of|vp|chief|architect)\b/i.test(t)) return "lead";
  if (/\b(senior|sr\.?)\b/i.test(t)) return "senior";
  if (/\b(junior|jr\.?|entry|entry-level|associate|graduate|new grad|apprentice|trainee|fresher)\b/i.test(t)) return "entry";
  return "mid";
}

function computeDiagnosticsEnhanced(candidate: any, job: any) {
  const candSeniority = detectCandidateSeniority(candidate);
  const jobSeniority = detectJobSeniority(job.title);
  const yearsOfExperience = calculateYearsOfExperience(candidate.experience);

  const candidateSkillTokens = (candidate.skills || []).map(normalizeSkillToTokens);
  const jobTitleLower = (job.title || "").toLowerCase();

  // Find job domain
  let matchedDomain: { key: string; skills: string[] } | null = null;
  for (const [key, domain] of Object.entries(DOMAIN_SKILL_TAXONOMY)) {
    if (domain.patterns.test(jobTitleLower) || (job.category && domain.patterns.test(job.category))) {
      matchedDomain = { key, skills: domain.skills };
      break;
    }
  }

  // Count candidate's domain skills
  let candidateDomainSkillCount = 0;
  if (matchedDomain) {
    for (const dSkill of matchedDomain.skills) {
      if (doesSkillMatch(dSkill, candidateSkillTokens).matched) {
        candidateDomainSkillCount++;
      }
    }
  }

  // Evidenced skills from job
  const jobEvidencedSkills: string[] = Array.isArray(job.skills) ? job.skills.filter(Boolean) : [];
  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];

  for (const skill of jobEvidencedSkills) {
    if (doesSkillMatch(skill, candidateSkillTokens).matched) {
      matchedSkills.push(skill);
    } else {
      missingSkills.push(skill);
    }
  }

  // 1. Skill Score (Weight: 50%)
  let skillScore = 0;
  if (jobEvidencedSkills.length >= 3) {
    // Substantive requirements list
    const ratio = matchedSkills.length / jobEvidencedSkills.length;
    skillScore = Math.round(ratio * 50);
  } else if (jobEvidencedSkills.length > 0) {
    // 1-2 tags (e.g. ['ai'] or ['sql'])
    const listedScore = Math.round((matchedSkills.length / jobEvidencedSkills.length) * 20);
    let domainScore = 0;
    if (candidateDomainSkillCount >= 4) domainScore = 30;
    else if (candidateDomainSkillCount >= 2) domainScore = 20;
    else if (candidateDomainSkillCount >= 1) domainScore = 10;
    skillScore = Math.min(50, listedScore + domainScore);
  } else {
    // 0 listed skills
    if (candidateDomainSkillCount >= 4) skillScore = 35;
    else if (candidateDomainSkillCount >= 2) skillScore = 25;
    else if (candidateDomainSkillCount >= 1) skillScore = 15;
    else skillScore = 5;
  }

  // 2. Title & Role Alignment (Weight: 25%)
  let titleScore = 0;
  const headlineLower = (candidate.headline || "").toLowerCase();
  const jobTokens = jobTitleLower.split(/[\s\-_,]+/).filter((t) => t.length > 2);
  let titleMatches = 0;
  for (const token of jobTokens) {
    if (headlineLower.includes(token)) titleMatches++;
    for (const exp of candidate.experience || []) {
      if ((exp.role || "").toLowerCase().includes(token)) {
        titleMatches += 0.5;
        break;
      }
    }
  }

  if (titleMatches >= 2) titleScore = 25;
  else if (titleMatches >= 1) titleScore = 18;
  else if (titleMatches >= 0.5) titleScore = 10;
  else titleScore = 0;

  // Seniority mismatch adjustments on title
  let seniorityAdjustment = 0;
  if (candSeniority === "entry" || candSeniority === "intern") {
    if (jobSeniority === "senior" || jobSeniority === "lead") {
      titleScore = Math.min(5, titleScore); // Cap title score at 5
      seniorityAdjustment = -20; // -20 penalty
    } else if (jobSeniority === "entry" || jobSeniority === "intern") {
      seniorityAdjustment = +10; // Entry match bonus!
    }
  } else if (candSeniority === "senior" || candSeniority === "lead") {
    if (jobSeniority === "entry" || jobSeniority === "intern") {
      titleScore = Math.min(8, titleScore);
      seniorityAdjustment = -15;
    } else if (jobSeniority === "senior" || jobSeniority === "lead") {
      seniorityAdjustment = +10;
    }
  } else if (candSeniority === "mid") {
    if (jobSeniority === "mid") {
      seniorityAdjustment = +5;
    } else if (jobSeniority === "senior" && yearsOfExperience < 3) {
      seniorityAdjustment = -5;
    }
  }

  // 3. Experience Score (Weight: 15%)
  let experienceScore = 0;
  if (yearsOfExperience >= 5) experienceScore = 15;
  else if (yearsOfExperience >= 2) experienceScore = 12;
  else if (yearsOfExperience >= 0.5) experienceScore = 8;
  else if (yearsOfExperience > 0) experienceScore = 4;
  else experienceScore = 2; // Genuine entry level graduate with 0 formal yrs gets 2

  if (jobSeniority === "senior" || jobSeniority === "lead") {
    if (yearsOfExperience < 1) experienceScore = 0;
    else if (yearsOfExperience < 4) experienceScore = Math.min(experienceScore, 4);
  }

  // 4. Remote & Location (Weight: 10%)
  let remoteScore = 0;
  const isWorldwide = Boolean(job.remote) && (job.remote_scope === "worldwide" || /worldwide/i.test(job.location || ""));
  if (isWorldwide || (job.remote && !job.location)) remoteScore = 10;
  else if (job.location && candidate.location && job.location.toLowerCase().includes(candidate.location.toLowerCase())) remoteScore = 10;
  else if (job.remote) remoteScore = 5;

  const rawScore = skillScore + titleScore + experienceScore + remoteScore + seniorityAdjustment;
  const finalScore = Math.min(98, Math.max(5, rawScore));

  return {
    score: finalScore,
    candSeniority,
    jobSeniority,
    breakdown: { skillScore, titleScore, experienceScore, remoteScore, seniorityAdjustment }
  };
}

async function testEnhanced() {
  const candidate = {
    headline: 'Entry Level Data Analyst',
    skills: ['SQL', 'Python', 'Excel', 'Tableau', 'Power BI', 'Data Analysis', 'Statistics'],
    location: 'Remote',
    experience: [{ role: 'Junior Data Analyst', startDate: '2023', endDate: '2024' }]
  };

  const { data: jobs } = await supabase
    .from('jobs')
    .select('id, title, company, location, remote, remote_scope, category, skills, description')
    .ilike('title', '%Data Analyst%')
    .limit(100);

  // Deduplicate by normalized title + company
  const seen = new Set<string>();
  const dedupedJobs: any[] = [];
  for (const j of jobs || []) {
    const normTitle = (j.title || '').trim().toLowerCase().replace(/\([^)]*\)/g, '').trim();
    const normCompany = (j.company || '').trim().toLowerCase();
    const key = `${normTitle}|${normCompany}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedJobs.push(j);
  }

  console.log(`Original jobs: ${jobs?.length}, Deduped: ${dedupedJobs.length}`);

  const scored = dedupedJobs.map((j) => {
    const diag = computeDiagnosticsEnhanced(candidate, j);
    return { title: j.title, company: j.company, location: j.location, ...diag };
  });

  scored.sort((a, b) => b.score - a.score);

  console.log('\nTop 10 Scored Jobs with Enhanced Seniority & Domain Skills:');
  scored.slice(0, 10).forEach((s, i) => {
    console.log(`#${i + 1} [${s.score}%] (${s.jobSeniority}) "${s.title}" @ ${s.company}`);
    console.log(`     skills=${s.breakdown.skillScore}, title=${s.breakdown.titleScore}, exp=${s.breakdown.experienceScore}, rem=${s.breakdown.remoteScore}, adj=${s.breakdown.seniorityAdjustment}`);
  });

  const seniorJobs = scored.filter(s => s.jobSeniority === 'senior');
  console.log('\nSenior Data Analyst jobs ranking and scores:');
  seniorJobs.slice(0, 3).forEach((s) => {
    console.log(`[${s.score}%] "${s.title}" @ ${s.company}`);
  });
}

testEnhanced();
