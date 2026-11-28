/** Values allowed by jobs_job_type_check (supabase/migrations/20261001_ingestion_pipeline.sql). */
export const CANONICAL_JOB_TYPES = ["job", "internship", "full-time", "part-time", "contract", "other"] as const;
export type CanonicalJobType = (typeof CANONICAL_JOB_TYPES)[number];

export type EmploymentTypeMapping = {
  job_type: CanonicalJobType;
  /** The raw source value, unchanged, so the decision stays auditable. */
  source_value: string | null;
  confidence: "exact" | "mapped" | "fallback";
};

// Only unambiguous synonyms. Anything not listed (compound, blank, unknown) falls back to 'other'.
const SYNONYMS: Record<string, CanonicalJobType> = {
  "full time": "full-time",
  fulltime: "full-time",
  permanent: "full-time",
  "part time": "part-time",
  parttime: "part-time", // Ashby employmentType "PartTime" (documented enum)
  contractor: "contract",
  freelance: "contract",
  intern: "internship",
  "co-op": "internship",
};

/**
 * Conservative raw source value -> canonical job_type. Never guesses a specific type for an ambiguous value.
 * Case and surrounding/repeated whitespace are ignored; nothing else is.
 */
export function mapEmploymentType(rawSourceValue: unknown, _sourceName?: string): EmploymentTypeMapping {
  // _sourceName is accepted for provenance callers; no rule is source-specific in this slice.
  const source_value = typeof rawSourceValue === "string" ? rawSourceValue : null;
  const key = (source_value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if ((CANONICAL_JOB_TYPES as readonly string[]).includes(key)) {
    return { job_type: key as CanonicalJobType, source_value, confidence: "exact" };
  }
  // Own-property guard: "constructor", "__proto__", etc. must not resolve to inherited Object.prototype members.
  const mapped = Object.hasOwn(SYNONYMS, key) ? SYNONYMS[key] : undefined;
  if (mapped) return { job_type: mapped, source_value, confidence: "mapped" };
  return { job_type: "other", source_value, confidence: "fallback" };
}
