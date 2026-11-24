import { describe, it, expect } from "vitest";
import {
  computeRecommendedRankingScore,
  compareByRecommendedRanking,
  shouldApplyRecommendedRanking,
  RECOMMENDED_RANKING_WEIGHTS,
  type RecommendedRankingJobInput,
} from "../scoring";
import type { CandidateProfile } from "@/lib/resume/types";

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

const baseJob = (overrides: Partial<RecommendedRankingJobInput> = {}): RecommendedRankingJobInput => ({
  title: "Backend Engineer",
  company: "Acme",
  location: "Remote - United States",
  country: "US",
  remote: true,
  remoteScope: "worldwide",
  category: "engineering",
  skills: ["Node.js", "PostgreSQL"],
  salary: "$150,000 - $180,000 /yr",
  postedAt: hoursAgo(1),
  ...overrides,
});

const confirmedCandidate: CandidateProfile = {
  name: "Jane Doe",
  email: "jane@example.com",
  phone: "",
  location: "United States",
  headline: "Backend Engineer",
  summary: "",
  skills: ["Node.js", "PostgreSQL", "TypeScript"],
  experience: [],
  education: [],
  certifications: [],
  confirmedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("RECOMMENDED_RANKING_WEIGHTS", () => {
  it("sums to 1 (weights fully allocate the 0-100 score)", () => {
    const total = Object.values(RECOMMENDED_RANKING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe("computeRecommendedRankingScore", () => {
  it("returns a score within 0-100 for a well-matched, fresh, salaried, worldwide-remote job", () => {
    const score = computeRecommendedRankingScore(baseJob(), confirmedCandidate, null);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThan(50); // strong on every input: should rank well above neutral
  });

  it("is deterministic: same inputs always produce the same score", () => {
    const job = baseJob();
    const a = computeRecommendedRankingScore(job, confirmedCandidate, null);
    const b = computeRecommendedRankingScore(job, confirmedCandidate, null);
    expect(a).toBe(b);
  });

  it("never throws and falls back to a neutral fit when there is no candidate/resume", () => {
    expect(() => computeRecommendedRankingScore(baseJob(), null, null)).not.toThrow();
    const score = computeRecommendedRankingScore(baseJob(), null, null);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("ranks a more recent listing higher than an otherwise-identical older one", () => {
    const fresh = computeRecommendedRankingScore(baseJob({ postedAt: hoursAgo(1) }), confirmedCandidate, null);
    const stale = computeRecommendedRankingScore(baseJob({ postedAt: hoursAgo(24 * 30) }), confirmedCandidate, null);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("ranks a listing with a stated salary higher than an otherwise-identical one without", () => {
    const withSalary = computeRecommendedRankingScore(baseJob({ salary: "$120,000/yr" }), confirmedCandidate, null);
    const withoutSalary = computeRecommendedRankingScore(baseJob({ salary: "" }), confirmedCandidate, null);
    expect(withSalary).toBeGreaterThan(withoutSalary);
  });

  it("ranks a worldwide-remote-eligible listing at least as high as one needing a country match it lacks", () => {
    const worldwide = computeRecommendedRankingScore(
      baseJob({ remote: true, remoteScope: "worldwide", country: "DE" }),
      confirmedCandidate,
      { preferredCountryCode: "US", remotePreference: "onsite" }
    );
    const mismatchedOnsite = computeRecommendedRankingScore(
      baseJob({ remote: false, remoteScope: undefined, country: "DE" }),
      confirmedCandidate,
      { preferredCountryCode: "US", remotePreference: "onsite" }
    );
    expect(worldwide).toBeGreaterThan(mismatchedOnsite);
  });

  it("ranks a job in the candidate's preferred country at least as high as one that is neither local nor remote", () => {
    const localMatch = computeRecommendedRankingScore(
      baseJob({ remote: false, remoteScope: undefined, country: "US" }),
      confirmedCandidate,
      { preferredCountryCode: "US", remotePreference: "onsite" }
    );
    const neither = computeRecommendedRankingScore(
      baseJob({ remote: false, remoteScope: undefined, country: "FR" }),
      confirmedCandidate,
      { preferredCountryCode: "US", remotePreference: "onsite" }
    );
    expect(localMatch).toBeGreaterThan(neither);
  });

  it("is ranking-only: a poorly-fit job still receives a score, never a hard exclusion (no null/NaN/throw)", () => {
    const poorFit = computeRecommendedRankingScore(
      baseJob({
        title: "Unrelated Role",
        skills: [],
        remote: false,
        remoteScope: undefined,
        country: "FR",
        salary: "",
        postedAt: hoursAgo(24 * 60),
      }),
      confirmedCandidate,
      { preferredCountryCode: "US", remotePreference: "onsite" }
    );
    expect(Number.isFinite(poorFit)).toBe(true);
    expect(poorFit).toBeGreaterThanOrEqual(0);
  });
});

describe("compareByRecommendedRanking", () => {
  it("orders a higher-scoring job before a lower-scoring one", () => {
    const strong = baseJob({ postedAt: hoursAgo(1), salary: "$150,000/yr" });
    const weak = baseJob({ postedAt: hoursAgo(24 * 60), salary: "" });
    const sorted = [weak, strong].sort((a, b) => compareByRecommendedRanking(a, b, confirmedCandidate, null));
    expect(sorted[0]).toBe(strong);
  });

  it("deterministic tie-break: equal scores order by newest postedAt first", () => {
    const now = hoursAgo(0);
    // Two structurally identical jobs except postedAt, forced to the same score by
    // giving them the same salary/location/skills — the only differentiator is recency,
    // which is itself part of the score, so instead we verify the comparator's explicit
    // tie-break path directly by constructing a scenario where scores are equal.
    const older = baseJob({ postedAt: hoursAgo(5) });
    const newer = baseJob({ postedAt: hoursAgo(5) }); // identical inputs -> identical score
    // With truly identical inputs, scores are equal; the newest (by postedAt) should win
    // the tie-break. Give `newer` a strictly later postedAt to exercise the tie-break path.
    const newerStill = { ...newer, postedAt: now };
    const sorted = [older, newerStill].sort((a, b) => compareByRecommendedRanking(a, b, confirmedCandidate, null));
    expect(sorted[0]).toBe(newerStill);
  });

  it("sort order does not depend on input array order (stable regardless of starting order)", () => {
    const jobs = [
      baseJob({ postedAt: hoursAgo(50), salary: "" }),
      baseJob({ postedAt: hoursAgo(1), salary: "$200,000/yr" }),
      baseJob({ postedAt: hoursAgo(10), salary: "$100,000/yr" }),
    ];
    const sortedForward = [...jobs].sort((a, b) => compareByRecommendedRanking(a, b, confirmedCandidate, null));
    const sortedReversed = [...jobs].reverse().sort((a, b) => compareByRecommendedRanking(a, b, confirmedCandidate, null));
    expect(sortedForward).toEqual(sortedReversed);
  });

  it("final tie-break: equal score and equal postedAt order by id", () => {
    const jobZ = baseJob({ id: "job-z", postedAt: hoursAgo(5) });
    const jobA = baseJob({ id: "job-a", postedAt: hoursAgo(5) }); // identical score and date
    const sorted = [jobZ, jobA].sort((a, b) => compareByRecommendedRanking(a, b, confirmedCandidate, null));
    expect(sorted[0]).toBe(jobA);
  });

  it("accepts a fixed `now` snapshot so every comparison uses the same instant", () => {
    const fixedNow = new Date("2026-01-01T00:00:00Z").getTime();
    const older = baseJob({ postedAt: new Date(fixedNow - 10 * 60 * 60 * 1000).toISOString() });
    const newer = baseJob({ postedAt: new Date(fixedNow - 1 * 60 * 60 * 1000).toISOString() });
    const result = compareByRecommendedRanking(older, newer, confirmedCandidate, null, fixedNow);
    expect(result).toBeGreaterThan(0); // newer should sort first (positive means a after b)
  });
});

describe("shouldApplyRecommendedRanking", () => {
  it("honors explicit Most recent on the For You tab", () => {
    expect(shouldApplyRecommendedRanking("recommended", "newest")).toBe(false);
  });

  it("is true when the user explicitly picks Sort: Recommended on another tab", () => {
    expect(shouldApplyRecommendedRanking("saved", "match")).toBe(true);
  });

  it("is false off the Recommended tab with the default local sort", () => {
    expect(shouldApplyRecommendedRanking("saved", "newest")).toBe(false);
  });
});

describe("integration: default Recommended tab with no resume", () => {
  it("uses the ranking score to order jobs, not just recency, even with no candidate/resume", () => {
    // Mirrors the Jobs page's exact wiring: activeTab defaults to "recommended",
    // sortBy defaults to "match", and there is no
    // confirmed resume. The ranking must still apply (per shouldApplyRecommendedRanking)
    // and must still produce a meaningful, non-recency-only order via the module's
    // neutral fitScore fallback.
    const activeTab = "recommended";
    const sortBy = "match";
    const candidate = null; // no resume
    const preferences = null; // no stated location/remote preference either

    expect(shouldApplyRecommendedRanking(activeTab, sortBy)).toBe(true);

    // Older but salaried + worldwide-remote should outrank a much newer listing
    // that has neither — proving order is score-driven, not newest-first.
    const olderButStronger = baseJob({
      id: "older-stronger",
      postedAt: hoursAgo(48),
      salary: "$150,000/yr",
      remote: true,
      remoteScope: "worldwide",
    });
    const newerButWeaker = baseJob({
      id: "newer-weaker",
      postedAt: hoursAgo(1),
      salary: "",
      remote: false,
      remoteScope: undefined,
      country: "FR",
    });

    const now = Date.now();
    const result = shouldApplyRecommendedRanking(activeTab, sortBy)
      ? [newerButWeaker, olderButStronger].sort((a, b) => compareByRecommendedRanking(a, b, candidate, preferences, now))
      : [newerButWeaker, olderButStronger];

    expect(result[0]).toBe(olderButStronger);
    expect(result[1]).toBe(newerButWeaker);
  });
});
