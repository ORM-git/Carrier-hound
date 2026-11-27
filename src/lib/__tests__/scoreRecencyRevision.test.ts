import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scoreInputRevision } from "@/lib/matcher/scoring";
import { matchScoreSnapshot, recallMatchScore, reconcileFeedWithDetail, rememberMatchScores } from "@/lib/matcher/scoreCache";
import { rankJobsByRecommendation, scoreJobRecommendation, withFeedScore, type OnboardingAnswers } from "@/lib/jobs/recommendations";
import { sharedDisplayScore } from "@/lib/jobs/displayScore";
import type { CandidateProfile } from "@/lib/resume/types";

// gap #60/#43 time validity: the shared score's recency points (0/1/3/5 by job age) change as a job ages, so the
// score-input revision must change with them, evaluated at the same instant the score was computed at.
const H = 3600e3;
const POSTED = Date.parse("2026-11-20T00:00:00Z");
const at = (hours: number, ms = 0) => POSTED + hours * H + ms;

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});
// A wall clock far from every instant under test: any scorer/revision path that ignores the passed instant and
// reads the clock instead shows up as a mismatch.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2030-01-01T00:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const row = {
  id: "j1",
  title: "Frontend Engineer",
  location: "Remote",
  remote: true,
  remote_scope: "worldwide",
  remote_eligibility: null,
  job_type: "full-time",
  category: "software",
  country_code: "US",
  posted_at: "2026-11-20T00:00:00Z",
  created_at: "2026-11-01T00:00:00Z",
  first_seen_at: "2026-11-01T00:00:00Z",
  description: "React",
  skills: ["React"],
  salary_text: null,
  salary_min: 100000,
  salary_max: 150000,
  currency: "USD",
  salary_period: "yearly",
};
const answers: OnboardingAnswers = { roles: ["Frontend Engineer"] };

// Real boundaries in scoreJobRecommendation: ageHours <= 24 -> 5, <= 24*7 -> 3, <= 24*30 -> 1, else 0 (inclusive).
const TABLE: [string, number, number][] = [
  ["posted", at(0), 45],
  ["24h - 1ms", at(24, -1), 45],
  ["24h exactly", at(24), 45],
  ["24h + 1ms", at(24, 1), 43],
  ["7d - 1ms", at(168, -1), 43],
  ["7d exactly", at(168), 43],
  ["7d + 1ms", at(168, 1), 41],
  ["30d - 1ms", at(720, -1), 41],
  ["30d exactly", at(720), 41],
  ["30d + 1ms", at(720, 1), 40],
  ["90d", at(2160), 40],
];

describe("score-input revision follows the scorer's recency state", () => {
  it.each([true, false])("Pro=%s: a score change at a boundary changes the revision; same tier keeps it", (paid) => {
    const scores = TABLE.map(([, now]) => sharedDisplayScore(row, answers, paid, now));
    expect(scores).toEqual(TABLE.map(([, , s]) => s));
    const revs = TABLE.map(([, now]) => scoreInputRevision(row, paid, now));
    for (let i = 0; i < TABLE.length; i++) {
      for (let j = i + 1; j < TABLE.length; j++) {
        const label = `${TABLE[i][0]} vs ${TABLE[j][0]}`;
        if (scores[i] === scores[j]) expect(revs[i], label).toBe(revs[j]);
        else expect(revs[i], label).not.toBe(revs[j]);
      }
    }
  });

  it("identical input and instant give an identical revision; the instant is explicit, not the wall clock", () => {
    expect(scoreInputRevision({ ...row }, true, at(5))).toBe(scoreInputRevision(row, true, at(5)));
    expect(scoreJobRecommendation(row, answers, at(1)).breakdown.recencyScore).toBe(5);
    expect(scoreJobRecommendation(row, answers, at(200)).breakdown.recencyScore).toBe(1);
    expect(rankJobsByRecommendation([row], answers, at(1))[0].matchScore).toBe(45);
    expect(rankJobsByRecommendation([row], answers, at(800))[0].matchScore).toBe(40);
  });

  it("missing or invalid dates score no recency and never invalidate over time", () => {
    for (const dates of [
      { posted_at: null, created_at: null, first_seen_at: null },
      { posted_at: "not-a-date", created_at: null, first_seen_at: null },
    ]) {
      const r = { ...row, ...dates };
      const scores = TABLE.map(([, now]) => sharedDisplayScore(r, answers, true, now));
      expect(new Set(scores)).toEqual(new Set([40]));
      expect(new Set(TABLE.map(([, now]) => scoreInputRevision(r, true, now))).size).toBe(1);
    }
  });

  it("uses the scorer's own posted_at -> created_at -> first_seen_at fallback", () => {
    const byCreated = { ...row, posted_at: null, created_at: "2026-11-20T00:00:00Z" };
    const byFirstSeen = { ...row, posted_at: null, created_at: null, first_seen_at: "2026-11-20T00:00:00Z" };
    for (const r of [byCreated, byFirstSeen]) {
      expect(sharedDisplayScore(r, answers, true, at(24))).toBe(45);
      expect(sharedDisplayScore(r, answers, true, at(24, 1))).toBe(43);
      expect(scoreInputRevision(r, true, at(24))).not.toBe(scoreInputRevision(r, true, at(24, 1)));
    }
    // posted_at wins over a newer created_at: still the posted_at tier
    const postedWins = { ...row, posted_at: "2026-10-01T00:00:00Z", created_at: "2026-11-20T00:00:00Z" };
    expect(sharedDisplayScore(postedWins, answers, true, at(1))).toBe(40);
    // A future date counts as fresh (negative age <= 24h), as the scorer does today
    expect(sharedDisplayScore(row, answers, true, at(-48))).toBe(45);
  });

  it("keeps Free paid-field isolation and the salary_period invalidation", () => {
    const now = at(3);
    expect(scoreInputRevision({ ...row, description: "x", skills: [], salary_min: 1, salary_period: "hourly" }, false, now)).toBe(
      scoreInputRevision(row, false, now)
    );
    expect(scoreInputRevision({ ...row, salary_period: "monthly" }, true, now)).not.toBe(scoreInputRevision(row, true, now));
  });
});

