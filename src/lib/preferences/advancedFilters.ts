/**
 * Advanced saved filters (years of experience required; skills come later), the one place that turns them
 * into request params and query predicates. Same owner gate as the other saved constraints
 * (NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS, see feedConstraints.ts): with the gate off nothing here is
 * sent and the saved values are stored only.
 *
 * Required years: inclusive overlap with the job's stated range; a job that states no years is kept
 * (unknown is not "fails"). Upper handle at the top = no upper bound; 0..top = no filter.
 */
import { normalizeSkillList, skillKey } from "@/lib/jobs/skillKey";
import {
  buildRequiredYearsClause,
  isRequiredYearsRangeActive,
  normalizeRequiredYearsRange,
  type RequiredYearsRange,
} from "@/lib/jobs/requiredYears";

export const YEARS_PARAM = { min: "yearsMin", max: "yearsMax" } as const;

/** Adds the range to request params only when it restricts something. */
export function appendRequiredYearsParams(params: URLSearchParams, range: RequiredYearsRange | null | undefined): void {
  if (!isRequiredYearsRangeActive(range)) return;
  const r = normalizeRequiredYearsRange(range);
  if (r.min !== null) params.set(YEARS_PARAM.min, String(r.min));
  if (r.max !== null) params.set(YEARS_PARAM.max, String(r.max));
}

/** Server side: the validated range from a request (junk, negative or non-finite values are dropped). */
export function requiredYearsFromParams(params: URLSearchParams): RequiredYearsRange {
  return normalizeRequiredYearsRange({ min: params.get(YEARS_PARAM.min), max: params.get(YEARS_PARAM.max) });
}

interface OrQuery<Q> {
  or(expr: string): Q;
}

/** Applies the range to a jobs query. Needs jobs.min_experience_years / max_experience_years. */
export function applyRequiredYears<Q extends OrQuery<Q>>(query: Q, range: RequiredYearsRange | null | undefined): Q {
  const clause = buildRequiredYearsClause(range);
  return clause ? query.or(`${clause}`) : query;
}

// --- Excluded skills -------------------------------------------------------------------------------
// Exact skills only (jobs.skills, never title or top_keywords), same key as saving (skillKey). A job with no
// stated skills is kept. Membership is decided in the database by the jobs_without_excluded_skills RPC BEFORE
// paging, never by filtering a fetched page. Free and Pro both get the filter; the skills payload itself
// stays masked as before. Off until the owner applies the migration and sets the readiness flag.
export const EXCLUDED_SKILLS_PARAM = "excludedSkills";
export const EXCLUDED_SKILLS_RPC = "jobs_without_excluded_skills";

export function appendExcludedSkillParams(params: URLSearchParams, skills: readonly string[] | null | undefined): void {
  const list = normalizeSkillList(skills ?? []);
  if (list.length) params.set(EXCLUDED_SKILLS_PARAM, JSON.stringify(list));
}

export type ExcludedSkillsParse = { ok: true; keys: string[] } | { ok: false };

/**
 * Server side. ABSENT param = no filter. PRESENT must be a strict JSON array of 0..50 strings, each non-blank and at
 * most 100 UTF-16 units; anything else is invalid and the route must reject (400) before any query: a malformed
 * saved filter never turns into an unfiltered feed, and nothing is dropped or truncated to make it fit.
 * A valid empty array is a no-op. Valid terms are keyed (skillKey) and deduplicated.
 */
export function parseExcludedSkillParams(params: URLSearchParams): ExcludedSkillsParse {
  const raw = params.get(EXCLUDED_SKILLS_PARAM);
  if (raw === null) return { ok: true, keys: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed) || parsed.length > 50) return { ok: false };
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const v of parsed) {
    if (typeof v !== "string" || v.length > 100) return { ok: false };
    const k = skillKey(v);
    if (!k) return { ok: false };
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return { ok: true, keys };
}

/** Owner readiness flag: the RPC must be applied and cost-checked before this is set. */
export function excludedSkillsRpcReady(value: string | undefined | null): boolean {
  return value === "1";
}

// --- Server capability (what the server can honestly apply right now) ------------------------------
export interface AdvancedCapabilities {
  /** Saved constraints are applied to the feed at all (the owner gate). With this false nothing below applies. */
  savedConstraintsApplied: boolean;
  /** Excluded skills are applied: RPC applied + readiness flag + service key. Same for Free and Pro. */
  excludedSkillsFilter: boolean;
  /**
   * Preferred skills move jobs up for PRO accounts only (skills are a paid scoring input; Free never gets a boost).
   * Owner flag CM_PREFERRED_SKILLS_RANKING=1 plus the service key. Global, not per account: the UI must say Pro.
   */
  preferredSkillsRanking: boolean;
  /**
   * Transient required-years range from the All Filters drawer: owner gate + service key + a live read-only probe that
   * jobs.min/max_experience_years are queryable (yearsReadiness.ts). Technical readiness only; jobs that state no years
   * are kept, so data coverage is not promised. Recommended feed tab only.
   */
  requiredYearsFilter: boolean;
}

/** Pure: callers pass the server-side values (nothing here reads the client). */
export function computeAdvancedCapabilities(input: {
  enforced: boolean;
  hasServiceKey: boolean;
  excludedSkillsRpcFlag: string | undefined | null;
  preferredSkillsRankingFlag: string | undefined | null;
  /** Result of probeRequiredYearsColumns; false when not probed. */
  requiredYearsQueryable?: boolean;
}): AdvancedCapabilities {
  return {
    savedConstraintsApplied: input.enforced,
    excludedSkillsFilter: input.enforced && input.hasServiceKey && excludedSkillsRpcReady(input.excludedSkillsRpcFlag),
    preferredSkillsRanking: input.enforced && input.hasServiceKey && input.preferredSkillsRankingFlag === "1",
    requiredYearsFilter: input.enforced && input.hasServiceKey && input.requiredYearsQueryable === true,
  };
}
