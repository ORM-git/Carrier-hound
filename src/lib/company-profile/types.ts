import { sanitizeExternalUrl, stripHtmlAndExecutableMarkup } from "@/lib/security/xss";

export type CompanyFactKey = "overview" | "website" | "headquarters" | "founded_year" | "employee_count_range" | "linkedin_url" | "twitter_url";

export interface CompanyFact<T = string> {
  value: T;
  sourceUrl: string;
  sourceKind: "official_site" | "official_report" | "official_announcement";
  retrievedAt: string;
  observedAt?: string | null;
  status?: "fresh" | "stale" | "conflict";
  conflict?: { value: string; sourceUrl: string; sourceKind: CompanyFact["sourceKind"]; retrievedAt: string; observedAt?: string | null } | null;
}

export interface CompanyLeader {
  id: string;
  name: string;
  role: string;
  roleAsOf: string | null;
  sourceUrl: string;
  retrievedAt: string;
}

export interface CompanyNewsItem {
  id: string;
  headline: string;
  publishedAt: string;
  sourceUrl: string;
  excerpt?: string | null;
}

export interface CompanyJobSummary {
  id: string;
  title: string;
  company: string;
  location: string;
  postedAt: string | null;
  logoUrl?: string | null;
}

export interface CompanyJobsResult {
  status: "ready" | "error" | "unknown";
  jobs: CompanyJobSummary[];
}

export interface CompanyProfile {
  companyId: string;
  facts: Partial<Record<CompanyFactKey, CompanyFact>>;
  leadership: CompanyLeader[];
  news: CompanyNewsItem[];
  jobs: CompanyJobsResult;
  freshness?: "fresh" | "stale" | "conflict";
}

const factKeys = new Set<CompanyFactKey>([
  "overview", "website", "headquarters", "founded_year", "employee_count_range", "linkedin_url", "twitter_url",
]);

export function isEligibleCompanyJob(candidate: { id?: unknown; company_id?: unknown; status?: unknown; is_active?: unknown }, companyId: string, currentJobId: string): boolean {
  return Boolean(candidate && typeof candidate.id === "string" && candidate.id !== currentJobId && candidate.company_id === companyId && candidate.status === "active" && candidate.is_active === true);
}

export function safeCompanySourceUrl(value: unknown): string | null {
  const safe = sanitizeExternalUrl(typeof value === "string" ? value : "");
  if (!safe) return null;
  try {
    const url = new URL(safe);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function sanitizeCompanyProfile(value: unknown, companyId?: string): CompanyProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CompanyProfile>;
  const id = companyId || (typeof raw.companyId === "string" ? raw.companyId : "");
  if (!id || !raw.facts || typeof raw.facts !== "object") return null;
  const facts: CompanyProfile["facts"] = {};
  for (const [key, candidate] of Object.entries(raw.facts)) {
    if (!factKeys.has(key as CompanyFactKey) || !candidate || typeof candidate !== "object") continue;
    const fact = candidate as CompanyFact;
    const sourceUrl = safeCompanySourceUrl(fact.sourceUrl);
    const retrievedAt = typeof fact.retrievedAt === "string" && Number.isFinite(Date.parse(fact.retrievedAt)) ? fact.retrievedAt : null;
    if (!sourceUrl || !retrievedAt || !["official_site", "official_report", "official_announcement"].includes(fact.sourceKind) || typeof fact.value !== "string" || !fact.value.trim()) continue;
    const isUrl = key.endsWith("_url") || key === "website";
    const cleanValue = isUrl ? safeCompanySourceUrl(fact.value) : stripHtmlAndExecutableMarkup(fact.value).trim().slice(0, key === "overview" ? 700 : 180);
    if (!cleanValue) continue;
    facts[key as CompanyFactKey] = {
      value: cleanValue,
      sourceUrl,
      sourceKind: fact.sourceKind,
      retrievedAt,
      observedAt: typeof fact.observedAt === "string" && Number.isFinite(Date.parse(fact.observedAt)) ? fact.observedAt : null,
      status: ["fresh", "stale", "conflict"].includes(String(fact.status)) ? fact.status : "fresh",
      conflict: fact.conflict && typeof fact.conflict.value === "string" && safeCompanySourceUrl(fact.conflict.sourceUrl) && Number.isFinite(Date.parse(fact.conflict.retrievedAt)) ? {
        value: stripHtmlAndExecutableMarkup(fact.conflict.value).trim().slice(0, key === "overview" ? 700 : 180),
        sourceUrl: safeCompanySourceUrl(fact.conflict.sourceUrl)!, sourceKind: fact.conflict.sourceKind,
        retrievedAt: fact.conflict.retrievedAt, observedAt: fact.conflict.observedAt || null,
      } : null,
    };
  }
  const leadership = Array.isArray(raw.leadership) ? raw.leadership.slice(0, 12).flatMap((row) => {
    const sourceUrl = safeCompanySourceUrl(row?.sourceUrl);
    if (!row || !sourceUrl || !row.name || !row.role || !Number.isFinite(Date.parse(row.retrievedAt))) return [];
    return [{ id: String(row.id), name: stripHtmlAndExecutableMarkup(row.name).slice(0, 100), role: stripHtmlAndExecutableMarkup(row.role).slice(0, 120), roleAsOf: row.roleAsOf && Number.isFinite(Date.parse(row.roleAsOf)) ? row.roleAsOf : null, sourceUrl, retrievedAt: row.retrievedAt }];
  }) : [];
  const news = Array.isArray(raw.news) ? raw.news.slice(0, 8).flatMap((row) => {
    const sourceUrl = safeCompanySourceUrl(row?.sourceUrl);
    if (!row || !sourceUrl || !row.headline || !Number.isFinite(Date.parse(row.publishedAt))) return [];
    return [{ id: String(row.id), headline: stripHtmlAndExecutableMarkup(row.headline).slice(0, 220), publishedAt: row.publishedAt, sourceUrl, excerpt: row.excerpt ? stripHtmlAndExecutableMarkup(row.excerpt).slice(0, 300) : null }];
  }) : [];
  const jobs = raw.jobs;
  const safeJobs: CompanyJobsResult = jobs && ["ready", "error", "unknown"].includes(jobs.status) ? {
    status: jobs.status,
    jobs: jobs.status === "ready" && Array.isArray(jobs.jobs) ? jobs.jobs.slice(0, 5).filter((job) => job && typeof job.id === "string").map((job) => ({ ...job, title: stripHtmlAndExecutableMarkup(job.title).slice(0, 180), company: stripHtmlAndExecutableMarkup(job.company).slice(0, 100), location: stripHtmlAndExecutableMarkup(job.location).slice(0, 120), logoUrl: job.logoUrl ? safeCompanySourceUrl(job.logoUrl) : null })) : [],
  } : { status: "unknown", jobs: [] };
  return { companyId: id, facts, leadership, news, jobs: safeJobs, freshness: ["fresh", "stale", "conflict"].includes(String(raw.freshness)) ? raw.freshness : "stale" };
}
