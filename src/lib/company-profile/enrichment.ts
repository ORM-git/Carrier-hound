import type { CompanyFact, CompanyFactKey, CompanyLeader, CompanyNewsItem } from "./types";
import { safeCompanySourceUrl } from "./types";

export interface OfficialPageExtraction {
  verified: boolean;
  facts: Partial<Record<CompanyFactKey, CompanyFact>>;
  leadership: CompanyLeader[];
  news: CompanyNewsItem[];
}

export interface EnrichmentOptions { write: boolean; cap: number; afterId?: string }
export interface CompanyAtsEvidence { ats_type?: string | null; slug?: string | null; careers_url?: string | null }
export const companyProfileObservationRpc = {
  leadership: "record_company_profile_leadership_observation",
  news: "record_company_profile_news_observation",
} as const;

type TimestampedObservation = { company_id: string; retrieved_at: string };

function dedupeObservationsByKey<T extends TimestampedObservation>(rows: T[], keyFor: (row: T) => string): T[] {
  const observations = new Map<string, T>();
  for (const row of rows) {
    const retrievedAt = Date.parse(row.retrieved_at);
    if (!Number.isFinite(retrievedAt)) continue;
    const key = keyFor(row);
    const existing = observations.get(key);
    if (!existing) {
      observations.set(key, row);
    } else if (retrievedAt > Date.parse(existing.retrieved_at)) {
      observations.set(key, { ...existing, retrieved_at: row.retrieved_at });
    }
  }
  return Array.from(observations.values());
}

export function dedupeLeadershipObservations<T extends TimestampedObservation & { name: string; role: string; role_as_of: string | null }>(rows: T[]): T[] {
  return dedupeObservationsByKey(rows, (row) => JSON.stringify([
    row.company_id,
    row.name,
    row.role,
    row.role_as_of === null ? null : row.role_as_of.slice(0, 10),
  ]));
}

export function dedupeCompanyNewsObservations<T extends TimestampedObservation & { source_url: string }>(rows: T[]): T[] {
  return dedupeObservationsByKey(rows, (row) => JSON.stringify([row.company_id, row.source_url]));
}

export interface CompanyProfileFreshnessInput {
  now: string;
  state?: { status?: string | null; last_succeeded_at?: string | null; next_refresh_at?: string | null; last_error?: string | null } | null;
  facts: Partial<Record<CompanyFactKey, Pick<CompanyFact, "retrievedAt" | "status">>>;
  leadership: Array<{ retrievedAt: string }>;
  news?: Array<{ publishedAt: string; retrievedAt?: string }>;
}

export function evaluateCompanyProfileFreshness(input: CompanyProfileFreshnessInput): { status: "fresh" | "stale" | "conflict"; shouldRefresh: boolean } {
  const now = Date.parse(input.now);
  const state = input.state;
  const daysOld = (date: string | null | undefined) => {
    const timestamp = date ? Date.parse(date) : NaN;
    return Number.isFinite(timestamp) ? (now - timestamp) / 86_400_000 : Infinity;
  };
  const conflicts = state?.status === "conflict" || Object.values(input.facts).some((fact) => fact?.status === "conflict");
  const staleFacts = Object.values(input.facts).some((fact) => !fact || daysOld(fact.retrievedAt) > 180);
  const staleLeadership = input.leadership.some((leader) => daysOld(leader.retrievedAt) > 30);
  const staleNews = input.news !== undefined && input.news.some((item) => daysOld(item.retrievedAt || item.publishedAt) > 90);
  const refreshDue = daysOld(state?.next_refresh_at) >= 0;
  const stale = staleFacts || staleLeadership || staleNews || !state?.last_succeeded_at || refreshDue;
  const retryCoolingDown = state?.status === "stale" && !refreshDue;
  return { status: conflicts ? "conflict" : stale ? "stale" : "fresh", shouldRefresh: conflicts ? refreshDue : stale && !retryCoolingDown };
}

