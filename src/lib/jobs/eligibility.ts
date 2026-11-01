/**
 * src/lib/jobs/eligibility.ts
 *
 * Country eligibility auto-filtering module.
 * Reuses src/lib/countries.ts helpers (matchCountryWithStrictFallback, COUNTRY_CODE_TO_NAME)
 * to prevent duplicate matching logic and preserve Indiana/India and New Mexico/Mexico guards.
 */

import {
  COUNTRY_CODE_TO_NAME,
  matchCountryWithStrictFallback,
  getCountryName,
} from "../countries";

export interface NormalizedUserCountries {
  codes: string[];
  names: string[];
}

export interface JobEligibilityRecord {
  country?: string | null;
  country_code?: string | null;
  location?: string | null;
  remote?: boolean | null;
  remote_scope?: string | null;
  remote_eligibility?: string | null;
}

// Common aliases and regions from onboarding/UI
const REGION_TO_CODES: Record<string, string[]> = {
  "EUROPEAN UNION": ["DE", "FR", "NL", "ES", "IE", "IT", "PL", "AT", "DK", "SE", "FI", "PT"],
  "EU": ["DE", "FR", "NL", "ES", "IE", "IT", "PL", "AT", "DK", "SE", "FI", "PT"],
  "AUSTRALIA / APAC": ["AU", "SG", "JP", "NZ", "PH"],
  "APAC": ["AU", "SG", "JP", "NZ", "PH"],
  "LATIN AMERICA": ["BR", "MX"],
  "LATAM": ["BR", "MX"],
  "UK": ["GB"],
  "U.K.": ["GB"],
  "USA": ["US"],
  "U.S.": ["US"],
  "U.S.A.": ["US"],
};

const GENERIC_WORLDWIDE_TOKENS = new Set([
  "worldwide",
  "worldwide / remote",
  "remote / global",
  "remote",
  "global",
  "any",
  "all",
  "remote / worldwide",
  "unrestricted",
]);

/**
 * Normalizes user onboarding location preferences into unique ISO country codes and display names.
 * Ignores generic worldwide tags (which signify no geographic restriction).
 */
export function normalizeUserCountries(locations: string[] | null | undefined): NormalizedUserCountries {
  if (!Array.isArray(locations) || locations.length === 0) {
    return { codes: [], names: [] };
  }

  const codeSet = new Set<string>();
  const nameSet = new Set<string>();

  // Inverted map: lowercase country name -> code
  const nameToCode: Record<string, string> = {};
  for (const [code, name] of Object.entries(COUNTRY_CODE_TO_NAME)) {
    nameToCode[name.toLowerCase()] = code;
  }

  for (const raw of locations) {
    if (!raw || typeof raw !== "string") continue;
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();

    // Skip generic worldwide markers
    if (GENERIC_WORLDWIDE_TOKENS.has(lower)) {
      continue;
    }

    const upper = trimmed.toUpperCase();

    // 1. Direct ISO code match
    if (COUNTRY_CODE_TO_NAME[upper]) {
      codeSet.add(upper);
      nameSet.add(COUNTRY_CODE_TO_NAME[upper]);
      continue;
    }

    // 2. Region / alias expansion
    if (REGION_TO_CODES[upper]) {
      for (const c of REGION_TO_CODES[upper]) {
        codeSet.add(c);
        nameSet.add(COUNTRY_CODE_TO_NAME[c] || c);
      }
      continue;
    }

    // 3. Exact country name match
    if (nameToCode[lower]) {
      const code = nameToCode[lower];
      codeSet.add(code);
      nameSet.add(COUNTRY_CODE_TO_NAME[code]);
      continue;
    }

    // 4. Substring country name match (e.g., "India (IN)" or "United States of America")
    let matched = false;
    for (const [name, code] of Object.entries(nameToCode)) {
      if (lower.includes(name) || name.includes(lower)) {
        codeSet.add(code);
        nameSet.add(COUNTRY_CODE_TO_NAME[code]);
        matched = true;
        break;
      }
    }

    if (!matched && trimmed.length > 0) {
      // Retain clean display name as fallback
      nameSet.add(trimmed);
    }
  }

  return {
    codes: Array.from(codeSet),
    names: Array.from(nameSet),
  };
}

/**
 * Checks whether a job location contains an explicit reference to a foreign country
 * outside the user's allowed country list.
 */
