import { extractSkillsFromJob } from "@/lib/matcher/scoring";

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

/**
 * Pro list serialization: description and raw skills dropped, derived facts kept. `evidencedSkills` is extractSkillsFromJob of the FULL row
 * (raw skills + description + title, category words removed, exact order and case): the only skill input the card fit score, ranking and
 * Why-match read. Detail rows (single-job endpoint, getLiveJobById) stay complete and keep the raw skills.
 * Derive everything else that reads the raw skills or description (role_category, top_keywords) BEFORE calling this.
 */
export function leanProListFields(row: { title?: string | null; description?: string | null; skills?: string[] | null; category?: string | null }) {
  return {
    description: "",
    skills: [] as string[],
    lean: true as const,
    experienceBuckets: experienceBucketsFor(row),
    evidencedSkills: extractSkillsFromJob({ title: row.title || "", description: row.description || "", skills: row.skills || [], category: row.category || "" } as any),
  };
}

/**
 * Evidence for a lean row that arrived WITHOUT evidencedSkills (the previously deployed lean DTO: raw skills +
 * descriptionSkills). Same order and case as the old client: raw skills, then description skills, then title.
 * Must run BEFORE the raw skills are dropped.
 */
export function deriveLegacyLeanEvidence(row: { title?: string; category?: string; skills?: unknown; descriptionSkills?: unknown }): string[] {
  const raw = Array.isArray(row.skills) ? (row.skills as string[]) : [];
  const desc = Array.isArray(row.descriptionSkills) ? (row.descriptionSkills as string[]) : [];
  return extractSkillsFromJob({ title: row.title || "", description: "", skills: [...raw, ...desc], category: row.category || "" } as any);
}

/**
 * One compat normalizer for EVERY ingress (recommended, search, pro unlock): a lean row from a server that predates
 * evidencedSkills gets its evidence derived and its raw skills / descriptionSkills dropped. Rows that already carry
 * evidencedSkills, and every non-lean row, pass through untouched.
 */
export function normalizeLeanWireRow<T extends Record<string, any>>(row: T): T {
  if (!row || row.lean !== true || Array.isArray(row.evidencedSkills)) return row;
  const { descriptionSkills, ...rest } = row as any; void descriptionSkills;
  return { ...rest, evidencedSkills: deriveLegacyLeanEvidence(row), skills: [] } as T;
}
