/**
 * Preferences sheet model: the draft the sheet edits, how it maps to/from UserPreferences, and the
 * ONE counting rule behind the top count, per-group counts and summaries.
 *
 * Counting rule: one per dimension that (a) has storage AND a live consumer and (b) has a non-empty
 * value. Never counted: unavailable/pending controls; work authorization (saved, no job query
 * consumer); a multi-choice work model (saved in full, but ranking only reads a single choice, so
 * 2+ choices rank as "any"); saved title/company/date constraints while their feed application is
 * not enabled by the owner (`constraintsApplied` false).
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
  errors: Partial<Record<"minSalary" | "salaryCurrency" | "companies", string>>;
}

export function validateDraft(d: PreferencesDraft): ValidationResult {
  const errors: ValidationResult["errors"] = {};
  if (d.minSalary !== null && (!Number.isFinite(d.minSalary) || d.minSalary < 0)) {
    errors.minSalary = "Enter a positive annual amount, or clear it.";
  }
  if (d.minSalary && !d.salaryCurrency) errors.salaryCurrency = "Choose the currency for your minimum salary.";
  const conflicts = companyConflicts(d);
  if (conflicts.length) {
    errors.companies = `Remove ${conflicts.join(", ")} from one of the company lists: a company can't be both shown only and never shown.`;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Company names in both lists (blocked by validation; if one reaches the query, exclusion wins). */
export function companyConflicts(d: PreferencesDraft): string[] {
  const ex = new Set(d.excludedCompanies.map((c) => c.toLowerCase()));
  return d.includedCompanies.filter((c) => ex.has(c.toLowerCase()));
}

/** `constraintsApplied`: constraint storage exists AND the owner enabled applying saved constraints. */
export function groupCounts(d: PreferencesDraft, constraintsApplied: boolean): Record<PreferenceGroup, number> {
  const n = (v: unknown) => (Array.isArray(v) ? v.length > 0 : Boolean(v)) ? 1 : 0;
  const c = constraintsApplied;
  return {
    basic:
      n(d.roles) + (c ? n(d.excludedTitles) : 0) + n(d.employmentTypes) + (d.workModels.length === 1 ? 1 : 0) +
      n(d.countryCode) + n(d.locations) + n(d.experienceLevel) + (c ? n(d.datePosted) : 0),
    compensation: n(d.minSalary && d.salaryCurrency),
    interests: 0, // every Interests control is pending a job-side data source
    company: c ? n(d.includedCompanies) + n(d.excludedCompanies) : 0,
  };
}

export function activeCount(d: PreferencesDraft, constraintsApplied: boolean): number {
  const g = groupCounts(d, constraintsApplied);
  return g.basic + g.compensation + g.interests + g.company;
}

/** First `max` items plus the "+N" overflow count. */
export function summarize(items: readonly string[], max = 2): { shown: string[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}