function hasForeignCountryRestriction(location: string, allowedCodes: string[]): boolean {
  if (!location) return false;
  const loc = location.toLowerCase();
  const allowedSet = new Set(allowedCodes.map((c) => c.toUpperCase()));

  for (const [code, name] of Object.entries(COUNTRY_CODE_TO_NAME)) {
    if (allowedSet.has(code)) continue;

    // Strict Indiana/India guard
    if (code === "IN") {
      if (loc.includes("india") && !loc.includes("indiana")) return true;
      continue;
    }
    // Strict New Mexico/Mexico guard
    if (code === "MX") {
      if (loc.includes("mexico") && !loc.includes("new mexico")) return true;
      continue;
    }

    if (loc.includes(name.toLowerCase())) {
      return true;
    }

    // Two-letter word boundary check for prominent codes like US, UK, DE, FR
    const codeRegex = new RegExp(`\\b${code}\\b`, "i");
    if (codeRegex.test(loc) && !loc.includes("remote")) {
      return true;
    }
  }

  return false;
}

/**
 * Evaluates whether a job is eligible for a candidate given their allowed countries.
 * 
 * Rules:
 * 1. Filter off -> always eligible.
 * 2. User has no locations/countries set -> always eligible (unfiltered).
 * 3. Worldwide jobs (remote_scope worldwide, remote_eligibility worldwide, or location contains worldwide) -> always eligible.
 * 4. Job matches any of the user's countries via matchCountryWithStrictFallback (strictly respecting Indiana/India & New Mexico/Mexico guards).
 * 5. Remote job with no country restriction -> eligible.
 * 6. Jobs restricted to countries not in the list -> excluded.
 */
export function isJobEligible(
  job: JobEligibilityRecord,
  userCountries: string[] | NormalizedUserCountries,
  options?: { filterEnabled?: boolean }
): boolean {
  if (options?.filterEnabled === false) {
    return true;
  }

  const normalized: NormalizedUserCountries = Array.isArray(userCountries)
    ? normalizeUserCountries(userCountries)
    : userCountries;

  // Guests or users without specific country restrictions stay unfiltered
  if (!normalized.codes || normalized.codes.length === 0) {
    return true;
  }

  const scope = (job.remote_scope || "").toLowerCase().trim();
  const elig = (job.remote_eligibility || "").toLowerCase().trim();
  const isRemote = Boolean(job.remote);
  const countryCode = (job.country_code || job.country || "").toUpperCase().trim();
  const loc = (job.location || "").toLowerCase().trim();

  // 1. Worldwide jobs are ALWAYS included
  if (
    scope === "worldwide" ||
    elig === "worldwide" ||
    /\b(worldwide|work from anywhere|anywhere in the world|global|all timezones)\b/i.test(loc)
  ) {
    return true;
  }

  // 2. Check if job matches any of the user's countries
  for (const code of normalized.codes) {
    if (matchCountryWithStrictFallback(job.country_code || job.country, job.location, code)) {
      return true;
    }
  }

  // 3. Remote with NO country restriction
  if (isRemote && elig !== "country_restricted" && scope !== "onsite") {
    const hasKnownCode = countryCode && countryCode !== "UNKNOWN" && countryCode !== "ALL" && countryCode !== "WW";
    const hasForeignLoc = hasForeignCountryRestriction(loc, normalized.codes);

    if (!hasKnownCode && !hasForeignLoc) {
      return true;
    }
  }

  // 4. Jobs restricted to countries not in the list are excluded
  return false;
}

/**
 * Filters a list of jobs based on the user's location preferences.
 * Returns the eligible jobs, count of filtered out jobs, and appliedEligibility metadata.
 */
export function applyEligibilityFilter<T extends JobEligibilityRecord>(
  jobs: T[],
  userLocations: string[] | null | undefined,
  options?: { filterEnabled?: boolean }
): {
  eligibleJobs: T[];
  filteredOut: number;
  appliedEligibility: { countries: string[]; filteredOut: number } | null;
} {
  if (options?.filterEnabled === false || !Array.isArray(jobs) || jobs.length === 0) {
    return {
      eligibleJobs: jobs || [],
      filteredOut: 0,
      appliedEligibility: null,
    };
  }

  const normalized = normalizeUserCountries(userLocations);

  // Guests and users without locations stay unfiltered
  if (normalized.codes.length === 0) {
    return {
      eligibleJobs: jobs,
      filteredOut: 0,
      appliedEligibility: null,
    };
  }

  const eligibleJobs: T[] = [];
  let filteredOut = 0;

  for (const job of jobs) {
    if (isJobEligible(job, normalized, options)) {
      eligibleJobs.push(job);
    } else {
      filteredOut++;
    }
  }

  return {
    eligibleJobs,
    filteredOut,
    appliedEligibility: {
      countries: normalized.names,
      filteredOut,
    },
  };
}
