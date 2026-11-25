import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { capJobsPerCompany } from "@/lib/jobs/capping";
import { rankJobsByRecommendation } from "@/lib/jobs/recommendations";
import { evaluateDataset, validateDataset, type EvalDataset } from "../rankingEval";

const load = (): EvalDataset => JSON.parse(readFileSync("scripts/eval/ranking/synthetic-v1.json", "utf8"));

describe("offline ranking eval on the synthetic fixture", () => {
  it("is deterministic: two runs give identical results", () => {
    expect(JSON.stringify(evaluateDataset(load()))).toBe(JSON.stringify(evaluateDataset(load())));
  });

  it("uses the production ranker pipeline (rank, qualifying filter, per-company cap) at the dataset instant", () => {
    const d = load();
    const now = Date.parse(d.referenceTime);
    const r = evaluateDataset(d);
    for (const p of d.profiles) {
      const pool = p.candidates.map((id) => d.jobs.find((j) => j.id === id)!);
      const ranked = rankJobsByRecommendation(pool, p.answers, now);
      const expected = capJobsPerCompany(p.answers && Object.keys(p.answers).some((k) => k !== "resumeProfile") ? ranked.filter((j) => (j.matchScore ?? 0) > 0) : ranked, 3, 30);
      expect(r.profiles.find((x) => x.id === p.id)!.ranked, p.id).toEqual(expected.map((j) => ({ id: j.id, score: j.matchScore ?? null })));
    }
  });

  it("reports counts, coverage, undefined metrics and the synthetic flag", () => {
    const r = evaluateDataset(load());
    expect(r.dataset.synthetic).toBe(true);
    expect(r.counts.profiles).toBe(7);
    expect(r.labelCoverage).toEqual({ pairs: 41, relevanceJudged: 39, eligibilityJudged: 39 });
    const empty = r.profiles.find((p) => p.id === "syn-no-relevant-pool")!;
    expect(empty.metrics.ndcgAtK).toBeNull();
    expect(r.macro.ndcgAtK.excluded).toBe(1);
    // Every profile covers a distinct role / level / work-model / location combination
    expect(new Set(load().profiles.map((p) => `${p.answers?.roles}|${p.answers?.experienceLevel}|${p.answers?.remotePreference}`)).size).toBe(7);
  });

  it("detects a hard-filter violation end to end when a label marks a returned job ineligible", () => {
    const d = load();
    const p = d.profiles.find((x) => x.id === "syn-fe-mid-remote-us")!;
    p.labels.j02 = { relevance: 3, eligibility: "ineligible" }; // label disagrees with the ranker on purpose
    const m = evaluateDataset(d).profiles.find((x) => x.id === p.id)!.metrics;
    expect(m.hardFilterViolationsInTopK).toEqual(["j02"]);
  });

  it("evaluates one split only: tuning profiles never enter held-out numbers", () => {
    const d = load();
    d.profiles[0].split = "tuning";
    const evalOnly = evaluateDataset(d, "eval");
    expect(evalOnly.counts).toMatchObject({ profiles: 6, skippedOtherSplit: 1 });
    expect(evalOnly.profiles.map((p) => p.id)).not.toContain(d.profiles[0].id);
    expect(evaluateDataset(d, "tuning").profiles.map((p) => p.id)).toEqual([d.profiles[0].id]);
  });

  it("rejects malformed datasets instead of guessing", () => {
    const bad = (mutate: (d: EvalDataset) => void) => {
      const d = load();
      mutate(d);
      return () => validateDataset(d);
    };
    expect(bad((d) => d.jobs.push({ ...d.jobs[0] }))).toThrow(/duplicate job id j01/);
    expect(bad((d) => d.profiles[0].candidates.push("j01"))).toThrow(/duplicate candidate j01/);
    expect(bad((d) => (d.profiles[0].labels.j27 = { relevance: 1 }))).toThrow(/label for non-candidate j27/);
    expect(bad((d) => (d.profiles[0].labels.j02 = { relevance: 5 as any }))).toThrow(/relevance must be 0-3/);
    expect(bad((d) => ((d.profiles[0] as any).labelProvenance = ""))).toThrow(/labelProvenance is required/);
    expect(bad((d) => ((d as any).referenceTime = "soon"))).toThrow(/referenceTime/);
    expect(bad(() => undefined)).not.toThrow();
  });
});
