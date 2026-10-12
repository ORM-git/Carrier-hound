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
  breakdown: {
    skillScore: number;
    titleScore: number;
    experienceScore: number;
    remoteScore: number;
    yearsOfExperience: number;
  };
}

/**
 * Standard tech skill alias mapping for bidirectional normalization
 */
const SKILL_ALIASES: Record<string, string[]> = {
  sql: ["sql", "mysql", "postgresql", "postgres", "sqlite", "pl/sql", "tsql", "t-sql", "mariadb"],
  javascript: ["javascript", "js", "es6", "es6+", "ecmascript"],
  typescript: ["typescript", "ts"],
  react: ["react", "react.js", "reactjs", "react-native", "react native"],
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
  docker: ["docker", "containerization", "containers"],
  "ci/cd": ["ci/cd", "ci", "cd", "continuous integration", "continuous delivery", "github actions", "gitlab ci"],
  graphql: ["graphql", "gql"],
  "rest api": ["rest api", "rest", "restful", "restful api", "restful apis"],
  mongodb: ["mongodb", "mongo"],
  redis: ["redis"],
  html: ["html", "html5"],
  css: ["css", "css3", "tailwind", "tailwind css", "sass", "scss"],
};

/**
 * Normalizes a skill string into its canonical alias tokens and sub-tokens.
 * E.g. 'SQL (PostgreSQL, MySQL)' -> tokens ['sql', 'postgresql', 'mysql', 'postgres', ...]
 */
export function normalizeSkillToTokens(skill: string): { original: string; tokens: Set<string> } {
  const tokens = new Set<string>();
  const clean = skill.trim().toLowerCase();
  if (!clean) return { original: skill, tokens };

  tokens.add(clean);

  // Split on parentheses, slashes, commas, semicolons, plus signs
  const parts = clean
    .split(/[\(\),\/;+]|\s+and\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const part of parts) {
    tokens.add(part);
    const alphanumeric = part.replace(/[\s\-_.]/g, "");
    if (alphanumeric) tokens.add(alphanumeric);

    // Check alias maps
    for (const [key, aliases] of Object.entries(SKILL_ALIASES)) {
      if (aliases.includes(part) || aliases.includes(alphanumeric) || key === part) {
        tokens.add(key);
        aliases.forEach((a) => tokens.add(a));
      }
    }
  }

  // Word-boundary scan for aliases
  for (const [key, aliases] of Object.entries(SKILL_ALIASES)) {
    for (const alias of aliases) {
      const regex = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (regex.test(clean)) {
        tokens.add(key);
        tokens.add(alias);
      }
    }
  }

  return { original: skill, tokens };
}

/**
 * Computes whether a candidate skill matches a job required skill using canonical tokens.
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

    // Direct substring/word boundary check
    const reqClean = jobReqSkill.toLowerCase();
    const candClean = cand.original.toLowerCase();
    if (candClean.includes(reqClean) || reqClean.includes(candClean)) {
      return { matched: true, candidateEvidence: cand.original };
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

/**
 * Extracts ONLY skills actually evidenced in the job description, skills array, or title.
 * Never invents skills or pushes title-inferred assumptions as requirements.
 * Handles missing/short description stubs identically across all surfaces.
 */
