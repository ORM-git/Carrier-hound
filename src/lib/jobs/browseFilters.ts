/**
 * Transient browse-only Jobs-page filters (never saved; no profile/preference writes).
 *
 * One definition for the client serializer (getLiveJobs), both server consumers (/api/jobs/search and
 * /api/jobs/recommended) and the pagination query identity. Contract: see the PR body for this module.
 *
 * - jobFunctions: OR inside the list over jobs.role_category, exact match against ROLE_CATEGORIES.
 *   A job with NULL role_category never matches an active selection (PROPOSED; same rule as job_type).
 * - minAnnualSalary + minAnnualSalaryCurrency: the job's salary_min, annualized from its salary_period
 *   (monthly x12, hourly x2080) and converted with src/lib/salary/fx.ts, must be >= the threshold.
 *   NULL salary_min, NULL/unknown salary_period or a currency outside the fx table never match (PROPOSED).
 * - excludedTitles / includedCompanies / excludedCompanies travel in the EXISTING feed-constraint params
 *   (excludeTitle / includeCompany / excludeCompany) with their existing semantics, merged with any saved ones.
 *
 * Invalid input is a 400 { error: "invalid_filter", field, reason }, never silently dropped. Empty = no-op.
 */
import { ROLE_CATEGORIES, type RoleCategory } from "@/lib/jobs/highVolumeEnrichment";
import { getFxRates, fxRatesSource, STATIC_FX_RATES } from "@/lib/salary/fx";
import { normalizeFeedConstraints, type SavedFeedConstraints } from "@/lib/preferences/feedConstraints";

export interface BrowseFilters {
  jobFunctions?: string[];
  excludedTitles?: string[];
  includedCompanies?: string[];
  excludedCompanies?: string[];
  minAnnualSalary?: number | null;
  minAnnualSalaryCurrency?: string | null;
}

export interface ParsedBrowseFilters {
  jobFunctions: RoleCategory[];
  minAnnualSalary: number | null;
  minAnnualSalaryCurrency: string | null;
}

export type BrowseFilterError = { error: "invalid_filter"; field: string; reason: string };

export const BROWSE_PARAMS = {
  jobFunction: "jobFunction",
  minAnnualSalary: "minAnnualSalary",
  minAnnualSalaryCurrency: "minAnnualSalaryCurrency",
} as const;

export const MAX_ANNUAL_SALARY = 100_000_000;
// Annualization factors per stored salary_period (CHECK: yearly | monthly | hourly).
export const PERIOD_FACTORS: Record<string, number> = { yearly: 1, monthly: 12, hourly: 2080 };
const SALARY_CURRENCIES = Object.keys(STATIC_FX_RATES);

const fail = (field: string, reason: string): BrowseFilterError => ({ error: "invalid_filter", field, reason });

/** Server side: validates the browse params of a request. Absent params are a no-op. */
export function parseBrowseFilters(params: URLSearchParams): ParsedBrowseFilters | BrowseFilterError {
  const rawFunctions = params.getAll(BROWSE_PARAMS.jobFunction);
  const jobFunctions: RoleCategory[] = [];
  for (const raw of rawFunctions) {
    const v = raw.trim().toUpperCase();
    if (!v) continue;
    if (!(ROLE_CATEGORIES as readonly string[]).includes(v)) return fail("jobFunctions", `unknown value "${raw.slice(0, 40)}"`);
    if (!jobFunctions.includes(v as RoleCategory)) jobFunctions.push(v as RoleCategory);
  }

  const rawMin = params.get(BROWSE_PARAMS.minAnnualSalary);
  const rawCur = params.get(BROWSE_PARAMS.minAnnualSalaryCurrency);
  let minAnnualSalary: number | null = null;
  let minAnnualSalaryCurrency: string | null = null;
  if (rawMin !== null && rawMin.trim() !== "") {
    if (!/^\d{1,9}$/.test(rawMin.trim())) return fail("minAnnualSalary", "must be a positive integer");
    minAnnualSalary = Number(rawMin.trim());
    if (minAnnualSalary < 1 || minAnnualSalary > MAX_ANNUAL_SALARY) return fail("minAnnualSalary", `must be 1..${MAX_ANNUAL_SALARY}`);
    minAnnualSalaryCurrency = (rawCur || "").trim().toUpperCase();
    if (!minAnnualSalaryCurrency) return fail("minAnnualSalaryCurrency", "required with minAnnualSalary");
    if (!SALARY_CURRENCIES.includes(minAnnualSalaryCurrency)) return fail("minAnnualSalaryCurrency", `must be one of ${SALARY_CURRENCIES.join(",")}`);
  } else if (rawCur !== null && rawCur.trim() !== "") {
    return fail("minAnnualSalaryCurrency", "sent without minAnnualSalary");
  }
  return { jobFunctions, minAnnualSalary, minAnnualSalaryCurrency };
}

export const isBrowseFilterError = (v: ParsedBrowseFilters | BrowseFilterError): v is BrowseFilterError => "error" in v;

