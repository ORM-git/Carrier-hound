/**
 * Managed Redis adapter (env-gated, zero-dependency, edge-safe).
 *
 * Speaks the Upstash Redis REST API over fetch, so it works in both the
 * Node and edge runtimes with no npm dependency. When the env vars are
 * absent (local dev, CI, previews) a NoopRedis is returned: every read is
 * a miss and every write is a no-op, so callers must already treat the
 * cache as an optimization, never a source of truth.
 *
 * Fail-open contract: network/HTTP/parse errors are swallowed into a
 * miss/no-op and reported through the optional onError hook. A cache
 * outage must never take a request path down.
 *
 * Env:
 *   UPSTASH_REDIS_REST_URL    e.g. https://<name>.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN  bearer token (secret - vault only)
 *
 * See docs/managed-redis.md for the owner activation checklist.
 */

export interface RedisAdapter {
  /** Returns null on miss, on disabled adapter, or on any failure. */
  get(key: string): Promise<string | null>;
  /** set with optional TTL seconds. Resolves false when disabled/failed. */
  set(key: string, value: string, opts?: { exSeconds?: number }): Promise<boolean>;
  del(key: string): Promise<boolean>;
  /** Atomic increment; returns the new value, or null when disabled/failed. */
  incr(key: string): Promise<number | null>;
  /** True when a real backend is configured (not when it is merely reachable). */
  isEnabled(): boolean;
}

/** Observability is best-effort too: a failing hook must not break fail-open reads. */
function notifyError(hook: ((err: unknown) => void) | undefined, err: unknown): void {
  try { hook?.(err); } catch { /* Preserve the adapter's miss/no-op contract. */ }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RedisOptions {
  url?: string;
  token?: string;
  fetchImpl?: FetchLike;
  onError?: (err: unknown) => void;
}

class NoopRedis implements RedisAdapter {
  async get(): Promise<string | null> { return null; }
  async set(): Promise<boolean> { return false; }
  async del(): Promise<boolean> { return false; }
  async incr(): Promise<number | null> { return null; }
  isEnabled(): boolean { return false; }
}

class UpstashRestRedis implements RedisAdapter {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: Required<Pick<RedisOptions, "url" | "token">> & RedisOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onError = opts.onError;
  }

  isEnabled(): boolean { return true; }

  private async call(args: Array<string | number>): Promise<unknown> {
    try {
      const path = args.map((a) => encodeURIComponent(String(a))).join("/");
      const res = await this.fetchImpl(`${this.base}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!res.ok) throw new Error(`redis HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: string };
      if (body.error) throw new Error(`redis error: ${body.error}`);
      return body.result ?? null;
    } catch (err) {
      notifyError(this.onError, err);
      return null;
    }
  }

  async get(key: string): Promise<string | null> {
    const r = await this.call(["GET", key]);
    return typeof r === "string" ? r : null;
  }

  async set(key: string, value: string, opts?: { exSeconds?: number }): Promise<boolean> {
    const args: Array<string | number> = ["SET", key, value];
    if (opts?.exSeconds && Number.isSafeInteger(opts.exSeconds) && opts.exSeconds > 0) {
      args.push("EX", opts.exSeconds);
    }
    return (await this.call(args)) === "OK";
  }

  async del(key: string): Promise<boolean> {
    const r = await this.call(["DEL", key]);
    return typeof r === "number" && r >= 0;
  }

  async incr(key: string): Promise<number | null> {
    const r = await this.call(["INCR", key]);
    const n = typeof r === "string" ? Number(r) : r;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  }
}

/**
 * Resolve the process-wide adapter. Noop unless BOTH env vars are set;
 * the result is memoized per env configuration (tests construct their own).
 */
let memo: { url: string; token: string; adapter: RedisAdapter } | null = null;

export function getRedis(opts: RedisOptions = {}): RedisAdapter {
  const url = opts.url ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = opts.token ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return new NoopRedis();
  if (!opts.fetchImpl && !opts.onError && memo && memo.url === url && memo.token === token) {
    return memo.adapter;
  }
  const adapter = new UpstashRestRedis({ ...opts, url, token });
  if (!opts.fetchImpl && !opts.onError) memo = { url, token, adapter };
  return adapter;
}

/** Test helper: drop the memoized adapter. */
export function resetRedisForTests(): void {
  memo = null;
}
