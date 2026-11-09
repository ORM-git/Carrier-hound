import { withJitter } from "../reliability/jitter";

/**
 * Client retry with backoff (FE row "Client retry with backoff").
 * Retries a fetch on a network error or a transient gateway status
 * (502/503/504) with exponential backoff plus jitter. Everything else is
 * returned as-is so callers keep their existing !res.ok handling:
 * 429 is never retried (the server rate limiter said stop), nor are other
 * 4xx or 5xx statuses. After the last attempt the final Response is returned,
 * or the final network error is rethrown.
 */
export interface RetryOptions {
  /** Extra attempts after the first. Default 2 (3 attempts total). */
  retries?: number;
  /** First backoff wait in ms; doubles each retry. Default 300. */
  baseMs?: number;
  /** Cap for a single wait in ms. Default 2000. */
  maxMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable random source in [0, 1) for tests. */
  rand?: () => number;
}

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  options: RetryOptions = {}
): Promise<Response> {
  const retries = Math.max(0, Math.floor(options.retries ?? 2));
  const baseMs = options.baseMs ?? 300;
  const maxMs = options.maxMs ?? 2000;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let error: unknown = null;
    try {
      res = await doFetch();
    } catch (e) {
      error = e;
    }
    if (res && !isTransientStatus(res.status)) return res;
    if (attempt >= retries) {
      if (res) return res;
      throw error;
    }
    const wait = Math.min(maxMs, baseMs * 2 ** attempt);
    await sleep(withJitter(wait, { rand: options.rand }));
  }
}
