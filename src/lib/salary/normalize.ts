/**
 * Salary normalization that separates what the source SAID from what we ASSUMED (checklist #21).
 * Pure and offline; not wired into recommendations, ingestion, scoring or any API yet.
 *
 * Strict mode (default): only an explicitly stated, recognized period is annualized. An absent or
 * unrecognized period yields null annual figures with a reason, never a guess. Invalid amounts are
 * reported, never repaired.
 * Compatibility mode (opt-in): reproduces the min-salary disqualifier in src/lib/jobs/recommendations.ts
 * 1:1 for a later reviewed parity swap. Its guessed paths carry periodInferred and conversionAssumed.
 */
import { detectPayPeriod } from "./parser";

export type NormalizedPeriod = "yearly" | "monthly" | "weekly" | "daily" | "hourly";

/**
 * Annualization factors. Only yearly (x1) and monthly (x12) are calendar-exact. Weekly x52 is a
 * convention (364 days, not a calendar year); hourly assumes 40h x 52wk; daily assumes 260 working days.
 */
export const ANNUALIZATION_FACTORS: Record<NormalizedPeriod, { factor: number; conversionAssumed: boolean }> = {
  yearly: { factor: 1, conversionAssumed: false },
  monthly: { factor: 12, conversionAssumed: false },
  weekly: { factor: 52, conversionAssumed: true },
  daily: { factor: 260, conversionAssumed: true },
  hourly: { factor: 2080, conversionAssumed: true },
};

/** Thresholds of the existing absent-period guess in recommendations.ts (compatibility mode only). */
export const COMPAT_GUESS_THRESHOLDS = { hourlyBelow: 500, monthlyBelow: 25000 } as const;

export interface SalaryInput {
  min?: number | null;
  max?: number | null;
  period?: string | null;
  currency?: string | null;
}

export interface NormalizedSalary {
  annualMin: number | null;
  annualMax: number | null;
  period: NormalizedPeriod | null;
  periodInferred: boolean;
  conversionAssumed: boolean;
  currency: string | null;
  reason?: string;
}

// Local extension around the read-only detectPayPeriod (same regex style and word boundaries).
const DAILY = /(?:^|\b)(?:per\s+day|\/day|daily|a\s+day)(?:(?<=\w)\b|$|\s)/i;
const WEEKLY = /(?:^|\b)(?:per\s+week|\/week|weekly|a\s+week)(?:(?<=\w)\b|$|\s)/i;

export function detectNormalizedPeriod(text: string | null | undefined): NormalizedPeriod | null {
  const base = detectPayPeriod(text);
  if (base) return base;
  if (!text || typeof text !== "string") return null;
  if (DAILY.test(text)) return "daily";
  if (WEEKLY.test(text)) return "weekly";
  return null;
}

const usable = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

// Frequencies that reuse a period word but are not that period (twice monthly, bi-weekly, every two weeks).
const QUALIFIED_FREQUENCY =
  /\b(?:twice|thrice|fortnight(?:ly)?|bi|semi)\b|\b(?:bi|semi)(?:week|month|annual|year|dai|hour)|\bevery\s+(?:other|few|two|three|four|\d+)\b|\b(?:\d+|two|three|four|several)\s+times\b/i;
const NEGATION = /^(?:not|non|no|never|without)$/i;

/**
 * Strict-mode guard: a period is usable only if it is single, unqualified and unnegated. Reuses
 * detectNormalizedPeriod on 1- and 2-token windows so it recognizes exactly the same aliases.
 */
function periodAmbiguity(text: string): string | null {
  if (QUALIFIED_FREQUENCY.test(text)) return `qualified/unsupported frequency "${text}"; not annualized`;
  const tokens = text.split(/[\s,;-]+|(?=\/)/).filter(Boolean);
  const at = (i: number, n: number) => detectNormalizedPeriod(tokens.slice(i, i + n).join(" "));
  const found = new Set<NormalizedPeriod>();
  for (let i = 0; i < tokens.length; i++) {
    if (NEGATION.test(tokens[i]) && (at(i + 1, 1) || at(i + 1, 2))) return `negated period "${text}"; not annualized`;
    const p = at(i, 1) || at(i, 2);
    if (p) found.add(p);
  }
  if (found.size > 1) return `conflicting periods (${Array.from(found).join(", ")}) in "${text}"; not annualized`;
  return null;
}

