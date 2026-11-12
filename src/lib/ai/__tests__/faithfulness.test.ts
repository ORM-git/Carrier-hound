import { describe, it, expect } from "vitest";
import {
  verifyResumeExtractionFaithfulness,
  verifyCoverLetterFaithfulness,
  verifyMatchExplanationFaithfulness,
  verifyAiOutputFaithfulness,
  extractTaxonomySkillsFromText,
  extractNumericFactsFromText,
} from "../faithfulness";
import { CandidateProfile } from "../../resume/types";

const BASE_RESUME_RAW = `
Alex Chen
alex.chen@example.com | (415) 555-0199
San Francisco, CA

SUMMARY
Frontend engineer with 4+ years building accessible web apps in TypeScript and React.

SKILLS
TypeScript, React, Next.js, Tailwind CSS, GraphQL

EXPERIENCE
Senior Frontend Engineer | Acme Corp | 2021 - Present
- Reduced bundle size by 35% and improved Lighthouse score across 12 pages.
- Built shared design system components using React and TypeScript.

EDUCATION
B.S. in Computer Science, State University, 2019

CERTIFICATIONS
AWS Certified Cloud Practitioner
`;

const BASE_CANDIDATE: Partial<CandidateProfile> = {
  name: "Alex Chen",
  email: "alex.chen@example.com",
  phone: "(415) 555-0199",
  headline: "Frontend Engineer | TypeScript & React",
  summary: "Frontend engineer with 4+ years building accessible web apps in TypeScript and React.",
  skills: ["TypeScript", "React", "Next.js", "Tailwind CSS", "GraphQL"],
  experience: [
    {
      id: "exp-1",
      company: "Acme Corp",
      role: "Senior Frontend Engineer",
      startDate: "2021",
      endDate: "Present",
      bullets: [
        "Reduced bundle size by 35% and improved Lighthouse score across 12 pages.",
        "Built shared design system components using React and TypeScript.",
      ],
    },
  ],
  education: [
    {
      id: "edu-1",
      degree: "B.S. in Computer Science",
      institution: "State University",
      year: "2019",
    },
  ],
  certifications: ["AWS Certified Cloud Practitioner"],
};

const TARGET_JOB = {
  title: "Senior Frontend Engineer",
  company: "Linear Systems",
  description:
    "Looking for a Senior Frontend Engineer experienced with TypeScript, React, Next.js, Kubernetes deployment previews, and 4+ years experience.",
};

