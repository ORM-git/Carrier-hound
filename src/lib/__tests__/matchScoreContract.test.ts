import { readFileSync } from "fs";
import { beforeEach, describe, expect, it } from "vitest";
import { MATCH_SCORE_VERSION, clampMatchScore, computeFitDiagnostics, toFitInput } from "@/lib/matcher/scoring";
import { candidateProfileVersion, jobRevisionKey, matchScoreSnapshot, recallMatchScore, rememberMatchScores } from "@/lib/matcher/scoreCache";
import type { CandidateProfile } from "@/lib/resume/types";

// CM mobile item 18: one score for the same job + candidate snapshot + scoring version on card, detail,
// Match Insights and after a reload.
const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
});

// CandidateProfile has no id: the snapshot uses a version of the scoring-relevant profile content.
const candidate = { confirmedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", skills: ["React"], experience: [], headline: "Engineer" };
const job = (over: Record<string, unknown> = {}) => ({ id: "j1", title: "Frontend Engineer", postedAt: "2026-11-20T00:00:00Z", location: "Remote", category: "engineering", remote: true, remoteScope: "worldwide", ...over });

describe("score cache keyed by job id + job revision + candidate version + preferences + scoring version", () => {
  it("recalls the score a card showed for the same job revision and snapshot", () => {
    const snap = matchScoreSnapshot(candidate, "p1");
    rememberMatchScores(snap, [job({ matchScore: 73 }), job({ id: "j2", matchScore: null })]);
    expect(recallMatchScore(snap, job())).toBe(73);
    expect(recallMatchScore(snap, job({ id: "j2" }))).toBeNull();
    expect(snap).toContain(String(MATCH_SCORE_VERSION));
  });

  it("a revised job (re-posted, retitled, moved, re-scoped) is a miss, not a stale score", () => {
    const snap = matchScoreSnapshot(candidate, "p1");
    rememberMatchScores(snap, [job({ matchScore: 73 })]);
    for (const over of [{ postedAt: "2026-11-23T00:00:00Z" }, { title: "Senior Frontend Engineer" }, { location: "Berlin" }, { remoteScope: "hybrid" }, { category: "design" }]) {
      expect(recallMatchScore(snap, job(over))).toBeNull();
    }
    expect(recallMatchScore(snap, job({ description: "longer detail text", skills: ["React"] }))).toBe(73); // detail-only fields don't miss
  });

  it("a changed candidate profile invalidates every entry, even with the same updatedAt; so do preferences", () => {
    const snap = matchScoreSnapshot(candidate, "p1");
    rememberMatchScores(snap, [job({ matchScore: 73 }), job({ id: "j9", matchScore: 50 })]);
    const newSkills = matchScoreSnapshot({ ...candidate, skills: ["React", "TypeScript"] }, "p1");
    const newPrefs = matchScoreSnapshot(candidate, "p2");
    expect(newSkills).not.toBe(snap);
    expect(recallMatchScore(newSkills, job())).toBeNull();
    expect(recallMatchScore(newPrefs, job())).toBeNull();
    rememberMatchScores(newPrefs, [job({ matchScore: 61 })]);
    expect(recallMatchScore(newPrefs, job())).toBe(61);
    expect(recallMatchScore(newPrefs, job({ id: "j9" }))).toBeNull(); // old snapshot's entries are gone, not mixed in
    expect(candidateProfileVersion(candidate)).toBe(candidateProfileVersion({ ...candidate }));
    expect(jobRevisionKey(job())).toMatch(/^j1\|/);
  });

  it("no snapshot (no confirmed resume) never stores or recalls; corrupt storage is ignored", () => {
    expect(matchScoreSnapshot({ updatedAt: "x" }, "p1")).toBeNull();
    rememberMatchScores(null, [job({ matchScore: 80 })]);
    expect(mem.size).toBe(0);
    mem.set("cm_match_scores", "{not json");
    expect(recallMatchScore(matchScoreSnapshot(candidate, "p1"), job())).toBeNull();
  });
});

describe("one fit input and clamp for card and detail", () => {
  it("toFitInput carries remote so card and detail fallback scores agree", () => {
    const job = { id: "j1", title: "Senior React Engineer", company: "Acme", location: "Remote", remote: true, category: "engineering", skills: ["React", "TypeScript"], description: "React TypeScript GraphQL", salary: "" };
    expect(toFitInput(job)).toMatchObject({ remote: true, remote_scope: "worldwide" });
    const cand = { id: "c1", name: "A", skills: ["React", "TypeScript"], experience: [], education: [], confirmedAt: "x", updatedAt: "y" } as unknown as CandidateProfile;
    const a = computeFitDiagnostics(cand, toFitInput(job)).score;
    const b = computeFitDiagnostics(cand, toFitInput({ ...job })).score;
    expect(clampMatchScore(a)).toBe(clampMatchScore(b));
    expect(clampMatchScore(4)).toBe(10);
    expect(clampMatchScore(100)).toBe(99);
  });

  it("surfaces share the helpers; render never writes scores onto feed jobs; no hardcoded percentages", () => {
    const page = readFileSync("src/app/jobs/page.tsx", "utf8");
    const detail = readFileSync("src/components/jobs/JobDetailView.tsx", "utf8");
    const panel = readFileSync("src/components/jobs/JobAiToolsPanel.tsx", "utf8");
    expect(page).not.toMatch(/job\.matchScore = (matchScore|score);/);
    expect(page).toContain("job={detailJob ?? selectedJob}");
    expect(page.match(/computeFitDiagnostics\(candidate, toFitInput\(job\)\)/g)).toHaveLength(2);
    expect(detail).toContain("computeFitDiagnostics(candidate, toFitInput(job))");
    for (const src of [page, detail, panel]) expect(src).not.toMatch(/Math\.max\(10, Math\.min\(99/);
    expect(detail).not.toMatch(/>\s*\d{2}%\s*</); // no literal percentages such as the old blurred "85%"
  });
});
