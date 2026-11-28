import { describe, it, expect } from "vitest";
import { compareByRecommendedRanking, computeRecommendedRankingScore, computeRankingInputCoverage, type RecommendedRankingJobInput } from "@/lib/matcher/scoring";
import { leanProListFields } from "@/lib/jobs/leanList";

const candidate: any = {
  name: "T", email: "", phone: "", location: "Remote", headline: "Backend Engineer", summary: "Engineer",
  skills: ["Python", "React", "SQL"],
  experience: [{ id: "1", company: "X", role: "Backend Engineer", startDate: "2019", endDate: "Present", bullets: ["a"], needsReview: false }],
  education: [], certifications: [], rawText: "x", confirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const NOW = Date.UTC(2026, 10, 28);
const posted = new Date(NOW - 3600_000).toISOString();
// A: skills evidenced ONLY in the description. B: nothing evidenced. B is newer, so only fit evidence can put A first.
const A = { id: "a", title: "Engineer", company: "Acme", location: "Remote", remote: true, country: "US", remoteScope: "worldwide", category: "engineering", skills: ["Engineer"], postedAt: new Date(NOW - 5 * 86400_000).toISOString(),
  description: "About the role. You will write Python services and React front ends every day, with SQL for reporting and a team that cares about quality." };
const B = { id: "b", title: "Engineer", company: "Globex", location: "Remote", remote: true, country: "US", remoteScope: "worldwide", category: "engineering", skills: ["Engineer"], postedAt: posted,
  description: "About the role. You will maintain legacy tooling and attend meetings every day, with a long list of unrelated chores for the whole team here." };
const lean = (j: typeof A) => ({ ...j, ...leanProListFields(j) }) as RecommendedRankingJobInput;
const order = (jobs: RecommendedRankingJobInput[]) => [...jobs].sort((x, y) => compareByRecommendedRanking(x, y, candidate, null, NOW)).map((j) => j.id);

describe("lean rows keep the client recommended ranking identical (no shared matchScore: fallback path)", () => {
  it("score, coverage and order match full rows; description-only evidence still ranks A first", () => {
    expect(computeRecommendedRankingScore(lean(A), candidate, null, NOW)).toBe(computeRecommendedRankingScore(A as any, candidate, null, NOW));
    expect(computeRecommendedRankingScore(lean(B), candidate, null, NOW)).toBe(computeRecommendedRankingScore(B as any, candidate, null, NOW));
    expect(computeRankingInputCoverage(lean(A), candidate, null, NOW)).toEqual(computeRankingInputCoverage(A as any, candidate, null, NOW));
    expect(order([A as any, B as any])).toEqual(["a", "b"]);
    expect(order([lean(A), lean(B)])).toEqual(["a", "b"]);
    expect(order([lean(B), lean(A)])).toEqual(["a", "b"]);
  });
  it("negative control: dropping evidencedSkills (the 893 regression) reorders lean rows", () => {
    const stripped = (j: typeof A) => ({ ...lean(j), evidencedSkills: undefined }) as RecommendedRankingJobInput;
    expect(computeRecommendedRankingScore(stripped(A), candidate, null, NOW)).not.toBe(computeRecommendedRankingScore(A as any, candidate, null, NOW));
    expect(order([stripped(A), stripped(B)])).toEqual(["b", "a"]);
  });
  it("shared finite matchScore on BOTH keeps priority with and without evidencedSkills; mixed/missing falls back to local score", () => {
    const sA = { ...lean(A), matchScore: 40 }, sB = { ...lean(B), matchScore: 90 };
    expect(order([sA, sB])).toEqual(["b", "a"]);
    expect(order([{ ...sA, evidencedSkills: undefined } as any, { ...sB, evidencedSkills: undefined } as any])).toEqual(["b", "a"]);
    expect(order([{ ...lean(A), matchScore: 40 }, lean(B)])).toEqual(["a", "b"]);   // mixed: local fallback, uses evidencedSkills
    expect(order([{ ...lean(A), matchScore: null }, { ...lean(B), matchScore: Number.NaN }])).toEqual(["a", "b"]);
  });
});

import { computeFitDiagnostics, extractSkillsFromJob, toFitInput } from "@/lib/matcher/scoring";
describe("evidencedSkills is authoritative ONLY for explicit lean===true rows", () => {
  const base: any = { id: "x", title: "Engineer", category: "engineering", skills: ["Engineer", "Go"] };
  it("lean + empty list is honored (empty)", () => {
    expect(extractSkillsFromJob({ ...base, description: "", lean: true, evidencedSkills: [] } as any)).toEqual([]);
  });
  it("FULL record with EMPTY description ignores a stale evidencedSkills; raw skills/title unchanged", () => {
    const without = extractSkillsFromJob({ ...base, description: "" } as any);
    expect(without).toContain("Go");
    expect(extractSkillsFromJob({ ...base, description: "", evidencedSkills: ["Kubernetes"] } as any)).toEqual(without);
    expect(extractSkillsFromJob({ ...base, description: "", lean: false, evidencedSkills: ["Kubernetes"] } as any)).toEqual(without);
  });
  it("stub (<60 char) description on a non-lean record also ignores it", () => {
    const without = extractSkillsFromJob({ ...base, description: "Short stub." } as any);
    expect(extractSkillsFromJob({ ...base, description: "Short stub.", evidencedSkills: ["Kubernetes"] } as any)).toEqual(without);
  });
  it("negative control: the same stale list on lean===true IS authoritative; lean flag survives normalization and toFitInput", () => {
    expect(extractSkillsFromJob({ ...base, description: "", lean: true, evidencedSkills: ["Kubernetes"] } as any)).toEqual(["Kubernetes"]);
    expect((toFitInput({ ...base, description: "", lean: true, evidencedSkills: ["Kubernetes"] } as any) as any).lean).toBe(true);
    expect((toFitInput({ ...base, description: "", evidencedSkills: ["Kubernetes"] } as any) as any).lean).toBeUndefined();
  });
});

describe("lean evidencedSkills = extractSkillsFromJob(FULL row): exact order/case, raw skills stripped", () => {
  const raw = { id: "r", title: "React Developer", company: "Acme", location: "Remote", remote: true, category: "engineering",
    skills: [" Node.js ", "engineering", "Python", "Node.js"], description: "" };
  const withDesc = { ...raw, description: "We use SQL and Python daily, plus Docker for deploys across the whole platform team, every sprint." };
  for (const [name, job] of [["raw skills only, no description", raw], ["raw + description + title", withDesc]] as const) {
    it(`${name}: list row carries no raw skills; fit score, matched skills and evidence equal the full row`, () => {
      const l: any = { ...job, ...leanProListFields(job) };
      expect(l.skills).toEqual([]);
      expect(l.evidencedSkills).toEqual(extractSkillsFromJob(job as any));   // same order and case, deduped as the full row
      const full = computeFitDiagnostics(candidate, toFitInput(job as any));
      const lean = computeFitDiagnostics(candidate, toFitInput(l));
      expect(lean.score).toBe(full.score);
      expect(lean.matchedSkills).toEqual(full.matchedSkills);
      expect(extractSkillsFromJob(toFitInput(l) as any)).toEqual(extractSkillsFromJob(job as any));
    });
  }
  it("negative controls: stripping raw skills WITHOUT the evidence list changes the result; an empty present list is honored; a full row ignores the field", () => {
    const l: any = { ...raw, ...leanProListFields(raw) };
    expect(extractSkillsFromJob({ ...toFitInput(l), evidencedSkills: undefined } as any)).not.toEqual(extractSkillsFromJob(raw as any));
    expect(extractSkillsFromJob({ ...toFitInput(l), evidencedSkills: [] } as any)).toEqual([]);                 // present-but-empty is authoritative on a lean row
    expect(extractSkillsFromJob({ ...toFitInput(withDesc as any), evidencedSkills: ["Kubernetes"] } as any)).toEqual(extractSkillsFromJob(withDesc as any)); // full row unchanged
  });
});

