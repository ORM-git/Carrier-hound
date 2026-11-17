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
        remotePreference: "any",
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

    it("hard filters: entry-level 100%-remote seeker never gets Senior/Staff on-site jobs as top matches", () => {
      const entryRemoteAnswers: OnboardingAnswers = {
        roles: ["Software Engineer"],
        experienceLevel: "entry",
        remotePreference: "remote",
        employmentTypes: ["full-time"],
      };

      const jobs = [
        {
          id: "senior-onsite",
          title: "Senior Staff Software Engineer",
          remote: false,
          location: "New York, NY",
          job_type: "full-time",
          posted_at: new Date().toISOString(),
        },
        {
          id: "entry-remote",
          title: "Junior Software Engineer",
          remote: true,
          remote_scope: "worldwide",
          location: "Remote (Worldwide)",
          job_type: "full-time",
          posted_at: new Date(Date.now() - 3600000).toISOString(),
        },
        {
          id: "entry-onsite",
          title: "Junior Software Engineer",
          remote: false,
          location: "San Francisco, CA",
          job_type: "full-time",
          posted_at: new Date().toISOString(),
        },
        {
          id: "lead-remote",
          title: "Lead Software Architect",
          remote: true,
          location: "Remote",
          job_type: "full-time",
          posted_at: new Date().toISOString(),
        },
      ];

      // Score individual jobs
      const seniorOnsiteScore = scoreJobRecommendation(jobs[0], entryRemoteAnswers);
      const entryRemoteScore = scoreJobRecommendation(jobs[1], entryRemoteAnswers);
      const entryOnsiteScore = scoreJobRecommendation(jobs[2], entryRemoteAnswers);
      const leadRemoteScore = scoreJobRecommendation(jobs[3], entryRemoteAnswers);

      // Hard filters: Senior/Staff roles and on-site roles must score 0
      expect(seniorOnsiteScore.score).toBe(0);
      expect(entryOnsiteScore.score).toBe(0);
      expect(leadRemoteScore.score).toBe(0);

      // Qualifying entry remote role scores high
      expect(entryRemoteScore.score).toBeGreaterThanOrEqual(80);

      // In ranking, only qualifying role is returned as #1 top match; disqualified roles score 0
      const ranked = rankJobsByRecommendation(jobs, entryRemoteAnswers);
      expect(ranked[0].id).toBe("entry-remote");
      expect(ranked[0].matchScore).toBe(entryRemoteScore.score);
      const seniorOnsiteRanked = ranked.find((j) => j.id === "senior-onsite");
      expect(seniorOnsiteRanked?.matchScore).toBe(0);
    });

    it("respects salary and country preferences as hard filters / strong ranking signals", () => {
      const answers: OnboardingAnswers = {
        roles: ["Frontend Developer"],
        locations: ["United States"],
        minSalary: 120000,
        remotePreference: "remote",
      };

      const lowSalaryJob = {
        id: "low-pay",
        title: "Frontend Developer",
        remote: true,
        location: "Remote",
        country_code: "US",
        salary_max: 60000,
        salary_period: "yearly",
      };

      const foreignCountryJob = {
        id: "foreign-country",
        title: "Frontend Developer",
        remote: false,
        location: "Berlin, Germany",
        country_code: "DE",
        salary_max: 140000,
      };

      const qualifyingJob = {
        id: "qualifying",
        title: "Frontend Developer",
        remote: true,
        location: "Remote (US)",
        country_code: "US",
        salary_max: 150000,
        salary_period: "yearly",
      };

      const lowPayScore = scoreJobRecommendation(lowSalaryJob, answers);
      const foreignScore = scoreJobRecommendation(foreignCountryJob, answers);
      const qualScore = scoreJobRecommendation(qualifyingJob, answers);

      expect(lowPayScore.score).toBe(0);
      expect(foreignScore.score).toBe(0);
      expect(qualScore.score).toBeGreaterThanOrEqual(60);

      const ranked = rankJobsByRecommendation([lowSalaryJob, foreignCountryJob, qualifyingJob], answers);
      expect(ranked[0].id).toBe("qualifying");
      expect(ranked[0].matchScore).toBe(qualScore.score);
      expect(ranked[1].matchScore).toBe(0);
      expect(ranked[2].matchScore).toBe(0);
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

    it("deterministic paging over a 700-row fixture: pages 16 and 17 have zero overlap, zero gaps, and honest totalCount", () => {
      // 700-row fixture with identical scores, same dates, varied IDs to force deterministic tie-breaking
      const fixture = Array.from({ length: 700 }, (_, i) => ({
        id: `job-uuid-${String(i).padStart(4, "0")}`,
        title: "Software Engineer",
        remote: true,
        posted_at: "2026-11-10T12:00:00Z",
        created_at: "2026-11-10T12:00:00Z",
      }));

      const answers: OnboardingAnswers = {
        roles: ["Software Engineer"],
        remotePreference: "remote",
      };

      const ranked = rankJobsByRecommendation(fixture, answers);
      expect(ranked).toHaveLength(700);

      const pageSize = 20;
      // Page 16: items index 300 to 319 (0-indexed: (16-1)*20 = 300)
      const page16From = (16 - 1) * pageSize;
      const page16 = ranked.slice(page16From, page16From + pageSize);

      // Page 17: items index 320 to 339
      const page17From = (17 - 1) * pageSize;
      const page17 = ranked.slice(page17From, page17From + pageSize);

      expect(page16).toHaveLength(20);
      expect(page17).toHaveLength(20);

      // 1. Assert zero overlap between adjacent pages
      const page16Ids = new Set(page16.map((j) => j.id));
      const page17Ids = new Set(page17.map((j) => j.id));
      page17Ids.forEach((id) => {
        expect(page16Ids.has(id)).toBe(false);
      });

      // 2. Assert zero gaps between adjacent pages
      const lastOf16 = page16[page16.length - 1];
      const firstOf17 = page17[0];
      const indexOfLast16 = ranked.findIndex((j) => j.id === lastOf16.id);
      const indexOfFirst17 = ranked.findIndex((j) => j.id === firstOf17.id);
      expect(indexOfFirst17).toBe(indexOfLast16 + 1);

      // 3. Honest totalCount matches the fixed pool size
      expect(ranked.length).toBe(700);

      // 4. Also assert deterministic unpersonalized fallback over the same 700-row fixture
      const fallbackRanked = rankJobsByRecommendation(fixture, null);
      const fallbackP16 = fallbackRanked.slice(page16From, page16From + pageSize);
      const fallbackP17 = fallbackRanked.slice(page17From, page17From + pageSize);
      const fb16Ids = new Set(fallbackP16.map((j) => j.id));
      fallbackP17.forEach((j) => {
        expect(fb16Ids.has(j.id)).toBe(false);
      });
      const lastFb16 = fallbackP16[fallbackP16.length - 1];
      const firstFb17 = fallbackP17[0];
      expect(fallbackRanked.findIndex((j) => j.id === firstFb17.id)).toBe(
        fallbackRanked.findIndex((j) => j.id === lastFb16.id) + 1
      );
    });
  });
});
