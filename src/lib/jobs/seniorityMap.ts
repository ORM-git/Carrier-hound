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
 *   Years come from the canonical extractor in requiredYears.ts (columns min_experience_years /
 *   max_experience_years, shared with scripts/scraper/required_years.py); this file adds no years logic.
 */
import { detectJobSeniority } from "@/lib/matcher/scoring";
import { extractYearsEvidence, type YearsEvidence } from "./requiredYears";

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
  min_experience_years: number | null;
  max_experience_years: number | null;
  source: SenioritySource;
  confidence: SeniorityConfidence;
  years_evidence: YearsEvidence[];
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
  const yearsOut = {
    min_experience_years: years?.min_experience_years ?? null,
    max_experience_years: years?.max_experience_years ?? null,
  };
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
