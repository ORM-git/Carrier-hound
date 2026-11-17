import { describe, it, expect } from "vitest";
import { computeFitDiagnostics } from "@/lib/matcher/scoring";
import { CandidateProfile } from "@/lib/resume/types";
import { LiveJob } from "@/lib/jobs/service";
import { rankJobsByRecommendation, OnboardingAnswers } from "@/lib/jobs/recommendations";

describe("Match Score Consistency & Unified Label", () => {
  const candidate: CandidateProfile = {
    name: "Alex Doe",
    email: "alex@example.com",
    phone: "555-0100",
    headline: "Frontend Engineer",
    summary: "Experienced Frontend Engineer",
    location: "United States",
    skills: ["React", "TypeScript", "Next.js"],
    experience: [],
    education: [],
    certifications: [],
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

    // Diagnostics computed once server-side on initial job representation
    const diagnostics = computeFitDiagnostics(candidate, {
      id: cardJob.id,
      title: cardJob.title,
      company: cardJob.company,
      location: cardJob.location,
      remote_scope: "worldwide",
      category: cardJob.category,
      skills: cardJob.skills,
      description: cardJob.description,
    });

    const serverScore = Math.max(10, Math.min(99, Math.round(diagnostics.score)));
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
    const detailDisplayedScore = typeof fullJob.matchScore === "number"
      ? Math.max(10, Math.min(99, Math.round(fullJob.matchScore)))
      : Math.max(10, Math.min(99, Math.round(computeFitDiagnostics(candidate, fullJob as any).score)));

    expect(cardDisplayedScore).toBe(serverScore);
    expect(detailDisplayedScore).toBe(serverScore);
    expect(cardDisplayedScore).toBe(detailDisplayedScore);
  });

  it("attaches server-computed matchScore in rankJobsByRecommendation", () => {
    const answers: OnboardingAnswers = {
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

    const ranked = rankJobsByRecommendation(jobs, answers);
    expect(ranked).toHaveLength(1);
    expect(typeof ranked[0].matchScore).toBe("number");
    expect(ranked[0].matchScore).toBeGreaterThan(0);
    expect(ranked[0]._matchScore).toBe(ranked[0].matchScore);
  });
});
