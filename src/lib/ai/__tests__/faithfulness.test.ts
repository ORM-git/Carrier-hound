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
      expect(report.verdict).toBe("faithful");
      expect(report.violations).toEqual([]);
      expect(report.checkedCount).toBeGreaterThan(0);
      expect(report.relationsVerified).toBe("verified_segmented");
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
      expect(report.verdict).toBe("unfaithful");
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
      expect(report.verdict).toBe("unfaithful");
      expect(report.violations[0].kind).toBe("skill_or_tool");
    });
  });

  describe("cover_letter faithfulness", () => {
    it("accepts cover letter prose grounded in candidate and job payload", () => {
      const letter =
        "I am excited to apply for Senior Frontend Engineer at Linear Systems. During my role as Senior Frontend Engineer at Acme Corp, I built design systems using React and TypeScript and reduced bundle size by 35% across 12 pages.";
      const report = verifyCoverLetterFaithfulness(letter, BASE_CANDIDATE, TARGET_JOB);
      expect(report.faithful).toBe(true);
      expect(report.verdict).toBe("faithful");
      expect(report.violations).toEqual([]);
    });

    it("rejects claiming JD-only skill (Kubernetes), fake metric, wrong email/URL, or unverified employer", () => {
      const unfaithfulLetter =
        "While worked at Stripe, I led Kubernetes clusters across 500 nodes and cut costs by 80%. Reach me at fake@example.com or https://linkedin.com/in/fake-alex.";
      const report = verifyCoverLetterFaithfulness(unfaithfulLetter, BASE_CANDIDATE, TARGET_JOB);
      expect(report.faithful).toBe(false);
      expect(report.verdict).toBe("unfaithful");
      const reasons = report.violations.map((v) => v.reason).join(" | ");
      expect(reasons).toContain("Kubernetes".toLowerCase());
      expect(reasons).toContain("Stripe");
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
      expect(report.verdict).toBe("unfaithful");
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
      expect(report.verdict).toBe("faithful");
      expect(report.violations).toEqual([]);
    });

    it("rejects fake matchedSkills, contradicting missingSkills (already on resume), and ungrounded summary facts", () => {
      const report = verifyMatchExplanationFaithfulness(
        {
          score: 90,
          matchedSkills: ["Kubernetes", "GraphQL"],
          missingSkills: ["React", "Rust"],
          summary:
            "Your 10 years at Amazon with Terraform and 65% latency improvements align well.",
        },
        BASE_CANDIDATE,
        TARGET_JOB
      );
      expect(report.faithful).toBe(false);
      expect(report.verdict).toBe("unfaithful");
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
      expect(fitReport.verdict).toBe("faithful");
    });
  });

  describe("adversarial regressions (reviewer rework cases 1-7)", () => {
    it("1. rejects target job company claimed as candidate employment ('I worked at Google.')", () => {
      const acmeCand: Partial<CandidateProfile> = {
        skills: ["React"],
        experience: [{ id: "1", company: "Acme", role: "Engineer", startDate: "2020", endDate: "2022", bullets: [] }],
      };
      const report = verifyCoverLetterFaithfulness(
        "I worked at Google.",
        acmeCand,
        { title: "Frontend Engineer", company: "Google", description: "React role." }
      );
      expect(report.faithful).toBe(false);
      expect(report.verdict).toBe("unfaithful");
      expect(report.violations.some((v) => v.kind === "employer_or_organization" && v.claim === "Google")).toBe(
        true
      );
    });

    it("2. rejects job title self-identification outside application span ('I am a Kubernetes Engineer.')", () => {
      const reactOnlyCand: Partial<CandidateProfile> = {
        skills: ["React"],
      };
      const k8sJob = {
        title: "Kubernetes Engineer",
        company: "CloudCo",
        description: "Manage Kubernetes infrastructure.",
      };
      const badReport = verifyCoverLetterFaithfulness(
        "I am a Kubernetes Engineer.",
        reactOnlyCand,
        k8sJob
      );
      expect(badReport.faithful).toBe(false);
      expect(badReport.verdict).toBe("unfaithful");
      expect(badReport.checkedCount).toBeGreaterThan(0);
      expect(badReport.violations.some((v) => v.kind === "skill_or_tool" && v.claim === "kubernetes")).toBe(
        true
      );

      // Greeting / application-context span exemption still works when applying + using verified skills
      const honestAppReport = verifyCoverLetterFaithfulness(
        "I am excited to apply for the Kubernetes Engineer position at CloudCo, bringing my React experience.",
        reactOnlyCand,
        k8sJob
      );
      expect(honestAppReport.faithful).toBe(true);
      expect(honestAppReport.verdict).toBe("faithful");
    });

    it("3. prevents laundering JD numbers into cover letter achievements ('I increased revenue by 80%.')", () => {
      const candWithout80: Partial<CandidateProfile> = {
        skills: ["TypeScript"],
        experience: [
          {
            id: "1",
            company: "Acme",
            role: "Engineer",
            startDate: "2021",
            endDate: "2023",
            bullets: ["Reduced bundle size by 15%."],
          },
        ],
      };
      const jdWith80 = {
        title: "Staff Engineer",
        company: "ScaleCo",
        description: "Join after our revenue grew 80% year over year.",
      };
      const report = verifyCoverLetterFaithfulness(
        "I increased revenue by 80%.",
        candWithout80,
        jdWith80
      );
      expect(report.faithful).toBe(false);
      expect(report.verdict).toBe("unfaithful");
      expect(report.violations.some((v) => v.kind === "numeric_metric" && v.claim === "80%")).toBe(true);
    });

    it("4. enforces subject ownership in match explanation ('Candidate has Kubernetes expertise.')", () => {
      const cand: Partial<CandidateProfile> = {
        skills: ["React", "TypeScript"],
      };
      const jd = {
        title: "Fullstack Engineer",
        company: "CloudCo",
        description: "Must know React, TypeScript, and Kubernetes.",
      };
      const report = verifyMatchExplanationFaithfulness(
        {
          score: 70,
          matchedSkills: ["React"],
          missingSkills: ["Kubernetes"],
          summary: "Candidate has Kubernetes expertise.",
        },
        cand,
        jd
      );
      expect(report.faithful).toBe(false);
      expect(report.verdict).toBe("unfaithful");
      expect(report.violations.some((v) => v.kind === "skill_or_tool" && v.claim === "kubernetes")).toBe(
        true
      );
    });

    it("5. handles negated/aspirational skill wording without false unsupported-skill failure", () => {
      const reactCand: Partial<CandidateProfile> = {
        skills: ["React", "TypeScript"],
        experience: [
          {
            id: "1",
            company: "Acme",
            role: "Engineer",
            startDate: "2021",
            endDate: "2024",
            bullets: ["Built React UI components."],
          },
        ],
      };
      const jd = {
        title: "Platform Frontend Engineer",
        company: "CloudCo",
        description: "React, TypeScript, Kubernetes.",
      };

      // Standalone negated/aspirational sentence: zero unsupported-skill error, marked inconclusive (never faithful)
      const standalone = verifyCoverLetterFaithfulness(
        "I have not used Kubernetes yet, and want to learn it.",
        reactCand,
        jd
      );
      expect(standalone.violations.some((v) => v.kind === "skill_or_tool")).toBe(false);
      expect(standalone.verdict).toBe("inconclusive");
      expect(standalone.faithful).toBe(false);

      // Combined with grounded claims: honest disclaimer passes cleanly
      const honestLetter = verifyCoverLetterFaithfulness(
        "At Acme I built React interfaces. I have not used Kubernetes yet, and want to learn it.",
        reactCand,
        jd
      );
      expect(honestLetter.faithful).toBe(true);
      expect(honestLetter.verdict).toBe("faithful");
      expect(honestLetter.violations).toEqual([]);
    });

    it("6. detects cross-employer reassignment in resume_extraction (inline and multiline)", () => {
      const inlineRaw = "Acme Engineer 2020 UI 20%, Beta Director 2022 sales 80%";
      const reassigned: Partial<CandidateProfile> = {
        experience: [
          {
            id: "exp-1",
            company: "Acme",
            role: "Director",
            startDate: "2022",
            endDate: "2022",
            bullets: ["Grew sales by 80%"],
          },
        ],
      };
      const inlineReport = verifyResumeExtractionFaithfulness(reassigned, inlineRaw);
      expect(inlineReport.faithful).toBe(false);
      expect(inlineReport.verdict).toBe("unfaithful");
      expect(inlineReport.relationsVerified).toBe("verified_segmented");
      expect(
        inlineReport.violations.some((v) => v.kind === "cross_employer_relation")
      ).toBe(true);

      const multilineRaw = [
        "Acme | Engineer | 2020",
        "- Built UI with 20% faster load",
        "",
        "Beta | Director | 2022",
        "- Drove sales 80%",
      ].join("\n");
      const multilineReport = verifyResumeExtractionFaithfulness(reassigned, multilineRaw);
      expect(multilineReport.faithful).toBe(false);
      expect(multilineReport.verdict).toBe("unfaithful");
      expect(
        multilineReport.violations.some((v) => v.kind === "cross_employer_relation")
      ).toBe(true);
    });

    it("7. rejects fabricated endDate 'Present' and marks empty/zero-claim inputs inconclusive", () => {
      const ended2021Raw = "Acme Corp | Senior Engineer | 2019 - 2021\n- Built TypeScript services.";
      const presentReport = verifyResumeExtractionFaithfulness(
        {
          experience: [
            {
              id: "1",
              company: "Acme Corp",
              role: "Senior Engineer",
              startDate: "2019",
              endDate: "Present",
              bullets: ["Built TypeScript services."],
            },
          ],
        },
        ended2021Raw
      );
      expect(presentReport.faithful).toBe(false);
      expect(presentReport.verdict).toBe("unfaithful");
      expect(
        presentReport.violations.some((v) => v.kind === "date_or_year" && v.claim.toLowerCase() === "present")
      ).toBe(true);

      // Empty {} extracted against non-empty rawText -> inconclusive, never faithful
      const emptyExtractReport = verifyResumeExtractionFaithfulness({}, ended2021Raw);
      expect(emptyExtractReport.faithful).toBe(false);
      expect(emptyExtractReport.verdict).toBe("inconclusive");
      expect(emptyExtractReport.checkedCount).toBe(0);

      // Missing/invalid shape via dispatcher -> inconclusive, never faithful
      const badShapeFit = verifyAiOutputFaithfulness("job_fit", null, {
        candidate: BASE_CANDIDATE,
        job: TARGET_JOB,
      });
      expect(badShapeFit.faithful).toBe(false);
      expect(badShapeFit.verdict).toBe("inconclusive");

      const emptyFit = verifyMatchExplanationFaithfulness({}, BASE_CANDIDATE, TARGET_JOB);
      expect(emptyFit.faithful).toBe(false);
      expect(emptyFit.verdict).toBe("inconclusive");

      const genericLetter = verifyCoverLetterFaithfulness(
        "Thank you for your time and consideration.",
        BASE_CANDIDATE,
        TARGET_JOB
      );
      expect(genericLetter.faithful).toBe(false);
      expect(genericLetter.verdict).toBe("inconclusive");
    });
  });
});
