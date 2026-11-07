/**
 * Shared jitter helper for retry/backoff waits (Reliability row: Jitter).
 * Plain exponential backoff makes many clients retry in lockstep after a
 * shared failure (thundering herd). Adding bounded random jitter spreads
 * the retries while preserving the expected backoff growth.
 *
 * withJitter returns a uniformly distributed integer in
 *   [baseMs * (1 - fraction), baseMs * (1 + fraction)]
 * using the injected RNG (defaults to Math.random). The RNG is injectable
 * so tests can pin the bounds deterministically.
 */
export interface JitterOptions {
  /** Symmetric jitter fraction. Default 0.2 (±20%). */
  fraction?: number;
  /** Random source in [0, 1). Defaults to Math.random. */
  rand?: () => number;
}

export function withJitter(baseMs: number, options: JitterOptions = {}): number {
  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new RangeError("withJitter baseMs must be a finite number >= 0");
  }
  const fraction = options.fraction ?? 0.2;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
    throw new RangeError("withJitter fraction must be a finite number in [0, 1)");
  }
  const rand = options.rand ?? Math.random;
  const sample = rand();
  const clamped = Math.min(Math.max(sample, 0), 0.999999999);
  return Math.round(baseMs * (1 - fraction + 2 * fraction * clamped));
}
