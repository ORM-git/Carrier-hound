import { describe, it, expect } from "vitest";
import {
  hasOnboardingAnswers,
  rankJobsByRecommendation,
  scoreJobRecommendation,
  scoreResumeMatch,
  RESUME_SKILL_MAX,
  RESUME_TITLE_MAX,
} from "@/lib/jobs/recommendations";

const recent = new Date(Date.now() - 2 * 864e5).toISOString();
const job = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  location: "Remote",
  remote: true,
  remote_scope: "worldwide",
  job_type: "full-time",
  posted_at: recent,
  ...extra,
});

const resume = {
  jobTitles: ["Data Analyst"],
  preferredRoles: ["Senior Data Analyst"],
  skills: ["SQL", "Tableau", "Python", "C++"],
  yearsOfExperience: 4,
};

describe("resume boost (soft ranking only)", () => {
  it("scores 0 and adds no breakdown field without a resume", () => {
    expect(scoreResumeMatch(job("1", "Data Analyst"), null)).toEqual({ score: 0, reasons: [] });
    const s = scoreJobRecommendation(job("1", "Data Analyst"), { roles: ["Data Analyst"] });
    expect(s.breakdown).not.toHaveProperty("resumeScore");
  });

  it("matches a resume title phrase and skills in title / skills list / description", () => {
    const r = scoreResumeMatch(
      job("1", "Senior Data Analyst", { skills: ["SQL"], description: "Build dashboards in Tableau with Python." }),
      resume
    );
    // title phrase (8) + three skills x 2 (6)
    expect(r.score).toBe(RESUME_TITLE_MAX + 6);
    expect(RESUME_SKILL_MAX).toBe(7);
    expect(r.reasons.join(" ")).toMatch(/resume title/);
    expect(r.reasons.join(" ")).toMatch(/SQL, Tableau, Python/);
  });

  it("uses whole-term matching (no 'SQL' in 'NoSQLite', handles 'C++')", () => {
    expect(scoreResumeMatch(job("1", "Engineer", { description: "We use NoSQLite." }), { skills: ["SQL"] }).score).toBe(0);
    expect(scoreResumeMatch(job("1", "Engineer", { description: "Modern C++ and Rust." }), { skills: ["C++"] }).score).toBe(2);
  });

  it("caps the boost at 15", () => {
    const r = scoreResumeMatch(
      job("1", "Data Analyst", { description: "a b c d e f g h" }),
      { jobTitles: ["Data Analyst"], skills: ["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => x + x) }
    );
    expect(r.score).toBeLessThanOrEqual(15);
  });

  it("hasOnboardingAnswers is false for resume alone (eligibility independent of resume)", () => {
    expect(hasOnboardingAnswers({ resumeProfile: resume })).toBe(false);
    expect(hasOnboardingAnswers({ resumeProfile: { skills: [], jobTitles: [" "] } })).toBe(false);
  });

  it("the job ID set is unchanged with and without a resume, keeping existing hard preferences", () => {
    const jobsList = [
      job("j1", "Frontend Engineer", { skills: ["React"] }),
      job("j2", "Data Analyst", { skills: ["SQL", "Tableau"] }),
      job("j3", "DevOps Engineer", { skills: ["AWS", "Docker"] }),
      job("j4", "Senior Architect", { skills: ["System Design"] }),
      job("j5", "Onsite Sales", { remote: false, remote_scope: "onsite", location: "Pune" }),
    ];

    // Case 1: No onboarding answers - all jobs returned with or without resume
    const withoutResume1 = rankJobsByRecommendation(jobsList, {});
    const withResume1 = rankJobsByRecommendation(jobsList, { resumeProfile: resume });
    expect(withResume1.map((j) => j.id).sort()).toEqual(withoutResume1.map((j) => j.id).sort());

    // Case 2: With onboarding answers and hard preferences (entry level hard-excludes senior/lead)
    const baseAnswers = { roles: ["Engineer"], remotePreference: "remote", experienceLevel: "entry" };
    const withoutResume2 = rankJobsByRecommendation(jobsList, baseAnswers);
    const withResume2 = rankJobsByRecommendation(jobsList, { ...baseAnswers, resumeProfile: resume });
    expect(withResume2.map((j) => j.id).sort()).toEqual(withoutResume2.map((j) => j.id).sort());
    // Seniority is still a hard preference; Open to Remote is additive, so the onsite job stays
    expect(withResume2.map((j) => j.id)).not.toContain("j4"); // Senior excluded for entry
    expect(withResume2.map((j) => j.id)).toContain("j5"); // Onsite kept: remote preference is additive
  });

  it("ranks resume-matching jobs above equal jobs that don't match", () => {
    const answers = { remotePreference: "remote", resumeProfile: resume };
    const ranked = rankJobsByRecommendation(
      [job("a", "Sales Executive"), job("b", "Data Analyst", { skills: ["SQL", "Tableau"] }), job("c", "Office Manager")],
      answers
    );
    expect(ranked[0].id).toBe("b");
    expect(ranked.map((j) => j.id)).toEqual(expect.arrayContaining(["a", "c"])); // nothing dropped by the resume
  });

  it("never overrides the user's hard preferences (seniority, not open to remote)", () => {
    const senior = rankJobsByRecommendation([job("senior", "Senior Data Analyst")], {
      remotePreference: "remote",
      experienceLevel: "entry",
      resumeProfile: resume,
    });
    expect(senior).toEqual([]);
    const onsiteOnly = rankJobsByRecommendation([job("remote", "Data Analyst")], {
      remotePreference: "onsite",
      resumeProfile: resume,
    });
    expect(onsiteOnly).toEqual([]);
  });
});
