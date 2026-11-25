/**
 * Offline ranking-quality metrics for labelled recommendation fixtures (checklist #62). Pure, no I/O.
 *
 * Conventions (see docs/ranking-eval.md):
 * - Relevance grade 0-3; a job without a grade is UNJUDGED, never treated as irrelevant.
 * - Effective grade = grade, except 0 when the job is labelled "ineligible" (a hard-filtered job has no value).
 * - NDCG@K: gain 2^g - 1, discount 1 / log2(position + 1) (position 1-based), computed on the condensed list
 *   (the ranking with unjudged jobs removed, then the first K). Ideal = all judged pool jobs by effective grade.
 *   Undefined (null) when the ideal DCG is 0 (no relevant label in the pool).
 * - Precision@K: judged jobs with effective grade >= RELEVANT_MIN_GRADE among the first min(K, n) jobs of the
 *   condensed list, divided by min(K, n). Null when no returned job is judged.
 * - Eligible recall: pool jobs labelled "eligible" AND graded relevant (>= RELEVANT_MIN_GRADE) that the ranker
 *   returned (anywhere), divided by all such pool jobs. Scoped to the judged pool, never the corpus. Null when the
 *   pool has no eligible relevant job. (Eligible but irrelevant jobs are not expected back, so they are excluded.)
 * - Hard-filter violations: returned jobs labelled "ineligible" (in the actual top K, and anywhere).
 * - Duplicate ids in the ranking: only the first occurrence counts; later ones are reported and ignored.
 */

export type Grade = 0 | 1 | 2 | 3;
export type Eligibility = "eligible" | "ineligible";
export interface JobLabel {
  /** Absent = unjudged. */
  relevance?: Grade;
  /** Absent = unknown. */
  eligibility?: Eligibility;
}

export const K = 10;
export const RELEVANT_MIN_GRADE = 2;

export interface RankingMetrics {
  returned: number;
  duplicateIds: string[];
  topK: string[];
  unjudgedInTopK: number;
  eligibilityUnknownInTopK: number;
  condensedTopK: string[];
  dcg: number;
  idcg: number;
  ndcgAtK: number | null;
  relevantInCondensedTopK: number;
  precisionAtK: number | null;
  precisionDenominator: number;
  eligibleReturned: number;
  eligibleDenominator: number;
  eligibleRecall: number | null;
  hardFilterViolationsInTopK: string[];
  hardFilterViolations: string[];
  tiedAdjacentPairsInTopK: number;
  undefinedReasons: string[];
}

const gain = (g: number) => 2 ** g - 1;
const discount = (position: number) => 1 / Math.log2(position + 1);
const dcgOf = (grades: number[]) => grades.reduce((sum, g, i) => sum + gain(g) * discount(i + 1), 0);

export function effectiveGrade(label: JobLabel | undefined): number | null {
  if (!label || label.relevance === undefined) return null;
  return label.eligibility === "ineligible" ? 0 : label.relevance;
}

/**
 * @param ranked  job ids in the ranker's order, as returned
 * @param scores  the ranker's score per returned position (same length as ranked), for tie reporting
 * @param labels  labels for the candidate pool (job id -> label); missing id = unjudged / unknown
 * @param pool    every candidate job id the ranker was given
 */
export function evaluateRanking(
  ranked: readonly string[],
  scores: readonly (number | null | undefined)[],
  labels: Readonly<Record<string, JobLabel>>,
  pool: readonly string[]
): RankingMetrics {
  const seen = new Set<string>();
  const unique: string[] = [];
  const uniqueScores: (number | null | undefined)[] = [];
  const duplicateIds: string[] = [];
  ranked.forEach((id, i) => {
    if (seen.has(id)) duplicateIds.push(id);
    else {
      seen.add(id);
      unique.push(id);
      uniqueScores.push(scores[i]);
    }
  });

  const topK = unique.slice(0, K);
  const condensed = unique.filter((id) => effectiveGrade(labels[id]) !== null);
  const condensedTopK = condensed.slice(0, K);
  const condensedGrades = condensedTopK.map((id) => effectiveGrade(labels[id]) as number);

  const idealGrades = Array.from(new Set(pool))
    .map((id) => effectiveGrade(labels[id]))
    .filter((g): g is number => g !== null)
    .sort((a, b) => b - a)
    .slice(0, K);
  const dcg = dcgOf(condensedGrades);
  const idcg = dcgOf(idealGrades);

  const relevantInCondensedTopK = condensedGrades.filter((g) => g >= RELEVANT_MIN_GRADE).length;
  const eligiblePool = Array.from(new Set(pool)).filter(
    (id) => labels[id]?.eligibility === "eligible" && (labels[id]?.relevance ?? -1) >= RELEVANT_MIN_GRADE
  );
  const eligibleReturned = eligiblePool.filter((id) => seen.has(id)).length;

  let ties = 0;
  for (let i = 1; i < topK.length; i++) {
    const a = uniqueScores[i - 1];
    const b = uniqueScores[i];
    if (typeof a === "number" && a === b) ties++;
  }

  const undefinedReasons: string[] = [];
  if (idcg === 0) undefinedReasons.push("ndcg: no relevant label in the judged pool");
  if (condensedTopK.length === 0) undefinedReasons.push("precision: no judged job among returned results");
  if (eligiblePool.length === 0) undefinedReasons.push("eligible recall: no job labelled eligible and relevant");

  return {
    returned: unique.length,
    duplicateIds,
    topK,
    unjudgedInTopK: topK.filter((id) => effectiveGrade(labels[id]) === null).length,
    eligibilityUnknownInTopK: topK.filter((id) => labels[id]?.eligibility === undefined).length,
    condensedTopK,
    dcg,
    idcg,
    ndcgAtK: idcg > 0 ? dcg / idcg : null,
    relevantInCondensedTopK,
    precisionAtK: condensedTopK.length > 0 ? relevantInCondensedTopK / condensedTopK.length : null,
    precisionDenominator: condensedTopK.length,
    eligibleReturned,
    eligibleDenominator: eligiblePool.length,
    eligibleRecall: eligiblePool.length > 0 ? eligibleReturned / eligiblePool.length : null,
    hardFilterViolationsInTopK: topK.filter((id) => labels[id]?.eligibility === "ineligible"),
    hardFilterViolations: unique.filter((id) => labels[id]?.eligibility === "ineligible"),
    tiedAdjacentPairsInTopK: ties,
    undefinedReasons,
  };
}

/** Mean over profiles where the metric is defined; the excluded count is reported, never silently dropped. */
export function macroMean(values: readonly (number | null)[]): { mean: number | null; included: number; excluded: number } {
  const defined = values.filter((v): v is number => typeof v === "number");
  return {
    mean: defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : null,
    included: defined.length,
    excluded: values.length - defined.length,
  };
}
