import { readFileSync } from "fs";
import { beforeEach, describe, expect, it } from "vitest";
import { MATCH_SCORE_VERSION, clampMatchScore, computeFitDiagnostics, toFitInput } from "@/lib/matcher/scoring";
import { matchScoreSnapshot, recallMatchScore, rememberMatchScores } from "@/lib/matcher/scoreCache";
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

const candidate = { id: "c1", confirmedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" };

describe("score cache keyed by version + candidate + preferences", () => {
  it("recalls the score a card showed for the same snapshot", () => {
    const snap = matchScoreSnapshot(candidate, "p1");
    rememberMatchScores(snap, [{ id: "j1", matchScore: 73 }, { id: "j2", matchScore: null }]);
    expect(recallMatchScore(snap, "j1")).toBe(73);
    expect(recallMatchScore(snap, "j2")).toBeNull();
    expect(snap).toContain(String(MATCH_SCORE_VERSION));
  });

  it("invalidates every entry together when the candidate or preferences change", () => {
    const snap = matchScoreSnapshot(candidate, "p1");
    rememberMatchScores(snap, [{ id: "j1", matchScore: 73 }, { id: "j9", matchScore: 50 }]);
    const newResume = matchScoreSnapshot({ ...candidate, updatedAt: "2026-11-03T00:00:00Z" }, "p1");
    const newPrefs = matchScoreSnapshot(candidate, "p2");
    expect(recallMatchScore(newResume, "j1")).toBeNull();
    expect(recallMatchScore(newPrefs, "j1")).toBeNull();
    rememberMatchScores(newPrefs, [{ id: "j1", matchScore: 61 }]);
    expect(recallMatchScore(newPrefs, "j1")).toBe(61);
    expect(recallMatchScore(newPrefs, "j9")).toBeNull(); // old snapshot's entries are gone, not mixed in
  });

  it("no snapshot (no confirmed resume) never stores or recalls; corrupt storage is ignored", () => {
    expect(matchScoreSnapshot({ id: "c1", updatedAt: "x" }, "p1")).toBeNull();
    rememberMatchScores(null, [{ id: "j1", matchScore: 80 }]);
    expect(mem.size).toBe(0);
    mem.set("cm_match_scores", "{not json");
    expect(recallMatchScore(matchScoreSnapshot(candidate, "p1"), "j1")).toBeNull();
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