export async function processCompanyBatch<T extends { id: string }>(
  companies: T[],
  afterId: string | null,
  processCompany: (company: T) => Promise<void>,
): Promise<{ nextAfterId: string | null; attempted: number; error: { companyId: string; message: string } | null }> {
  let nextAfterId = afterId;
  let attempted = 0;
  for (const company of companies) {
    attempted++;
    try {
      await processCompany(company);
      nextAfterId = company.id;
    } catch (error) {
      return {
        nextAfterId,
        attempted,
        error: { companyId: company.id, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  return { nextAfterId, attempted, error: null };
}

interface RobotsGroup { userAgents: string[]; rules: Array<{ allow: boolean; path: string }> }

/** Applies RFC-style robots groups, wildcard paths, and the longest matching rule. */
export function robotsAllows(robots: string, path: string, productToken = "careermonke"): boolean {
  const groups: RobotsGroup[] = [];
  let group: RobotsGroup | null = null;
  const finishGroup = () => {
    if (group?.userAgents.length) groups.push(group);
    group = null;
  };
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) {
      if (group?.rules.length) finishGroup();
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "user-agent") {
      if (group?.rules.length) finishGroup();
      if (!group) group = { userAgents: [], rules: [] };
      group.userAgents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && value && group) {
      group.rules.push({ allow: key === "allow", path: value });
    }
  }
  finishGroup();
  const specific = groups.filter((candidate) => candidate.userAgents.some((agent) => agent !== "*" && productToken.toLowerCase().includes(agent)));
  const applicable = specific.length ? specific : groups.filter((candidate) => candidate.userAgents.includes("*"));
  const matching = applicable.flatMap((candidate) => candidate.rules).filter((rule) => {
    const terminal = rule.path.endsWith("$");
    const pattern = rule.path.replace(/\$$/, "").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try { return new RegExp(`^${pattern}${terminal ? "$" : ""}`).test(path); } catch { return false; }
  });
  if (!matching.length) return true;
  const specificity = Math.max(...matching.map((rule) => rule.path.replace(/[\*$]/g, "").length));
  return !matching.some((rule) => !rule.allow && rule.path.replace(/[\*$]/g, "").length === specificity);
}

export function parseEnrichmentOptions(argv: string[]): EnrichmentOptions {
  const hasWrite = argv.includes("--write");
  const at = argv.indexOf("--max-rows");
  const cap = at >= 0 ? Number(argv[at + 1]) : NaN;
  if (!Number.isInteger(cap) || cap <= 0 || cap > 100) throw new Error("--max-rows must be an explicit positive integer no greater than 100");
  const afterAt = argv.indexOf("--after-id");
  const afterId = afterAt >= 0 ? argv[afterAt + 1] : undefined;
  if (afterAt >= 0 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(afterId || "")) throw new Error("--after-id must be a company UUID from the previous report");
  return { write: hasWrite, cap, afterId };
}

export function isAllowedCompanyProfileWriteTarget(supabaseUrl: string, environment: string, expectedProjectRef: string | undefined): boolean {
  if ((environment !== "local" && environment !== "staging") || !expectedProjectRef) return false;
  try {
    const parsed = new URL(supabaseUrl);
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    const expectedRef = expectedProjectRef.trim().toLowerCase();
    const productionRef = "szakevhxhwpeskidvtfs";
    if (expectedRef === productionRef) return false;
    if (environment === "local") {
      return parsed.protocol === "http:" && expectedRef === "local" && ["localhost", "127.0.0.1", "::1"].includes(host.replace(/^\[|\]$/g, ""));
    }
    return parsed.protocol === "https:" && expectedRef !== "local" && host === `${expectedRef}.supabase.co`;
  } catch { return false; }
}

const clean = (value: unknown, max = 700): string => typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/[\s\u00a0]+/g, " ").trim().slice(0, max) : "";
const iso = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function objects(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (value && typeof value === "object") {
    const item = value as Record<string, any>;
    return [item, ...(Array.isArray(item["@graph"]) ? item["@graph"].flatMap(objects) : [])];
  }
  return [];
}
function isOrg(o: Record<string, any>): boolean {
  const types = Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]];
  return types.some((t) => ["Organization", "Corporation", "EducationalOrganization"].includes(t));
}
function normalizedHost(value: string): string | null {
  const safe = safeCompanySourceUrl(value);
  if (!safe) return null;
  const host = new URL(safe).hostname.toLowerCase().replace(/^www\./, "");
  return host;
}

