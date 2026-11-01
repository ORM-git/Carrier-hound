import { CandidateProfile, WorkExperienceItem } from "../resume/types";
import { SKILLS_TAXONOMY } from "../resume/parser";

export interface FitDiagnosticsResult {
  score: number; // 0 to 100
  scoreGrade: "high" | "good" | "moderate" | "low";
  matchedSkills: string[];
  missingSkills: string[];
  inferredSignals: string[];
  whyYouFit: string[];
  gaps: string[];
  jobRequiredSkills: string[];
  hasConfirmedResume?: boolean;
  breakdown: {
    skillScore: number;
    titleScore: number;
    experienceScore: number;
    remoteScore: number;
    yearsOfExperience: number;
    seniorityAdjustment?: number;
  };
}

/**
 * Genuine tech skill alias mapping with explicit canonical boundaries.
 * Distinct technologies are strictly segregated (React != React Native, Java != JavaScript, SQL != PostgreSQL).
 */
export const GENUINE_SKILL_ALIASES: Record<string, string[]> = {
  react: ["react", "react.js", "reactjs"],
  "react native": ["react native", "react-native", "reactnative"],
  javascript: ["javascript", "js", "es6", "es6+", "ecmascript"],
  java: ["java", "core java"],
  typescript: ["typescript", "ts"],
  sql: ["sql"],
  postgresql: ["postgresql", "postgres", "pg"],
  mysql: ["mysql"],
  sqlite: ["sqlite", "sqlite3"],
  "node.js": ["node.js", "nodejs", "node"],
  vue: ["vue", "vue.js", "vuejs"],
  python: ["python", "python3", "py"],
  golang: ["golang", "go"],
  kubernetes: ["kubernetes", "k8s"],
  aws: ["aws", "amazon web services"],
  gcp: ["gcp", "google cloud", "google cloud platform"],
  azure: ["azure", "microsoft azure"],
  "c#": ["c#", "csharp", ".net", "dotnet", "asp.net"],
  "c++": ["c++", "cpp"],
  docker: ["docker"],
  "ci/cd": ["ci/cd", "continuous integration", "continuous delivery"],
  graphql: ["graphql", "gql"],
  "rest api": ["rest api", "rest", "restful", "restful api", "restful apis"],
  mongodb: ["mongodb", "mongo"],
  redis: ["redis"],
  html: ["html", "html5"],
  css: ["css", "css3"],
  tailwind: ["tailwind", "tailwind css", "tailwindcss"],
  sass: ["sass", "scss"],
};

export function getCanonicalSkillId(skill: string): string | null {
  const clean = skill.trim().toLowerCase();
  if (!clean) return null;
  if (GENUINE_SKILL_ALIASES[clean]) return clean;
  for (const [key, aliases] of Object.entries(GENUINE_SKILL_ALIASES)) {
    if (aliases.includes(clean)) return key;
  }
  const noPunct = clean.replace(/[-_.]/g, " ").replace(/\s+/g, " ").trim();
  if (GENUINE_SKILL_ALIASES[noPunct]) return noPunct;
  for (const [key, aliases] of Object.entries(GENUINE_SKILL_ALIASES)) {
    if (aliases.some((a) => a.replace(/[-_.]/g, " ").replace(/\s+/g, " ").trim() === noPunct)) {
      return key;
    }
  }
  return null;
}

export function areSkillsGenuineMatch(skillA: string, skillB: string): boolean {
  const aClean = skillA.trim().toLowerCase();
  const bClean = skillB.trim().toLowerCase();
  if (aClean === bClean) return true;

  const aCanon = getCanonicalSkillId(aClean);
  const bCanon = getCanonicalSkillId(bClean);
  if (aCanon && bCanon) {
    return aCanon === bCanon;
  }
  return false;
}

/**
 * Normalizes a skill string into its canonical alias tokens and sub-tokens.
 * E.g. 'SQL (PostgreSQL, MySQL)' -> tokens ['sql', 'postgresql', 'mysql', 'postgres', ...]
 */
