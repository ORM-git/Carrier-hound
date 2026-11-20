import { describe, it, expect } from "vitest";
import {
  answersFromCandidate,
  buildRelevancePrefilter,
  fieldsForTitle,
  isRelevantToProfile,
  OnboardingAnswers,
  rankJobsByRecommendation,
  scoreJobRecommendation,
} from "@/lib/jobs/recommendations";
import { compareByRecommendedRanking, withSharedScore, computeFitDiagnostics } from "@/lib/matcher/scoring";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";

const recent = new Date(Date.now() - 2 * 864e5).toISOString();
const remoteJob = (id: string, title: string, category: string) => ({
  id,
  title,
  category,
  location: "Remote (Worldwide)",
  remote: true,
  remote_scope: "worldwide",
  job_type: "full-time",
  posted_at: recent,
});

// Real titles from the live jobs table with their stored categories ("engineering" is the ingest default
// for many non-tech roles, e.g. legal).
const REAL_TITLES: [string, string][] = [
  ["Backend Engineer, GitLab Orbit", "engineering"],
  ["Senior Backend Engineer, Identity and Access Management", "engineering"],
  ["Staff Backend Engineer, Database Automation (Go)", "data"],
  ["Fullstack Software Engineer (x/f/m) - Product Platform", "devops"],
  ["DevOps Engineer (Observability)", "devops"],
  ["Founding Engineer", "engineering"],
  ["Commercial Counsel", "engineering"],
  ["Lead Counsel, Litigation", "engineering"],
  ["Account Executive, Strategic", "sales"],
  ["Enterprise Account Executive - Financial Services", "sales"],
  ["Sales Development Representative", "sales"],
  ["Presales Solutions Engineer, Defense", "sales"],
  ["Technical Recruiter, OpenRouter (Fixed Term)", "hr"],
  ["Tokenization Analyst", "engineering"],
  ["Principal Product Marketing Manager, Competitive", "marketing"],
  ["Senior Content Marketing Manager", "marketing"],
  ["Lifecycle Marketing Manager, Capital", "marketing"],
  ["Executive Assistant, Marketing", "marketing"],
  ["Senior Software Engineer, Marketing Technology", "marketing"],
  ["Financial Analyst, G&A", "engineering"],
  ["Senior Financial Analyst (FP&A) - Entertainment", "engineering"],
  ["International Payroll Analyst", "finance"],
  ["Strategic Finance Analyst", "finance"],
  ["Software Engineer, Financial Data & Payments", "data"],
  ["AI Strategist, Financial Services", "ai"],
  ["Product Manager, Payments", "product"],
  ["Senior Product Designer", "design"],
  ["Data Analyst", "data"],
];
const corpus = REAL_TITLES.map(([t, c], i) => remoteJob(`j${i}`, t, c));

const PROFILES: Record<string, { answers: OnboardingAnswers; onRole: RegExp }> = {
  backend: {
    answers: { roles: ["Backend Developer"], experienceLevel: "mid", remotePreference: "remote", employmentTypes: ["full-time"] },
    onRole: /backend|software engineer|fullstack|devops|founding engineer/i,
  },
  marketing: {
    answers: { roles: ["Marketing Manager"], experienceLevel: "mid", remotePreference: "remote", employmentTypes: ["full-time"] },
    onRole: /marketing manager/i,
  },
  finance: {
    answers: { roles: ["Financial Analyst"], experienceLevel: "mid", remotePreference: "remote", employmentTypes: ["full-time"] },
    onRole: /financial analyst|payroll|finance analyst/i,
  },
};