function normalizedLink(value: string, baseUrl: string): string | null {
  try {
    const safe = safeCompanySourceUrl(new URL(value, baseUrl).href);
    if (!safe) return null;
    const url = new URL(safe);
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
    return `${host}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch { return null; }
}

function expectedAtsBoardLinks(board: CompanyAtsEvidence): string[] {
  const links: string[] = [];
  if (board.careers_url) links.push(board.careers_url);
  const slug = String(board.slug || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) return links;
  const urls: Record<string, string[]> = {
    greenhouse: [`https://boards.greenhouse.io/${slug}`, `https://job-boards.greenhouse.io/${slug}`],
    lever: [`https://jobs.lever.co/${slug}`],
    ashby: [`https://jobs.ashbyhq.com/${slug}`],
    smartrecruiters: [`https://careers.smartrecruiters.com/${slug}`],
    recruitee: [`https://${slug}.recruitee.com`],
    workable: [`https://apply.workable.com/${slug}`, `https://${slug}.workable.com`],
  };
  links.push(...(urls[String(board.ats_type || "").toLowerCase()] || []));
  return links;
}

/** A first-party domain is trusted only when an enabled ATS board is linked from it (or its careers URL is that domain). */
export function isAtsEvidenceLinked(canonicalDomain: string, homeHtml: string, homeUrl: string, boards: CompanyAtsEvidence[]): boolean {
  const expectedHost = normalizedHost(`https://${canonicalDomain}`);
  if (!expectedHost || !Array.isArray(boards) || !boards.length) return false;
  const linked = new Set<string>();
  for (const match of Array.from(homeHtml.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi))) {
    const link = normalizedLink(match[1].replace(/&amp;/g, "&"), homeUrl);
    if (link) linked.add(link);
  }
  for (const board of boards) {
    for (const candidate of expectedAtsBoardLinks(board)) {
      const link = normalizedLink(candidate, homeUrl);
      if (!link) continue;
      if (link.split("/")[0] === expectedHost || linked.has(link)) return true;
    }
  }
  return false;
}

function organizationNameKey(value: unknown): string {
  return clean(value, 120).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function personAffiliatedWithOrganization(person: Record<string, any>, organization: Record<string, any>, expectedName: string, expectedHost: string): boolean {
  const relationships = Array.isArray(person.worksFor) ? person.worksFor : [person.worksFor];
  const organizationId = typeof organization["@id"] === "string" ? organization["@id"] : null;
  return relationships.some((relationship) => {
    if (typeof relationship === "string") return organizationNameKey(relationship) === expectedName;
    if (!relationship || typeof relationship !== "object") return false;
    const nameMatches = organizationNameKey(relationship.name) === expectedName;
    const idMatches = organizationId && relationship["@id"] === organizationId;
    const url = typeof relationship.url === "string" ? normalizedHost(relationship.url) : null;
    const idHost = typeof relationship["@id"] === "string" ? normalizedHost(relationship["@id"]) : null;
    const domainMatches = url === expectedHost || idHost === expectedHost;
    const hasConflictingName = Boolean(relationship.name) && !nameMatches;
    const hasConflictingDomain = Boolean(url || idHost) && !domainMatches;
    return !hasConflictingName && !hasConflictingDomain && (nameMatches || idMatches || domainMatches);
  });
}

function verifiedSocialLinks(organization: Record<string, any>, expectedName: string): Partial<Record<"linkedin_url" | "twitter_url", string>> {
  const sameAs = Array.isArray(organization.sameAs) ? organization.sameAs : [organization.sameAs];
  const result: Partial<Record<"linkedin_url" | "twitter_url", string>> = {};
  for (const value of sameAs) {
    if (typeof value !== "string") continue;
    const safe = safeCompanySourceUrl(value);
    if (!safe) continue;
    const url = new URL(safe);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);
    if ((host === "linkedin.com" || host === "www.linkedin.com") && segments.length === 2 && ["company", "showcase"].includes(segments[0].toLowerCase()) && !result.linkedin_url) {
      result.linkedin_url = safe;
    }
    if (["twitter.com", "x.com"].includes(host) && segments.length === 1 && organizationNameKey(segments[0]) === expectedName && !result.twitter_url) {
      result.twitter_url = safe;
    }
  }
  return result;
}

