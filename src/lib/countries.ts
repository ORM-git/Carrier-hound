/**
 * src/lib/countries.ts
 *
 * Supported country list, code-to-name dictionary, and strict location filter helpers for CareerMonke.
 * Used across JobFilterBar, AllFiltersDrawer, MobileFilterSheet, service.ts, and search/pro routes.
 */

export interface CountryOption {
  code: string;
  name: string;
  label: string;
}

export const SUPPORTED_COUNTRIES: CountryOption[] = [
  { code: "", name: "Worldwide", label: "Worldwide (All Countries)" },
  { code: "US", name: "United States", label: "United States (US)" },
  { code: "GB", name: "United Kingdom", label: "United Kingdom (GB)" },
  { code: "CA", name: "Canada", label: "Canada (CA)" },
  { code: "IN", name: "India", label: "India (IN)" },
  { code: "DE", name: "Germany", label: "Germany (DE)" },
  { code: "FR", name: "France", label: "France (FR)" },
  { code: "NL", name: "Netherlands", label: "Netherlands (NL)" },
  { code: "AU", name: "Australia", label: "Australia (AU)" },
  { code: "ES", name: "Spain", label: "Spain (ES)" },
  { code: "BR", name: "Brazil", label: "Brazil (BR)" },
  { code: "SG", name: "Singapore", label: "Singapore (SG)" },
  { code: "IE", name: "Ireland", label: "Ireland (IE)" },
  { code: "JP", name: "Japan", label: "Japan (JP)" },
  { code: "MX", name: "Mexico", label: "Mexico (MX)" },
];

export const COUNTRY_CODE_TO_NAME: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  IN: "India",
  DE: "Germany",
  FR: "France",
  NL: "Netherlands",
  AU: "Australia",
  ES: "Spain",
  BR: "Brazil",
  SG: "Singapore",
  IE: "Ireland",
  JP: "Japan",
  MX: "Mexico",
  // Extended ISO mappings
  CH: "Switzerland",
  SE: "Sweden",
  IT: "Italy",
  PL: "Poland",
  IL: "Israel",
  AE: "United Arab Emirates",
  AT: "Austria",
  DK: "Denmark",
  NO: "Norway",
  FI: "Finland",
  NZ: "New Zealand",
  PT: "Portugal",
  PH: "Philippines",
  BE: "Belgium",
  BG: "Bulgaria",
  HR: "Croatia",
  CY: "Cyprus",
  CZ: "Czechia",
  EE: "Estonia",
  GR: "Greece",
  HU: "Hungary",
  LV: "Latvia",
  LT: "Lithuania",
  LU: "Luxembourg",
  MT: "Malta",
  RO: "Romania",
  SK: "Slovakia",
  SI: "Slovenia",
};

/**
 * Returns the full country name for a given 2-letter ISO country code.
 */
export function getCountryName(countryCode?: string | null): string | null {
  if (!countryCode) return null;
  const upper = countryCode.trim().toUpperCase();
  return COUNTRY_CODE_TO_NAME[upper] || null;
}

/**
 * Builds the PostgREST .or() filter clause for a given country code,
 * applying strict exclusions for known false positives:
 * - "IN": matches "India" but excludes "Indiana"
 * - "MX": matches "Mexico" but excludes "New Mexico"
 */
export function getCountryFilterClause(countryCode: string): string | null {
  const code = countryCode.trim().toUpperCase();
  const countryName = COUNTRY_CODE_TO_NAME[code];
  if (!countryName) return null;

  if (code === "IN") {
    return "country_code.eq.IN,and(location.ilike.%India%,location.not.ilike.%Indiana%)";
  }
  if (code === "MX") {
    return "country_code.eq.MX,and(location.ilike.%Mexico%,location.not.ilike.%New Mexico%)";
  }
  return `country_code.eq.${code},location.ilike.%${countryName}%`;
}

/**
 * Matches a job against a selected country code, supporting strict text fallback:
 * - Direct match: jobCountry === targetCode
 * - Text fallback: location contains country name
 * - Strict exclusions: "Indiana" is not "India", "New Mexico" is not "Mexico"
 */
export function matchCountryWithStrictFallback(
  jobCountry: string | null | undefined,
  jobLocation: string | null | undefined,
  selectedCountryCode: string
): boolean {
  if (!selectedCountryCode || selectedCountryCode.toLowerCase() === "all") return true;
  const targetCode = selectedCountryCode.trim().toUpperCase();
  const c = (jobCountry || "").trim().toUpperCase();
  if (c && c !== "UNKNOWN" && c === targetCode) {
    return true;
  }
  const countryName = COUNTRY_CODE_TO_NAME[targetCode]?.toLowerCase();
  if (!countryName) return false;

  const loc = (jobLocation || "").toLowerCase();
  if (targetCode === "IN") {
    return loc.includes("india") && !loc.includes("indiana");
  }
  if (targetCode === "MX") {
    return loc.includes("mexico") && !loc.includes("new mexico");
  }
  return loc.includes(countryName);
}

export {
  normalizeUserCountries,
  isJobEligible,
  applyEligibilityFilter,
} from "./jobs/eligibility";
export type {
  NormalizedUserCountries,
  JobEligibilityRecord,
} from "./jobs/eligibility";
