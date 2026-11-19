import { describe, it, expect } from "vitest";
import {
  getCanonicalSkillId,
  areSkillsGenuineMatch,
  normalizeSkillToTokens,
  computeFitDiagnostics,
  getDiagnosticsSummary,
} from "@/lib/matcher/scoring";
import { CandidateProfile } from "@/lib/resume/types";

describe("skill matching", () => {
  it("resolves known aliases to a canonical skill id", () => {
    expect(getCanonicalSkillId("React.js")).toBe(getCanonicalSkillId("react"));
    expect(getCanonicalSkillId("k8s")).toBe(getCanonicalSkillId("kubernetes"));
  });

  it("returns null for unknown skills", () => {
    expect(getCanonicalSkillId("not-a-real-skill-xyz")).toBeNull();
  });

  it("treats alias variants as genuine matches", () => {
    expect(areSkillsGenuineMatch("React", "React.js")).toBe(true);
    expect(areSkillsGenuineMatch("React", "Java")).toBe(false);
  });

  it("tokenizes multi-word skills", () => {
    const { tokens } = normalizeSkillToTokens("Amazon Web Services");
    expect(tokens.size).toBeGreaterThan(1);
    expect(tokens.has("amazon") || tokens.has("aws") || tokens.has("web")).toBe(true);
  });

  describe("computeFitDiagnostics", () => {
    function makeProfile(partial: Partial<CandidateProfile>): CandidateProfile {
      return {
        name: "Alex Dev",
        email: "alex@example.com",
        phone: "555-0100",
        headline: "Senior Frontend Engineer",
        summary: "Senior Frontend Engineer with 5+ years experience",
        location: "San Francisco, CA",
        skills: ["React", "TypeScript", "Next.js", "Tailwind CSS", "Redux"],
        experience: [],
        education: [],
        certifications: [],
        confirmedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...partial,
      };
    }

    const candidate = makeProfile({
      experience: [
        {
          id: "exp-1",
          role: "Frontend Engineer",
          company: "Acme",
          startDate: "2020-01-01",
          endDate: "2026-01-01",
          bullets: ["Built React web applications"],
        },
      ],
    });

    it("evaluates a rich job posting with matched skills, seniority, and location", () => {
      const job = {
        title: "Senior Frontend Engineer",
        category: "engineering",
        location: "Remote (Worldwide)",
        remote_scope: "worldwide",
        skills: ["React", "TypeScript", "Next.js", "GraphQL"],
      };

      const result = computeFitDiagnostics(candidate, job);
      expect(result.score).toBeGreaterThanOrEqual(70);
      expect(result.scoreGrade).toBe("high");
      expect(result.matchedSkills).toContain("React");
      expect(result.missingSkills).toContain("GraphQL");
      expect(result.breakdown.remoteScore).toBe(10);
      expect(result.whyYouFit.length).toBeGreaterThan(0);

      const summary = getDiagnosticsSummary(result);
      expect(summary).toContain("Matches");
    });

    it("penalizes entry candidate on senior role and handles low skills", () => {
      const juniorCand = makeProfile({
        headline: "Junior Web Developer",
        skills: ["HTML", "CSS"],
        experience: [],
      });

      const seniorJob = {
        title: "Senior Staff Architect",
        location: "Berlin, Germany",
        skills: ["Java", "Distributed Systems", "Kubernetes"],
      };

      const result = computeFitDiagnostics(juniorCand, seniorJob);
      expect(result.scoreGrade).toBe("low");
      expect(result.breakdown.seniorityAdjustment).toBeLessThan(0);
      expect(result.gaps.length).toBeGreaterThan(0);
    });

    it("handles jobs with 0 skills using domain patterns and candidate skills", () => {
      const jobZeroSkills = {
        title: "Frontend Developer",
        category: "frontend",
        location: "San Francisco, CA",
      };

      const result = computeFitDiagnostics(candidate, jobZeroSkills);
      expect(result.breakdown.skillScore).toBeGreaterThan(0);
      expect(result.breakdown.titleScore).toBeGreaterThanOrEqual(18);
    });

    it("handles candidates with empty skills and empty experience gracefully", () => {
      const emptyCand = makeProfile({
        headline: "",
        skills: [],
        experience: [],
      });

      const job = {
        title: "Data Analyst",
        location: "Onsite",
      };

      const result = computeFitDiagnostics(emptyCand, job);
      expect(result.score).toBe(5); // Minimum floor
      const summary = getDiagnosticsSummary(result);
      expect(summary).toBe("Evaluated against your confirmed resume facts and requirements.");
    });
  });
});