describe("AI Output Faithfulness Verifiers (offline v1)", () => {
  describe("shared extraction & disambiguation helpers", () => {
    it("suppresses lowercase English 'go'/'rest' in prose while preserving explicit 'Go'/'REST'", () => {
      const prose = "I want to go further and support the rest of your engineering team.";
      expect(extractTaxonomySkillsFromText(prose)).toEqual([]);

      const explicitTech = "Built Go microservices exposing REST APIs and React Native apps.";
      const found = extractTaxonomySkillsFromText(explicitTech);
      expect(found).toContain("go");
      expect(found).toContain("rest");
      expect(found).toContain("react native");
      expect(found).not.toContain("react");
    });

    it("normalizes numbers with commas and currencies", () => {
      expect(extractNumericFactsFromText("Served 10,000+ users, cut latency 40% with $50k savings")).toEqual([
        "10000+",
        "40%",
        "$50k",
      ]);
    });
  });

  describe("resume_extraction faithfulness", () => {
    it("accepts extracted resume facts strictly grounded in rawText", () => {
      const report = verifyResumeExtractionFaithfulness(BASE_CANDIDATE, BASE_RESUME_RAW);
      expect(report.faithful).toBe(true);
      expect(report.violations).toEqual([]);
      expect(report.checkedCount).toBeGreaterThan(0);
    });

    it("rejects fabricated skills, employers, metrics, degrees, years, and contact info", () => {
      const hallucinated: Partial<CandidateProfile> = {
        ...BASE_CANDIDATE,
        email: "wrong@evil.com",
        skills: [...(BASE_CANDIDATE.skills || []), "Kubernetes", "Rust"],
        experience: [
          {
            id: "exp-1",
            company: "Stripe",
            role: "Principal Staff Engineer",
            startDate: "2016",
            endDate: "Present",
            bullets: ["Scaled payment pipeline throughput by 99% using Terraform."],
          },
        ],
        education: [
          {
            id: "edu-1",
            degree: "PhD in Quantum Computing",
            institution: "MIT",
            year: "2015",
          },
        ],
      };

      const report = verifyResumeExtractionFaithfulness(hallucinated, BASE_RESUME_RAW);
      expect(report.faithful).toBe(false);
      const kinds = new Set(report.violations.map((v) => v.kind));
      expect(kinds.has("contact_or_link")).toBe(true);
      expect(kinds.has("skill_or_tool")).toBe(true);
      expect(kinds.has("employer_or_organization")).toBe(true);
      expect(kinds.has("role_or_title")).toBe(true);
      expect(kinds.has("date_or_year")).toBe(true);
      expect(kinds.has("numeric_metric")).toBe(true);
      expect(kinds.has("education_or_degree")).toBe(true);
    });

    it("prevents React Native in rawText from falsely justifying React", () => {
      const rnRaw = "Alex Chen. Skills: React Native, TypeScript.";
      const report = verifyResumeExtractionFaithfulness({ skills: ["React"] }, rnRaw);
      expect(report.faithful).toBe(false);
      expect(report.violations[0].kind).toBe("skill_or_tool");
    });
  });

  describe("cover_letter faithfulness", () => {
    it("accepts cover letter prose grounded in candidate and job payload", () => {
      const letter =
        "I am excited to apply for Senior Frontend Engineer at Linear Systems. During my role as Senior Frontend Engineer at Acme Corp, I built design systems using React and TypeScript and reduced bundle size by 35% across 12 pages.";
      const report = verifyCoverLetterFaithfulness(letter, BASE_CANDIDATE, TARGET_JOB);
      expect(report.faithful).toBe(true);
      expect(report.violations).toEqual([]);
    });

    it("rejects claiming JD-only skill (Kubernetes), fake metric, wrong email/URL, or unverified employer", () => {
      const unfaithfulLetter =
        "While worked at Google, I led Kubernetes clusters across 500 nodes and cut costs by 80%. Reach me at fake@example.com or https://linkedin.com/in/fake-alex.";
      const report = verifyCoverLetterFaithfulness(unfaithfulLetter, BASE_CANDIDATE, TARGET_JOB);
      expect(report.faithful).toBe(false);
      const reasons = report.violations.map((v) => v.reason).join(" | ");
      expect(reasons).toContain("Kubernetes".toLowerCase());
      expect(reasons).toContain("Google");
      expect(reasons).toContain("80%");
      expect(reasons).toContain("fake@example.com");
      expect(reasons).toContain("https://linkedin.com/in/fake-alex");
    });

    it("rejects claiming years of experience for a fresher with 0 experience entries", () => {
      const fresher: Partial<CandidateProfile> = {
        name: "Sam Patel",
        skills: ["Python", "SQL"],
        experience: [],
      };
      const job = {
        title: "Junior Data Analyst",
        company: "DataCo",
        description: "Requires 5 years experience in Python and SQL.",
      };
      const letter = "With 5 years of experience in Python, I would love to join DataCo.";
      const report = verifyCoverLetterFaithfulness(letter, fresher, job);
      expect(report.faithful).toBe(false);
      expect(report.violations.some((v) => v.kind === "experience_claim" || v.kind === "numeric_metric")).toBe(
        true
      );
    });
  });

  describe("job_fit (match explanation) faithfulness", () => {
    it("accepts consistent match explanation grounded in candidate and job", () => {
      const report = verifyMatchExplanationFaithfulness(
        {
          score: 84,
          matchedSkills: ["TypeScript", "React", "Next.js"],
          missingSkills: ["Kubernetes"],
          summary:
            "Strong 84% fit: you bring React, TypeScript, and Next.js for Linear Systems, though Kubernetes is missing.",
        },
        BASE_CANDIDATE,
        TARGET_JOB
      );
      expect(report.faithful).toBe(true);
      expect(report.violations).toEqual([]);
    });

    it("rejects fake matchedSkills, contradicting missingSkills (already on resume), and ungrounded summary facts", () => {
      const report = verifyMatchExplanationFaithfulness(
        {
          score: 90,
          matchedSkills: ["Kubernetes", "GraphQL"], // Kubernetes missing from candidate; GraphQL absent from job
          missingSkills: ["React", "Rust"], // React already on candidate; Rust absent from job
          summary:
            "Your 10 years at Amazon with Terraform and 65% latency improvements align well.",
        },
        BASE_CANDIDATE,
        TARGET_JOB
      );
      expect(report.faithful).toBe(false);
      const kinds = new Set(report.violations.map((v) => v.kind));
      expect(kinds.has("skill_or_tool")).toBe(true);
      expect(kinds.has("skill_contradiction")).toBe(true);
      expect(kinds.has("numeric_metric")).toBe(true);
      expect(kinds.has("employer_or_organization")).toBe(true);
    });

    it("routes operations via verifyAiOutputFaithfulness dispatcher", () => {
      const fitReport = verifyAiOutputFaithfulness(
        "job_fit",
        { score: 75, matchedSkills: ["TypeScript"], missingSkills: [], summary: "Matches TypeScript." },
        { candidate: BASE_CANDIDATE, job: TARGET_JOB }
      );
      expect(fitReport.operation).toBe("job_fit");
      expect(fitReport.faithful).toBe(true);
    });
  });
});
