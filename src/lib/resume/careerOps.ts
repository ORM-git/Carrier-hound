/**
 * Adapted from career-ops (https://github.com/career-ops-hq/career-ops)
 * Core ATS CV reframing, prompt templates, ATS linting rules, and 4-stage cover letter generation.
 */

import { CandidateProfile } from "./types";

export interface CareerOpsAtsLintResult {
  passed: boolean;
  score: number;
  checks: {
    ruleId: string;
    description: string;
    status: "pass" | "warn" | "fail";
    detail?: string;
  }[];
}

export interface CareerOpsCoverLetterStages {
  stage1Hook: string;
  stage2Challenges: string;
  stage3ProofPoints: string;
  stage4Closing: string;
}

/**
 * ATS Linting Rules adapted from career-ops ats-rules.yml
 * Enforces parser-friendly structures, standard headers, and zero complex elements.
 */
export const CAREER_OPS_ATS_RULES = [
  {
    id: "single_column",
    name: "Single-Column Layout",
    description: "Ensure layout is strictly single-column. Multi-column tables or floating text boxes cause parsing failures in ATS systems.",
    severity: "critical",
  },
  {
    id: "standard_headers",
    name: "Canonical Section Headings",
    description: "Use standard headings: PROFESSIONAL SUMMARY, TECHNICAL SKILLS, PROFESSIONAL EXPERIENCE, EDUCATION, CERTIFICATIONS.",
    severity: "critical",
  },
  {
    id: "contact_clarity",
    name: "Clear Contact Information",
    description: "Header must contain candidate name, email, phone, and location without graphics or nested symbols.",
    severity: "critical",
  },
  {
    id: "bullet_structure",
    name: "Action Verb + Impact Bullets",
    description: "Every experience bullet point must begin with an active verb and contain measurable metrics or technical outcomes.",
    severity: "high",
  },
  {
    id: "keyword_density",
    name: "Role & Skill Alignment",
    description: "Incorporate targeted domain and job-description keywords naturally without keyword stuffing.",
    severity: "high",
  },
  {
    id: "no_hallucinations",
    name: "Strict Evidence Grounding",
    description: "Never fabricate employers, graduation dates, or skills outside candidate's verified profile.",
    severity: "critical",
  },
];

/**
 * Prompt Template for CV Re-framing against a specific Job Description.
 * Ported from career-ops CV tailoring prompt module.
 */
export function buildCareerOpsCvTailorPrompt(params: {
  candidate: CandidateProfile;
  job: {
    title: string;
    company: string;
    description?: string;
    location?: string;
  };
  missingKeywords?: string[];
}): string {
  const { candidate, job, missingKeywords = [] } = params;

  return `
You are the Career-Ops ATS Resume Tailoring Agent.
Task: Re-frame and optimize the candidate's verified resume for the following specific target job.

=== TARGET JOB ===
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || "Remote"}
Job Description:
${job.description || `${job.title} at ${job.company}`}

=== VERIFIED CANDIDATE PROFILE (SOURCE OF TRUTH) ===
Name: ${candidate.name}
Headline: ${candidate.headline || "Software Engineer"}
Verified Skills: ${(candidate.skills || []).join(", ")}
Verified Experience:
${(candidate.experience || [])
  .map(
    (e) => `• ${e.role} at ${e.company} (${e.startDate} - ${e.endDate}):\n  ${(e.bullets || []).join("\n  ")}`
  )
  .join("\n\n")}
Verified Education:
${(candidate.education || []).map((edu) => `• ${edu.degree} - ${edu.institution} (${edu.year})`).join("\n")}
Verified Certifications: ${(candidate.certifications || []).join(", ") || "None"}

=== ATS TARGET CRITERIA ===
1. Strict Single-Column format.
2. Canonical Headings: PROFESSIONAL SUMMARY, TECHNICAL SKILLS, PROFESSIONAL EXPERIENCE, EDUCATION, CERTIFICATIONS.
3. Target ATS match score >= 85 against the job description.
4. Natural incorporation of target domain and tech keywords: ${missingKeywords.slice(0, 8).join(", ") || "Role-specific technologies"}.
5. STRICT ZERO-HALLUCINATIONS:
   - Do NOT invent companies, employers, degrees, graduation years, or unverified claims.
   - Only re-frame, prioritize, and articulate the candidate's genuine achievements using the target JD's vocabulary.
`.trim();
}

/**
 * 4-Stage Cover Letter prompt template adapted from career-ops interactive cover letter engine:
 * 1. Why / Strategic Hook: Enthusiasm and alignment with company mission
 * 2. Their Problems / Challenges: Understanding what the team is solving based on JD
 * 3. My Approach / Proof Points: Concrete verified evidence from candidate's experience
 * 4. Close & Call to Action: Professional invitation for an interview/technical discussion
 */