/** Extracts only first-party structured facts from an employer page; no title/copyright guesses. */
function extractOfficialCompanyPageInternal(input: {
  html: string; pageUrl: string; canonicalDomain: string; companyName: string; retrievedAt?: string; atsBoards?: CompanyAtsEvidence[];
}, atsVerifiedByHomepage = false): OfficialPageExtraction {
  const pageUrl = safeCompanySourceUrl(input.pageUrl);
  const expectedHost = normalizedHost(`https://${input.canonicalDomain}`);
  const fetchedHost = pageUrl ? normalizedHost(pageUrl) : null;
  if (!pageUrl || !expectedHost || fetchedHost !== expectedHost) return { verified: false, facts: {}, leadership: [], news: [] };
  if (!atsVerifiedByHomepage && !isAtsEvidenceLinked(input.canonicalDomain, input.html, pageUrl, input.atsBoards || [])) return { verified: false, facts: {}, leadership: [], news: [] };
  const retrievedAt = iso(input.retrievedAt || new Date().toISOString())!;
  const parsed = Array.from(input.html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)).flatMap((match) => {
    try { return objects(JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"))); } catch { return []; }
  });
  const pagePath = new URL(pageUrl).pathname.toLowerCase();
  const expectedName = organizationNameKey(input.companyName);
  const organization = parsed.find((o) => isOrg(o) && clean(o.name, 120).toLowerCase().replace(/[^a-z0-9]/g, "") === expectedName);
  if (!organization) return { verified: false, facts: {}, leadership: [], news: [] };
  const facts: OfficialPageExtraction["facts"] = {};
  const add = (key: CompanyFactKey, value: unknown, sourceKind: CompanyFact["sourceKind"] = "official_site", observedAt?: string | null) => {
    const text = clean(value, key === "overview" ? 700 : 180);
    if (text) facts[key] = { value: text, sourceUrl: pageUrl, sourceKind, retrievedAt, observedAt: observedAt || null };
  };
  const website = safeCompanySourceUrl(typeof organization.url === "string" ? organization.url : `https://${expectedHost}/`);
  if (website && normalizedHost(website) === expectedHost) facts.website = { value: website, sourceUrl: pageUrl, sourceKind: "official_site", retrievedAt };
  const metaDescription = input.html.match(/<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["']([^"']*)["'])[^>]*>/i)?.[1];
  add("overview", organization.description || metaDescription);
  const address = organization.headquarters;
  if (address && typeof address === "object") {
    add("headquarters", [address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean).join(", "));
  }
  const founded = iso(organization.foundingDate);
  if (founded) add("founded_year", founded.slice(0, 4), "official_site", founded);
  const employees = organization.numberOfEmployees;
  if (typeof employees === "string") add("employee_count_range", employees);
  else if (employees && typeof employees === "object" && typeof employees.value === "number" && employees.value > 0) add("employee_count_range", `${employees.value}`);
  const socialLinks = verifiedSocialLinks(organization, expectedName);
  if (socialLinks.linkedin_url) add("linkedin_url", socialLinks.linkedin_url);
  if (socialLinks.twitter_url) add("twitter_url", socialLinks.twitter_url);
  const leadership: CompanyLeader[] = (/(?:about|leadership|team|management)/i.test(pagePath) ? parsed : []).filter((o) => {
    const types = Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]];
    return types.includes("Person") && clean(o.name) && (o.jobTitle || o.hasOccupation) && personAffiliatedWithOrganization(o, organization, expectedName, expectedHost);
  }).slice(0, 12).flatMap((o, index) => {
    const name = clean(o.name, 100), role = clean(o.jobTitle || o.hasOccupation?.name, 120);
    return name && role && /\b(chief|ceo|cfo|cto|coo|cmo|cpo|president|founder|co-founder|executive|board|chair|vice president|vp)\b/i.test(role) ? [{ id: `${index}:${name}`, name, role, roleAsOf: iso(o.roleAsOf), sourceUrl: pageUrl, retrievedAt }] : [];
  });
  const news: CompanyNewsItem[] = (/(?:news|press|stories|blog|reports?)/i.test(pagePath) ? parsed : []).filter((o) => {
    const types = Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]];
    return types.includes("NewsArticle") || types.includes("Article");
  }).slice(0, 8).flatMap((o, index) => {
    const headline = clean(o.headline || o.name, 220), publishedAt = iso(o.datePublished), sourceUrl = safeCompanySourceUrl(typeof o.url === "string" ? o.url : pageUrl);
    if (!headline || !publishedAt || !sourceUrl || normalizedHost(sourceUrl) !== expectedHost) return [];
    return [{ id: `${publishedAt}:${index}`, headline, publishedAt, sourceUrl, excerpt: clean(o.description, 300) || null }];
  });
  return { verified: true, facts, leadership, news };
}

