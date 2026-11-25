/**
 * Runs the production recommendation ranker on a labelled fixture dataset and scores it (checklist #62).
 * Offline: no database, network or writes. Dataset format: docs/ranking-eval.md.
 */
import { capJobsPerCompany } from "../jobs/capping";
import {
  hasOnboardingAnswers,
  rankJobsByRecommendation,
  type JobScoringCandidate,
  type OnboardingAnswers,
} from "../jobs/recommendations";
import { K, RELEVANT_MIN_GRADE, evaluateRanking, macroMean, type JobLabel, type RankingMetrics } from "./rankingMetrics";

export type Split = "tuning" | "eval";

export interface EvalJob extends JobScoringCandidate {
  id: string;
}

export interface EvalProfile {
  /** Stable profile/query id, never a real user id. */
  id: string;
  split: Split;
  description?: string;
  /** Exactly what the ranker receives: saved preferences plus optional resume signals. */
  answers: OnboardingAnswers | null;
  /** Candidate job ids from dataset.jobs: the pool the ranker ranks for this profile. */
  candidates: string[];
  /** job id -> label. A candidate with no entry is unjudged / eligibility unknown. */
  labels: Record<string, JobLabel>;
  /** Who produced the labels and how (e.g. "synthetic-author", "human-judge:<role>#<n>"). */
  labelProvenance: string;
}

export interface EvalDataset {
  version: string;
  /** True for author-made test fixtures: never evidence of real recommendation quality. */
  synthetic: boolean;
  description?: string;
  /** The fixed instant the ranker scores at, so recency and results are reproducible. */
  referenceTime: string;
  jobs: EvalJob[];
  profiles: EvalProfile[];
}

const GRADES = new Set([0, 1, 2, 3]);
const ELIGIBILITY = new Set(["eligible", "ineligible"]);

/** Throws on a malformed dataset instead of evaluating something ambiguous. */
export function validateDataset(d: EvalDataset): void {
  const errors: string[] = [];
  if (!d || typeof d.version !== "string" || !d.version) errors.push("version is required");
  if (typeof d?.synthetic !== "boolean") errors.push("synthetic must be true or false");
  if (!Number.isFinite(Date.parse(d?.referenceTime))) errors.push("referenceTime must be an ISO timestamp");
  const jobIds = new Set<string>();
  for (const j of d?.jobs || []) {
    if (!j.id) errors.push("job without id");
    else if (jobIds.has(j.id)) errors.push(`duplicate job id ${j.id}`);
    jobIds.add(j.id);
  }
  const profileIds = new Set<string>();
  for (const p of d?.profiles || []) {
    if (!p.id) errors.push("profile without id");
    else if (profileIds.has(p.id)) errors.push(`duplicate profile id ${p.id}`);
    profileIds.add(p.id);
    if (p.split !== "eval" && p.split !== "tuning") errors.push(`${p.id}: split must be "eval" or "tuning"`);
    if (!p.labelProvenance) errors.push(`${p.id}: labelProvenance is required`);
    const pool = new Set<string>();
    for (const c of p.candidates || []) {
      if (!jobIds.has(c)) errors.push(`${p.id}: unknown candidate ${c}`);
      if (pool.has(c)) errors.push(`${p.id}: duplicate candidate ${c}`);
      pool.add(c);
    }
    for (const [jobId, l] of Object.entries(p.labels || {})) {
      if (!pool.has(jobId)) errors.push(`${p.id}: label for non-candidate ${jobId}`);
      if (l.relevance !== undefined && !GRADES.has(l.relevance)) errors.push(`${p.id}/${jobId}: relevance must be 0-3`);
      if (l.eligibility !== undefined && !ELIGIBILITY.has(l.eligibility)) errors.push(`${p.id}/${jobId}: bad eligibility`);
    }
  }
  if (errors.length) throw new Error(`Invalid ranking-eval dataset:\n- ${errors.join("\n- ")}`);
}

/** Same pipeline as /api/jobs/recommended: rank, drop non-qualifying when personalized, cap per company. */
export function rankLikeRecommendedFeed(jobs: EvalJob[], answers: OnboardingAnswers | null, now: number) {
  const ranked = rankJobsByRecommendation(jobs, answers, now);
  const qualifying = hasOnboardingAnswers(answers) ? ranked.filter((j) => (j.matchScore ?? j._matchScore ?? 0) > 0) : ranked;
  return capJobsPerCompany(qualifying, 3, 30);
}