export function buildCareerOpsCoverLetterPrompt(params: {
  candidate: CandidateProfile;
  job: {
    title: string;
    company: string;
    description?: string;
    location?: string;
  };
}): string {
  const { candidate, job } = params;

  return `
You are the Career-Ops Cover Letter Generator.
Craft a 4-stage, highly personalized, ATS-friendly cover letter for:
Candidate: ${candidate.name}
Target Role: ${job.title}
Target Company: ${job.company}
Location: ${job.location || "Remote"}

Job Description Focus:
${job.description ? job.description.slice(0, 1200) : `${job.title} at ${job.company}`}

Candidate Verified Background:
- Skills: ${(candidate.skills || []).slice(0, 10).join(", ")}
- Recent Experience: ${(candidate.experience || []).slice(0, 2).map((e) => `${e.role} at ${e.company}`).join("; ") || "Technical Projects & Academic Rigor"}

Follow the Career-Ops 4-Stage Structure:
Stage 1 (The Hook): Acknowledge ${job.company}'s work and articulate why ${candidate.name} is specifically applying for ${job.title}.
Stage 2 (Their Challenges): Reference the technical and operational challenges described in the job listing.
Stage 3 (My Approach & Proof Points): Present concrete accomplishments from candidate's real experience that prove readiness to tackle those exact challenges.
Stage 4 (The Close): Reiterate enthusiasm and propose a conversation about contributing to ${job.company}'s roadmap.

Rule: ZERO hallucinations. Only cite verified candidate projects and technologies.
`.trim();
}

/**
 * Validates a candidate profile against Career-Ops ATS Lint rules.
 */
export function lintCandidateProfileForAts(
  candidate: CandidateProfile,
  atsScore: number
): CareerOpsAtsLintResult {
  const checks: CareerOpsAtsLintResult["checks"] = [];

  // Check 1: Contact clarity
  const hasName = Boolean(candidate.name && candidate.name.trim() !== "Candidate");
  const hasContact = Boolean(candidate.email || candidate.phone);
  checks.push({
    ruleId: "contact_clarity",
    description: "Header contains clear contact info (Name, Email, Phone, Location)",
    status: hasName && hasContact ? "pass" : "warn",
    detail: hasName && hasContact ? "Contact block is well-structured" : "Provide valid email/phone in profile",
  });

  // Check 2: Canonical headings
  const hasSummary = Boolean(candidate.summary && candidate.summary.length > 20);
  const hasSkills = Boolean(candidate.skills && candidate.skills.length > 0);
  const hasExperience = Boolean(candidate.experience && candidate.experience.length > 0);
  const hasEducation = Boolean(candidate.education && candidate.education.length > 0);

  checks.push({
    ruleId: "standard_headers",
    description: "Standard ATS headings present (Summary, Skills, Experience, Education)",
    status: hasSummary && hasSkills && (hasExperience || hasEducation) ? "pass" : "warn",
    detail: "Standard section titles ensure reliable ATS classification",
  });

  // Check 3: Action verb & bullet structure
  let totalBullets = 0;
  let actionVerbBullets = 0;
  const actionVerbRegex = /^(Architected|Engineered|Built|Designed|Developed|Implemented|Optimized|Spearheaded|Created|Standardized|Automated|Integrated|Led|Managed|Refactored|Reduced|Increased|Scaled|Deployed|Maintained)\b/i;

  (candidate.experience || []).forEach((exp) => {
    (exp.bullets || []).forEach((bullet) => {
      totalBullets++;
      if (actionVerbRegex.test(bullet.trim())) {
        actionVerbBullets++;
      }
    });
  });

  checks.push({
    ruleId: "bullet_structure",
    description: "Bullet points structured with strong action verbs",
    status: totalBullets === 0 || actionVerbBullets / totalBullets >= 0.7 ? "pass" : "warn",
    detail: totalBullets > 0 ? `${actionVerbBullets}/${totalBullets} bullets start with action verbs` : "No experience bullets to check",
  });

  // Check 4: ATS Target Score
  checks.push({
    ruleId: "ats_score_target",
    description: "ATS alignment score meets or exceeds 85 target",
    status: atsScore >= 85 ? "pass" : "warn",
    detail: `Current ATS score: ${atsScore}/100`,
  });

  const passed = checks.every((c) => c.status !== "fail") && atsScore >= 85;

  return {
    passed,
    score: atsScore,
    checks,
  };
}
