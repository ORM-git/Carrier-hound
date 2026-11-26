/**
 * Offline seniority + years-of-experience mapping (checklist #16, first slice). Pure; NOT wired into
 * ingestion. Output `level` is always a value of the existing jobs_seniority_check enum
 * (supabase/migrations/20261001_filter_upgrades.sql); nothing is remapped or collapsed.
 *
 * Precedence: explicit source value > title inference > description parsing.
 * - Source values already in the canonical vocabulary pass through unchanged (staff and director included).
 * - Title inference delegates to the existing detectJobSeniority and keeps only its unambiguous outputs:
 *   "senior" and "entry". Its "lead" folds staff/principal/director/head-of/vp/chief/architect together
 *   (false positives like "Staff Accountant", school "Principal"), its "mid" is the no-keyword default and
 *   "intern" has no enum value: all three stay unknown. No new title keywords are added.
 * - Description text contributes years bounds only; mapping years to a level would be a new policy.
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
}

const YEARS = String.raw`(?:years?|yrs?)`;
const N = String.raw`(\d{1,2}(?:\.\d)?)`;
const RANGE = new RegExp(String.raw`\b${N}\s*(?:-|–|—|to)\s*${N}\s*\+?\s*${YEARS}`, "gi");
const MIN_ONLY = [
  new RegExp(String.raw`\b${N}\s*\+\s*${YEARS}`, "gi"),
  new RegExp(String.raw`\b${N}\s*or\s+more\s+${YEARS}`, "gi"),
  new RegExp(String.raw`\b(?:at\s+least|minimum(?:\s+of)?|min\.?)\s+${N}\s*\+?\s*${YEARS}`, "gi"),
];
const MAX_YEARS = 40;

/** Years bounds from free text. Distinct disagreeing statements are ambiguous and yield nothing. */
export function parseYearsOfExperience(text?: string | null): { years_min: number; years_max: number | null } | null {
  if (!text) return null;
  const found = new Map<string, { years_min: number; years_max: number | null }>();
  for (const m of Array.from(text.matchAll(RANGE))) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo <= hi && hi <= MAX_YEARS) found.set(`${lo}-${hi}`, { years_min: lo, years_max: hi });
  }
  const rest = text.replace(RANGE, " "); // so "3-5+ years" is not also read as "5+ years"
  for (const re of MIN_ONLY) {
    for (const m of Array.from(rest.matchAll(re))) {
      const lo = Number(m[1]);
      if (lo <= MAX_YEARS) found.set(`${lo}-`, { years_min: lo, years_max: null });
    }
  }
  return found.size === 1 ? Array.from(found.values())[0] : null;
}

function canonical(value?: string | null): JobSeniority | null {
  const v = (value || "").trim().toLowerCase();
  return (JOB_SENIORITY_LEVELS as readonly string[]).includes(v) && v !== "unknown" ? (v as JobSeniority) : null;
}

function fromTitle(title?: string | null): JobSeniority | null {
  if (!title || !title.trim()) return null;
  const detected = detectJobSeniority(title);
  return detected === "senior" || detected === "entry" ? detected : null;
}

export function mapJobSeniority(input: SeniorityMapInput): SeniorityMapResult {
  const years = parseYearsOfExperience(input.description);
  const yearsOut = { years_min: years?.years_min ?? null, years_max: years?.years_max ?? null };
  const explicit = canonical(input.seniority);
  const titled = fromTitle(input.title);

  if (explicit) {
    // A disagreeing title signal does not override the source, but it does lower trust in it.
    const confidence: SeniorityConfidence = titled && titled !== explicit ? "medium" : "high";
    return { level: explicit, ...yearsOut, source: "source_field", confidence };
  }
  if (titled) return { level: titled, ...yearsOut, source: "title", confidence: "medium" };

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
  return { level: "unknown", ...yearsOut, source, confidence: "low" };
}
