/**
 * Edge KV / config store adapter (env-gated, zero-dependency, edge-safe).
 *
 * Two backends behind one interface:
 *  1. A Cloudflare KV *binding* (the normal path on Cloudflare Pages
 *     production): the request context hands us the bound namespace, we
 *     wrap it directly. No tokens, no network egress.
 *  2. The Cloudflare KV REST API (scripts, crons, local integration
 *     checks), enabled only when CLOUDFLARE_ACCOUNT_ID,
 *     CLOUDFLARE_KV_NAMESPACE_ID and CLOUDFLARE_KV_API_TOKEN are all set.
 *
 * Neither configured -> NoopEdgeKv: reads miss, writes no-op. Like the
 * Redis adapter this is fail-open: backend errors become a miss/no-op via
 * the optional onError hook. The store is for config and cache-shaped
 * data only - never a source of truth, never PII (docs/edge-kv.md).
 */

export interface KvBindingLike {
  get(key: string, opts?: { type?: "text" | "json" }): Promise<unknown>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface EdgeKvAdapter {
  get(key: string): Promise<string | null>;
  getJson<T = unknown>(key: string): Promise<T | null>;
  put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  isEnabled(): boolean;
}

/** Observability is best-effort too: a failing hook must not break fail-open reads. */
function notifyError(hook: ((err: unknown) => void) | undefined, err: unknown): void {
  try {
    // A void callback can still be async. Observe its rejection without waiting
    // for telemetry, which must never delay the cache miss/no-op response.
    void Promise.resolve(hook?.(err)).catch(() => {});
  } catch { /* Preserve the adapter's miss/no-op contract. */ }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface EdgeKvOptions {
  binding?: KvBindingLike;
  accountId?: string;
  namespaceId?: string;
  apiToken?: string;
  fetchImpl?: FetchLike;
  onError?: (err: unknown) => void;
}

class NoopEdgeKv implements EdgeKvAdapter {
  async get(): Promise<string | null> { return null; }
  async getJson(): Promise<null> { return null; }
  async put(): Promise<boolean> { return false; }
  async delete(): Promise<boolean> { return false; }
  isEnabled(): boolean { return false; }
}

class BindingEdgeKv implements EdgeKvAdapter {
  constructor(private readonly ns: KvBindingLike, private readonly onError?: (err: unknown) => void) {}
  isEnabled(): boolean { return true; }

  async get(key: string): Promise<string | null> {
    try {
      const v = await this.ns.get(key, { type: "text" });
      return typeof v === "string" ? v : null;
    } catch (err) { notifyError(this.onError, err); return null; }
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    try {
      const v = await this.ns.get(key, { type: "json" });
      return (v ?? null) as T | null;
    } catch (err) { notifyError(this.onError, err); return null; }
  }

  async put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<boolean> {
    try {
      const o: { expirationTtl?: number } = {};
      if (opts?.ttlSeconds && Number.isSafeInteger(opts.ttlSeconds) && opts.ttlSeconds > 0) {
        o.expirationTtl = opts.ttlSeconds;
      }
      await this.ns.put(key, value, o);
      return true;
    } catch (err) { notifyError(this.onError, err); return false; }
  }

  async delete(key: string): Promise<boolean> {
    try { await this.ns.delete(key); return true; }
    catch (err) { notifyError(this.onError, err); return false; }
  }
}

class RestEdgeKv implements EdgeKvAdapter {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly onError?: (err: unknown) => void;

  constructor(opts: Required<Pick<EdgeKvOptions, "accountId" | "namespaceId" | "apiToken">> & EdgeKvOptions) {
    this.base =
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}` +
      `/storage/kv/namespaces/${encodeURIComponent(opts.namespaceId)}/values`;
    this.token = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onError = opts.onError;
  }

  isEnabled(): boolean { return true; }

  private async request(method: string, key: string, body?: string, ttlSeconds?: number): Promise<Response | null> {
    try {
      const q = ttlSeconds && Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0
        ? `?expiration_ttl=${ttlSeconds}` : "";
      const res = await this.fetchImpl(`${this.base}/${encodeURIComponent(key)}${q}`, {
        method,
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
        body,
      });
      if (!res.ok) throw new Error(`kv HTTP ${res.status}`);
      return res;
    } catch (err) { notifyError(this.onError, err); return null; }
  }

  async get(key: string): Promise<string | null> {
    const res = await this.request("GET", key);
    if (!res) return null;
    try { return await res.text(); } catch (err) { notifyError(this.onError, err); return null; }
  }

  async getJson<T = unknown>(key: string): Promise<T | null> {
    const text = await this.get(key);
    if (text === null) return null;
    try { return JSON.parse(text) as T; } catch (err) { notifyError(this.onError, err); return null; }
  }

  async put(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<boolean> {
    return (await this.request("PUT", key, value, opts?.ttlSeconds)) !== null;
  }

  async delete(key: string): Promise<boolean> {
    return (await this.request("DELETE", key)) !== null;
  }
}

/**
 * Resolve an adapter. Priority: explicit/request binding > env REST config
 * > noop. Not memoized: bindings are per-request on Pages.
 */
export function getEdgeKv(opts: EdgeKvOptions = {}): EdgeKvAdapter {
  if (opts.binding) return new BindingEdgeKv(opts.binding, opts.onError);
  const accountId = opts.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespaceId = opts.namespaceId ?? process.env.CLOUDFLARE_KV_NAMESPACE_ID;
  const apiToken = opts.apiToken ?? process.env.CLOUDFLARE_KV_API_TOKEN;
  if (accountId && namespaceId && apiToken) {
    return new RestEdgeKv({ ...opts, accountId, namespaceId, apiToken });
  }
  return new NoopEdgeKv();
}
