/**
 * Preferences sheet model: the draft the sheet edits, how it maps to/from UserPreferences, and the
 * ONE counting rule behind the top count, per-group counts and summaries.
 *
 * Counting rule: one per SELECTED VALUE, the same as the chips in the sheet's summary strip (so 8 selected roles
 * show 8, not 1; the reference shows every selected value). Never counted: unavailable/pending controls; work
 * authorization (saved, no job query consumer); saved title/company/date constraints while their feed
 * application is not enabled by the owner (`constraintsApplied` false).
 */
import type { UserPreferences } from "@/lib/auth/types";
import { getCountryName } from "@/lib/countries";
import { isExperienceLevelFilterActive, parseExperienceLevels } from "@/lib/jobs/experienceLevels";
import { normalizeSkillList, skillKey } from "@/lib/jobs/skillKey";
import { isRequiredYearsRangeActive, normalizeRequiredYearsRange } from "@/lib/jobs/requiredYears";
import { categoriesForRoles } from "@/lib/onboarding/roleCategories";
import {
  legacyRemotePreference,
  normalizeTextList,
  normalizeWorkModels,
  parseDatePosted,
  workModelsFromLegacy,
  type DatePostedWindow,
  type WorkModel,
} from "./feedConstraints";

export interface PreferencesDraft {
  roles: string[];
  excludedTitles: string[];
  employmentTypes: string[];
  workModels: WorkModel[];
  countryCode: string; // "" = not set / worldwide
  locations: string[];
  experienceLevel: string; // "" = not set
  datePosted: DatePostedWindow | null;
  minSalary: number | null; // null = no minimum
  salaryCurrency: string;
  workAuth: string;
  includedCompanies: string[];
  excludedCompanies: string[];
  /** Required years of experience: null = unset; max null = no upper bound (slider top). */
  requiredYearsMin: number | null;
  requiredYearsMax: number | null;
  preferredSkills: string[];
  excludedSkills: string[];
}

export type PreferenceGroup = "basic" | "compensation" | "interests" | "company";

export function draftFromPreferences(p: UserPreferences): PreferencesDraft {
  return {
    roles: [...(p.roles || [])],
    excludedTitles: [...(p.excludedTitles || [])],
    employmentTypes: [...(p.employmentTypes || [])],
    workModels: p.workModels ? normalizeWorkModels(p.workModels) : workModelsFromLegacy(p.remotePreference),
    countryCode: (p.countryCode || "").toUpperCase(),
    locations: [...(p.locations || [])],
    experienceLevel: p.experienceLevel || "",
    datePosted: parseDatePosted(p.datePosted),
    minSalary: typeof p.minSalary === "number" && p.minSalary > 0 ? p.minSalary : null,
    salaryCurrency: p.salaryCurrency || "",
    workAuth: p.workAuth || "",
    includedCompanies: [...(p.includedCompanies || [])],
    excludedCompanies: [...(p.excludedCompanies || [])],
    requiredYearsMin: normalizeRequiredYearsRange({ min: p.requiredYearsMin, max: p.requiredYearsMax }).min,
    requiredYearsMax: normalizeRequiredYearsRange({ min: p.requiredYearsMin, max: p.requiredYearsMax }).max,
    preferredSkills: [...(p.preferredSkills || [])],
    excludedSkills: [...(p.excludedSkills || [])],
  };
}

/**
 * The preferences to save: the committed row with the draft applied. Every field the sheet does
 * not edit (digest, onboarding, eligibility flags, country name when unchanged) is carried over.
 */
