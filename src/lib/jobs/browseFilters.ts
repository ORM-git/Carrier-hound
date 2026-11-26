/**
 * Transient browse-only Jobs-page filters (never saved; no profile/preference writes).
 *
 * One definition for the client serializer (getLiveJobs), both server consumers (/api/jobs/search and
 * /api/jobs/recommended) and the pagination query identity. Contract: see the PR body for this module.
 *
 * - jobFunctions: OR inside the list over jobs.role_category, exact match against ROLE_CATEGORIES.
 *   A job with NULL role_category never matches an active selection (PROPOSED; same rule as job_type).
 * - minAnnualSalary + minAnnualSalaryCurrency: the job's salary_min, annualized from its salary_period
 *   and converted with src/lib/salary/fx.ts, must be >= the threshold. Compared at exact decimal precision
 *   (salary_min is NUMERIC): the per-period threshold is the exact quotient rounded UP at 1e-10, so for any
 *   stored value with <= 10 fractional digits the comparison equals annualized >= threshold (48.50/h passes
 *   100000 USD, 48.00/h fails). STANDING ASSUMPTIONS: hourly x2080 = 40h x 52wk, monthly x12, yearly x1.
 *   NULL salary_min, NULL/unknown salary_period or a currency outside the fx table never match (PROPOSED).
 *   Stored period/currency defaults are not proof the source stated them (PROPOSED semantics, not fact).
 * - minAnnualSalary input contract: an integer 1..MAX_ANNUAL_SALARY. Absent/null (and a blank string on
 *   the wire) is the no-op. Anything else (negative, zero, fraction, NaN/Infinity, exponent, lone currency,
 *   amount without currency) is a 400. The client never drops, floors or rounds: it sends the value
 *   verbatim and routes it to the server, whose parseBrowseFilters is the one validator for both sides.
 * - FX: rates are HELD CONSTANT WITHIN A CONTINUATION. Page 1 resolves getFxRates() once and reports them
 *   in salaryFx.rates; every later page (page > 1 or a cursor) must send them back as fxRates and is
 *   evaluated on exactly those rates (salaryFx.source "continuation_pinned"). A continuation page with the
 *   salary filter and no fxRates is a 400, never served on a different rate table.
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
  /** Rates pinned from page 1's salaryFx.rates; send on every continuation page. Not part of the identity. */
  fxRates?: Record<string, number> | null;
}

export interface ParsedBrowseFilters {
  jobFunctions: RoleCategory[];
  minAnnualSalary: number | null;
  minAnnualSalaryCurrency: string | null;
  fxRates: Record<string, number> | null;
}

export type BrowseFilterError = { error: "invalid_filter"; field: string; reason: string };

export const BROWSE_PARAMS = {
  jobFunction: "jobFunction",
  minAnnualSalary: "minAnnualSalary",
  minAnnualSalaryCurrency: "minAnnualSalaryCurrency",
  fxRates: "fxRates",
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

  const rawFx = params.get(BROWSE_PARAMS.fxRates);
  let fxRates: Record<string, number> | null = null;
  if (rawFx !== null && rawFx.trim() !== "") {
    fxRates = {};
    for (const pair of rawFx.split(",")) {
      const [cur, val] = pair.split(":");
      const rate = Number(val);
      if (!SALARY_CURRENCIES.includes(cur) || !val || !Number.isFinite(rate) || rate <= 0) return fail("fxRates", "must be CUR:rate pairs");
      fxRates[cur] = rate;
    }
    if (SALARY_CURRENCIES.some((c) => !(c in fxRates!))) return fail("fxRates", `must include ${SALARY_CURRENCIES.join(",")}`);
  }
  return { jobFunctions, minAnnualSalary, minAnnualSalaryCurrency, fxRates };
}

/**
 * Rates for this response. A salary-filtered continuation page must carry page 1's rates (fxRates);
 * otherwise it is a 400 rather than a page evaluated on a different rate table.
 */
export function resolveBrowseFxRates(f: ParsedBrowseFilters, isContinuation: boolean): Record<string, number> | BrowseFilterError {
  if (f.fxRates) return f.fxRates;
  if (isContinuation && f.minAnnualSalary !== null) return fail("fxRates", "required on a continuation page: send page 1's salaryFx.rates");
  return getFxRates();
}

export const serializeFxRates = (rates: Record<string, number>) => SALARY_CURRENCIES.map((c) => `${c}:${rates[c]}`).join(",");

export const isBrowseFilterError = <T extends object>(v: T | BrowseFilterError): v is BrowseFilterError => "error" in v;

/** True when a parsed request has a browse predicate that needs the full jobs table. */
export function browseFiltersActive(f: ParsedBrowseFilters): boolean {
  return f.jobFunctions.length > 0 || f.minAnnualSalary !== null;
}

// BigInt() calls, not literals/**: tsconfig targets below ES2020.
const pow10 = (k: number) => BigInt("1" + "0".repeat(k));
const ONE = BigInt(1);

// Exact rational [num, den] of a finite positive number's shortest decimal form (rates, amounts).
function toRational(n: number): [bigint, bigint] {
  const [mant, exp] = n.toExponential().split("e");
  const [int, frac = ""] = mant.split(".");
  const e = Number(exp) - frac.length;
  const digits = BigInt(int + frac);
  return e >= 0 ? [digits * pow10(e), ONE] : [digits, pow10(-e)];
}