/** True when a parsed request has a browse predicate that needs the full jobs table. */
export function browseFiltersActive(f: ParsedBrowseFilters): boolean {
  return f.jobFunctions.length > 0 || f.minAnnualSalary !== null;
}

/**
 * Per-currency, per-period thresholds for salary_min (rounded up, so a job never passes on rounding).
 * Uses the same rates the response reports in salaryFx.
 */
export function annualSalaryThresholds(min: number, currency: string, rates: Record<string, number> = getFxRates()) {
  const base = rates[currency];
  const out: Array<{ currency: string; period: string; minSalary: number }> = [];
  for (const cur of SALARY_CURRENCIES) {
    const rate = rates[cur];
    if (!base || !rate) continue;
    const annual = (min / base) * rate;
    for (const [period, factor] of Object.entries(PERIOD_FACTORS)) {
      out.push({ currency: cur, period, minSalary: Math.ceil(annual / factor) });
    }
  }
  return out;
}

interface BrowseQuery<Q> {
  in(column: string, values: readonly string[]): Q;
  or(expr: string): Q;
}

/** Applies the parsed browse predicates (AND-ed with every other filter). Clauses are built only from validated values. */
export function applyBrowseFilters<Q extends BrowseQuery<Q>>(query: Q, f: ParsedBrowseFilters, rates?: Record<string, number>): Q {
  let q = query;
  if (f.jobFunctions.length) q = q.in("role_category", f.jobFunctions);
  if (f.minAnnualSalary !== null && f.minAnnualSalaryCurrency) {
    const groups = annualSalaryThresholds(f.minAnnualSalary, f.minAnnualSalaryCurrency, rates).map(
      (t) => `and(currency.eq.${t.currency},salary_period.eq.${t.period},salary_min.gte.${t.minSalary})`
    );
    q = q.or(groups.join(","));
  }
  return q;
}

/** Rate provenance for a response that applied the salary filter (null otherwise). */
export function salaryFxReport(f: ParsedBrowseFilters, rates: Record<string, number> = getFxRates()) {
  if (f.minAnnualSalary === null) return null;
  return { ...fxRatesSource(), rates, baseCurrency: f.minAnnualSalaryCurrency };
}

// --- Client side -----------------------------------------------------------------------------------

/** True when the browse selection restricts results (empty lists and blank values are a no-op). */
export function hasBrowseFilters(b?: BrowseFilters | null): boolean {
  if (!b) return false;
  return Boolean(
    b.jobFunctions?.some((v) => v.trim()) ||
      b.excludedTitles?.some((v) => v.trim()) ||
      b.includedCompanies?.some((v) => v.trim()) ||
      b.excludedCompanies?.some((v) => v.trim()) ||
      (b.minAnnualSalary != null && b.minAnnualSalary > 0)
  );
}

/** Saved constraints AND browse lists: the union of each list, same normalization (exclusion still wins). */
export function mergeBrowseConstraints(saved: SavedFeedConstraints, b?: BrowseFilters | null): SavedFeedConstraints {
  if (!b) return saved;
  return normalizeFeedConstraints({
    excludedTitles: [...saved.excludedTitles, ...(b.excludedTitles || [])],
    includedCompanies: [...saved.includedCompanies, ...(b.includedCompanies || [])],
    excludedCompanies: [...saved.excludedCompanies, ...(b.excludedCompanies || [])],
    datePosted: saved.datePosted,
  });
}

/** Adds jobFunction / minAnnualSalary params (title/company lists go through appendFeedConstraintParams). */
export function appendBrowseFilterParams(params: URLSearchParams, b?: BrowseFilters | null): void {
  if (!b) return;
  const seen = new Set<string>();
  for (const v of b.jobFunctions || []) {
    const t = v.trim().toUpperCase();
    if (t && !seen.has(t)) { seen.add(t); params.append(BROWSE_PARAMS.jobFunction, t); }
  }
  if (b.minAnnualSalary != null && b.minAnnualSalary > 0) {
    params.set(BROWSE_PARAMS.minAnnualSalary, String(Math.floor(b.minAnnualSalary)));
    params.set(BROWSE_PARAMS.minAnnualSalaryCurrency, (b.minAnnualSalaryCurrency || "").trim().toUpperCase());
  }
}

/** Stable pagination query-identity input: order-insensitive, case-insensitive, empty = "". */
export function browseFilterIdentity(b?: BrowseFilters | null): string {
  if (!hasBrowseFilters(b)) return "";
  const list = (v?: string[]) => Array.from(new Set((v || []).map((s) => s.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean))).sort();
  return JSON.stringify([
    list(b!.jobFunctions),
    list(b!.excludedTitles),
    list(b!.includedCompanies),
    list(b!.excludedCompanies),
    b!.minAnnualSalary && b!.minAnnualSalary > 0 ? Math.floor(b!.minAnnualSalary) : null,
    b!.minAnnualSalary && b!.minAnnualSalary > 0 ? (b!.minAnnualSalaryCurrency || "").trim().toUpperCase() : null,
  ]);
}
