/**
 * SLO evaluation primitives (pure, offline-testable).
 *
 * Target values live in docs/slo.md - never hard-code a new number here
 * without it being documented and grounded (measured data or a published
 * standard such as web.dev's "good" thresholds).
 */

export interface SloTarget {
  /** Percentile to evaluate, e.g. 75. */
  percentile: number;
  /** Breach when the percentile exceeds this many milliseconds. */
  maxMs: number;
}

export interface SloEvaluation {
  sampleCount: number;
  percentiles: Record<string, number | null>;
  breaches: Array<{ percentile: number; maxMs: number; actualMs: number }>;
  status: "no_data" | "ok" | "breach";
}

/** Nearest-rank percentile on an unsorted numeric sample. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p <= 0 || p > 100) throw new RangeError(`percentile must be in (0, 100], got ${p}`);
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Evaluate samples against percentile targets. NaN/negative samples are
 * dropped before evaluation.
 */
export function evaluateSlo(samples: readonly number[], targets: readonly SloTarget[]): SloEvaluation {
  const clean = samples.filter((v) => Number.isFinite(v) && v >= 0);
  const percentiles: Record<string, number | null> = {};
  const breaches: SloEvaluation["breaches"] = [];

  for (const t of targets) {
    if (!Number.isFinite(t.maxMs) || t.maxMs < 0) throw new RangeError("maxMs must be finite and nonnegative");
    const actual = percentile(clean, t.percentile);
    percentiles[`p${t.percentile}`] = actual;
    if (actual !== null && actual > t.maxMs) {
      breaches.push({ percentile: t.percentile, maxMs: t.maxMs, actualMs: actual });
    }
  }

  return {
    sampleCount: clean.length,
    percentiles,
    breaches,
    status: clean.length === 0 ? "no_data" : breaches.length > 0 ? "breach" : "ok",
  };
}
