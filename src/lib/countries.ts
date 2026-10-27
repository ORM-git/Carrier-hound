/**
 * src/lib/countries.ts
 *
 * Supported country list and code-to-name dictionary for CareerMonke job filtering.
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
};

/**
 * Returns the full country name for a given 2-letter ISO country code.
 */
export function getCountryName(countryCode?: string | null): string | null {
  if (!countryCode) return null;
  const upper = countryCode.trim().toUpperCase();
  return COUNTRY_CODE_TO_NAME[upper] || null;
}