export function normalizeSkillToTokens(skill: string): { original: string; tokens: Set<string> } {
  const tokens = new Set<string>();
  const clean = skill.trim().toLowerCase();
  if (!clean) return { original: skill, tokens };

  // 1. Direct canonical check on the full skill string
  const canonicalFull = getCanonicalSkillId(clean);
  if (canonicalFull) {
    tokens.add(canonicalFull);
    const aliases = GENUINE_SKILL_ALIASES[canonicalFull] || [];
    aliases.forEach((a) => tokens.add(a));
    return { original: skill, tokens };
  }

  // 2. If not a single known canonical skill, split on composite delimiters: parentheses, slashes, commas, semicolons, " and "
  tokens.add(clean);
  const parts = clean
    .split(/[\(\),\/;+]|\s+and\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const part of parts) {
    tokens.add(part);
    const partCanon = getCanonicalSkillId(part);
    if (partCanon) {
      tokens.add(partCanon);
      const aliases = GENUINE_SKILL_ALIASES[partCanon] || [];
      aliases.forEach((a) => tokens.add(a));
    } else {
      const alphanumeric = part.replace(/[\s\-_.]/g, "");
      if (alphanumeric) tokens.add(alphanumeric);
    }
  }

  return { original: skill, tokens };
}

/**
 * Computes whether a candidate skill matches a job required skill using canonical tokens.
 * Direct symmetric substring matching is explicitly prohibited to prevent false equivalences.
 */
export function doesSkillMatch(
  jobReqSkill: string,
  candidateSkills: Array<{ original: string; tokens: Set<string> }>
): { matched: boolean; candidateEvidence?: string } {
  const reqNormalized = normalizeSkillToTokens(jobReqSkill);

  for (const cand of candidateSkills) {
    // Check if any canonical token overlaps
    for (const reqToken of Array.from(reqNormalized.tokens)) {
      if (cand.tokens.has(reqToken)) {
        return { matched: true, candidateEvidence: cand.original };
      }
    }
  }

  return { matched: false };
}

/**
 * Calculates genuine total years of experience from work history.
 */
export function calculateYearsOfExperience(experience?: WorkExperienceItem[]): number {
  if (!experience || experience.length === 0) return 0;
  const currentYear = new Date().getFullYear();
  let totalYears = 0;

  for (const exp of experience) {
    if (!exp.startDate) continue;
    const startYearMatch = exp.startDate.match(/\b(19\d\d|20\d\d)\b/);
    if (!startYearMatch) continue;
    const startYear = parseInt(startYearMatch[1], 10);

    let endYear = currentYear;
    if (exp.endDate && !/\b(present|now|current)\b/i.test(exp.endDate)) {
      const endYearMatch = exp.endDate.match(/\b(19\d\d|20\d\d)\b/);
      if (endYearMatch) {
        endYear = parseInt(endYearMatch[1], 10);
      }
    }
    const duration = Math.max(0.5, endYear - startYear);
    totalYears += duration;
  }

  return Math.round(totalYears * 10) / 10;
}

export interface StandardJobScoringInput {
  id?: string;
  title: string;
  company?: string;
  description?: string;
  location?: string;
  remote?: boolean;
  remote_scope?: string;
  remoteScope?: string;
  category?: string;
  skills?: string[];
  salary_text?: string;
  salary?: string;
  apply_url?: string;
  applyUrl?: string;
}

export const CATEGORY_LEVEL_WORDS = new Set([
  "engineering",
  "software engineering",
  "data engineering",
  "design",
  "product",
  "product management",
  "marketing",
  "sales",
  "operations",
  "finance",
  "accounting",
  "hr",
  "human resources",
  "customer support",
  "customer service",
  "customer-support",
  "legal",
  "healthcare",
  "cyber-security",
  "cybersecurity",
  "tech",
  "technology",
  "information technology",
  "administration",
  "general",
  "other",
  "recruiting",
  "talent acquisition",
  "internship",
  "internships",
]);

/**
 * Extracts ONLY skills actually evidenced in the job description, skills array, or title.
 * Never invents skills or pushes title-inferred assumptions as requirements.
 * Filters out category-level and department words (e.g. "engineering", "design")
 * so they are never classified as missing skills.
 * Handles missing/short description stubs identically across all surfaces.
 */
