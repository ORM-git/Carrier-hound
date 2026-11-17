import { describe, it, expect } from "vitest";
import {
  hasOnboardingAnswers,
  scoreJobRecommendation,
  rankJobsByRecommendation,
  OnboardingAnswers,
} from "@/lib/jobs/recommendations";

describe("Deterministic Recommendation Scoring Engine", () => {
  describe("hasOnboardingAnswers", () => {
    it("returns false for null, undefined, or empty answers", () => {
      expect(hasOnboardingAnswers(null)).toBe(false);
      expect(hasOnboardingAnswers(undefined)).toBe(false);
      expect(hasOnboardingAnswers({})).toBe(false);
      expect(
        hasOnboardingAnswers({
          roles: [],
          experienceLevel: null,
          remotePreference: null,
          locations: [],
          employmentTypes: [],
          categories: [],
        })
      ).toBe(false);
    });

    it("returns true when any question has been answered", () => {
      expect(hasOnboardingAnswers({ roles: ["Frontend Developer"] })).toBe(true);
      expect(hasOnboardingAnswers({ experienceLevel: "senior" })).toBe(true);
      expect(hasOnboardingAnswers({ remotePreference: "remote" })).toBe(true);
      expect(hasOnboardingAnswers({ locations: ["Worldwide / Remote"] })).toBe(true);
      expect(hasOnboardingAnswers({ employmentTypes: ["full-time"] })).toBe(true);
      expect(hasOnboardingAnswers({ categories: ["engineering"] })).toBe(true);
    });
  });

  describe("scoreJobRecommendation", () => {
    const defaultAnswers: OnboardingAnswers = {
      roles: ["Frontend Developer"],
      experienceLevel: "senior",
      remotePreference: "remote",
      locations: ["Worldwide / Remote"],
      employmentTypes: ["full-time"],
      categories: ["engineering"],
    };

    it("scores highest for exact role title, senior, worldwide remote, full-time", () => {
      const perfectJob = {
        title: "Senior Frontend Developer",
        category: "engineering",
        remote: true,
        remote_scope: "worldwide",
        location: "Remote (Worldwide)",
        job_type: "full-time",
        posted_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // 2 hours ago
      };

      const result = scoreJobRecommendation(perfectJob, defaultAnswers);
      // Role match (40) + Remote worldwide (30) + Senior match (20) + Full-time (10) + Recency (5) = 100
      expect(result.score).toBe(100);
      expect(result.breakdown.roleScore).toBe(40);
      expect(result.breakdown.locationScore).toBe(30);
      expect(result.breakdown.experienceScore).toBe(20);
      expect(result.breakdown.jobTypeScore).toBe(10);
      expect(result.breakdown.recencyScore).toBe(5);
    });

    it("penalizes mismatched seniority (e.g. entry seeker on senior role)", () => {
      const entryAnswers: OnboardingAnswers = {
        ...defaultAnswers,
        experienceLevel: "entry",
      };

      const seniorJob = {
        title: "Senior Frontend Developer",
        category: "engineering",
        remote: true,
        job_type: "full-time",
      };

      const juniorJob = {
        title: "Junior Frontend Developer",
        category: "engineering",
        remote: true,
        job_type: "full-time",
      };

      const seniorScore = scoreJobRecommendation(seniorJob, entryAnswers);
      const juniorScore = scoreJobRecommendation(juniorJob, entryAnswers);

      expect(juniorScore.score).toBeGreaterThan(seniorScore.score);
      expect(juniorScore.breakdown.experienceScore).toBe(20);
      expect(seniorScore.breakdown.experienceScore).toBe(0);
    });

    it("handles remote preference: remote seeker prefers remote over onsite", () => {
      const remoteAnswers: OnboardingAnswers = {
        roles: ["Software Engineer"],
        remotePreference: "remote",
      };

      const remoteJob = {
        title: "Software Engineer",
        remote: true,
        location: "Remote",
      };

      const onsiteJob = {
        title: "Software Engineer",
        remote: false,
        location: "Austin, TX (Onsite)",
      };

      const remoteScore = scoreJobRecommendation(remoteJob, remoteAnswers);
      const onsiteScore = scoreJobRecommendation(onsiteJob, remoteAnswers);

      expect(remoteScore.score).toBeGreaterThan(onsiteScore.score);
      expect(remoteScore.breakdown.locationScore).toBeGreaterThanOrEqual(20);
      expect(onsiteScore.breakdown.locationScore).toBe(0);
    });
  });

  describe("rankJobsByRecommendation", () => {
    it("sorts jobs by match score descending, then recency descending", () => {
      const answers: OnboardingAnswers = {
        roles: ["Backend Engineer"],
        experienceLevel: "mid",
        remotePreference: "remote",
        employmentTypes: ["full-time"],
      };

      const jobs = [
        {
          id: "unrelated",
          title: "Sales Director",
          remote: false,
          posted_at: new Date(Date.now() - 1 * 864e5).toISOString(),
        },
        {
          id: "perfect",
          title: "Backend Engineer",
          remote: true,
          job_type: "full-time",
          posted_at: new Date(Date.now() - 5 * 864e5).toISOString(),
        },
        {
          id: "partial",
          title: "Senior Backend Engineer",
          remote: false,
          job_type: "full-time",
          posted_at: new Date(Date.now() - 3 * 864e5).toISOString(),
        },
      ];

      const ranked = rankJobsByRecommendation(jobs, answers);
      expect(ranked.map((j) => j.id)).toEqual(["perfect", "partial", "unrelated"]);
      expect(ranked[0].matchScore).toBeGreaterThan(ranked[1].matchScore!);
      expect(ranked[1].matchScore).toBeGreaterThan(ranked[2].matchScore!);
    });

    it("falls back to latest jobs (posted_at DESC) when user has no answers", () => {
      const jobs = [
        { id: "old", title: "Backend Engineer", posted_at: "2026-11-01T00:00:00Z" },
        { id: "newest", title: "Sales Person", posted_at: "2026-11-15T00:00:00Z" },
        { id: "middle", title: "Designer", posted_at: "2026-11-10T00:00:00Z" },
      ];

      const ranked = rankJobsByRecommendation(jobs, null);
      expect(ranked.map((j) => j.id)).toEqual(["newest", "middle", "old"]);
    });

    it("handles empty and single-item arrays safely", () => {
      expect(rankJobsByRecommendation([], null)).toEqual([]);
      expect(rankJobsByRecommendation([], { roles: ["Engineer"] })).toEqual([]);
      const single = [{ id: "one", title: "Developer" }];
      expect(rankJobsByRecommendation(single, { roles: ["Developer"] })).toHaveLength(1);
    });
  });
});
