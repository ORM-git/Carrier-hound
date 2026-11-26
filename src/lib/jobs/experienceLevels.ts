/**
 * Experience Level filter: one shared definition for the server query and the client predicate.
 *
 * The Level facet is multi-select (comma-separated, e.g. "entry,senior") and is an OR inside the
 * facet; callers AND it with every other filter. Classification reuses the existing title heuristic
 * (same substrings and priority as the jobs page `inferJobLevel` and the old server branches) plus
 * the existing `job_type = internship` field for "intern". No new title keywords are introduced.
 *
 * Priority (first match wins): intern (job_type) > director > lead > senior > entry > mid (none of the above).
 * Director / Executive is a whole-word title match on director, vp, vice president, head of, chief.
 * The server clauses encode the same priority, so a job is returned by the server exactly when the
 * client predicate accepts it. Clauses are built only from the constants below, never from input.
 */

export type CanonicalExperienceLevel = "intern" | "entry" | "mid" | "senior" | "lead" | "director";

export const CANONICAL_EXPERIENCE_LEVELS: readonly CanonicalExperienceLevel[] = [
  "intern",
  "entry",
  "mid",
  "senior",
  "lead",
  "director",
] as const;

export const EXPERIENCE_LEVEL_LABELS: Record<CanonicalExperienceLevel, string> = {
  intern: "Intern / New Grad",
  entry: "Entry Level",
  mid: "Mid Level",
  senior: "Senior Level",
  lead: "Staff / Principal / Lead",
  director: "Director / Executive",
};

// Existing title keywords (unchanged from the pre-multi-select server/client heuristic).
const LEAD_KEYWORDS = ["staff", "principal", "lead"] as const;
const SENIOR_KEYWORDS = ["senior", "sr."] as const;
const ENTRY_KEYWORDS = ["junior", "entry", "associate"] as const;
const INTERN_JOB_TYPE = "internship";
// Whole-word title phrases (same set the seniority backfill uses). Regex-matched, never substring-matched.
const DIRECTOR_PHRASES = ["director", "vp", "vice president", "head of", "chief"] as const;
// Explicit ASCII boundaries, identical in JS and Postgres. Not \\b / \\y: Postgres \\y is Unicode-aware
// (so "Édirector" would not match there) while JS \\b is ASCII-only. Both sides treat only [a-z0-9_] as word chars.
const WORD_CHARS = "a-z0-9_";
const DIRECTOR_RE = new RegExp(`(?<![${WORD_CHARS}])(?:${DIRECTOR_PHRASES.join("|")})(?![${WORD_CHARS}])`, "i");
/** Postgres/PostgREST (imatch, POSIX ARE) pattern equal to DIRECTOR_RE for one phrase. */
export const directorPgPattern = (phrase: string) => `(^|[^${WORD_CHARS}])${phrase}([^${WORD_CHARS}]|$)`;

// URL/query tokens accepted for each level (ids, UI labels and legacy single-level values).
const LEVEL_ALIASES: Record<string, CanonicalExperienceLevel> = {
  intern: "intern",
  internship: "intern",
  "intern / new grad": "intern",
  "new grad": "intern",
  entry: "entry",
  "entry level": "entry",
  "entry-level": "entry",
  junior: "entry",
  mid: "mid",
  "mid level": "mid",
  "mid-level": "mid",
  senior: "senior",
  "senior level": "senior",
  lead: "lead",
  staff: "lead",
  "staff / lead": "lead",
  "staff / principal / lead": "lead",
  director: "director",
  executive: "director",
  exec: "director",
  "director / executive": "director",
  "director/executive": "director",
};

// shortcut: input bounded to 200 chars / 20 tokens; 6 levels exist, so anything longer is junk.
const MAX_RAW_LENGTH = 200;
const MAX_TOKENS = 20;

/**
 * Normalizes a raw level value (string or string[]) to deduplicated canonical levels in canonical
 * order. Unknown, injected or unsupported values (e.g. "director") are dropped; "all" means none.
 */
export function parseExperienceLevels(raw?: string | string[] | null): CanonicalExperienceLevel[] {
  if (!raw) return [];
  const joined = (Array.isArray(raw) ? raw.filter((s) => typeof s === "string").join(",") : String(raw)).slice(
    0,
    MAX_RAW_LENGTH
  );
  const matched = new Set<CanonicalExperienceLevel>();
  for (const token of joined.split(",").slice(0, MAX_TOKENS)) {
    const canonical = LEVEL_ALIASES[token.trim().toLowerCase()];
    if (canonical) matched.add(canonical);
  }
  return CANONICAL_EXPERIENCE_LEVELS.filter((lvl) => matched.has(lvl));
}

export function formatExperienceLevels(levels: readonly CanonicalExperienceLevel[]): string {
  return levels.join(",");
}

/** True when the selection restricts results (1-5 levels). Empty, "all" or all 6 levels = no filter. */
export function isExperienceLevelFilterActive(raw?: string | string[] | null): boolean {
  const n = parseExperienceLevels(raw).length;
  return n > 0 && n < CANONICAL_EXPERIENCE_LEVELS.length;
}

/**
 * The Level filter the feed applies. An explicit browse selection (any value that names at least one level,
 * including all six = "any level") overrides the saved one; it is never intersected with it. Unset, "all" or
 * an unknown token falls back to the saved selection, but ONLY when saved constraints are enforced (owner
 * gate) and the feed is the personalized one. With the gate off the saved level stays ranking-only.
 * Returns the raw value to filter by, or undefined for no filter from this source.
 */
