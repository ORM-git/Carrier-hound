/**
 * Required experience years: what a job POSTING asks of the candidate (not the candidate's CV years).
 *
 * Pure extractor, ported from the reviewed #787 years lane (src/lib/jobs/seniorityMap.ts) with the
 * canonical column names min_experience_years / max_experience_years. The seniority mapping from #787
 * is intentionally not included. The Python ingestion normalizer (scripts/scraper/required_years.py)
 * must return the same bounds for every case in __tests__/fixtures/required-years-cases.json; both
 * suites read that one file, so there is one behavior and two implementations.
 *
 * Bounds need positive, scoped work-experience evidence: company age, candidate age and negated
 * requirements produce none; ambiguous, conflicting or invalid text stays null with the evidence kept.
 * min set + max null = "N+"; min null + max set = inclusive upper bound ("up to N").
 */
const YEARS = String.raw`(?:years?|yrs?)`;
// A complete token: not glued to a preceding digit or dot ("12.25" is not "25", "100.5" is not "5").
const N = String.raw`(?<![0-9.])(\d{1,2}(?:\.\d)?)`;
// Range ends are matched as WHOLE numeric tokens of any length, then validated: an unsupported end ("2.75-4",
// "12.25-15", "0.25 to 2") makes the whole range invalid. It is never reduced to its valid end as a lone minimum.
const GEN = String.raw`(?<![0-9.])([0-9]+(?:\.[0-9]+)?)`;
const GEN2 = String.raw`([0-9]+(?:\.[0-9]+)?)`;
const STRICT_TOKEN = /^[0-9]{1,2}(?:\.[0-9])?$/;
const RANGE = new RegExp(String.raw`\b${GEN}\s*(?:-|–|—|to)\s*${GEN2}\s*\+?\s*${YEARS}`, "gi");
const MIN_ONLY = [
  new RegExp(String.raw`\b${N}\s*\+\s*${YEARS}`, "gi"),
  new RegExp(String.raw`\b${N}\s*or\s+more\s+${YEARS}`, "gi"),
  new RegExp(String.raw`\b(?:at\s+least|minimum(?:\s+of)?|min\.?)\s+${N}\s*\+?\s*${YEARS}`, "gi"),
  new RegExp(String.raw`\b${N}\s*${YEARS}`, "gi"), // plain "2 years": a minimum only with an experience cue
];
// A minus sign attached to the amount ("-2 years", "-2-4 years", "-2 to 4 years"): rejected as invalid,
// never stripped to a positive. Runs before every other extractor so none can consume the unsigned suffix.
const NEGATIVE_AMOUNT = new RegExp(
  String.raw`(?<![\w.])[-−]${GEN2}(?:\s*(?:-|–|—|to)\s*${GEN2})?\s*\+?\s*(?:or\s+more\s+)?${YEARS}`,
  "gi",
);
// Any upper qualifier directly before a range or minimum-style match: never a minimum.
const UPPER_PREFIX =
  /\b(?:up\s+to|at\s+most|maximum(?:\s+of)?|max\.?|no\s+more\s+than|not\s+more\s+than|less\s+than|fewer\s+than|under|below)\s*$/i;
// A sign attached just before a match start (defence in depth for every extractor).
const SIGN_BEFORE = /(?:^|[^\w.])[-−]$/;
// Inclusive upper bounds: a max only, never a minimum. A trailing "+" ("up to 3+") is contradictory.
const UPPER_INCLUSIVE = new RegExp(
  String.raw`\b(?:up\s+to|at\s+most|maximum(?:\s+of)?|max\.?|no\s+more\s+than|not\s+more\s+than)\s+${N}\s*(\+)?\s*${YEARS}`,
  "gi",
);
// Strict upper bounds ("less than 2"): not representable without approximating, so ambiguous.
const UPPER_STRICT = new RegExp(String.raw`\b(?:less\s+than|fewer\s+than|under|below)\s+${N}\s*\+?\s*${YEARS}`, "gi");
// "no more than" / "not more than" are bounds, not negations.
const UPPER_NEGATION_WORDS = /\b(?:no|not)\s+more\s+than\b/gi;
const MAX_YEARS = 40;

