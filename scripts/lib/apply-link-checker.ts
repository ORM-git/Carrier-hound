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
 * URL safety limits (honest): before every hop the URL must be http(s), default port, no
 * credentials, no local hostname. DNS is bounded by the hop timeout. EVERY resolved answer
 * must pass: IPv4 via isPrivateIp (logoResolver); IPv6 via the stricter checker-local
 * allowlist isPublicIpv6 (2000::/3 only, minus 6to4, IETF 2001::/23 incl. Teredo, and doc
 * ranges, so loopback in any spelling, multicast, ULA, link-local, IPv4-mapped and NAT64 are
 * all refused). The real fetch pins the socket to the checked address, so a second DNS
 * answer cannot swap in an internal IP for that hop.
 * Not covered: IPv4 special ranges isPrivateIp does not list (e.g. 198.18/15, TEST-NETs),
 * any HTTP proxy that re-resolves, and a resolver that lies.
 */

import dns from "node:dns";
import net from "node:net";
import { Agent } from "undici";
import { isPrivateIp, type DnsLookupFn } from "../../src/lib/companies/logoResolver";

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

const fail = (category: Category, message: string) => Object.assign(new Error(message), { category });

/** IPv6 -> 8 words, or null if unparseable. Handles "::", zone ids and an embedded dotted IPv4 tail. */
function ipv6Words(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  if (s.includes(".")) {
    const colon = s.lastIndexOf(":");
    const v4 = s.slice(colon + 1);
    if (!net.isIPv4(v4)) return null;
    const [a, b, c, d] = v4.split(".").map(Number);
    s = `${s.slice(0, colon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || head.length + fill + tail.length !== 8) return null;
  const words = [...head, ...Array<string>(fill).fill("0"), ...tail];
  return words.every((w) => /^[0-9a-f]{1,4}$/.test(w)) ? words.map((w) => parseInt(w, 16)) : null;
}

/** Conservative allowlist: ordinary global unicast only. Fails closed on anything unparseable. */
export function isPublicIpv6(ip: string): boolean {
  const w = ipv6Words(ip);
  if (!w) return false;
  if ((w[0] & 0xe000) !== 0x2000) return false; // outside 2000::/3: ::, ::1, ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8
  if (w[0] === 0x2002) return false; // 6to4 embeds an IPv4 that may be private
  if (w[0] === 0x2001 && w[1] < 0x0200) return false; // 2001::/23 IETF special use, incl. Teredo 2001::/32
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false; // documentation 2001:db8::/32
  if (w[0] === 0x3fff) return false; // documentation 3fff::/20 (whole /16, conservative)
  return true;
}

function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address.split("%")[0]);
  if (family === 4) return isPrivateIp(address);
  if (family === 6) return !isPublicIpv6(address);
  return true;
}

const realLookup: DnsLookupFn = (host) => dns.promises.lookup(host, { all: true });

/** Resolver call that settles within timeoutMs whatever the resolver does; a late answer is ignored. */
async function boundedLookup(lookup: DnsLookupFn, host: string, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(fail("timeout", `DNS lookup timed out after ${timeoutMs}ms for ${host}`)), timeoutMs);
  });
  const answer = Promise.resolve()
    .then(() => lookup(host))
    .catch((e: NodeJS.ErrnoException) => {
      throw fail("transport_error", `DNS lookup failed for ${host}: ${e?.code ?? e?.message ?? String(e)}`);
    });
  try {
    return await Promise.race([answer, deadline]); // race subscribes to both, so a late rejection is handled
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates a URL and every DNS answer. Throws an Error carrying .category:
 * unsafe_url (policy refusal), transport_error (DNS failure) or timeout (DNS too slow).
 */
export async function assertSafeUrl(
  raw: string,
  lookup: DnsLookupFn = realLookup,
  timeoutMs: number = DEFAULTS.timeoutMs,
): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail("unsafe_url", "invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("unsafe_url", `scheme ${url.protocol} not allowed`);
  if (url.username || url.password) throw fail("unsafe_url", "credentials in URL not allowed");
  if (url.port) throw fail("unsafe_url", `non-default port ${url.port} not allowed`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  let answers: { address: string; family: number }[];
  if (net.isIP(host)) {
    answers = [{ address: host, family: net.isIP(host) }];
  } else {
    if (!host.includes(".") || /(^|\.)(localhost|local|internal|home\.arpa)$/.test(host)) {
      throw fail("unsafe_url", `local hostname ${host} not allowed`);
    }
    answers = await boundedLookup(lookup, host, timeoutMs);
    if (!answers?.length) throw fail("transport_error", `DNS lookup returned no addresses for ${host}`);
  }
  const bad = answers.find((x) => isBlockedAddress(x.address));
  if (bad) throw fail("unsafe_url", `blocked non-public address ${bad.address} for ${host}`);
  return { url, address: answers[0].address, family: answers[0].family };
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
  // Challenge marker first: a 200 challenge page is not evidence the apply page is reachable.
  if (headers.get("cf-mitigated")?.toLowerCase() === "challenge") return "blocked_or_challenge";
  if (status >= 200 && status < 300) return "reachable";
  if (status === 401 || status === 403 || status === 429) return "blocked_or_challenge";
  if (status === 404 || status === 410) return "missing";
  if (status >= 400 && status < 500) return "client_error";
  if (status >= 500) return "server_error";
  return "unexpected_status";
}

type Schedule = (host: string) => Promise<void>;

/** One request: validate, wait for the host slot, fetch with a timeout, discard the body. */
async function requestOnce(method: "HEAD" | "GET", rawUrl: string, deps: CheckerDeps, schedule: Schedule, hops: Hop[]) {
  const timeoutMs = deps.timeoutMs ?? DEFAULTS.timeoutMs;
  const { url, address, family } = await assertSafeUrl(rawUrl, deps.lookup, timeoutMs); // throws categorized errors
  await schedule(url.hostname); // throttle wait sits outside every deadline and is never a finding
  const hop: Hop = { method, url: url.href, status: null, startedAt: deps.now() };
  hops.push(hop);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Pin the socket to the address that passed the private-range check (no DNS rebinding for this hop).
  const dispatcher = new Agent({ connect: { lookup: (_h, _o, cb) => cb(null, [{ address, family }]) } });
  try {
    const res = await deps.fetch(url.href, { method, redirect: "manual", headers: HEADERS, signal: controller.signal, dispatcher });
    hop.status = res.status;
    await res.body?.cancel().catch(() => {}); // never download the page; status and headers are all we use
    return { url, status: res.status, headers: res.headers };
  } catch (e) {
    const aborted = controller.signal.aborted;
    throw fail(aborted ? "timeout" : "transport_error", aborted ? `timed out after ${timeoutMs}ms` : (e as Error).message || String(e));
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
