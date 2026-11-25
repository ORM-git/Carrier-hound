import { readFileSync } from "fs";
import { beforeEach, describe, expect, it } from "vitest";
import { MATCH_SCORE_VERSION, computeFitDiagnostics, displayMatchScore, scoreInputRevision, toFitInput } from "@/lib/matcher/scoring";
import { candidateProfileVersion, matchScoreSnapshot, recallMatchScore, reconcileFeedWithDetail, rememberMatchScores } from "@/lib/matcher/scoreCache";
import { withFeedScore } from "@/lib/jobs/recommendations";
import type { CandidateProfile } from "@/lib/resume/types";

const NOW = Date.parse("2026-11-25T00:00:00Z"); // fixed reference instant for revisions

// CM mobile item 18: one score per job score-input revision + candidate snapshot + scoring version, on the
// feed card, the detail header and Match Insights, invalidated together when any input changes.
const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

type Row = Record<string, unknown> & { title: string; location: string; remote: boolean; remote_scope: string; category: string; job_type: string; description: string; skills: string[]; salary_text: string; posted_at: string };
const row: Row = {
  title: "Senior Frontend Engineer",
  location: "Remote",
  remote: true,
  remote_scope: "worldwide",
  remote_eligibility: null,
  job_type: "full-time",
  category: "engineering",
  country_code: "US",
  posted_at: "2026-11-20T00:00:00Z",
  description: "React TypeScript GraphQL design systems",
  skills: ["React", "TypeScript"],
  salary_text: "$150k",
  salary_min: 150000,
  salary_max: 180000,
  currency: "USD",
};
const cand = (skills: string[]) =>
  ({
    name: "A", email: "", phone: "", headline: "Engineer", summary: "", skills, experience: [], education: [], certifications: [],
    confirmedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
  }) as CandidateProfile;

// The client shape of a job as the feed and the detail receive it (LiveJob), with the server revision stamped.
const liveJob = (r: Row, extra: Record<string, unknown> = {}) => ({
  id: "j1",
  title: r.title,
  company: "Acme",
  location: r.location,
  remote: r.remote,
  remoteScope: r.remote_scope,
  category: r.category,
  type: r.job_type,
  description: r.description,
  skills: r.skills,
  salary: r.salary_text,
  postedAt: r.posted_at,
  applyUrl: "",
  scoreRevision: scoreInputRevision(r, true, NOW) as string | null,
  matchScore: undefined as number | null | undefined,
  ...extra,
});

describe("scoreInputRevision covers every scoring input", () => {
  it.each([
    ["skills", { skills: ["React", "TypeScript", "Go"] }],
    ["description", { description: "React TypeScript GraphQL design systems, now with Rust" }],
    ["seniority (title)", { title: "Staff Frontend Engineer" }],
    ["remote", { remote: false }],
    ["remote scope", { remote_scope: "hybrid" }],
    ["salary", { salary_min: 160000 }],
    ["location", { location: "Berlin" }],
    ["category", { category: "design" }],
    ["job type", { job_type: "contract" }],
    ["posted date", { posted_at: "2026-11-23T00:00:00Z" }],
  ])("a changed %s gives a new revision", (_label, change) => {
    expect(scoreInputRevision({ ...row, ...change }, true, NOW)).not.toBe(scoreInputRevision(row, true, NOW));
  });

  it("is stable for the same inputs, carries the scoring version, and free rows hash only what free scoring reads", () => {
    expect(scoreInputRevision({ ...row }, true, NOW)).toBe(scoreInputRevision(row, true, NOW));
    expect(scoreInputRevision(row, true, NOW).startsWith(`${MATCH_SCORE_VERSION}.p.`)).toBe(true);
    expect(scoreInputRevision({ ...row, description: "", skills: [] }, false, NOW)).toBe(scoreInputRevision(row, false, NOW));
    expect(scoreInputRevision({ ...row, title: "Staff Frontend Engineer" }, false, NOW)).not.toBe(scoreInputRevision(row, false, NOW));
  });
});

describe("withFeedScore adopts a same-id feed score only for the same revision", () => {
  const feed = [liveJob(row, { matchScore: 83 })];

  it("same revision -> feed score", () => {
    expect(withFeedScore(liveJob(row), feed).matchScore).toBe(83);
  });

  it("changed inputs (new revision) or a missing revision -> not adopted", () => {
    expect(withFeedScore(liveJob({ ...row, description: "changed" }), feed).matchScore).toBeUndefined();
    expect(withFeedScore(liveJob(row, { scoreRevision: null }), feed).matchScore).toBeUndefined();
    expect(withFeedScore(liveJob(row), [{ id: "j1", matchScore: 83 }]).matchScore).toBeUndefined();
  });
});

