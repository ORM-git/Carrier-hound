export interface UserPreferences {
  roles: string[];
  categories: string[];
  experienceLevel?: "intern" | "entry" | "mid" | "senior" | "lead" | string;
  employmentTypes: string[]; // ['full-time', 'contract', 'internship']
  locations: string[];
  remotePreference: "remote" | "hybrid" | "onsite" | "any";
  workAuth?: string;
  country?: string;
  countryCode?: string;
  minSalary?: number;
  salaryCurrency?: string; // 'USD', 'INR', 'EUR', 'GBP'
  dailyDigestOptIn: boolean;
  onboardingCompleted: boolean;
  eligibilityFilter?: boolean;
  updatedAt: string;
}

/**
 * Blank preferences for an account that has saved nothing yet. New users start
 * here: no roles, no experience level, no salary, no work authorization.
 * Never persisted on read; only an explicit save writes a row.
 */
export function emptyUserPreferences(): UserPreferences {
  return {
    roles: [],
    categories: [],
    employmentTypes: [],
    locations: [],
    remotePreference: "any",
    dailyDigestOptIn: false,
    onboardingCompleted: false,
    eligibilityFilter: true,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Legacy sample preferences. Do NOT seed these into the DB or use them as a
 * fallback for real users; kept only as a negative-control fixture in tests.
 */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  roles: ["Software Engineer", "Frontend Developer", "Full Stack Developer"],
  categories: ["engineering", "tech"],
  experienceLevel: "mid",
  employmentTypes: ["full-time"],
  locations: ["Remote / Global"],
  remotePreference: "remote",
  workAuth: "Authorized",
  minSalary: 80000,
  salaryCurrency: "USD",
  dailyDigestOptIn: false,
  onboardingCompleted: false,
  eligibilityFilter: true,
  updatedAt: new Date().toISOString(),
};