export function extractSkillsFromJob(job: StandardJobScoringInput): string[] {
  const evidenced = new Set<string>();

  // 1. If the job already has explicit skills array in database
  if (Array.isArray(job.skills) && job.skills.length > 0) {
    job.skills.forEach((s) => {
      if (s && typeof s === "string" && s.trim()) evidenced.add(s.trim());
    });
  }

  // 2. Search substantive description for evidenced skills (requires minimum 60 chars)
  const cleanDesc = (job.description || "").trim();
  if (cleanDesc.length >= 60) {
    const descLower = cleanDesc.toLowerCase();
    for (const skill of SKILLS_TAXONOMY) {
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
    const lowerSkill = skill.toLowerCase();
    const escaped = lowerSkill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(titleText)) {
      evidenced.add(skill);
    }
  }

  return Array.from(evidenced);
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

  const candidateSkillTokens = (candidate.skills || []).map(normalizeSkillToTokens);
  const jobEvidencedSkills = extractSkillsFromJob(normalizedJob);
  const inferredSignals = extractInferredDomainSignals(normalizedJob);

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

  // If no explicit skills in listing description, check category/title overlap instead of blind 35/50
  let skillScore = 0;
  if (jobEvidencedSkills.length > 0) {
    const skillRatio = matchedSkills.length / jobEvidencedSkills.length;
    skillScore = Math.round(skillRatio * 50);
  } else {
    const jobTitleLower = job.title.toLowerCase();
    const candidateHasRelevantSkill = (candidate.skills || []).some((s) => {
      const sLower = s.toLowerCase();
      return jobTitleLower.includes(sLower) || (job.category && job.category.toLowerCase().includes(sLower));
    });
    if (candidateHasRelevantSkill) {
      skillScore = 20;
    } else if ((candidate.skills || []).length > 0) {
      skillScore = 10;
    } else {
      skillScore = 0;
    }
  }

  // 2. Title & Role Alignment (Weight: 25%)
  let titleScore = 0;
  const jobTitleLower = job.title.toLowerCase();
  const headlineLower = (candidate.headline || "").toLowerCase();

  const jobTokens = jobTitleLower.split(/[\s\-_,]+/).filter((t) => t.length > 2);
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

  // 3. Experience & Seniority Alignment (Weight: 15% - based on actual years, not position count)
  const yearsOfExperience = calculateYearsOfExperience(candidate.experience);
  let experienceScore = 0;

  if (yearsOfExperience >= 5) experienceScore = 15;
  else if (yearsOfExperience >= 2) experienceScore = 12;
  else if (yearsOfExperience >= 0.5) experienceScore = 8;
  else if (yearsOfExperience > 0) experienceScore = 4;
  else experienceScore = 0; // ZERO years = 0 points!

  const isSeniorJob =
    jobTitleLower.includes("senior") ||
    jobTitleLower.includes("lead") ||
    jobTitleLower.includes("staff") ||
    jobTitleLower.includes("principal");

  if (isSeniorJob) {
    if (yearsOfExperience < 1) {
      experienceScore = 0; // 0 points for senior role with 0 or negligible years
    } else if (yearsOfExperience < 4) {
      experienceScore = Math.min(experienceScore, 4);
    }
  }

  // 4. Remote & Location Compatibility (Weight: 10%)
  // STRICT: Do not award default points when geography restrictions exist
  let remoteScore = 0;
  const jobRemote = (job.remote_scope || "").toLowerCase();
  const jobLoc = (job.location || "").toLowerCase();
  const candLoc = (candidate.location || "").toLowerCase();

  const isWorldwide =
    jobRemote === "worldwide" ||
    (/\b(worldwide|anywhere|global|work from anywhere)\b/i.test(jobLoc) &&
      !/\b(us only|u\.s\. only|united states only|uk only|eu only|india only)\b/i.test(jobLoc));

  const isGeographicallyRestricted =
    jobRemote === "country_restricted" ||
    /\b(united states|u\.s\.|usa|remote - us|remote \(us\)|uk|canada|india|germany|europe|emea|apac)\b/i.test(jobLoc) ||
    (!isWorldwide && job.location && !jobLoc.includes("remote"));

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
  const finalScore = Math.min(100, Math.max(5, skillScore + titleScore + experienceScore + remoteScore));

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
  }

  if (titleMatches >= 1) {
    whyYouFit.push(
      `Background as "${candidate.headline || candidate.experience?.[0]?.role || "Engineer"}" aligns with "${job.title}".`
    );
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
  if (missingSkills.length > 0) {
    gaps.push(
      `Skills mentioned in listing without explicit resume evidence (${missingSkills.length}): ${missingSkills.slice(0, 5).join(", ")}${missingSkills.length > 5 ? "..." : ""}.`
    );
  }

  if (isSeniorJob && yearsOfExperience < 4) {
    gaps.push(`Senior role scope typically requires 5+ years; resume shows ~${yearsOfExperience} years.`);
  }

  if (isGeographicallyRestricted && remoteScore === 0) {
    gaps.push(`Listing has geographic restrictions (${job.location || "specific region"}) that may not match your profile location.`);
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
    breakdown: {
      skillScore,
      titleScore,
      experienceScore,
      remoteScore,
      yearsOfExperience,
    },
  };
}

/**
 * Single shared scoring function used across list card, detail page, dashboard, and Top 10.
 */
export const calculateConsistentJobMatchScore = computeFitDiagnostics;

