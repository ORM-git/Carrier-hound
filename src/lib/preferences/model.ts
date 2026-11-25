/**
 * Preferences sheet model: the draft the sheet edits, how it maps to/from UserPreferences, and the
 * ONE counting rule behind the top count, per-group counts and summaries.
 *
 * Counting rule: one per dimension that (a) is available (has storage and a real consumer) and
 * (b) has a non-empty COMMITTED value. Unavailable/pending controls never count. Work
 * authorization is saved but has no job query consumer yet, so it is not counted either.
 */
import type { UserPreferences } from "@/lib/auth/types";
import { getCountryName } from "@/lib/countries";
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
  };
}

/**
 * The preferences to save: the committed row with the draft applied. Every field the sheet does
 * not edit (digest, onboarding, eligibility flags, country name when unchanged) is carried over.
 */
export function preferencesFromDraft(committed: UserPreferences, d: PreferencesDraft): UserPreferences {
  const constraintsAvailable = committed.feedConstraintsAvailable !== false;
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
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: Partial<Record<"minSalary" | "salaryCurrency", string>>;
}

export function validateDraft(d: PreferencesDraft): ValidationResult {
  const errors: ValidationResult["errors"] = {};
  if (d.minSalary !== null && (!Number.isFinite(d.minSalary) || d.minSalary < 0)) {
    errors.minSalary = "Enter a positive annual amount, or clear it.";
  }
  if (d.minSalary && !d.salaryCurrency) errors.salaryCurrency = "Choose the currency for your minimum salary.";
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Company names in both lists (exclusion wins when saved). */
export function companyConflicts(d: PreferencesDraft): string[] {
  const ex = new Set(d.excludedCompanies.map((c) => c.toLowerCase()));
  return d.includedCompanies.filter((c) => ex.has(c.toLowerCase()));
}

export function groupCounts(d: PreferencesDraft, constraintsAvailable: boolean): Record<PreferenceGroup, number> {
  const n = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v)) ? 1 : 0;
  const c = constraintsAvailable;
  return {
    basic:
      n(d.roles) + (c ? n(d.excludedTitles) : 0) + n(d.employmentTypes) + n(d.workModels) + n(d.countryCode) +
      n(d.locations) + n(d.experienceLevel) + (c ? n(d.datePosted) : 0),
    compensation: n(d.minSalary && d.salaryCurrency),
    interests: 0, // every Interests control is pending a job-side data source
    // An included name that is also excluded has no effect (exclusion wins), so it does not count.
    company: c ? n(d.includedCompanies.filter((x) => !companyConflicts(d).includes(x))) + n(d.excludedCompanies) : 0,
  };
}

export function activeCount(d: PreferencesDraft, constraintsAvailable: boolean): number {
  const g = groupCounts(d, constraintsAvailable);
  return g.basic + g.compensation + g.interests + g.company;
}

/** First `max` items plus the "+N" overflow count. */
export function summarize(items: readonly string[], max = 2): { shown: string[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}
