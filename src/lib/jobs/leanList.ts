import { extractDescriptionSkills } from "@/lib/matcher/scoring";

/**
 * Lean Pro list rows. The Recommended and Search list responses for a Pro viewer carry only what a card needs:
 * the description (the largest field) is left empty and the row says so with `lean: true`. The full record
 * is fetched on demand by the single-job detail endpoint, which stays complete.
 *
 * The client Experience filter used to read the full description text per row. The server now derives the
 * matching buckets from the SAME text (title + description + skills) with the SAME rules and sends them as a
 * few short strings, so the filter result is identical without shipping the description.
 */
export const EXPERIENCE_BUCKETS = ["1-3 Years", "3-5 Years", "5+ Years", "8+ Years"] as const;
export type ExperienceBucket = (typeof EXPERIENCE_BUCKETS)[number];

export function experienceTextMatches(bucket: string, text: string): boolean {
  const t = text.toLowerCase();
  if (bucket === "1-3 Years") return t.includes("1-3") || t.includes("1 to 3") || t.includes("entry") || t.includes("junior");
  if (bucket === "3-5 Years") return t.includes("3-5") || t.includes("3 to 5") || t.includes("mid") || !t.includes("senior");
  if (bucket === "5+ Years") return t.includes("5+") || t.includes("5 years") || t.includes("senior") || t.includes("lead");
  if (bucket === "8+ Years") return t.includes("8+") || t.includes("8 years") || t.includes("staff") || t.includes("principal");
  return true;
}

export function experienceSourceText(job: { title?: string | null; description?: string | null; skills?: string[] | null }): string {
  return `${job.title} ${job.description || ""} ${(job.skills || []).join(" ")}`;
}

/** Buckets a row matches, computed from its FULL text (call before the description is dropped). */
export function experienceBucketsFor(job: { title?: string | null; description?: string | null; skills?: string[] | null }): ExperienceBucket[] {
  const text = experienceSourceText(job);
  return EXPERIENCE_BUCKETS.filter((b) => experienceTextMatches(b, text));
}

/** Experience filter for one list row: lean rows use the server-derived buckets, full rows the text itself. */
export function jobMatchesExperience(
  job: { title?: string | null; description?: string | null; skills?: string[] | null; lean?: boolean; experienceBuckets?: string[] },
  bucket: string,
): boolean {
  if (job.lean && Array.isArray(job.experienceBuckets)) {
    return (EXPERIENCE_BUCKETS as readonly string[]).includes(bucket) ? job.experienceBuckets.includes(bucket) : true;
  }
  return experienceTextMatches(bucket, experienceSourceText(job));
}

/** Pro list serialization: description dropped, derived facts kept. */
export function leanProListFields(row: { title?: string | null; description?: string | null; skills?: string[] | null; category?: string | null }) {
  return {
    description: "",
    lean: true as const,
    experienceBuckets: experienceBucketsFor(row),
    // The card fit diagnostics read skills evidenced in the description; send just those names, not the text.
    descriptionSkills: extractDescriptionSkills(row.description, row.category),
  };
}