const THRESHOLD_SCALE = 10;
// num/den rounded UP at 10^-THRESHOLD_SCALE, as a plain decimal string ("48.076923077").
function ceilDecimal(num: bigint, den: bigint): string {
  const q = (num * pow10(THRESHOLD_SCALE) + den - ONE) / den;
  const s = q.toString().padStart(THRESHOLD_SCALE + 1, "0");
  return `${s.slice(0, -THRESHOLD_SCALE)}.${s.slice(-THRESHOLD_SCALE)}`.replace(/\.?0+$/, "");
}

/**
 * Per-currency, per-period salary_min thresholds as exact decimal strings: min / base * rate / factor,
 * computed in integer arithmetic and rounded up at 1e-10 (see module doc). Uses the same rates the
 * response reports in salaryFx.
 */
export function annualSalaryThresholds(min: number, currency: string, rates: Record<string, number> = getFxRates()) {
  const base = rates[currency];
  const out: Array<{ currency: string; period: string; minSalary: string }> = [];
  if (!base) return out;
  const [mN, mD] = toRational(min);
  const [bN, bD] = toRational(base);
  for (const cur of SALARY_CURRENCIES) {
    const rate = rates[cur];
    if (!rate) continue;
    const [rN, rD] = toRational(rate);
    for (const [period, factor] of Object.entries(PERIOD_FACTORS)) {
      out.push({ currency: cur, period, minSalary: ceilDecimal(mN * rN * bD, mD * rD * bN * BigInt(factor)) });
    }
  }
  return out;
}

/**
 * Exact rational thresholds for a one-statement numeric comparison (PROPOSAL, not wired): a job passes iff
 * salary_min * den >= num, with currency/period equal. num/den are decimal strings of arbitrary-size integers
 * (no rounding, no 1e-10 scale), reduced by their gcd, meant to be compared in Postgres numeric inside one RPC.
 */
export const RATIONAL_LIMITS = { minRate: 1e-6, maxRate: 1e9, maxDigits: 80 } as const;
export type SalaryRational = { currency: string; period: string; num: string; den: string };

/**
 * Preconditions are checked, not assumed: amount a finite integer 1..MAX_ANNUAL_SALARY, currency in the
 * supported set, every rate finite and within RATIONAL_LIMITS (the upstream cache only checks > 0, so Infinity,
 * NaN, 0 or absurd exponents must be rejected here), and num/den stay <= maxDigits. Failure is a typed error,
 * never a throw or an invalid rational.
 */
export function annualSalaryRationals(min: number, currency: string, rates: Record<string, number>): SalaryRational[] | BrowseFilterError {
  const bad = (field: string, reason: string): BrowseFilterError => ({ error: "invalid_filter", field, reason });
  if (!Number.isInteger(min) || min < 1 || min > MAX_ANNUAL_SALARY) return bad("minAnnualSalary", `must be an integer 1..${MAX_ANNUAL_SALARY}`);
  if (!SALARY_CURRENCIES.includes(currency)) return bad("minAnnualSalaryCurrency", "unsupported currency");
  const L = RATIONAL_LIMITS;
  for (const cur of SALARY_CURRENCIES) {
    const r = rates?.[cur];
    if (typeof r !== "number" || !Number.isFinite(r) || r < L.minRate || r > L.maxRate) return bad("fxRates", `rate for ${cur} must be finite and within ${L.minRate}..${L.maxRate}`);
  }
  const out: SalaryRational[] = [];
  const [mN, mD] = toRational(min);
  const [bN, bD] = toRational(rates[currency]);
  const gcd = (a: bigint, b: bigint): bigint => { while (b > BigInt(0)) { [a, b] = [b, a % b]; } return a; };
  for (const cur of SALARY_CURRENCIES) {
    const [rN, rD] = toRational(rates[cur]);
    for (const [period, factor] of Object.entries(PERIOD_FACTORS)) {
      const num = mN * rN * bD, den = mD * rD * bN * BigInt(factor);
      const g = gcd(num, den);
      const n = (num / g).toString(), d = (den / g).toString();
      if (n.length > L.maxDigits || d.length > L.maxDigits || d === "0" || n === "0") return bad("fxRates", "threshold exceeds supported precision");
      out.push({ currency: cur, period, num: n, den: d });
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
  // Pinned rates were reported (with their upstream/static provenance) on page 1 of this continuation.
  const provenance = f.fxRates ? { source: "continuation_pinned" as const, fetchedAt: null } : fxRatesSource();
  return { ...provenance, rates, baseCurrency: f.minAnnualSalaryCurrency };
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
      b.minAnnualSalary != null ||
      b.minAnnualSalaryCurrency?.trim()
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
  // Verbatim, never dropped or rounded: the server validates (invalid = 400).
  if (b.minAnnualSalary != null) params.set(BROWSE_PARAMS.minAnnualSalary, String(b.minAnnualSalary));
  const cur = (b.minAnnualSalaryCurrency || "").trim().toUpperCase();
  if (cur) params.set(BROWSE_PARAMS.minAnnualSalaryCurrency, cur);
  if (b.fxRates) params.set(BROWSE_PARAMS.fxRates, serializeFxRates(b.fxRates));
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
    b!.minAnnualSalary != null ? String(b!.minAnnualSalary) : null,
    (b!.minAnnualSalaryCurrency || "").trim().toUpperCase() || null,
  ]);
}
