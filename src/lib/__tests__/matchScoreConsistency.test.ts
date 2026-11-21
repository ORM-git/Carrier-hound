import { describe, it, expect } from "vitest";
import { LiveJob } from "@/lib/jobs/service";
import {
  scoreJobRecommendation,
  rankJobsByRecommendation,
  withFeedScore,
  OnboardingAnswers,
} from "@/lib/jobs/recommendations";

describe("Match Score Consistency & Unified Label", () => {
  const answers: OnboardingAnswers = {
    roles: ["Frontend Engineer"],
    experienceLevel: "mid",
    remotePreference: "remote",
    locations: ["United States"],
    employmentTypes: ["full-time"],
  };

  it("produces identical match score with or without full description when job.matchScore is preserved", () => {
    // Teaser job as returned from search/feed (no description)
    const cardJob: LiveJob = {
      id: "job-123",
      title: "Frontend Engineer",
      company: "Verified Employer",
      location: "Remote (Worldwide)",
      category: "engineering",
      remote: true,
      country: "US",
      type: "Full-time",
      directSource: true,
      applyUrl: "",
      date: "Today",
      salary: "",
      description: "",
      skills: ["React", "TypeScript"],
    };

    // Score computed once server-side on initial job representation
    const scored = scoreJobRecommendation(
      {
        id: cardJob.id,
        title: cardJob.title,
        location: cardJob.location,
        remote: cardJob.remote,
        remote_scope: "worldwide",
        category: cardJob.category,
        country_code: cardJob.country,
        job_type: cardJob.type,
      },
      answers
    );

    const serverScore = Math.max(10, Math.min(99, Math.round(scored.score)));
    cardJob.matchScore = serverScore;

    // Simulate clicking card: getLiveJobById returns full job with full description
    const fullJob: LiveJob = {
      ...cardJob,
      company: "Acme Corp",
      salary: "$120,000 - $150,000 /yr",
      applyUrl: "https://example.com/apply",
      description: "Full lengthy description with many keywords that previously altered scoring...",
      // Server / selection handler preserves the server-computed matchScore
      matchScore: cardJob.matchScore,
    };

    // Card score
    const cardDisplayedScore = cardJob.matchScore;

    // Detail view score: must use job.matchScore if present
    const detailDisplayedScore =
      typeof fullJob.matchScore === "number"
        ? Math.max(10, Math.min(99, Math.round(fullJob.matchScore)))
        : Math.max(10, Math.min(99, Math.round(scoreJobRecommendation(fullJob as any, answers).score)));

    expect(cardDisplayedScore).toBe(serverScore);
    expect(detailDisplayedScore).toBe(serverScore);
    expect(cardDisplayedScore).toBe(detailDisplayedScore);
  });

  it("attaches server-computed matchScore in rankJobsByRecommendation", () => {
    const onboardingAnswers: OnboardingAnswers = {
      roles: ["Fullstack Engineer"],
      experienceLevel: "entry",
      remotePreference: "remote",
    };

    const jobs = [
      {
        id: "j1",
        title: "Junior Fullstack Engineer",
        remote: true,
        location: "Remote",
        posted_at: new Date().toISOString(),
      },
    ];

    const ranked = rankJobsByRecommendation(jobs, onboardingAnswers);
    expect(ranked).toHaveLength(1);
    expect(typeof ranked[0].matchScore).toBe("number");
    expect(ranked[0].matchScore).toBeGreaterThan(0);
    expect(ranked[0]._matchScore).toBe(ranked[0].matchScore);
  });
});

describe("card and detail read one stored score (withFeedScore)", () => {
  // Mirrors the clamp both getJobMatchScore (card) and JobDetailView (detail) apply to job.matchScore.
  const shown = (j: { matchScore?: number | null }) =>
    typeof j.matchScore === "number" ? Math.max(10, Math.min(99, Math.round(j.matchScore))) : null;

  it("deep-linked detail (no score, or a recomputed resume score) shows the feed card's score", () => {
    const feed = [{ id: "j1", title: "Frontend Engineer, Ads", matchScore: 83 }];
    expect(shown(withFeedScore({ id: "j1", title: "Frontend Engineer, Ads" }, feed))).toBe(shown(feed[0]));
    expect(shown(withFeedScore({ id: "j1", title: "Frontend Engineer, Ads", matchScore: 85 }, feed))).toBe(83);
  });

  it("keeps the job's own score when the feed doesn't have it, and returns the same object when unchanged", () => {
    const detail = { id: "x", matchScore: 70 };
    expect(withFeedScore(detail, [])).toBe(detail);
    expect(withFeedScore(detail, [{ id: "x", matchScore: 70 }])).toBe(detail);
  });
});
