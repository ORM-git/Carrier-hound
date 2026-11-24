/**
 * Wikidata as a company-profile source (CC0). Used under Wikidata's data-access policy: the Action API,
 * a descriptive User-Agent, one request per second, no retry on 403/429. Owner-approved 2026-11-24.
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
  const listings = best(entity, "P414").map((s) => {
    const exchange = itemId(s);
    const ticker = s.qualifiers?.P249?.map((q) => (typeof q.datavalue?.value === "string" ? q.datavalue.value : null)).find(Boolean) || null;
    return exchange && labels[exchange] && ticker ? `${labels[exchange]}: ${ticker}` : null;
  }).filter((v): v is string => v !== null);
  add("funding_stage", listings.length ? `Public (${Array.from(new Set(listings)).slice(0, 2).join(", ")})` : null);

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
 * At most 4 + founders requests per company (search, candidates, entity, labels, one P31 check per founder),
 * spaced 1s apart. Throws on fetch failure or malformed data; the caller records a redacted fetch_failed.
 */
export async function fetchWikidataProfile(input: {
  company: { name: string; canonical_domain: string | null };
  fetchJson: WikidataFetcher; sleep: (ms: number) => Promise<void>; now: () => string; sha256: (text: string) => string; record?: WikidataRecord;
}): Promise<WikidataProfile> {
  const { company, fetchJson, sleep, now, sha256, record } = input;
  const domain = bareHost(company.canonical_domain);
  const none = (outcome: WikidataProfile["outcome"]): WikidataProfile => ({ outcome, entityId: null, facts: {}, leadership: [] });
  if (!domain || !company.name.trim()) return none("no_match");
  let first = true;
  const get = async (url: string, what: string, keep: boolean) => {
    if (!first) await sleep(1_000);
    first = false;
    const res = await fetchJson(url);
    if (keep) record?.({ kind: "wikidata", requested_url: url, final_url: res.url, status: res.status, fetched_at: now(), bytes: Buffer.byteLength(res.text), sha256: sha256(res.text) });
    return parseJson(res.text, what);
  };

  const search = await get(apiUrl({ action: "wbsearchentities", type: "item", language: "en", limit: "7", search: company.name.trim().slice(0, 100) }), "search", false);
  if (!Array.isArray(search.search)) throw new Error("Wikidata search response is malformed");
  const candidateIds = (search.search as Array<{ id?: unknown }>).map((r) => r.id).filter((id): id is string => typeof id === "string" && /^Q\d+$/.test(id));
  if (!candidateIds.length) return none("no_match");
  const candidates = await get(apiUrl({ action: "wbgetentities", props: "claims", ids: candidateIds.join("|") }), "candidates", false);
  const entities = candidates.entities as Record<string, Entity> | undefined;
  if (!entities || typeof entities !== "object") throw new Error("Wikidata candidates response is malformed");
  const matches = candidateIds.filter((id) => best(entities[id] || {}, "P856").some((s) => isHomepageOf(stringValue(s), domain)));
  if (matches.length !== 1) return none(matches.length ? "ambiguous" : "no_match");

  const qid = matches[0];
  const full = await get(apiUrl({ action: "wbgetentities", props: "claims|descriptions", languages: "en", ids: qid }), "entity", true);
  const entity = (full.entities as Record<string, Entity> | undefined)?.[qid];
  if (!entity?.claims) throw new Error("Wikidata entity response is malformed");
  const retrievedAt = now();
  const refs = referencedIds(entity);
  const labels: Record<string, string> = {};
  if (refs.length) {
    const named = await get(apiUrl({ action: "wbgetentities", props: "labels", languages: "en", ids: refs.join("|") }), "labels", true);
    for (const [id, e] of Object.entries((named.entities as Record<string, Entity>) || {})) {
      const label = e?.labels?.en?.value;
      if (typeof label === "string" && label.trim()) labels[id] = label.trim();
    }
  }
  const humans = new Set<string>();
  for (const founder of best(entity, "P112").map(itemId).filter((id): id is string => !!id && !!labels[id]).slice(0, MAX_LEADERS)) {
    const claims = await get(apiUrl({ action: "wbgetclaims", entity: founder, property: "P31" }), "founder", true);
    const p31 = ((claims.claims as Record<string, Statement[]> | undefined)?.P31 || []).map(itemId);
    if (p31.includes("Q5")) humans.add(founder); // instance of human; an organization is never labelled Founder
  }
  return { outcome: "matched", ...extractWikidataProfile({ entity, companyDomain: domain, labels, humans, retrievedAt }) };
}