describe("relevance gate", () => {
  it("the audit case: Commercial Counsel scores 0 for a backend developer, however well location/seniority match", () => {
    const res = scoreJobRecommendation(remoteJob("c", "Commercial Counsel", "engineering"), PROFILES.backend.answers);
    expect(res.score).toBe(0);
    expect(res.reasons.join(" ")).toMatch(/Not relevant/);
  });

  for (const [name, { answers, onRole }] of Object.entries(PROFILES)) {
    it(`${name}: every recommendation is on-role, and every on-role job is recommended`, () => {
      const ranked = rankJobsByRecommendation(corpus, answers);
      expect(ranked.length).toBeGreaterThan(0);
      for (const job of ranked.slice(0, 20)) expect(job.title).toMatch(onRole);
      const expected = corpus.filter((j) => onRole.test(j.title)).map((j) => j.id).sort();
      expect(ranked.map((j) => j.id).sort()).toEqual(expected);
    });
  }

  it("a domain word in another field's title never qualifies it", () => {
    const finance = PROFILES.finance.answers;
    expect(isRelevantToProfile(remoteJob("1", "Enterprise Account Executive - Financial Services", "sales"), finance)).toBe(false);
    expect(isRelevantToProfile(remoteJob("2", "Software Engineer, Financial Data & Payments", "data"), finance)).toBe(false);
    expect(isRelevantToProfile(remoteJob("3", "AI Strategist, Financial Services", "ai"), finance)).toBe(false);
    expect(isRelevantToProfile(remoteJob("4", "Executive Assistant, Marketing", "marketing"), PROFILES.marketing.answers)).toBe(false);
  });

  it("the 'engineering' category alone is not trusted, but generic engineering titles in it are", () => {
    const backend = PROFILES.backend.answers;
    expect(isRelevantToProfile(remoteJob("1", "Founding Engineer", "engineering"), backend)).toBe(true);
    expect(isRelevantToProfile(remoteJob("2", "Billing Operations Analyst", "engineering"), backend)).toBe(false);
    expect(isRelevantToProfile(remoteJob("3", "Tokenization Analyst", "engineering"), backend)).toBe(false);
  });

  it("a trusted category decides when the title names no field", () => {
    expect(isRelevantToProfile(remoteJob("1", "Associate, Growth Programs", "marketing"), PROFILES.marketing.answers)).toBe(true);
    expect(isRelevantToProfile(remoteJob("2", "Associate", "sales"), PROFILES.marketing.answers)).toBe(false);
  });

  it("seniority and generic words never count as overlap", () => {
    const answers = { roles: ["Senior Data Analyst"] };
    expect(isRelevantToProfile(remoteJob("1", "Senior Account Executive", "sales"), answers)).toBe(false);
    expect(isRelevantToProfile(remoteJob("2", "Analyst, Partnerships", "sales"), answers)).toBe(false);
    expect(isRelevantToProfile(remoteJob("3", "Senior Data Analyst", "data"), answers)).toBe(true);
  });

  it("with no field, a distinctive shared role word or resume skill decides", () => {
    expect(isRelevantToProfile(remoteJob("1", "Kubernetes Specialist", "engineering"), { resumeProfile: { skills: ["Kubernetes"] } })).toBe(true);
    expect(isRelevantToProfile(remoteJob("2", "Office Assistant", "engineering"), { resumeProfile: { skills: ["Kubernetes"] } })).toBe(false);
  });

  it("is open for users with no role, field or skill signals (nothing to compare)", () => {
    const answers: OnboardingAnswers = { locations: ["India"], remotePreference: "remote" };
    expect(isRelevantToProfile(remoteJob("1", "Commercial Counsel", "engineering"), answers)).toBe(true);
    expect(buildRelevancePrefilter(answers)).toBeNull();
  });

  it("classifies titles by role noun", () => {
    expect(Array.from(fieldsForTitle("Commercial Counsel"))).toEqual(["legal"]);
    expect(Array.from(fieldsForTitle("Enterprise Account Executive - Financial Services"))).toEqual(["sales"]);
    expect(Array.from(fieldsForTitle("Senior Software Engineer, Marketing Technology"))).toEqual(["engineering"]);
    expect(Array.from(fieldsForTitle("Senior Content Marketing Manager"))).toEqual(["marketing"]);
  });
});

describe("relevance pre-filter (candidate pool query)", () => {
  for (const [name, { answers }] of Object.entries(PROFILES)) {
    it(`${name}: is a superset of the gate and uses only PostgREST-safe terms`, () => {
      const pf = buildRelevancePrefilter(answers)!;
      for (const t of pf.terms) expect(t).not.toMatch(/[%_(),"'`;\\$*]/);
      for (const c of pf.categories) expect(c).toMatch(/^[a-z-]+$/);
      for (const job of corpus) {
        if (isRelevantToProfile(job, answers)) expect(matchesPostgrestOr(pf.orClause, job)).toBe(true);
      }
    });
  }

  it("excludes clearly off-field jobs from the pool", () => {
    const pf = buildRelevancePrefilter(PROFILES.finance.answers)!;
    expect(matchesPostgrestOr(pf.orClause, remoteJob("x", "DevOps Engineer (Observability)", "devops"))).toBe(false);
  });
});

describe("one scoring path across surfaces", () => {
  it("the Recommended re-sort keeps the shared server order when jobs carry the shared score", () => {
    const a = { id: "a", title: "Backend Engineer", matchScore: 60, salary: "", postedAt: recent };
    const b = { id: "b", title: "Backend Engineer II", matchScore: 80, salary: "$200k", postedAt: recent };
    expect([a, b].sort((x, y) => compareByRecommendedRanking(x, y, null, null)).map((j) => j.id)).toEqual(["b", "a"]);
    const a2 = { ...a, matchScore: 90 };
    expect([b, a2].sort((x, y) => compareByRecommendedRanking(x, y, null, null)).map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("resume users are scored by the shared scorer with their resume as the profile", () => {
    const candidate: any = {
      headline: "Backend developer",
      skills: ["Go", "PostgreSQL"],
      experience: [{ id: "1", company: "X", role: "Backend Engineer", startDate: "", endDate: "", bullets: [] }],
      education: [],
      certifications: [],
      name: "",
      email: "",
      phone: "",
      summary: "",
      updatedAt: "",
    };
    const answers = answersFromCandidate(candidate, null);
    expect(answers.roles).toEqual(["Backend Engineer"]);
    expect(scoreJobRecommendation(remoteJob("c", "Commercial Counsel", "engineering"), answers).score).toBe(0);
    expect(scoreJobRecommendation(remoteJob("b", "Senior Backend Engineer", "engineering"), answers).score).toBeGreaterThan(0);
    // Saved target roles win over the resume title
    expect(answersFromCandidate(candidate, { roles: ["Data Engineer"] }).roles).toEqual(["Data Engineer"]);
  });

  it("explanation views carry the shared score and its grade", () => {
    const fit = computeFitDiagnostics(
      { skills: ["Go"], experience: [], education: [], certifications: [], name: "", email: "", phone: "", headline: "", summary: "", updatedAt: "", confirmedAt: "x" } as any,
      { title: "Backend Engineer", skills: ["Go"] }
    );
    const shared = withSharedScore(fit, 78);
    expect(shared.score).toBe(78);
    expect(shared.scoreGrade).toBe("high");
    expect(shared.matchedSkills).toEqual(fit.matchedSkills);
    expect(withSharedScore(fit, 40).scoreGrade).toBe("moderate");
  });
});
