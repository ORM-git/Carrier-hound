/**
 * Wikidata as a company-profile source (CC0). Used under Wikidata's data-access policy: the Action API,
 * a descriptive User-Agent, one request per second across the whole run (wikidataClient), 429 cooldowns that honor
 * Retry-After, no retry on 403. Owner-approved 2026-11-24.
 *
 * Identity is never guessed from a name: a candidate from the name search counts only when its official
 * website (P856) is exactly the homepage of the company's stored domain (host match, path "/" or empty;
 * products like openai.com/sora never count), and exactly one candidate may match.
 * Only values a statement states are kept; ambiguous single-valued statements are dropped, never picked.
 */
import type { CompanyFact, CompanyFactKey } from "./types";

export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
export const WIKIDATA_HOST = "www.wikidata.org";
const MAX_LEADERS = 6;

export interface WikidataFetched { url: string; text: string; status: number; contentType: string }
export type WikidataFetcher = (url: string) => Promise<WikidataFetched>;

export const WIKIDATA_MIN_INTERVAL_MS = 1_000;
export const WIKIDATA_MAX_429_RETRIES = 2;
export const WIKIDATA_MAX_COOLDOWN_MS = 120_000;
const DEFAULT_429_COOLDOWN_MS = 5_000;

/** Thrown by the transport for a non-2xx answer; retryAfterMs comes from the Retry-After header when present. */
export class WikidataHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) { super(`Wikidata returned HTTP ${status}`); this.name = "WikidataHttpError"; }
}

/** Retry-After as delta-seconds or an HTTP date; null when absent or unparseable. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  const value = (header || "").trim();
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * One client per run, shared by every company: a single 1 req/s pacer (never reset per company), a global
 * cooldown after a 429 (Retry-After, else 5s doubling; at most 2 retries, never past a 120s wait), and, when
 * `cache` is on, a response cache by URL. Write-time revalidation uses cache: false so it always refetches.
 */
export function wikidataClient(fetchJson: WikidataFetcher, options: { sleep: (ms: number) => Promise<void>; nowMs: () => number; cache: boolean }): WikidataFetcher {
  let nextAt = -Infinity;
  const cache = new Map<string, WikidataFetched>();
  const paced = async (url: string): Promise<WikidataFetched> => {
    for (let attempt = 0; ; attempt++) {
      const wait = nextAt - options.nowMs();
      if (wait > 0) await options.sleep(wait);
      nextAt = options.nowMs() + WIKIDATA_MIN_INTERVAL_MS;
      try { return await fetchJson(url); }
      catch (error) {
        if (!(error instanceof WikidataHttpError) || error.status !== 429 || attempt >= WIKIDATA_MAX_429_RETRIES) throw error;
        const cooldown = error.retryAfterMs ?? DEFAULT_429_COOLDOWN_MS * 2 ** attempt;
        if (cooldown > WIKIDATA_MAX_COOLDOWN_MS) throw new Error(`Wikidata asked for a ${Math.ceil(cooldown / 1_000)}s cooldown, over the ${WIKIDATA_MAX_COOLDOWN_MS / 1_000}s cap; stopping`);
        nextAt = Math.max(nextAt, options.nowMs() + cooldown); // every later request, for any company, waits too
      }
    }
  };
  return async (url) => {
    if (!options.cache) return paced(url);
    const hit = cache.get(url);
    if (hit) return { ...hit };
    const fetched = await paced(url);
    cache.set(url, fetched);
    return { ...fetched };
  };
}
export type WikidataRecord = (source: { kind: "wikidata"; requested_url: string; final_url: string; status: number; fetched_at: string; bytes: number; sha256: string }) => void;

export interface WikidataLeader { name: string; role: string; roleAsOf: string | null; sourceUrl: string; retrievedAt: string }
export interface WikidataProfile {
  outcome: "matched" | "no_match" | "ambiguous";
  entityId: string | null;
  facts: Partial<Record<CompanyFactKey, CompanyFact>>;
  leadership: WikidataLeader[];
}

type Snak = { snaktype?: string; datavalue?: { value?: unknown } };
type Statement = { rank?: string; mainsnak?: Snak; qualifiers?: Record<string, Snak[]> };
type Entity = { id?: string; claims?: Record<string, Statement[]>; descriptions?: Record<string, { value?: string }>; labels?: Record<string, { value?: string }> };

export const apiUrl = (params: Record<string, string>) =>
  `${WIKIDATA_API}?${new URLSearchParams({ format: "json", formatversion: "1", ...params }).toString()}`;

export function bareHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch { return null; }
}

