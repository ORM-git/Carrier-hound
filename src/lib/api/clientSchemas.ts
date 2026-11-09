import { z } from "zod";

/**
 * Frontend sheet row "Client schema validation (zod/yup)".
 * Runtime schemas for the public JSON payloads the browser consumes
 * (/api/stats and /api/ticker). A malformed response is dropped or
 * normalised to "unknown" instead of reaching component state.
 * No rendered output changes for well-formed payloads.
 */

const finiteNumber = z.number().refine((n) => Number.isFinite(n));

export const statsResponseSchema = z.object({
  activeJobs: z.unknown().optional(),
  totalJobs: z.unknown().optional(),
  companies: z.unknown().optional(),
  companiesScanned: z.unknown().optional(),
  jobsToday: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
});

export interface ParsedStats {
  activeJobs: number | null;
  companies: number | null;
  jobsToday: number | null;
  totalJobs: number | null;
  companiesScanned: number | null;
  updatedAt?: string;
}

function numOrNull(v: unknown): number | null {
  const r = finiteNumber.safeParse(v);
  return r.success ? r.data : null;
}

/** Null when the payload is not an object; bad counts become null (jobsToday defaults to 0). */
export function parseStatsResponse(raw: unknown): ParsedStats | null {
  const parsed = statsResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const activeJobs = numOrNull(d.activeJobs) ?? numOrNull(d.totalJobs);
  const companies = numOrNull(d.companies) ?? numOrNull(d.companiesScanned);
  return {
    activeJobs,
    companies,
    jobsToday: numOrNull(d.jobsToday) ?? 0,
    totalJobs: activeJobs,
    companiesScanned: companies,
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : undefined,
  };
}

/** Landing globe strip: counts stay null when absent (no invented figures). */
export function parseGlobeStats(raw: unknown): {
  jobsToday: number;
  totalJobs: number | null;
  companiesScanned: number | null;
} | null {
  const parsed = statsResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  return {
    jobsToday: numOrNull(d.jobsToday) ?? 0,
    totalJobs: numOrNull(d.totalJobs),
    companiesScanned: numOrNull(d.companiesScanned),
  };
}

export const tickerItemSchema = z.object({
  company: z.string(),
  title: z.string(),
  posted_at: z.string(),
  logo_url: z.string().nullable(),
});
export type TickerItemParsed = z.infer<typeof tickerItemSchema>;

/** Accepts a bare array or { jobs: [...] }; drops malformed items; missing logo_url -> null. */
export function parseTickerResponse(raw: unknown): TickerItemParsed[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown }).jobs)
      ? (raw as { jobs: unknown[] }).jobs
      : [];
  const out: TickerItemParsed[] = [];
  for (const item of list) {
    const withLogo =
      item && typeof item === "object" && !("logo_url" in item)
        ? { ...(item as object), logo_url: null }
        : item;
    const r = tickerItemSchema.safeParse(withLogo);
    if (r.success) out.push(r.data);
  }
  return out;
}