export function preferencesFromDraft(committed: UserPreferences, d: PreferencesDraft): UserPreferences {
  const constraintsAvailable = committed.feedConstraintsAvailable !== false;
  const advancedAvailable = committed.advancedPreferencesAvailable !== false;
  const years = normalizeRequiredYearsRange({ min: d.requiredYearsMin, max: d.requiredYearsMax });
  const countryChanged = d.countryCode !== (committed.countryCode || "").toUpperCase();
  const roles = normalizeTextList(d.roles);
  return {
    ...committed,
    roles,
    // Taxonomy roles map to job categories; custom roles keep their text and add none.
    categories: categoriesForRoles(roles),
    employmentTypes: [...d.employmentTypes],
    workModels: normalizeWorkModels(d.workModels),
    remotePreference: legacyRemotePreference(normalizeWorkModels(d.workModels)),
    locations: normalizeTextList(d.locations),
    experienceLevel: d.experienceLevel || undefined,
    minSalary: d.minSalary && d.minSalary > 0 ? Math.round(d.minSalary) : undefined,
    salaryCurrency: d.salaryCurrency || committed.salaryCurrency,
    workAuth: d.workAuth || undefined,
    ...(countryChanged
      ? { countryCode: d.countryCode || "", country: d.countryCode ? getCountryName(d.countryCode) || "" : "" }
      : {}),
    ...(constraintsAvailable
      ? {
          excludedTitles: normalizeTextList(d.excludedTitles),
          datePosted: d.datePosted,
          includedCompanies: normalizeTextList(d.includedCompanies),
          excludedCompanies: normalizeTextList(d.excludedCompanies),
        }
      : {}),
    ...(advancedAvailable
      ? {
          requiredYearsMin: years.min,
          requiredYearsMax: years.max,
          preferredSkills: normalizeSkillList(d.preferredSkills),
          excludedSkills: normalizeSkillList(d.excludedSkills),
        }
      : {}),
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: Partial<Record<"minSalary" | "salaryCurrency" | "companies" | "requiredYears" | "skills", string>>;
}

export function validateDraft(d: PreferencesDraft): ValidationResult {
  const errors: ValidationResult["errors"] = {};
  if (d.minSalary !== null && (!Number.isFinite(d.minSalary) || d.minSalary < 0)) {
    errors.minSalary = "Enter a positive annual amount, or clear it.";
  }
  if (d.minSalary && !d.salaryCurrency) errors.salaryCurrency = "Choose the currency for your minimum salary.";
  const yearOk = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0);
  if (!yearOk(d.requiredYearsMin) || !yearOk(d.requiredYearsMax) ||
      (d.requiredYearsMin !== null && d.requiredYearsMax !== null && d.requiredYearsMax < d.requiredYearsMin)) {
    errors.requiredYears = "Choose a valid range of years, or clear it.";
  }
  const skillConflicts = skillConflictsOf(d);
  if (skillConflicts.length) {
    errors.skills = `Remove ${skillConflicts.join(", ")} from one of the skill lists: a skill can't be both preferred and excluded.`;
  }
  const conflicts = companyConflicts(d);
  if (conflicts.length) {
    errors.companies = `Remove ${conflicts.join(", ")} from one of the company lists: a company can't be both shown only and never shown.`;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Skills in both lists (blocked by validation). Compared case-insensitively. */
export function skillConflictsOf(d: PreferencesDraft): string[] {
  const ex = new Set(d.excludedSkills.map(skillKey));
  return d.preferredSkills.filter((c) => ex.has(skillKey(c)));
}

/** Company names in both lists (blocked by validation; if one reaches the query, exclusion wins). */
export function companyConflicts(d: PreferencesDraft): string[] {
  const ex = new Set(d.excludedCompanies.map((c) => c.toLowerCase()));
  return d.includedCompanies.filter((c) => ex.has(c.toLowerCase()));
}

/** `constraintsApplied`: constraint storage exists AND the owner enabled applying saved constraints. */
/**
 * `advancedAvailable`: the advanced columns exist (default false, so nothing advanced is counted until the caller
 * says so). Required years and excluded skills are feed filters, so they also need `constraintsApplied` (owner gate);
 * preferred skills only rank, so they count whenever storage exists. Skills count one per selected skill; a
 * required-years range is one value.
 */
export function groupCounts(d: PreferencesDraft, constraintsApplied: boolean, advancedAvailable = false): Record<PreferenceGroup, number> {
  const one = (v: unknown) => (v ? 1 : 0);
  const c = constraintsApplied;
  const place = normalizeTextList([d.countryCode ? getCountryName(d.countryCode) || d.countryCode : "", ...d.locations]).length;
  return {
    basic:
      d.roles.length + (c ? d.excludedTitles.length : 0) + d.employmentTypes.length + d.workModels.length +
      place + (isExperienceLevelFilterActive(d.experienceLevel) ? parseExperienceLevels(d.experienceLevel).length : 0) + (c ? one(d.datePosted) : 0) +
      (c && advancedAvailable && isRequiredYearsRangeActive({ min: d.requiredYearsMin, max: d.requiredYearsMax }) ? 1 : 0),
    compensation: one(d.minSalary && d.salaryCurrency),
    interests: advancedAvailable ? d.preferredSkills.length + (c ? d.excludedSkills.length : 0) : 0, // other Interests controls are pending a job-side data source
    company: c ? d.includedCompanies.length + d.excludedCompanies.length : 0,
  };
}

export function activeCount(d: PreferencesDraft, constraintsApplied: boolean, advancedAvailable = false): number {
  const g = groupCounts(d, constraintsApplied, advancedAvailable);
  return g.basic + g.compensation + g.interests + g.company;
}

/** First `max` items plus the "+N" overflow count. */
export function summarize(items: readonly string[], max = 2): { shown: string[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}
