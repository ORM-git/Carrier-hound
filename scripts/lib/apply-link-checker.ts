/**
 * Core of the read-only Apply-link transport checker (scripts/check-apply-links.ts).
 *
 * Pure: importing this module loads no credentials, opens no DB client and makes no
 * request. Fetch, DNS lookup, clock and sleep are injected so tests run fully offline.
 *
 * What a result means: "reachable" = the final hop answered HTTP 2xx. That is transport
 * reachability only. It does NOT prove the job is still open, that the page is the right
 * posting, or that the company matches. No body is read; nothing is classified semantically.
 *
 * URL safety limits (honest): every hop is checked for http(s), default port, no
 * credentials, and a resolved address outside private/loopback/link-local/CGNAT/multicast
 * ranges (isPrivateIp from logoResolver). The real fetch pins the connection to the address
 * that was checked, so a second DNS answer cannot swap in an internal IP for that hop.
 * Not covered: IPv6 ranges isPrivateIp does not list (e.g. 6to4/NAT64 embeddings), any
 * HTTP proxy that re-resolves, and anything the resolver itself returns falsely.
 */

import { Agent } from "undici";
import { isPrivateIp, resolveAndValidateHost, type DnsLookupFn } from "../../src/lib/companies/logoResolver";

export interface ApplyJob {
  id: string;
  title: string;
  company: string;
  apply_url: string;
}

export type Category =
  | "reachable" // final hop 2xx: transport reachable only
  | "missing" // 404/410: page confirmed gone at that URL
  | "client_error" // other 4xx
  | "unsafe_url" // stored or redirected URL refused before any request
  | "redirect_failed" // redirect loop or limit exceeded
  | "blocked_or_challenge" // 401/403/429 or a bot-challenge marker: indeterminate
  | "server_error" // 5xx: indeterminate
  | "unexpected_status" // 1xx/3xx without a usable Location: indeterminate
  | "timeout"
  | "transport_error"; // DNS failure, connection reset, TLS error

export type Outcome = "reachable" | "failed" | "indeterminate";

export const OUTCOME: Record<Category, Outcome> = {
  reachable: "reachable",
  missing: "failed",
  client_error: "failed",
  unsafe_url: "failed",
  redirect_failed: "failed",
  blocked_or_challenge: "indeterminate",
  server_error: "indeterminate",
  unexpected_status: "indeterminate",
  timeout: "indeterminate",
  transport_error: "indeterminate",
};

export interface Hop {
  method: "HEAD" | "GET";
  url: string;
  status: number | null;
  startedAt: number;
}

export interface CheckResult {
  id: string;
  title: string;
  company: string;
  originalUrl: string;
  finalUrl: string | null;
  finalStatus: number | null;
  category: Category;
  hops: Hop[];
  durationMs: number;
  error?: string;
}

export type FetchFn = (url: string, init: RequestInit & { dispatcher?: Agent }) => Promise<Response>;

export interface CheckerDeps {
  fetch: FetchFn;
  lookup?: DnsLookupFn; // undefined = real DNS
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onResult?: (r: CheckResult) => void;
  concurrency?: number;
  hostGapMs?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export const DEFAULTS = { concurrency: 5, hostGapMs: 1000, timeoutMs: 10_000, maxRedirects: 5 };

const HEADERS = {
  // Honest identity, no browser spoofing; no cookies or auth are ever sent.
  "User-Agent": "CareerMonkeLinkCheck/1.0 (read-only apply-link transport check)",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
};

/** Throws a reason string if the URL is not an ordinary public http(s) destination. */
export async function assertSafeUrl(raw: string, lookup?: DnsLookupFn): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`scheme ${url.protocol} not allowed`);
  if (url.username || url.password) throw new Error("credentials in URL not allowed");
  if (url.port) throw new Error(`non-default port ${url.port} not allowed`);
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|home\.arpa)$/.test(host)) {
    throw new Error(`local hostname ${host} not allowed`);
  }
  const { resolvedIp, family } = await resolveAndValidateHost(host, lookup);
  if (isPrivateIp(resolvedIp)) throw new Error(`private address ${resolvedIp}`); // belt and braces
  return { url, address: resolvedIp, family };
}

/**
 * Serialized per-host start scheduler. Each call queues behind the previous call for the
 * same host and starts at least gapMs after it; different hosts never wait on each other.
 */
