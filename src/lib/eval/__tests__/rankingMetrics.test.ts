import { describe, expect, it } from "vitest";
import { evaluateRanking, macroMean, type JobLabel } from "../rankingMetrics";

// Hand calculation, gain 2^g - 1, discount 1/log2(pos + 1):
//   grades 3,2,1,0 in order -> 7/1 + 3/log2(3) + 1/log2(4) + 0 = 7 + 1.892789 + 0.5 = 9.392789
//   grades 0,1,2,3 in order -> 0 + 1/log2(3) + 3/log2(4) + 7/log2(5) = 0.630930 + 1.5 + 3.014736 = 5.145666
//   reversed NDCG = 5.145666 / 9.392789 = 0.547830
const labels: Record<string, JobLabel> = {
  a: { relevance: 3, eligibility: "eligible" },
  b: { relevance: 2, eligibility: "eligible" },
  c: { relevance: 1, eligibility: "eligible" },
  d: { relevance: 0, eligibility: "eligible" },
};
const pool = ["a", "b", "c", "d"];
const none = (n: number) => Array(n).fill(null);

describe("ranking metrics, hand-calculated", () => {
  it("perfect order: NDCG 1, P@10 = 2 relevant / 4 judged, eligible recall 2/2", () => {
    const m = evaluateRanking(["a", "b", "c", "d"], none(4), labels, pool);
    expect(m.dcg).toBeCloseTo(9.392789, 5);
    expect(m.idcg).toBeCloseTo(9.392789, 5);
    expect(m.ndcgAtK).toBe(1);
    expect(m.precisionAtK).toBe(0.5);
    expect(m.precisionDenominator).toBe(4); // fewer than 10 results: denominator is what was returned and judged
    expect(m.eligibleRecall).toBe(1);
    expect([m.eligibleReturned, m.eligibleDenominator]).toEqual([2, 2]);
  });

  it("reversed order: NDCG 0.547830", () => {
    const m = evaluateRanking(["d", "c", "b", "a"], none(4), labels, pool);
    expect(m.dcg).toBeCloseTo(5.145666, 5);
    expect(m.ndcgAtK).toBeCloseTo(0.54783, 5);
    expect(m.precisionAtK).toBe(0.5);
  });

  it("hard-filter violation: an ineligible job is counted, earns no gain, and lowers NDCG", () => {
    const withBlocked = { ...labels, x: { relevance: 3, eligibility: "ineligible" } as JobLabel };
    const m = evaluateRanking(["x", "a", "b"], none(3), withBlocked, [...pool, "x"]);
    expect(m.hardFilterViolationsInTopK).toEqual(["x"]);
    expect(m.hardFilterViolations).toEqual(["x"]);
    // x has effective grade 0: DCG = 0 + 7/log2(3) + 3/log2(4) = 4.416508 + 1.5; ideal ignores x
    expect(m.dcg).toBeCloseTo(5.916508, 5);
    expect(m.ndcgAtK).toBeCloseTo(5.916508 / 9.392789, 5);
    expect(m.precisionAtK).toBeCloseTo(2 / 3, 10);
  });

  it("unjudged results are removed (condensed list), never scored as irrelevant", () => {
    const m = evaluateRanking(["u", "a", "b", "c", "d"], none(5), labels, [...pool, "u"]);
    expect(m.unjudgedInTopK).toBe(1);
    expect(m.eligibilityUnknownInTopK).toBe(1);
    expect(m.condensedTopK).toEqual(["a", "b", "c", "d"]);
    expect(m.ndcgAtK).toBe(1); // as if u were absent; scoring u as 0 would push a to position 2
    expect(m.precisionDenominator).toBe(4);
  });

  it("no relevant label: NDCG undefined, not 0; no eligible relevant label: recall undefined", () => {
    const zero = { p: { relevance: 0 }, q: { relevance: 1, eligibility: "ineligible" } } as Record<string, JobLabel>;
    const m = evaluateRanking(["p", "q"], none(2), zero, ["p", "q"]);
    expect(m.ndcgAtK).toBeNull();
    expect(m.eligibleRecall).toBeNull();
    expect(m.precisionAtK).toBe(0);
    expect(m.undefinedReasons).toHaveLength(2);
  });

  it("empty ranking and nothing judged returned: precision undefined; recall 0 over an explicit denominator", () => {
    const m = evaluateRanking([], [], labels, pool);
    expect(m.precisionAtK).toBeNull();
    expect(m.ndcgAtK).toBe(0);
    expect([m.eligibleReturned, m.eligibleDenominator, m.eligibleRecall]).toEqual([0, 2, 0]);
  });

  it("duplicates count once; ties are reported; only the first 10 are scored", () => {
    const dup = evaluateRanking(["a", "a", "b"], [50, 50, 40], labels, pool);
    expect(dup.duplicateIds).toEqual(["a"]);
    expect(dup.returned).toBe(2);
    expect(dup.tiedAdjacentPairsInTopK).toBe(0); // the duplicate is not a tie with itself
    expect(evaluateRanking(["a", "b", "c"], [50, 50, 40], labels, pool).tiedAdjacentPairsInTopK).toBe(1);

    const many: Record<string, JobLabel> = {};
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    ids.forEach((id, i) => (many[id] = { relevance: i < 2 ? 0 : 2, eligibility: "eligible" }));
    const m = evaluateRanking(ids, none(12), many, ids);
    expect(m.topK).toHaveLength(10);
    expect(m.precisionAtK).toBe(8 / 10);
    expect(m.eligibleRecall).toBe(1);
  });

  it("macro mean skips undefined profiles and reports how many", () => {
    expect(macroMean([1, 0.5, null])).toEqual({ mean: 0.75, included: 2, excluded: 1 });
    expect(macroMean([null])).toEqual({ mean: null, included: 0, excluded: 1 });
  });
});