// A proposition: sentence/bullet, or the side of a contrastive conjunction. Commas do not split.
// The dot of an abbreviated qualifier ("Max. 3 years", "Min. 3 years") does not end the proposition.
const CLAUSE_SPLIT = /(?:(?<!\b(?:max|min))[.!?](?!\d)|[;\n•])+|\b(?:but|however|whereas)\b/i;
// Positive work-experience cue that must sit in the same proposition as the years mention.
const EXPERIENCE_CUE = /\bexperien(?:ce|ced)\b|\bexp\b|\bhands[- ]on\b/i;
const NEGATION = /\b(?:no|not|without|never|none)\b|n't\b/i;
// The employer describing itself (company age / history), not the candidate.
const COMPANY_CUE = /\b(?:we've|we have|we've been|our (?:company|firm|team has|history)|founded|established|serving|in business|track record|history)\b/i;
// Years immediately followed by an age word: candidate age.
const AGE_AFTER = /^\s*(?:old\b|of\s+age\b)/i;

export type YearsEvidenceStatus = "requirement" | "negated" | "ambiguous" | "invalid" | "not_experience";
export interface YearsEvidence {
  text: string; // the proposition the mention came from
  match: string;
  status: YearsEvidenceStatus;
}
/** min_experience_years null with max_experience_years set = an inclusive upper bound only ("up to 3 years"). */
export type YearsBounds = { min_experience_years: number | null; max_experience_years: number | null };

/**
 * Every years mention with why it was or was not used. Bounds only when there is at least one scoped,
 * positive work-experience requirement, all requirements agree, and no experience-scoped mention is
 * negated, ambiguous or invalid. Otherwise null, with the evidence kept.
 */
export function extractYearsEvidence(text?: string | null): { bounds: YearsBounds | null; evidence: YearsEvidence[] } {
  const evidence: YearsEvidence[] = [];
  const accepted = new Map<string, YearsBounds>();
  if (!text) return { bounds: null, evidence };

  for (const raw of text.split(CLAUSE_SPLIT)) {
    const clause = (raw || "").trim();
    if (!clause) continue;
    const scoped = EXPERIENCE_CUE.test(clause);
    const negated = NEGATION.test(clause.replace(UPPER_NEGATION_WORDS, " "));
    type Forced = "ambiguous" | "invalid" | undefined;
    const classify = (m: RegExpMatchArray, lo: number | null, hi: number | null, forced: Forced): YearsEvidenceStatus => {
      const after = clause.slice((m.index ?? 0) + m[0].length);
      if (AGE_AFTER.test(after) || !scoped) return "not_experience";
      if (negated) return "negated";
      if (COMPANY_CUE.test(clause)) return "ambiguous";
      if (forced) return forced;
      const bad = (v: number | null) => v !== null && (v < 0 || v > MAX_YEARS);
      if ((lo === null && hi === null) || bad(lo) || bad(hi) || (lo !== null && hi !== null && hi < lo)) return "invalid";
      return "requirement";
    };
    const record = (m: RegExpMatchArray, lo: number | null, hi: number | null, forced?: Forced) => {
      const status = classify(m, lo, hi, forced);
      evidence.push({ text: clause, match: m[0].trim(), status });
      if (status === "requirement") accepted.set(`${lo ?? ""}-${hi ?? ""}`, { min_experience_years: lo, max_experience_years: hi });
    };
    // Each pass blanks what it matched, so later passes cannot re-read it ("3-5+ years" is not also "5+ years").
    let rest = clause;
    const pass = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
      for (const m of Array.from(rest.matchAll(re))) fn(m);
      rest = rest.replace(re, (x) => " ".repeat(x.length));
    };
    // Blanking keeps offsets, so clause.slice(0, m.index) is the original text before a match.
    const before = (m: RegExpMatchArray) => clause.slice(0, m.index ?? 0);
    const guard = (m: RegExpMatchArray): Forced =>
      SIGN_BEFORE.test(before(m)) ? "invalid" : UPPER_PREFIX.test(before(m)) ? "ambiguous" : undefined;
    pass(NEGATIVE_AMOUNT, (m) => record(m, null, null, "invalid"));
    pass(RANGE, (m) =>
      STRICT_TOKEN.test(m[1]) && STRICT_TOKEN.test(m[2])
        ? record(m, Number(m[1]), Number(m[2]), guard(m))
        : record(m, null, null, "invalid")
    );
    pass(UPPER_INCLUSIVE, (m) => record(m, null, Number(m[1]), m[2] ? "ambiguous" : undefined));
    pass(UPPER_STRICT, (m) => record(m, null, null, "ambiguous"));
    for (const re of MIN_ONLY) pass(re, (m) => record(m, Number(m[1]), null, guard(m)));
  }

  const blocked = evidence.some((e) => e.status === "negated" || e.status === "ambiguous" || e.status === "invalid");
  const bounds = !blocked && accepted.size === 1 ? Array.from(accepted.values())[0] : null;
  return { bounds, evidence };
}