describe("score cache keyed by id + server revision; snapshot = scoring version + candidate version + preferences", () => {
  it("a changed description or skills is a miss, never the old score", () => {
    const snap = matchScoreSnapshot(cand(["React"]), "p1");
    rememberMatchScores(snap, [liveJob(row, { matchScore: 73 })]);
    expect(recallMatchScore(snap, liveJob(row))).toBe(73);
    expect(recallMatchScore(snap, liveJob({ ...row, description: "longer, changed description" }))).toBeNull();
    expect(recallMatchScore(snap, liveJob({ ...row, skills: ["React"] }))).toBeNull();
    expect(recallMatchScore(snap, { id: "j1", scoreRevision: null })).toBeNull();
  });

  it("a changed candidate profile (same updatedAt) or preferences invalidates every entry together", () => {
    const snap = matchScoreSnapshot(cand(["React"]), "p1");
    rememberMatchScores(snap, [liveJob(row, { matchScore: 73 }), liveJob(row, { id: "j9", matchScore: 50 })]);
    const newSkills = matchScoreSnapshot(cand(["React", "TypeScript"]), "p1");
    expect(newSkills).not.toBe(snap);
    expect(recallMatchScore(newSkills, liveJob(row))).toBeNull();
    expect(recallMatchScore(matchScoreSnapshot(cand(["React"]), "p2"), liveJob(row, { id: "j9" }))).toBeNull();
    expect(candidateProfileVersion(cand(["React"]))).toBe(candidateProfileVersion(cand(["React"])));
  });

  it("no snapshot never stores; corrupt storage is ignored", () => {
    expect(matchScoreSnapshot({ updatedAt: "x" }, "p1")).toBeNull();
    rememberMatchScores(null, [liveJob(row, { matchScore: 80 })]);
    expect(mem.size).toBe(0);
    mem.set("cm_match_scores", "{not json");
    expect(recallMatchScore(matchScoreSnapshot(cand(["React"]), "p1"), liveJob(row))).toBeNull();
  });
});

describe("a changed input updates feed card, detail header and Match Insights together", () => {
  // Each surface's wiring: card = getJobMatchScore (fit fallback only without a shared score);
  // detail = withFeedScore(fetched, feed) -> displayMatchScore(job, diagnostics); insights = same job + diagnostics.
  type J = ReturnType<typeof liveJob>;
  const fit = (c: CandidateProfile, j: J) => computeFitDiagnostics(c, toFitInput(j));
  const card = (c: CandidateProfile, j: J) => displayMatchScore(j, typeof j.matchScore === "number" ? null : fit(c, j));
  const surfaces = (c: CandidateProfile, feed: J[], fetchedDetail: J) => {
    const feedNow = reconcileFeedWithDetail(feed, fetchedDetail);
    const detailJob = withFeedScore(fetchedDetail, feedNow);
    const diagnostics = fit(c, detailJob);
    return { card: card(c, feedNow[0]), detail: displayMatchScore(detailJob, diagnostics), insights: displayMatchScore(detailJob, diagnostics) };
  };

  it("unchanged inputs: all three show the shared feed score", () => {
    expect(surfaces(cand(["React"]), [liveJob(row, { matchScore: 88 })], liveJob(row))).toEqual({ card: 88, detail: 88, insights: 88 });
  });

  it("job inputs changed since the feed (skills/description): the stale 88 is dropped everywhere and all three agree", () => {
    const changed = { ...row, skills: ["Go", "Kubernetes"], description: "Go Kubernetes platform" };
    const c = cand(["React", "TypeScript"]);
    const s = surfaces(c, [liveJob(row, { matchScore: 88 })], liveJob(changed));
    expect(s.card).toBe(s.detail);
    expect(s.detail).toBe(s.insights);
    expect(s.card).not.toBe(88);
    expect(s.card).toBe(displayMatchScore({}, fit(c, liveJob(changed))));
  });

  it("candidate profile changed (no shared score): all three recompute with the new profile together", () => {
    const before = surfaces(cand(["Java"]), [liveJob(row)], liveJob(row));
    const after = surfaces(cand(["React", "TypeScript", "GraphQL"]), [liveJob(row)], liveJob(row));
    expect(new Set(Object.values(before)).size).toBe(1);
    expect(new Set(Object.values(after)).size).toBe(1);
    expect(after.card).not.toBe(before.card);
  });

  it("the real surfaces are wired to this contract and every jobs route stamps the revision", () => {
    const page = readFileSync("src/app/jobs/page.tsx", "utf8");
    const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
    const panel = readFileSync("src/components/jobs/JobAiToolsPanel.tsx", "utf8");
    expect(page).toContain("return displayMatchScore(job, computeFitDiagnostics(candidate, toFitInput(job)));");
    expect(page).toContain("setLiveJobs((prev) => reconcileFeedWithDetail(prev, selectedJob))");
    expect(page).toContain("fullJob.scoreRevision === job.scoreRevision");
    expect(page).toContain("job={detailJob ?? selectedJob}");
    expect(page).not.toMatch(/job\.matchScore = (matchScore|score);/);
    expect(detail).toContain("const matchScore = displayMatchScore(job, diagnostics);");
    expect(panel).toContain("const matchScore = displayMatchScore(job, diagnostics);");
    for (const route of ["recommended", "search", "pro"]) {
      expect(readFileSync(`src/app/api/jobs/${route}/route.ts`, "utf8")).toContain("scoreRevision: scoreInputRevision(");
    }
  });
});