/** The company's homepage itself: same bare host and a root path. A product page on the same host is not the company. */
export function isHomepageOf(raw: unknown, domain: string | null): boolean {
  if (typeof raw !== "string" || !domain || bareHost(raw) !== domain) return false;
  try { return ["", "/"].includes(new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).pathname); } catch { return false; }
}

/** Statements to trust: preferred ones if any, else normal ones; deprecated never. */
function best(entity: Entity, property: string): Statement[] {
  const all = (entity.claims?.[property] || []).filter((s) => s.rank !== "deprecated" && s.mainsnak?.snaktype === "value");
  const preferred = all.filter((s) => s.rank === "preferred");
  return preferred.length ? preferred : all;
}
const itemId = (s: Statement | Snak | undefined): string | null => {
  const v = ("mainsnak" in (s || {}) ? (s as Statement).mainsnak : (s as Snak))?.datavalue?.value as { id?: string } | undefined;
  return typeof v?.id === "string" && /^Q\d+$/.test(v.id) ? v.id : null;
};
const stringValue = (s: Statement): string | null => (typeof s.mainsnak?.datavalue?.value === "string" ? (s.mainsnak.datavalue.value as string) : null);
const timeValue = (snak: Snak | undefined): { iso: string; precision: number } | null => {
  const v = snak?.datavalue?.value as { time?: string; precision?: number } | undefined;
  const m = typeof v?.time === "string" ? /^\+(\d{4})-(\d{2})-(\d{2})T/.exec(v.time) : null;
  if (!m || typeof v?.precision !== "number") return null;
  return { iso: `${m[1]}-${m[2] === "00" ? "01" : m[2]}-${m[3] === "00" ? "01" : m[3]}T00:00:00.000Z`, precision: v.precision };
};
/** Exactly one trusted value, else nothing: two different values is ambiguity, not a choice. */
function single<T>(values: Array<T | null>): T | null {
  const unique = Array.from(new Set(values.filter((v): v is T => v !== null).map((v) => JSON.stringify(v))));
  return unique.length === 1 ? JSON.parse(unique[0]) as T : null;
}

export function employeeBand(n: number): string | null {
  if (!Number.isFinite(n) || n < 1) return null;
  const bands: Array<[number, string]> = [[10, "1-10"], [50, "11-50"], [200, "51-200"], [500, "201-500"], [1000, "501-1,000"], [5000, "1,001-5,000"], [10000, "5,001-10,000"]];
  for (const [max, label] of bands) if (n <= max) return label;
  return "10,001+";
}

/**
 * When a statement's validity window ends, as the first instant AFTER it, from a P582 (end time) snak.
 * An end date is valid through its whole precision unit: a day-precision end date is valid through that day,
 * a month through that month, a year through that year. Precision coarser than a year, an unknown-value end
 * ("somevalue") or an unreadable time cannot be placed, so the caller treats the statement as ended (unknown).
 * "novalue" is not an end at all.
 */
function validUntilMs(snak: Snak): number | null {
  const v = snak.datavalue?.value as { time?: string; precision?: number } | undefined;
  const m = snak.snaktype === "value" && typeof v?.time === "string" ? /^\+(\d{4})-(\d{2})-(\d{2})T/.exec(v.time) : null;
  const p = v?.precision;
  if (!m || typeof p !== "number") return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (p >= 11) return month >= 1 && day >= 1 ? Date.UTC(year, month - 1, day + 1) : null;
  if (p === 10) return month >= 1 ? Date.UTC(year, month, 1) : null;
  if (p === 9) return Date.UTC(year + 1, 0, 1);
  return null;
}
/** First instant a statement is valid, from a P580 (start time) snak; null when absent or unplaceable. */
function validFromMs(snak: Snak | undefined): number | null {
  if (!snak) return null;
  const t = timeValue(snak);
  const v = snak.datavalue?.value as { time?: string } | undefined;
  const m = typeof v?.time === "string" ? /^\+(\d{4})-(\d{2})-(\d{2})T/.exec(v.time) : null;
  if (!t || !m || t.precision < 9) return null;
  return Date.parse(t.iso);
}
/** True when any end time of the statement has passed at `nowMs` (or cannot be placed). */
function hasEnded(s: Statement, nowMs: number): boolean {
  const ends = (s.qualifiers?.P582 || []).filter((q) => q.snaktype !== "novalue");
  if (!ends.length) return false;
  if (!Number.isFinite(nowMs)) return true;
  return ends.some((q) => { const until = validUntilMs(q); return until === null || nowMs >= until; });
}