export function createHostScheduler(gapMs: number, now: () => number, sleep: (ms: number) => Promise<void>) {
  const tails = new Map<string, Promise<void>>();
  const lastStart = new Map<string, number>();
  return (host: string): Promise<void> => {
    const slot = (tails.get(host) ?? Promise.resolve()).then(async () => {
      const last = lastStart.get(host);
      if (last !== undefined) {
        const wait = last + gapMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastStart.set(host, now());
    });
    tails.set(host, slot);
    return slot;
  };
}

/** Deterministic seeded sample (mulberry32 + partial Fisher-Yates). No seed = first n, in order. */
export function sampleJobs<T>(universe: readonly T[], n: number, seed: number | null): T[] {
  if (seed === null) return universe.slice(0, n);
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = universe.slice();
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

function classifyStatus(status: number, headers: Headers): Category {
  if (status >= 200 && status < 300) return "reachable";
  if (status === 401 || status === 403 || status === 429 || headers.get("cf-mitigated") === "challenge") return "blocked_or_challenge";
  if (status === 404 || status === 410) return "missing";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500) return "server_error";
  return "unexpected_status";
}

type Schedule = (host: string) => Promise<void>;

/** One request: validate, wait for the host slot, fetch with a timeout, discard the body. */
async function requestOnce(method: "HEAD" | "GET", rawUrl: string, deps: CheckerDeps, schedule: Schedule, hops: Hop[]) {
  const { url, address, family } = await assertSafeUrl(rawUrl, deps.lookup).catch((e: Error) => {
    throw Object.assign(new Error(e.message), { category: "unsafe_url" as Category });
  });
  await schedule(url.hostname);
  const hop: Hop = { method, url: url.href, status: null, startedAt: deps.now() };
  hops.push(hop);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULTS.timeoutMs);
  // Pin the socket to the address that passed the private-range check (no DNS rebinding for this hop).
  const dispatcher = new Agent({ connect: { lookup: (_h, _o, cb) => cb(null, [{ address, family }]) } });
  try {
    const res = await deps.fetch(url.href, { method, redirect: "manual", headers: HEADERS, signal: controller.signal, dispatcher });
    hop.status = res.status;
    await res.body?.cancel().catch(() => {}); // never download the page; status and headers are all we use
    return { url, status: res.status, headers: res.headers };
  } catch (e) {
    const aborted = controller.signal.aborted;
    throw Object.assign(new Error(aborted ? `timed out after ${deps.timeoutMs ?? DEFAULTS.timeoutMs}ms` : (e as Error).message || String(e)), {
      category: (aborted ? "timeout" : "transport_error") as Category,
    });
  } finally {
    clearTimeout(timer);
    await dispatcher.destroy().catch(() => {});
  }
}

export async function checkJob(job: ApplyJob, deps: CheckerDeps, schedule: Schedule): Promise<CheckResult> {
  const start = deps.now();
  const hops: Hop[] = [];
  const maxRedirects = deps.maxRedirects ?? DEFAULTS.maxRedirects;
  const done = (category: Category, error?: string): CheckResult => {
    const last = hops[hops.length - 1];
    return {
      id: job.id,
      title: job.title,
      company: job.company,
      originalUrl: job.apply_url,
      finalUrl: last?.url ?? null,
      finalStatus: last?.status ?? null,
      category,
      hops,
      durationMs: deps.now() - start,
      ...(error ? { error } : {}),
    };
  };

  let method: "HEAD" | "GET" = "HEAD";
  let current = job.apply_url;
  const seen = new Set<string>();
  try {
    for (let redirects = 0; ; ) {
      const { url, status, headers } = await requestOnce(method, current, deps, schedule, hops);
      const location = headers.get("location");
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        seen.add(`${method} ${url.href}`);
        current = new URL(location, url).href;
        if (status === 303) method = "GET";
        if (seen.has(`${method} ${current}`)) return done("redirect_failed", `redirect loop back to ${current}`);
        if (++redirects > maxRedirects) return done("redirect_failed", `more than ${maxRedirects} redirects`);
        continue;
      }
      if (method === "HEAD" && (status === 405 || status === 400 || status === 501)) {
        method = "GET"; // HEAD refused: one GET to the same URL, body discarded, same limits
        current = url.href;
        continue;
      }
      return done(classifyStatus(status, headers));
    }
  } catch (e) {
    return done((e as { category?: Category }).category ?? "transport_error", (e as Error).message);
  }
}

/** Checks jobs with bounded global concurrency and per-host start spacing. */
export async function checkJobs(jobs: readonly ApplyJob[], deps: CheckerDeps): Promise<CheckResult[]> {
  const schedule = createHostScheduler(deps.hostGapMs ?? DEFAULTS.hostGapMs, deps.now, deps.sleep);
  const results: CheckResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await checkJob(jobs[i], deps, schedule);
      deps.onResult?.(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? DEFAULTS.concurrency, jobs.length) }, worker));
  return results;
}

/**
 * Exit contract:
 *   0 = check completed and every sampled link was transport-reachable (2xx)
 *   1 = check completed with at least one failed finding (missing, client_error, unsafe_url, redirect_failed)
 *   2 = check completed, no failed findings, but some results indeterminate (blocked/challenge, 5xx, timeout, transport)
 *   3 = not run / evidence unavailable (no mode, missing config, DB error, empty input, bad fixture)
 */
export const EXIT = { ALL_REACHABLE: 0, FAILED_FINDINGS: 1, INDETERMINATE: 2, NOT_RUN: 3 } as const;

export function exitCodeFor(results: readonly CheckResult[]): number {
  if (results.length === 0) return EXIT.NOT_RUN;
  const outcomes = new Set(results.map((r) => OUTCOME[r.category]));
  if (outcomes.has("failed")) return EXIT.FAILED_FINDINGS;
  if (outcomes.has("indeterminate")) return EXIT.INDETERMINATE;
  return EXIT.ALL_REACHABLE;
}
