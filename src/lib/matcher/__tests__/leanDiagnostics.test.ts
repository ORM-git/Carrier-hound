import { describe, it, expect } from "vitest";
import { computeFitDiagnostics, toFitInput } from "@/lib/matcher/scoring";
import { leanProListFields } from "@/lib/jobs/leanList";

const candidate: any = {
  name: "T", email: "", phone: "", location: "Remote", headline: "Backend Engineer", summary: "Engineer",
  skills: ["Python", "React", "SQL"],
  experience: [{ id: "1", company: "X", role: "Backend Engineer", startDate: "2019", endDate: "Present", bullets: ["a"], needsReview: false }],
  education: [], certifications: [], rawText: "x", confirmedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const job = {
  id: "j1", title: "Engineer", company: "Acme", location: "Remote", remote: true, category: "engineering",
  skills: ["Engineer"],
  description: "About the role. You will write Python services and React front ends every day, with SQL for reporting and a team that cares about quality.",
};

describe("lean list rows keep the card fit diagnostics identical", () => {
  const lean = { ...job, ...leanProListFields(job) };

  it("server derives the description-evidenced skills; the text is dropped", () => {
    expect(lean.description).toBe("");
    expect(lean.descriptionSkills).toEqual(expect.arrayContaining(["Python", "React"]));
  });

  it("matchedSkills, score and the zero-skills card label are the same as with the full description", () => {
    const full = computeFitDiagnostics(candidate, toFitInput(job));
    const withLean = computeFitDiagnostics(candidate, toFitInput(lean));
    expect(full.matchedSkills.length).toBeGreaterThan(0);
    expect(withLean.matchedSkills).toEqual(full.matchedSkills);
    expect(withLean.score).toBe(full.score);
    expect(withLean.matchedSkills.length === 0).toBe(full.matchedSkills.length === 0);
  });

  it("negative control: without the derived skills the lean row would flip to zero matched skills", () => {
    const stripped = computeFitDiagnostics(candidate, toFitInput({ ...lean, descriptionSkills: undefined }));
    expect(stripped.matchedSkills.length).toBe(0);
  });

  it("a full row (description present) ignores descriptionSkills, so detail scoring is unchanged", () => {
    const a = computeFitDiagnostics(candidate, toFitInput(job));
    const b = computeFitDiagnostics(candidate, toFitInput({ ...job, descriptionSkills: ["Kubernetes"] }));
    expect(b.matchedSkills).toEqual(a.matchedSkills);
  });
});