/** Entity ids this profile needs labels for (HQ, exchange, CEO, founders). */
export function referencedIds(entity: Entity): string[] {
  const ids = new Set<string>();
  for (const p of ["P159", "P414", "P169", "P112"]) for (const s of best(entity, p)) { const id = itemId(s); if (id) ids.add(id); }
  return Array.from(ids).slice(0, 40);
}

export function extractWikidataProfile(input: {
  entity: Entity; companyDomain: string; labels: Record<string, string>; humans: Set<string>; retrievedAt: string;
}): Omit<WikidataProfile, "outcome"> {
  const { entity, labels, humans, retrievedAt } = input;
  const qid = String(entity.id);
  const sourceUrl = `https://www.wikidata.org/wiki/${qid}`;
  const facts: Partial<Record<CompanyFactKey, CompanyFact>> = {};
  const add = (key: CompanyFactKey, value: string | null, observedAt: string | null = null) => {
    if (value && value.trim()) facts[key] = { value: value.trim().slice(0, 700), sourceUrl, sourceKind: "wikidata", retrievedAt, observedAt };
  };

  const website = best(entity, "P856").map(stringValue).find((u) => isHomepageOf(u, bareHost(input.companyDomain))) || null;
  add("website", website);
  add("overview", entity.descriptions?.en?.value || null);
  const inception = single(best(entity, "P571").map((s) => { const t = timeValue(s.mainsnak); return t && t.precision >= 9 ? t.iso.slice(0, 4) : null; }));
  add("founded_year", inception); // no observed_at: an inception year is not a dated observation
  const hq = single(best(entity, "P159").map((s) => { const id = itemId(s); return id ? labels[id] || null : null; }));
  add("headquarters", hq);

  // Employees: the statement with the latest point in time (P585); undated counts are not comparable.
  const counts = best(entity, "P1128").map((s) => {
    const amount = Number((s.mainsnak?.datavalue?.value as { amount?: string } | undefined)?.amount);
    const when = timeValue(s.qualifiers?.P585?.[0]);
    return Number.isFinite(amount) && when ? { amount, when: when.iso } : null;
  }).filter((c): c is { amount: number; when: string } => c !== null).sort((a, b) => b.when.localeCompare(a.when));
  if (counts.length && (counts.length === 1 || counts[0].when !== counts[1].when)) add("employee_count_range", employeeBand(counts[0].amount), counts[0].when);

  const twitter = single(best(entity, "P2002").map(stringValue).map((u) => (u && /^[A-Za-z0-9_]{1,15}$/.test(u) ? u : null)));
  add("twitter_url", twitter ? `https://x.com/${twitter}` : null);
  const linkedin = single(best(entity, "P4264").map(stringValue).map((u) => (u && /^[A-Za-z0-9\-_.%]{1,100}$/.test(u) ? u : null)));
  add("linkedin_url", linkedin ? `https://www.linkedin.com/company/${linkedin}` : null);

  // Funding stage: Wikidata only states listings. A listing with a ticker means public; no listing is NOT "private".
  // Only listings valid at retrievedAt count: one whose end time (P582) has passed, or cannot be placed, does not
  // state "Public" now, while a future-dated end keeps it valid. A start time (P580) after retrievedAt has not begun.
  // observed_at is the start of the newest kept listing when stated to the day, else null (never invented).
  const nowMs = Date.parse(retrievedAt);
  const listings = best(entity, "P414").filter((s) => !hasEnded(s, nowMs)).map((s) => {
    const exchange = itemId(s);
    const ticker = s.qualifiers?.P249?.map((q) => (typeof q.datavalue?.value === "string" ? q.datavalue.value : null)).find(Boolean) || null;
    const from = validFromMs(s.qualifiers?.P580?.[0]);
    if (from !== null && Number.isFinite(nowMs) && from > nowMs) return null;
    const since = timeValue(s.qualifiers?.P580?.[0]);
    return exchange && labels[exchange] && ticker ? { text: `${labels[exchange]}: ${ticker}`, since: since && since.precision >= 11 ? since.iso : null } : null;
  }).filter((v): v is { text: string; since: string | null } => v !== null);
  const listedSince = listings.map((l) => l.since).filter((v): v is string => v !== null).sort().at(-1) ?? null;
  add("funding_stage", listings.length ? `Public (${Array.from(new Set(listings.map((l) => l.text))).slice(0, 2).join(", ")})` : null, listedSince);

  const leadership: WikidataLeader[] = [];
  for (const s of best(entity, "P169")) {
    const id = itemId(s);
    if (!id || !labels[id] || s.qualifiers?.P582?.length) continue; // an end time means a former CEO
    const since = timeValue(s.qualifiers?.P580?.[0]);
    leadership.push({ name: labels[id], role: "Chief Executive Officer", roleAsOf: since && since.precision >= 11 ? since.iso.slice(0, 10) : null, sourceUrl, retrievedAt });
  }
  for (const s of best(entity, "P112")) {
    const id = itemId(s);
    if (id && labels[id] && humans.has(id)) leadership.push({ name: labels[id], role: "Founder", roleAsOf: null, sourceUrl, retrievedAt });
  }
  const seen = new Set<string>();
  return {
    entityId: qid, facts,
    leadership: leadership.filter((l) => l.name.length <= 100 && !seen.has(`${l.name}|${l.role}`) && seen.add(`${l.name}|${l.role}`)).slice(0, MAX_LEADERS),
  };
}