describe("cached and feed scores across a boundary", () => {
  const cand = {
    name: "A", email: "", phone: "", headline: "Engineer", summary: "", skills: ["React"], experience: [], education: [],
    certifications: [], confirmedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
  } as CandidateProfile;
  // What a response at `now` carries for the job: score and revision from the same instant
  const live = (now: number, withScore = false) => ({
    id: "j1",
    scoreRevision: scoreInputRevision(row, true, now) as string | null,
    matchScore: withScore ? sharedDisplayScore(row, answers, true, now) : undefined,
  });

  it.each([
    ["24h", 24],
    ["7d", 168],
    ["30d", 720],
  ])("localStorage: reused before the %s boundary, rejected after it", (_l, hours) => {
    const snap = matchScoreSnapshot(cand, "p1");
    const stored = live(at(hours, -60_000), true);
    rememberMatchScores(snap, [stored]);
    expect(recallMatchScore(snap, live(at(hours)))).toBe(stored.matchScore);
    expect(recallMatchScore(snap, live(at(hours, 1)))).toBeNull();
  });

  it("feed score: adopted at the same tier, dropped after a boundary; unknown revision never adopted", () => {
    const feed = [live(at(23), true)];
    expect(withFeedScore(live(at(24)), feed).matchScore).toBe(45);
    expect(withFeedScore(live(at(24, 1)), feed).matchScore).toBeUndefined();
    expect(reconcileFeedWithDetail(feed, live(at(25), true))[0].matchScore).toBe(43);
    expect(reconcileFeedWithDetail(feed, live(at(25)))[0].matchScore).toBeNull();
    expect(reconcileFeedWithDetail(feed, live(at(20), true))).toBe(feed);
    expect(withFeedScore({ id: "j1", scoreRevision: null, matchScore: undefined }, feed).matchScore).toBeUndefined();
  });

  it("list and detail agree for the same row and instant", () => {
    const detailRow = Object.fromEntries(Object.entries(row).reverse());
    for (const [, now] of TABLE) {
      expect(scoreInputRevision(detailRow, true, now)).toBe(scoreInputRevision(row, true, now));
      expect(scoreInputRevision(detailRow, false, now)).toBe(scoreInputRevision(row, false, now));
    }
  });
});

describe("routes stamp score and revision from one reference instant", () => {
  const files = [
    "src/app/api/jobs/recommended/route.ts",
    "src/app/api/jobs/search/route.ts",
    "src/app/api/jobs/pro/route.ts",
    "src/lib/jobs/service.ts",
  ];
  it.each(files)("%s", (file) => {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const calls = lines.filter((l) => /\b(scoreInputRevision|sharedDisplayScore|rankJobsByRecommendation)\(/.test(l) && !/^\s*(import|\/\/|\*)/.test(l));
    expect(calls.some((l) => l.includes("scoreInputRevision("))).toBe(true);
    // Each call passes the response's one instant as its last argument
    for (const l of calls) expect(l.trim(), l.trim()).toMatch(/,\s*scoredAt\)( : null)?[,;]?$/);
    expect(lines.filter((l) => /const scoredAt = Date\.now\(\);/.test(l)).length).toBeGreaterThan(0);
  });
});
