/**
 * Offline seniority + years-of-experience mapping (checklist #16, first slice). Pure; NOT wired into
 * ingestion. Output `level` is always a value of the existing jobs_seniority_check enum
 * (supabase/migrations/20261001_filter_upgrades.sql); nothing is remapped or collapsed.
 *
 * Precedence: explicit source value > title inference > description parsing.
 * - Source values already in the canonical vocabulary pass through unchanged (staff, director and an explicit
 *   "unknown" included: a source "unknown" is never upgraded by the title).
 * - Title inference delegates to the existing detectJobSeniority and keeps only its unambiguous outputs:
 *   "senior" and "entry". Its "lead" folds staff/principal/director/head-of/vp/chief/architect together
 *   (false positives like "Staff Accountant", school "Principal"), its "mid" is the no-keyword default and
 *   "intern" has no enum value: all three stay unknown. No new title keywords are added.
 * - Description text contributes years bounds only; mapping years to a level would be a new policy.
 *   Bounds need positive, scoped work-experience evidence (see extractYearsEvidence): company age,
 *   candidate age and negated requirements produce none; ambiguous or conflicting text stays null.
 */
import { detectJobSeniority } from "@/lib/matcher/scoring";

export const JOB_SENIORITY_LEVELS = ["entry", "mid", "senior", "staff", "lead", "director", "unknown"] as const;
export type JobSeniority = (typeof JOB_SENIORITY_LEVELS)[number];
export type SenioritySource = "source_field" | "title" | "description" | "none";
export type SeniorityConfidence = "high" | "medium" | "low";

export interface SeniorityMapInput {
  seniority?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface SeniorityMapResult {
  level: JobSeniority;
  years_min: number | null;
  years_max: number | null;
  source: SenioritySource;
  confidence: SeniorityConfidence;
  years_evidence: YearsEvidence[];
}

const YEARS = String.raw`(?:years?|yrs?)`;
const N = String.raw`(\d{1,2}(?:\.\d)?)`;
const RANGE = new RegExp(String.raw`\b${N}\s*(?:-|–|—|to)\s*${N}\s*\+?\s*${YEARS}`, "gi");
const MIN_ONLY = [
  new RegExp(String.raw`\b${N}\s*\+\s*${YEARS}`, "gi"),
  new RegExp(String.raw`\b${N}\s*or\s+more\s+${YEARS}`, "gi"),
  new RegExp(String.raw`\b(?:at\s+least|minimum(?:\s+of)?|min\.?)\s+${N}\s*\+?\s*${YEARS}`, "gi"),
  new RegExp(String.raw`\b${N}\s*${YEARS}`, "gi"), // plain "2 years": a minimum only with an experience cue
];
const MAX_YEARS = 40;

// A proposition: sentence/bullet, or the side of a contrastive conjunction. Commas do not split.
const CLAUSE_SPLIT = /(?:[.!?](?!\d)|[;\n•])+|\b(?:but|however|whereas)\b/i;
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
export type YearsBounds = { years_min: number; years_max: number | null };

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
    const classify = (m: RegExpMatchArray, lo: number, hi: number | null): YearsEvidenceStatus => {
      const after = clause.slice((m.index ?? 0) + m[0].length);
      if (AGE_AFTER.test(after) || !scoped) return "not_experience";
      if (NEGATION.test(clause)) return "negated";
      if (COMPANY_CUE.test(clause)) return "ambiguous";
      if (lo < 0 || lo > MAX_YEARS || (hi !== null && (hi < lo || hi > MAX_YEARS))) return "invalid";
      return "requirement";
    };
    const record = (m: RegExpMatchArray, lo: number, hi: number | null) => {
      const status = classify(m, lo, hi);
      evidence.push({ text: clause, match: m[0].trim(), status });
      if (status === "requirement") accepted.set(`${lo}-${hi ?? ""}`, { years_min: lo, years_max: hi });
    };

    let rest = clause;
    for (const m of Array.from(clause.matchAll(RANGE))) record(m, Number(m[1]), Number(m[2]));
    rest = rest.replace(RANGE, (s) => " ".repeat(s.length)); // "3-5+ years" is not also "5+ years"
    for (const re of MIN_ONLY) {
      for (const m of Array.from(rest.matchAll(re))) record(m, Number(m[1]), null);
      rest = rest.replace(re, (s) => " ".repeat(s.length));
    }
  }

  const blocked = evidence.some((e) => e.status === "negated" || e.status === "ambiguous" || e.status === "invalid");
  const bounds = !blocked && accepted.size === 1 ? Array.from(accepted.values())[0] : null;
  return { bounds, evidence };
}

/** Years bounds from free text, or null when not stated, not experience, negated, ambiguous or conflicting. */
export function parseYearsOfExperience(text?: string | null): YearsBounds | null {
  return extractYearsEvidence(text).bounds;
}

function canonical(value?: string | null): JobSeniority | null {
  const v = (value || "").trim().toLowerCase();
  return (JOB_SENIORITY_LEVELS as readonly string[]).includes(v) ? (v as JobSeniority) : null;
}

function fromTitle(title?: string | null): JobSeniority | null {
  if (!title || !title.trim()) return null;
  const detected = detectJobSeniority(title);
  return detected === "senior" || detected === "entry" ? detected : null;
}

export function mapJobSeniority(input: SeniorityMapInput): SeniorityMapResult {
  const { bounds: years, evidence } = extractYearsEvidence(input.description);
  const yearsOut = { years_min: years?.years_min ?? null, years_max: years?.years_max ?? null };
  const explicit = canonical(input.seniority);
  const titled = fromTitle(input.title);

  if (explicit) {
    // A disagreeing title signal does not override the source, but it does lower trust in it.
    const confidence: SeniorityConfidence = titled && titled !== explicit ? "medium" : "high";
    return { level: explicit, ...yearsOut, source: "source_field", confidence, years_evidence: evidence };
  }
  if (titled) return { level: titled, ...yearsOut, source: "title", confidence: "medium", years_evidence: evidence };

  // No level signal: never a guessed level; record where the only usable (or present) input came from.
  const source: SenioritySource = years
    ? "description"
    : (input.seniority || "").trim()
      ? "source_field"
      : (input.title || "").trim()
        ? "title"
        : (input.description || "").trim()
          ? "description"
          : "none";
  return { level: "unknown", ...yearsOut, source, confidence: "low", years_evidence: evidence };
}