function parseJson(text: string, what: string): Record<string, unknown> {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`Wikidata ${what} response is malformed`); }
  if (!data || typeof data !== "object" || "error" in (data as object)) throw new Error(`Wikidata ${what} response is malformed`);
  return data as Record<string, unknown>;
}

/**
 * At most 4 + founders requests per company (search, candidates, entity, labels, one P31 check per founder).
 * Pacing, cooldown and caching belong to the wikidataClient passed as fetchJson. Every response is recorded,
 * identity lookups included, so a write revalidates the match as well as the values.
 * Throws on fetch failure or malformed data; the caller records a redacted fetch_failed.
 */
export async function fetchWikidataProfile(input: {
  company: { name: string; canonical_domain: string | null };
  fetchJson: WikidataFetcher; now: () => string; sha256: (text: string) => string; record?: WikidataRecord;
}): Promise<WikidataProfile> {
  const { company, fetchJson, now, sha256, record } = input;
  const domain = bareHost(company.canonical_domain);
  const none = (outcome: WikidataProfile["outcome"]): WikidataProfile => ({ outcome, entityId: null, facts: {}, leadership: [] });
  if (!domain || !company.name.trim()) return none("no_match");
  const get = async (url: string, what: string) => {
    const res = await fetchJson(url);
    record?.({ kind: "wikidata", requested_url: url, final_url: res.url, status: res.status, fetched_at: now(), bytes: Buffer.byteLength(res.text), sha256: sha256(res.text) });
    return parseJson(res.text, what);
  };

  const search = await get(apiUrl({ action: "wbsearchentities", type: "item", language: "en", limit: "7", search: company.name.trim().slice(0, 100) }), "search");
  if (!Array.isArray(search.search)) throw new Error("Wikidata search response is malformed");
  const candidateIds = (search.search as Array<{ id?: unknown }>).map((r) => r.id).filter((id): id is string => typeof id === "string" && /^Q\d+$/.test(id));
  if (!candidateIds.length) return none("no_match");
  const candidates = await get(apiUrl({ action: "wbgetentities", props: "claims", ids: candidateIds.join("|") }), "candidates");
  const entities = candidates.entities as Record<string, Entity> | undefined;
  if (!entities || typeof entities !== "object") throw new Error("Wikidata candidates response is malformed");
  const matches = candidateIds.filter((id) => best(entities[id] || {}, "P856").some((s) => isHomepageOf(stringValue(s), domain)));
  if (matches.length !== 1) return none(matches.length ? "ambiguous" : "no_match");

  const qid = matches[0];
  const full = await get(apiUrl({ action: "wbgetentities", props: "claims|descriptions", languages: "en", ids: qid }), "entity");
  const entity = (full.entities as Record<string, Entity> | undefined)?.[qid];
  if (!entity?.claims) throw new Error("Wikidata entity response is malformed");
  const retrievedAt = now();
  const refs = referencedIds(entity);
  const labels: Record<string, string> = {};
  if (refs.length) {
    const named = await get(apiUrl({ action: "wbgetentities", props: "labels", languages: "en", ids: refs.join("|") }), "labels");
    for (const [id, e] of Object.entries((named.entities as Record<string, Entity>) || {})) {
      const label = e?.labels?.en?.value;
      if (typeof label === "string" && label.trim()) labels[id] = label.trim();
    }
  }
  const humans = new Set<string>();
  for (const founder of best(entity, "P112").map(itemId).filter((id): id is string => !!id && !!labels[id]).slice(0, MAX_LEADERS)) {
    const claims = await get(apiUrl({ action: "wbgetclaims", entity: founder, property: "P31" }), "founder");
    const p31 = ((claims.claims as Record<string, Statement[]> | undefined)?.P31 || []).map(itemId);
    if (p31.includes("Q5")) humans.add(founder); // instance of human; an organization is never labelled Founder
  }
  return { outcome: "matched", ...extractWikidataProfile({ entity, companyDomain: domain, labels, humans, retrievedAt }) };
}