export function extractSkillsFromJob(job: StandardJobScoringInput): string[] {
  const evidenced = new Set<string>();

  const isCategoryWord = (skill: string): boolean => {
    const lower = skill.trim().toLowerCase();
    if (CATEGORY_LEVEL_WORDS.has(lower)) return true;
    if (job.category && lower === job.category.trim().toLowerCase()) return true;
    return false;
  };

  // 1. If the job already has explicit skills array in database
  if (Array.isArray(job.skills) && job.skills.length > 0) {
    job.skills.forEach((s) => {
      if (s && typeof s === "string" && s.trim() && !isCategoryWord(s)) {
        evidenced.add(s.trim());
      }
    });
  }

  // 2. Search substantive description for evidenced skills (requires minimum 60 chars)
  const cleanDesc = (job.description || "").trim();
  if (cleanDesc.length >= 60) {
    const descLower = cleanDesc.toLowerCase();
    for (const skill of SKILLS_TAXONOMY) {
      if (isCategoryWord(skill)) continue;
      const lowerSkill = skill.toLowerCase();
      const escaped = lowerSkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(?:^|[\\s,;/|])${escaped}(?:$|[\\s,;/|])`, "i");
      if (regex.test(descLower)) {
        evidenced.add(skill);
      }
    }
  }

  // 3. Also check if title explicitly names a specific technology (e.g. "React Developer", "Python Engineer")
  const titleText = (job.title || "").toLowerCase();
  for (const skill of SKILLS_TAXONOMY) {
    if (isCategoryWord(skill)) continue;
    const lowerSkill = skill.toLowerCase();
    const escaped = lowerSkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(titleText)) {
      evidenced.add(skill);
    }
  }

  return Array.from(evidenced).filter((s) => !isCategoryWord(s));
}

/**
 * Extracts domain-level signals inferred from title/category (kept separate from actual requirements).
 */
export function extractInferredDomainSignals(job: {
  title?: string;
  category?: string;
}): string[] {
  const signals: string[] = [];
  const t = (job.title || "").toLowerCase();
  const c = (job.category || "").toLowerCase();

  if (t.includes("frontend") || t.includes("front-end")) signals.push("Frontend Architecture");
  if (t.includes("backend") || t.includes("back-end")) signals.push("Backend & API Systems");
  if (t.includes("full") && t.includes("stack")) signals.push("Full-Stack Systems");
  if (t.includes("devops") || t.includes("cloud") || t.includes("sre")) signals.push("Cloud & Infrastructure");
  if (t.includes("data") || t.includes("ml") || t.includes("ai")) signals.push("Data & ML Pipelines");
  if (c && c !== "other" && !signals.includes(c)) signals.push(c.toUpperCase());

  return signals;
}

export type SeniorityLevel = "intern" | "entry" | "mid" | "senior" | "lead";

export function detectCandidateSeniority(candidate: CandidateProfile): SeniorityLevel {
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

export function detectJobSeniority(title: string): SeniorityLevel {
  const t = (title || "").toLowerCase();
  if (/\b(intern|internship|co-op|coop)\b/i.test(t)) return "intern";
  if (/\b(lead|principal|staff|director|head of|vp|chief|architect)\b/i.test(t)) return "lead";
  if (/\b(senior|sr\.?)\b/i.test(t)) return "senior";
  if (/\b(junior|jr\.?|entry|entry-level|associate|graduate|new grad|apprentice|trainee|fresher)\b/i.test(t)) return "entry";
  return "mid";
}

export const DOMAIN_SKILL_TAXONOMY: Record<string, { patterns: RegExp; skills: string[] }> = {
  data_analytics: {
    patterns: /\b(data analyst|business analyst|bi analyst|analytics|reporting analyst|data analysis|insights analyst)\b/i,
    skills: ["sql", "python", "r", "excel", "tableau", "power bi", "data analysis", "statistics", "pandas", "looker", "bi", "reporting", "etl", "snowflake", "bigquery"],
  },
  data_engineering: {
    patterns: /\b(data engineer|etl developer|pipeline engineer|big data)\b/i,
    skills: ["python", "sql", "spark", "kafka", "airflow", "aws", "gcp", "snowflake", "etl", "databricks", "postgresql"],
  },
  frontend: {
    patterns: /\b(frontend|front-end|ui developer|web developer|react developer)\b/i,
    skills: ["javascript", "typescript", "react", "html", "css", "tailwind", "next.js", "vue", "redux", "ui"],
  },
  backend: {
    patterns: /\b(backend|back-end|api developer|server engineer|software engineer)\b/i,
    skills: ["python", "node.js", "java", "golang", "c#", "postgresql", "sql", "docker", "aws", "rest api", "graphql"],
  },
  machine_learning: {
    patterns: /\b(machine learning|ml engineer|ai engineer|data scientist|nlp|computer vision)\b/i,
    skills: ["python", "machine learning", "deep learning", "pytorch", "tensorflow", "scikit-learn", "sql", "ai", "pandas"],
  },
  devops_cloud: {
    patterns: /\b(devops|sre|site reliability|cloud engineer|platform engineer|infrastructure)\b/i,
    skills: ["docker", "kubernetes", "aws", "gcp", "azure", "terraform", "ci/cd", "linux", "git"],
  },
  qa_testing: {
    patterns: /\b(qa|quality assurance|test engineer|automation engineer|sdet)\b/i,
    skills: ["selenium", "cypress", "jest", "automation", "python", "javascript", "testing", "qa"],
  },
  security: {
    patterns: /\b(security|threat|soc|cybersecurity|infosec|incident response)\b/i,
    skills: ["cybersecurity", "security", "threat", "siem", "soc", "incident response", "network security", "compliance"],
  },
  product_management: {
    patterns: /\b(product manager|product owner|technical product)\b/i,
    skills: ["product management", "agile", "scrum", "jira", "roadmap", "user research", "analytics", "sql"],
  },
};

/**
 * Computes a transparent, reproducible fit score (0-100) and diagnostics breakdown.
 * Formula:
 * - Technical Skill Evidence (50%)
 * - Title & Role Alignment (25%)
 * - Experience & Seniority (15% based on actual years of experience)
 * - Location Compatibility (10% - 0 if geography restricted and not matching)
 *
 * Guarantees 100% score consistency across list cards, detail pages, and dashboards
 * by using the same normalized inputs and handling missing/short JDs identically.
 */
export function computeFitDiagnostics(
  candidate: CandidateProfile,
  job: StandardJobScoringInput
): FitDiagnosticsResult {
  const hasConfirmedResume = Boolean(
    candidate &&
    candidate.confirmedAt &&
    ((candidate.skills && candidate.skills.length > 0) ||
      (candidate.experience && candidate.experience.length > 0))
  );
  const normalizedJob: StandardJobScoringInput = {
    id: job.id,
    title: job.title || "Untitled Position",
    company: job.company || "Verified Employer",
    description: typeof job.description === "string" ? job.description : "",
    location: job.location || "",
    remote: Boolean(job.remote),
    remote_scope: job.remote_scope || job.remoteScope || (job.remote ? "worldwide" : undefined),
    category: job.category || "",
    skills: Array.isArray(job.skills) ? job.skills : [],
    salary_text: job.salary_text || job.salary || "",
  };

  const candidateSkillTokens = hasConfirmedResume
    ? (candidate.skills || []).map(normalizeSkillToTokens)
    : [];
  const jobEvidencedSkills = extractSkillsFromJob(normalizedJob);
  const inferredSignals = extractInferredDomainSignals(normalizedJob);
  const jobTitleLower = (normalizedJob.title || "").toLowerCase();

  // 1. Skill Match Component (Weight: 50%)
  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];
  const matchEvidenceMap: Record<string, string> = {};

  for (const skill of jobEvidencedSkills) {
    const matchRes = doesSkillMatch(skill, candidateSkillTokens);
    if (matchRes.matched) {
      matchedSkills.push(skill);
      if (matchRes.candidateEvidence) {
        matchEvidenceMap[skill] = matchRes.candidateEvidence;
      }
    } else {
      missingSkills.push(skill);
    }
  }

  // Count candidate's domain skills for the job title / category
  let matchedDomain: { key: string; skills: string[] } | null = null;
  for (const [key, domain] of Object.entries(DOMAIN_SKILL_TAXONOMY)) {
    if (domain.patterns.test(jobTitleLower) || (normalizedJob.category && domain.patterns.test(normalizedJob.category))) {
      matchedDomain = { key, skills: domain.skills };
      break;
    }
  }

  let candidateDomainSkillCount = 0;
  if (matchedDomain) {
    for (const dSkill of matchedDomain.skills) {
      if (doesSkillMatch(dSkill, candidateSkillTokens).matched) {
        candidateDomainSkillCount++;
      }
    }
  }

  let skillScore = 0;
  if (jobEvidencedSkills.length >= 3) {
    // Rich job posting with explicit requirements list
    const skillRatio = matchedSkills.length / jobEvidencedSkills.length;
    skillScore = Math.round(skillRatio * 50);
  } else if (jobEvidencedSkills.length > 0) {
    // 1-2 tagged skills (common in scraped jobs that only have ['ai'] or ['sql'])
    const listedRatioScore = Math.round((matchedSkills.length / jobEvidencedSkills.length) * 20);
    let domainScore = 0;
    if (candidateDomainSkillCount >= 4) domainScore = 30;
    else if (candidateDomainSkillCount >= 2) domainScore = 20;
    else if (candidateDomainSkillCount >= 1) domainScore = 10;
    skillScore = Math.min(50, Math.max(listedRatioScore + domainScore, matchedSkills.length > 0 ? 35 : 0));
  } else {
    // 0 listed skills
    if (candidateDomainSkillCount >= 4) skillScore = 35;
    else if (candidateDomainSkillCount >= 2) skillScore = 25;
    else if (candidateDomainSkillCount >= 1) skillScore = 15;
    else {
      const candidateHasRelevantSkill = (candidate.skills || []).some((s) => {
        const sLower = s.toLowerCase();
        return jobTitleLower.includes(sLower) || (normalizedJob.category && normalizedJob.category.toLowerCase().includes(sLower));
      });
      if (candidateHasRelevantSkill) {
        skillScore = 20;
      } else if ((candidate.skills || []).length > 0) {
        skillScore = 10;
      } else {
        skillScore = 0;
      }
    }
  }

  // 2. Title & Role Alignment (Weight: 25%)
  let titleScore = 0;
  const headlineLower = (candidate.headline || "").toLowerCase();

  const TITLE_STOP_TOKENS = new Set([
    "senior", "junior", "entry", "level", "lead", "principal", "staff", "intern", "internship", "associate", "and", "the", "for", "with", "remote"
  ]);
  const jobTokens = jobTitleLower
    .split(/[\s\-_,()/]+/)
    .filter((t) => t.length > 2 && !TITLE_STOP_TOKENS.has(t));
  let titleMatches = 0;
  for (const token of jobTokens) {
    if (headlineLower.includes(token)) {
      titleMatches++;
    }
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
  else titleScore = 0; // STRICT: 0 points if no title match

  // Seniority Alignment Adjustments
  const candSeniority = detectCandidateSeniority(candidate);
  const jobSeniority = detectJobSeniority(normalizedJob.title);
  const yearsOfExperience = hasConfirmedResume ? calculateYearsOfExperience(candidate.experience) : 0;
  const hasDomainAlignment = skillScore > 0 || titleScore > 0;
  let seniorityAdjustment = 0;

  if (candSeniority === "entry" || candSeniority === "intern") {
    if (jobSeniority === "senior" || jobSeniority === "lead") {
      titleScore = Math.min(5, titleScore); // Heavy mismatch: cap title score at 5
      seniorityAdjustment = -20; // -20 penalty
    } else if ((jobSeniority === "entry" || jobSeniority === "intern") && hasDomainAlignment) {
      seniorityAdjustment = +10; // Entry match bonus when domain aligns!
    }
  } else if (candSeniority === "senior" || candSeniority === "lead") {
    if (jobSeniority === "entry" || jobSeniority === "intern") {
      titleScore = Math.min(8, titleScore); // Overqualified penalty
      seniorityAdjustment = -15;
    } else if ((jobSeniority === "senior" || jobSeniority === "lead") && hasDomainAlignment) {
      seniorityAdjustment = +10; // Senior match bonus when domain aligns!
    }
  } else if (candSeniority === "mid") {
    if (jobSeniority === "mid" && hasDomainAlignment) {
      seniorityAdjustment = +5;
    } else if (jobSeniority === "senior" && yearsOfExperience < 3) {
      seniorityAdjustment = -5;
    }
  }

  // 3. Experience & Seniority Alignment (Weight: 15% - based on actual years, not position count)
  let experienceScore = 0;

  if (yearsOfExperience >= 5) experienceScore = 15;
  else if (yearsOfExperience >= 2) experienceScore = 12;
  else if (yearsOfExperience >= 0.5) experienceScore = 8;
  else if (yearsOfExperience > 0) experienceScore = 4;
  else experienceScore = candSeniority === "entry" || candSeniority === "intern" ? 2 : 0;

  if (jobSeniority === "senior" || jobSeniority === "lead") {
    if (yearsOfExperience < 1) {
      experienceScore = 0; // 0 points for senior role with 0 or negligible years
    } else if (yearsOfExperience < 4) {
      experienceScore = Math.min(experienceScore, 4);
    }
  }

  // 4. Remote & Location Compatibility (Weight: 10%)
  // STRICT: Do not award default points when geography restrictions exist
  let remoteScore = 0;
  const jobRemote = (normalizedJob.remote_scope || "").toLowerCase();
  const jobLoc = (normalizedJob.location || "").toLowerCase();
  const candLoc = (candidate.location || "").toLowerCase();

  const isWorldwide =
    jobRemote === "worldwide" ||
    (/\b(worldwide|anywhere|global|work from anywhere)\b/i.test(jobLoc) &&
      !/\b(us only|u\.s\. only|united states only|uk only|eu only|india only)\b/i.test(jobLoc));

  const isGeographicallyRestricted =
    jobRemote === "country_restricted" ||
    /\b(united states|u\.s\.|usa|remote - us|remote \(us\)|uk|canada|india|germany|europe|emea|apac)\b/i.test(jobLoc) ||
    (!isWorldwide && normalizedJob.location && !jobLoc.includes("remote"));

  if (isWorldwide) {
    remoteScore = 10;
  } else if (candLoc && jobLoc && (jobLoc.includes(candLoc) || candLoc.includes(jobLoc))) {
    remoteScore = 10;
  } else if (isGeographicallyRestricted) {
    remoteScore = 0; // Restricted to another region
  } else if (jobRemote === "remote" || jobLoc.includes("remote")) {
    remoteScore = 5; // General remote with unspecified eligibility
  } else {
    remoteScore = 0;
  }

  // Sum components
  const finalScore = Math.min(
    100,
    Math.max(5, skillScore + titleScore + experienceScore + remoteScore + seniorityAdjustment)
  );

  let scoreGrade: "high" | "good" | "moderate" | "low" = "low";
  if (finalScore >= 75) scoreGrade = "high";
  else if (finalScore >= 55) scoreGrade = "good";
  else if (finalScore >= 35) scoreGrade = "moderate";
  else scoreGrade = "low";

  // Construct factual "Why You Fit" reasons
  const whyYouFit: string[] = [];
  if (matchedSkills.length > 0) {
    const evidenceSnippets = matchedSkills.slice(0, 3).map((s) => {
      const orig = matchEvidenceMap[s];
      return orig && orig.toLowerCase() !== s.toLowerCase() ? `${s} (via "${orig}")` : s;
    });
    whyYouFit.push(
      `Evidenced ${matchedSkills.length} of ${jobEvidencedSkills.length} listed requirements: ${evidenceSnippets.join(", ")}${matchedSkills.length > 3 ? ` +${matchedSkills.length - 3} more` : ""}.`
    );
  } else if (candidateDomainSkillCount >= 3 && matchedDomain) {
    whyYouFit.push(
      `Strong foundational domain skill coverage for ${matchedDomain.key.replace("_", " ")} role.`
    );
  }

  if (titleMatches >= 1) {
    whyYouFit.push(
      `Background as "${candidate.headline || candidate.experience?.[0]?.role || "Engineer"}" aligns with "${normalizedJob.title}".`
    );
  }

  if ((candSeniority === "entry" && (jobSeniority === "entry" || jobSeniority === "intern")) || (candSeniority === "senior" && (jobSeniority === "senior" || jobSeniority === "lead"))) {
    whyYouFit.push(`Seniority level (${jobSeniority}) aligns directly with your career stage.`);
  }

  if (yearsOfExperience > 0) {
    whyYouFit.push(`~${yearsOfExperience} years of work history provides relevant seniority for this opening.`);
  }

  if (isWorldwide) {
    whyYouFit.push("Worldwide remote role with flexible location compatibility.");
  } else if (remoteScore === 10) {
    whyYouFit.push("Location aligns with role's geographic eligibility.");
  }

  if (whyYouFit.length === 0) {
    whyYouFit.push("Core background provides a foundation for this position.");
  }

  // Construct "Gaps" reasons
  const gaps: string[] = [];
  if (candSeniority === "entry" && (jobSeniority === "senior" || jobSeniority === "lead")) {
    gaps.push(
      `Seniority mismatch: Role is ${jobSeniority} level, but your profile is entry level.`
    );
  } else if (candSeniority === "senior" && (jobSeniority === "entry" || jobSeniority === "intern")) {
    gaps.push(
      `Seniority mismatch: Role is entry/junior level, but your profile indicates senior experience.`
    );
  }

  if (missingSkills.length > 0) {
    gaps.push(
      `Skills mentioned in listing without explicit resume evidence (${missingSkills.length}): ${missingSkills.slice(0, 5).join(", ")}${missingSkills.length > 5 ? "..." : ""}.`
    );
  }

  if (jobSeniority === "senior" && yearsOfExperience < 4) {
    gaps.push(`Senior role scope typically requires 5+ years; resume shows ~${yearsOfExperience} years.`);
  }

  if (isGeographicallyRestricted && remoteScore === 0) {
    gaps.push(`Listing has geographic restrictions (${normalizedJob.location || "specific region"}) that may not match your profile location.`);
  }

  return {
    score: finalScore,
    scoreGrade,
    matchedSkills,
    missingSkills,
    inferredSignals,
    whyYouFit,
    gaps,
    jobRequiredSkills: jobEvidencedSkills,
    hasConfirmedResume,
    breakdown: {
      skillScore,
      titleScore,
      experienceScore,
      remoteScore,
      yearsOfExperience,
      seniorityAdjustment,
    },
  };
}

/**
 * Single shared scoring function used across list card, detail page, dashboard, and Top 10.
 */
export const calculateConsistentJobMatchScore = computeFitDiagnostics;

/**
 * Constructs a factual, 1-2 line summary built strictly from real diagnostics
 * (matched skills, years of experience) with zero invented claims or marketing fluff.
 * If there is no confirmed resume or no real evidence, returns an empty string (renders nothing).
 */
export function getDiagnosticsSummary(diagnostics?: FitDiagnosticsResult | null): string {
  if (!diagnostics || !diagnostics.hasConfirmedResume) {
    return "";
  }
  const matched = diagnostics.matchedSkills || [];
  const years = diagnostics.breakdown?.yearsOfExperience ?? 0;

  if (matched.length > 0 && years > 0) {
    const skillList = matched.slice(0, 3).join(", ");
    const more = matched.length > 3 ? ` +${matched.length - 3} more` : "";
    return `Matches ${matched.length} of your skills (${skillList}${more}) and ${years}+ years of experience.`;
  }
  if (matched.length > 0) {
    const skillList = matched.slice(0, 3).join(", ");
    const more = matched.length > 3 ? ` +${matched.length - 3} more` : "";
    return `Matches ${matched.length} of your confirmed skills: ${skillList}${more}.`;
  }
  if (years > 0) {
    return `Aligns with your ${years}+ years of confirmed experience in this opening.`;
  }
  return "";
}

