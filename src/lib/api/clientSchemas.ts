/**
 * Frontend sheet row "Client schema validation (zod/yup)".
 * Small hand-written runtime validators for the public JSON payloads the
 * browser consumes (/api/stats and /api/ticker). No schema library: this
 * module is imported by landing client code, which has a first-load budget.
 * A malformed response is dropped or normalised to null instead of reaching
 * component state. No rendered output changes for well-formed payloads.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface ParsedStats {
  activeJobs: number | null;
  companies: number | null;
  jobsToday: number | null;
  totalJobs: number | null;
  companiesScanned: number | null;
  updatedAt?: string;
}

/** Null when the payload is not an object; bad counts become null (jobsToday defaults to 0). */
export function parseStatsResponse(raw: unknown): ParsedStats | null {
  if (!isRecord(raw)) return null;
  const activeJobs = numOrNull(raw.activeJobs) ?? numOrNull(raw.totalJobs);
  const companies = numOrNull(raw.companies) ?? numOrNull(raw.companiesScanned);
  return {
    activeJobs,
    companies,
    jobsToday: numOrNull(raw.jobsToday) ?? 0,
    totalJobs: activeJobs,
    companiesScanned: companies,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  };
}

/** Landing globe strip: counts stay null when absent (no invented figures). */
export function parseGlobeStats(raw: unknown): {
  jobsToday: number;
  totalJobs: number | null;
  companiesScanned: number | null;
} | null {
  if (!isRecord(raw)) return null;
  return {
    jobsToday: numOrNull(raw.jobsToday) ?? 0,
    totalJobs: numOrNull(raw.totalJobs),
    companiesScanned: numOrNull(raw.companiesScanned),
  };
}

export interface TickerItemParsed {
  company: string;
  title: string;
  posted_at: string;
  logo_url: string | null;
}

function parseTickerItem(item: unknown): TickerItemParsed | null {
  if (!isRecord(item)) return null;
  const { company, title, posted_at } = item;
  if (typeof company !== "string") return null;
  if (typeof title !== "string") return null;
  if (typeof posted_at !== "string") return null;
  // Missing logo_url -> null; present but not string|null -> drop the item.
  const logo = "logo_url" in item ? item.logo_url : null;
  if (logo !== null && typeof logo !== "string") return null;
  return { company, title, posted_at, logo_url: logo };
}

/** Accepts a bare array or { jobs: [...] }; drops malformed items; anything else -> []. */
export function parseTickerResponse(raw: unknown): TickerItemParsed[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.jobs)
      ? raw.jobs
      : [];
  const out: TickerItemParsed[] = [];
  for (const item of list) {
    const parsed = parseTickerItem(item);
    if (parsed) out.push(parsed);
  }
  return out;
}