export function resolveEffectiveLevel(
  explicit: string | string[] | null | undefined,
  saved: string | string[] | null | undefined,
  opts: { enforced: boolean; personalized: boolean }
): string | string[] | undefined {
  const hasExplicit = parseExperienceLevels(explicit).length > 0;
  if (hasExplicit) return explicit ?? undefined;
  if (opts.enforced && opts.personalized && isExperienceLevelFilterActive(saved)) return saved ?? undefined;
  return undefined;
}

const hasAny = (text: string, words: readonly string[]) => words.some((w) => text.includes(w));

/** True for a Director / Executive title (whole-word director, vp, vice president, head of, chief). */
export function isDirectorTitle(title?: string | null): boolean {
  return DIRECTOR_RE.test(title || "");
}

/** Classifies one job with the shared heuristic (same result the server clauses produce). */
export function classifyJobExperienceLevel(title?: string | null, jobType?: string | null): CanonicalExperienceLevel {
  if ((jobType || "").trim().toLowerCase() === INTERN_JOB_TYPE) return "intern";
  if (isDirectorTitle(title)) return "director";
  const t = (title || "").toLowerCase();
  if (hasAny(t, LEAD_KEYWORDS)) return "lead";
  if (hasAny(t, SENIOR_KEYWORDS)) return "senior";
  if (hasAny(t, ENTRY_KEYWORDS)) return "entry";
  return "mid";
}

/** Client-side predicate: does this job pass the Level facet? (OR across selected levels.) */
export function matchesExperienceLevelFilter(
  job: { title?: string | null; type?: string | null; job_type?: string | null },
  rawLevel?: string | string[] | null
): boolean {
  if (!isExperienceLevelFilterActive(rawLevel)) return true;
  return parseExperienceLevels(rawLevel).includes(classifyJobExperienceLevel(job.title, job.job_type ?? job.type));
}

// --- Server clauses (PostgREST logic-tree syntax), built only from the constants above ---------
const anyTitle = (words: readonly string[]) => `or(${words.map((w) => `title.ilike.%${w}%`).join(",")})`;
const noTitle = (words: readonly string[]) => words.map((w) => `title.not.ilike.%${w}%`).join(",");
// NULL job_type is "not internship" (a bare neq would drop NULL rows).
const NOT_INTERN = `or(job_type.is.null,job_type.neq.${INTERN_JOB_TYPE})`;
// Whole-word director match, one condition per phrase (PostgREST imatch, explicit ASCII boundaries).
// The value is double-quoted because the pattern holds parentheses and a pipe.
const directorConds = DIRECTOR_PHRASES.map((w) => `title.imatch."${directorPgPattern(w)}"`);
const anyDirector = `or(${directorConds.join(",")})`;
const noDirector = DIRECTOR_PHRASES.map((w) => `title.not.imatch."${directorPgPattern(w)}"`).join(",");

const LEVEL_CLAUSES: Record<CanonicalExperienceLevel, string> = {
  intern: `job_type.eq.${INTERN_JOB_TYPE}`,
  director: `and(${NOT_INTERN},${anyDirector})`,
  lead: `and(${NOT_INTERN},${noDirector},${anyTitle(LEAD_KEYWORDS)})`,
  senior: `and(${NOT_INTERN},${noDirector},${noTitle(LEAD_KEYWORDS)},${anyTitle(SENIOR_KEYWORDS)})`,
  entry: `and(${NOT_INTERN},${noDirector},${noTitle(LEAD_KEYWORDS)},${noTitle(SENIOR_KEYWORDS)},${anyTitle(ENTRY_KEYWORDS)})`,
  mid: `and(${NOT_INTERN},${noDirector},${noTitle(LEAD_KEYWORDS)},${noTitle(SENIOR_KEYWORDS)},${noTitle(ENTRY_KEYWORDS)})`,
};

/** The single PostgREST `or` expression for a selection, or null when the facet does not filter. */
export function buildExperienceLevelOrClause(rawLevel?: string | string[] | null): string | null {
  if (!isExperienceLevelFilterActive(rawLevel)) return null;
  return parseExperienceLevels(rawLevel)
    .map((lvl) => LEVEL_CLAUSES[lvl])
    .join(",");
}

/** Applies the Level facet to a Supabase query builder (one `.or()`, AND-ed with other filters). */
export function applyExperienceLevelQuery<T extends { or: (expr: string) => T }>(
  query: T,
  rawLevel?: string | string[] | null
): T {
  const clause = buildExperienceLevelOrClause(rawLevel);
  return clause ? query.or(clause) : query;
}

// --- Early-career (intern / new grad / fresher / junior) classifier -------------------------------
// One word list shared by recommendation ranking and the explicit Experience filter, so an "intern"
// seeker and an "entry" filter agree on what counts. Whole-word match: "Internal Audit" is not an intern role.
const EARLY_CAREER_WORDS = ["intern", "internship", "graduate", "grad", "fresher", "junior", "entry", "associate"] as const;
const EARLY_CAREER_RE = new RegExp(`\\b(${EARLY_CAREER_WORDS.join("|")})\\b`, "i");

export function isEarlyCareerJob(title?: string | null, jobType?: string | null): boolean {
  return (jobType || "").trim().toLowerCase() === INTERN_JOB_TYPE || EARLY_CAREER_RE.test(title || "");
}

/** PostgREST `or` expression equivalent to isEarlyCareerJob. */
export const EARLY_CAREER_OR_CLAUSE = [
  ...EARLY_CAREER_WORDS.map((w) => `title.imatch.\\y${w}\\y`),
  `job_type.eq.${INTERN_JOB_TYPE}`,
].join(",");