export function normalizeSalary(input: SalaryInput, options: { compatibility?: boolean } = {}): NormalizedSalary {
  const currency = input.currency?.trim() || null;
  const rawPeriod = (input.period ?? "").toString().trim();
  const period = rawPeriod ? detectNormalizedPeriod(rawPeriod) : null;
  const empty = (reason: string, p: NormalizedPeriod | null = period): NormalizedSalary => ({
    annualMin: null, annualMax: null, period: p, periodInferred: false, conversionAssumed: false, currency, reason,
  });

  if (options.compatibility) {
    // Legacy parity (recommendations.ts ~654-690). Selection happens BEFORE any strict validation:
    //   rawMax = max ?? min  (only null/undefined fall through; 0, negative and NaN are kept and then skipped)
    //   skipped unless typeof rawMax === "number" && rawMax > 0  (no min>max check; the other bound is never read)
    // A skipped selection returns null annual values with a reason: the caller's filter does not run.
    // Comparison value for a later parity swap is (annualMax ?? annualMin): annualMax when max was selected,
    // annualMin when max was absent and min was selected.
    const selected = input.max ?? input.min;
    if (typeof selected !== "number" || !(selected > 0)) {
      return empty("compatibility: selected amount (max, else min) is not a positive number; filter skipped");
    }
    // Legacy test is `typeof v === "number" && v > 0`: Infinity passes it (and never disqualifies), NaN/0/negative do not.
    const side = (v: number | null | undefined): number | null => (typeof v === "number" && v > 0 ? v : null);
    const cMin = side(input.min);
    const cMax = side(input.max);
    const compat = (p: NormalizedPeriod | null, factor: number, periodInferred: boolean, conversionAssumed: boolean, reason?: string): NormalizedSalary => ({
      annualMin: cMin === null ? null : cMin * factor,
      annualMax: cMax === null ? null : cMax * factor,
      period: p, periodInferred, conversionAssumed, currency, ...(reason ? { reason } : {}),
    });
    const recognized = period === "hourly" || period === "monthly" || period === "yearly" ? period : null;
    if (recognized) return compat(recognized, ANNUALIZATION_FACTORS[recognized].factor, false, ANNUALIZATION_FACTORS[recognized].conversionAssumed);
    if (rawPeriod) {
      // Explicit but not hourly/monthly/yearly: today's code uses the amount as-is, never guesses monthly.
      return compat(null, 1, true, true, `compatibility: unrecognized period "${rawPeriod}" used as annual`);
    }
    const guessed: NormalizedPeriod =
      selected < COMPAT_GUESS_THRESHOLDS.hourlyBelow ? "hourly" : selected < COMPAT_GUESS_THRESHOLDS.monthlyBelow ? "monthly" : "yearly";
    return compat(guessed, ANNUALIZATION_FACTORS[guessed].factor, true, true, `compatibility: period guessed ${guessed} from amount`);
  }

  const min = usable(input.min) ? input.min : null;
  const max = usable(input.max) ? input.max : null;
  const badMin = input.min != null && min === null;
  const badMax = input.max != null && max === null;
  if (min === null && max === null) {
    return empty(badMin || badMax ? "invalid amount: null, zero, negative or non-finite" : "no salary amount");
  }
  if (min !== null && max !== null && min > max) return empty("invalid range: min greater than max");
  const invalidNote = badMin || badMax ? `invalid ${badMin ? "min" : "max"} amount ignored` : undefined;

  const annualize = (p: NormalizedPeriod | null, factor: number, periodInferred: boolean, conversionAssumed: boolean, reason?: string): NormalizedSalary => ({
    annualMin: min === null ? null : min * factor,
    annualMax: max === null ? null : max * factor,
    period: p,
    periodInferred,
    conversionAssumed,
    currency,
    ...(reason ? { reason } : {}),
  });

  if (!rawPeriod) return empty("period not stated; not annualized");
  const ambiguity = periodAmbiguity(rawPeriod);
  if (ambiguity) return empty(ambiguity, null);
  if (!period) return empty(`unrecognized period "${rawPeriod}"; not annualized`, null);
  const result = annualize(period, ANNUALIZATION_FACTORS[period].factor, false, ANNUALIZATION_FACTORS[period].conversionAssumed, invalidNote);
  const overflow = [result.annualMin, result.annualMax].some((v) => v !== null && !Number.isFinite(v));
  return overflow ? empty(`annualized amount overflows (x${ANNUALIZATION_FACTORS[period].factor}); not annualized`) : result;
}
