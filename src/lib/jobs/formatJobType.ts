/**
 * Normalizes and formats the job type for display on job cards.
 * Returns null if the source type is missing, empty, or a generic placeholder
 * (such as "job", "unknown", "other", "n/a", "none", "unlisted"), so that
 * cards cleanly omit or hide the field without inventing an unbacked type
 * (specifically: never inventing "Full-time").
 *
 * When source data has a real type (e.g. "internship", "contract", "full-time", "part-time"),
 * it formats it with canonical casing.
 */
export function formatJobType(type?: string | null): string | null {
  if (!type) return null;
  const trimmed = type.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  // Generic placeholders or unknown values must NEVER invent a job type.
  // Return null so the card field is cleanly hidden.
  if (
    lower === "job" ||
    lower === "unknown" ||
    lower === "other" ||
    lower === "n/a" ||
    lower === "na" ||
    lower === "none" ||
    lower === "unlisted"
  ) {
    return null;
  }

  if (lower === "internship" || lower === "intern") return "Internship";
  if (lower === "full-time" || lower === "full_time" || lower === "fulltime") return "Full-time";
  if (lower === "part-time" || lower === "part_time" || lower === "parttime") return "Part-time";
  if (lower === "contract" || lower === "contractor") return "Contract";
  if (lower === "temporary" || lower === "temp") return "Temporary";
  if (lower === "volunteer") return "Volunteer";
  if (lower === "freelance" || lower === "freelancer") return "Freelance";
  if (lower === "per diem" || lower === "per_diem") return "Per Diem";

  // Capitalize words for custom valid types (e.g. "apprenticeship" -> "Apprenticeship")
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