export interface ProfileResult {
  id: string;
  candidates: number;
  labelled: { relevance: number; eligibility: number; unjudged: number };
  ranked: { id: string; score: number | null }[];
  metrics: RankingMetrics;
}

export interface EvalResult {
  dataset: { version: string; synthetic: boolean; referenceTime: string };
  split: Split;
  conventions: { k: number; relevantMinGrade: number; gain: string; discount: string; unjudged: string };
  counts: { profiles: number; uniqueCandidateJobs: number; skippedOtherSplit: number };
  labelCoverage: { pairs: number; relevanceJudged: number; eligibilityJudged: number };
  profiles: ProfileResult[];
  macro: {
    ndcgAtK: ReturnType<typeof macroMean>;
    precisionAtK: ReturnType<typeof macroMean>;
    eligibleRecall: ReturnType<typeof macroMean>;
  };
  totals: { hardFilterViolationsInTopK: number; hardFilterViolations: number; duplicateIds: number; unjudgedInTopK: number };
}

/** Evaluates one split only, so tuning profiles never leak into held-out numbers. */
export function evaluateDataset(d: EvalDataset, split: Split = "eval"): EvalResult {
  validateDataset(d);
  const now = Date.parse(d.referenceTime);
  const byId = new Map(d.jobs.map((j) => [j.id, j]));
  const selected = d.profiles.filter((p) => p.split === split);
  const profiles: ProfileResult[] = selected.map((p) => {
    const pool = p.candidates.map((id) => byId.get(id)!);
    const ranked = rankLikeRecommendedFeed(pool, p.answers, now);
    const ids = ranked.map((j) => String(j.id));
    const scores = ranked.map((j) => (typeof j.matchScore === "number" ? j.matchScore : null));
    const labels = Object.values(p.labels);
    return {
      id: p.id,
      candidates: p.candidates.length,
      labelled: {
        relevance: labels.filter((l) => l.relevance !== undefined).length,
        eligibility: labels.filter((l) => l.eligibility !== undefined).length,
        unjudged: p.candidates.filter((c) => p.labels[c]?.relevance === undefined).length,
      },
      ranked: ids.map((id, i) => ({ id, score: scores[i] })),
      metrics: evaluateRanking(ids, scores, p.labels, p.candidates),
    };
  });
  const sum = (f: (r: ProfileResult) => number) => profiles.reduce((a, r) => a + f(r), 0);
  return {
    dataset: { version: d.version, synthetic: d.synthetic, referenceTime: d.referenceTime },
    split,
    conventions: {
      k: K,
      relevantMinGrade: RELEVANT_MIN_GRADE,
      gain: "2^grade - 1 (grade 0 if labelled ineligible)",
      discount: "1 / log2(position + 1), condensed list",
      unjudged: "removed before NDCG/precision (condensed list); never counted as irrelevant",
    },
    counts: {
      profiles: profiles.length,
      uniqueCandidateJobs: new Set(selected.flatMap((p) => p.candidates)).size,
      skippedOtherSplit: d.profiles.length - selected.length,
    },
    labelCoverage: {
      pairs: sum((r) => r.candidates),
      relevanceJudged: sum((r) => r.labelled.relevance),
      eligibilityJudged: sum((r) => r.labelled.eligibility),
    },
    profiles,
    macro: {
      ndcgAtK: macroMean(profiles.map((r) => r.metrics.ndcgAtK)),
      precisionAtK: macroMean(profiles.map((r) => r.metrics.precisionAtK)),
      eligibleRecall: macroMean(profiles.map((r) => r.metrics.eligibleRecall)),
    },
    totals: {
      hardFilterViolationsInTopK: sum((r) => r.metrics.hardFilterViolationsInTopK.length),
      hardFilterViolations: sum((r) => r.metrics.hardFilterViolations.length),
      duplicateIds: sum((r) => r.metrics.duplicateIds.length),
      unjudgedInTopK: sum((r) => r.metrics.unjudgedInTopK),
    },
  };
}