export function extractOfficialCompanyPage(input: {
  html: string; pageUrl: string; canonicalDomain: string; companyName: string; retrievedAt?: string; atsBoards?: CompanyAtsEvidence[];
}): OfficialPageExtraction {
  return extractOfficialCompanyPageInternal(input);
}

/** Keeps the ATS identity evidence available when validating first-party subpages. */
export function extractOfficialCompanySubpage(input: {
  html: string; pageUrl: string; canonicalDomain: string; companyName: string; retrievedAt?: string; atsBoards: CompanyAtsEvidence[];
  homepageContext?: { verified: boolean; homepageUrl: string; homepageHtml: string };
}): OfficialPageExtraction {
  const expectedHost = normalizedHost(`https://${input.canonicalDomain}`);
  const homepageHost = input.homepageContext ? normalizedHost(input.homepageContext.homepageUrl) : null;
  const subpageHost = normalizedHost(input.pageUrl);
  const verifiedHomepageContext = input.homepageContext?.verified === true
    && Boolean(expectedHost && homepageHost === expectedHost && subpageHost === expectedHost)
    && isAtsEvidenceLinked(input.canonicalDomain, input.homepageContext!.homepageHtml, input.homepageContext!.homepageUrl, input.atsBoards);
  return extractOfficialCompanyPageInternal(input, verifiedHomepageContext);
}

/** Failed/empty/ambiguous observations never erase an existing sourced fact. */
export function reconcileCompanyFacts<T extends string>(existing: Partial<Record<CompanyFactKey, CompanyFact<T>>>, observed: Partial<Record<CompanyFactKey, CompanyFact<T>>>, covered: boolean) {
  const next = { ...existing };
  if (!covered) return next;
  for (const [key, candidate] of Object.entries(observed) as [CompanyFactKey, CompanyFact<T>][]) {
    if (!candidate?.value || !candidate.sourceUrl || !candidate.retrievedAt) continue;
    const current = next[key];
    if (!current) { next[key] = { ...candidate, status: "fresh", conflict: null }; continue; }
    if (current.value === candidate.value) {
      if (Date.parse(candidate.retrievedAt) >= Date.parse(current.retrievedAt)) next[key] = { ...candidate, status: "fresh", conflict: null };
      continue;
    }
    const oldObservation = current.observedAt ? Date.parse(current.observedAt) : NaN;
    const newObservation = candidate.observedAt ? Date.parse(candidate.observedAt) : NaN;
    if (Number.isFinite(newObservation) && (!Number.isFinite(oldObservation) || newObservation > oldObservation)) {
      next[key] = { ...candidate, status: "fresh", conflict: null };
    } else if (!Number.isFinite(newObservation) || !Number.isFinite(oldObservation) || newObservation === oldObservation) {
      next[key] = { ...current, status: "conflict", conflict: { value: candidate.value, sourceUrl: candidate.sourceUrl, sourceKind: candidate.sourceKind, retrievedAt: candidate.retrievedAt, observedAt: candidate.observedAt || null } };
    }
  }
  return next;
}
