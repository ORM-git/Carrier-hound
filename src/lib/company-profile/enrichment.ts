import type { CompanyFact, CompanyFactKey, CompanyLeader, CompanyNewsItem } from "./types";
import { safeCompanySourceUrl } from "./types";

export interface OfficialPageExtraction {
  verified: boolean;
  facts: Partial<Record<CompanyFactKey, CompanyFact>>;
  leadership: CompanyLeader[];
  news: CompanyNewsItem[];
}

export interface EnrichmentOptions { write: boolean; cap: number; afterId?: string }

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
    const ref = parsed.hostname.endsWith(".supabase.co") ? parsed.hostname.split(".")[0] : "local";
    return (parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && ref === expectedProjectRef && ref !== "szakevhxhwpeskidvtfs";
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

/** Extracts only first-party structured facts from an employer page; no title/copyright guesses. */
export function extractOfficialCompanyPage(input: {
  html: string; pageUrl: string; canonicalDomain: string; companyName: string; retrievedAt?: string;
}): OfficialPageExtraction {
  const pageUrl = safeCompanySourceUrl(input.pageUrl);
  const expectedHost = normalizedHost(`https://${input.canonicalDomain}`);
  const fetchedHost = pageUrl ? normalizedHost(pageUrl) : null;
  if (!pageUrl || !expectedHost || fetchedHost !== expectedHost) return { verified: false, facts: {}, leadership: [], news: [] };
  const retrievedAt = iso(input.retrievedAt || new Date().toISOString())!;
  const parsed = Array.from(input.html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)).flatMap((match) => {
    try { return objects(JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"))); } catch { return []; }
  });
  const pagePath = new URL(pageUrl).pathname.toLowerCase();
  const expectedName = clean(input.companyName, 120).toLowerCase().replace(/[^a-z0-9]/g, "");
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
  for (const link of Array.from(input.html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi))) {
    let linked = "";
    try { linked = new URL(link[1].replace(/&amp;/g, "&"), pageUrl).href; } catch {}
    const url = safeCompanySourceUrl(linked);
    if (!url) continue;
    const host = normalizedHost(url);
    if (host === "linkedin.com" || host === "www.linkedin.com") add("linkedin_url", url);
    if (host === "twitter.com" || host === "x.com") add("twitter_url", url);
  }
  const leadership: CompanyLeader[] = (/(?:about|leadership|team|management)/i.test(pagePath) ? parsed : []).filter((o) => {
    const types = Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]];
    return types.includes("Person") && clean(o.name) && (o.jobTitle || o.hasOccupation);
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

/** Failed/empty/ambiguous observations never erase an existing sourced fact. */
export function reconcileCompanyFacts<T extends string>(existing: Partial<Record<CompanyFactKey, CompanyFact<T>>>, observed: Partial<Record<CompanyFactKey, CompanyFact<T>>>, covered: boolean) {
  const next = { ...existing };
  if (!covered) return next;
  for (const [key, candidate] of Object.entries(observed) as [CompanyFactKey, CompanyFact<T>][]) {
    if (!candidate?.value || !candidate.sourceUrl || !candidate.retrievedAt) continue;
    const current = next[key];
    if (!current || current.value === candidate.value && Date.parse(candidate.retrievedAt) >= Date.parse(current.retrievedAt)) next[key] = candidate;
  }
  return next;
}