/** Years bounds from free text, or null when not stated, not experience, negated, ambiguous or conflicting. */
export function parseYearsOfExperience(text?: string | null): YearsBounds | null {
  return extractYearsEvidence(text).bounds;
}


/** Provenance label stored in jobs.experience_years_source for bounds taken from the description. */
export const REQUIRED_YEARS_SOURCE_DESCRIPTION = "description";

// --- User selection: the Preferences "Required experience" range --------------------------------
// Two-handle slider, 0 to 11+. The UPPER handle at the top point means "no upper bound" (max = null);
// it never forces the lower handle to 11. Only the LOWER handle at 11 sets min = 11. So 0..top is every
// job that states a requirement; 0..4 is 0-4; lower 11 with upper top is 11+.
export const REQUIRED_YEARS_SLIDER_TOP = 11;

export interface RequiredYearsRange {
  min: number | null; // null = unset
  max: number | null; // null = no upper bound
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Clean saved/request values: finite, >= 0, rounded to 0.1, min <= max. Anything else is unset. */
export function normalizeRequiredYearsRange(input: { min?: unknown; max?: unknown } | null | undefined): RequiredYearsRange {
  const clean = (v: unknown): number | null => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (!finite(n) || n < 0 || n > MAX_YEARS) return null;
    return Math.round(n * 10) / 10;
  };
  let min = clean(input?.min);
  let max = clean(input?.max);
  if (min !== null && max !== null && max < min) {
    // An inverted range is invalid input, not something to guess at: treat it as unset.
    min = null;
    max = null;
  }
  return { min, max };
}

/** Slider handles (0..11) to the stored range. Upper handle at the top = no upper bound. */
export function rangeFromSliderHandles(lower: number, upper: number): RequiredYearsRange {
  const lo = Math.min(REQUIRED_YEARS_SLIDER_TOP, Math.max(0, Math.round(lower)));
  const hi = Math.min(REQUIRED_YEARS_SLIDER_TOP, Math.max(0, Math.round(upper)));
  return normalizeRequiredYearsRange({ min: lo, max: hi >= REQUIRED_YEARS_SLIDER_TOP ? null : Math.max(lo, hi) });
}

/** True when the range restricts anything: a lower bound above 0, or any upper bound. 0..top does not. */
export function isRequiredYearsRangeActive(range: RequiredYearsRange | null | undefined): boolean {
  if (!range) return false;
  const r = normalizeRequiredYearsRange(range);
  return (r.min !== null && r.min > 0) || r.max !== null;
}

/** A job's stated range as [lo, hi] (hi = Infinity for "N+"), or null when it states nothing. */
function jobInterval(job: { min_experience_years?: number | null; max_experience_years?: number | null }): [number, number] | null {
  const lo = job.min_experience_years ?? null;
  const hi = job.max_experience_years ?? null;
  if (!finite(lo) && !finite(hi)) return null;
  return [finite(lo) ? lo : 0, finite(hi) ? hi : Infinity];
}

/**
 * Does the job pass the selected range? Inclusive overlap at both ends. A job that states no requirement
 * is KEPT (unknown is not "fails"). Examples with selection 0-2: "2-4 years" passes (touches at 2),
 * "3+ years" does not, "up to 1 year" passes.
 */
export function matchesRequiredYears(
  job: { min_experience_years?: number | null; max_experience_years?: number | null },
  range: RequiredYearsRange | null | undefined
): boolean {
  if (!isRequiredYearsRangeActive(range)) return true;
  const sel = normalizeRequiredYearsRange(range);
  const iv = jobInterval(job);
  if (!iv) return true;
  const selLo = sel.min ?? 0;
  const selHi = sel.max ?? Infinity;
  return iv[0] <= selHi && iv[1] >= selLo;
}

/**
 * PostgREST filters for the same predicate on jobs.min_experience_years / max_experience_years. Returns
 * one `and(...)` expression for `.or()` (a single-branch or), or null when the range does not restrict.
 * NULL columns mean "unknown": a job with both NULL passes; a NULL min is 0 and a NULL max is unbounded.
 * Numbers are validated finite values formatted by this function, never raw input.
 */
export function buildRequiredYearsClause(range: RequiredYearsRange | null | undefined): string | null {
  if (!isRequiredYearsRangeActive(range)) return null;
  const sel = normalizeRequiredYearsRange(range);
  const parts: string[] = [];
  if (sel.max !== null) parts.push(`or(min_experience_years.is.null,min_experience_years.lte.${sel.max})`);
  if (sel.min !== null && sel.min > 0) parts.push(`or(max_experience_years.is.null,max_experience_years.gte.${sel.min})`);
  return parts.length ? `and(${parts.join(",")})` : null;
}
