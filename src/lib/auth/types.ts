export interface UserPreferences {
  roles: string[];
  categories: string[];
  experienceLevel: "intern" | "entry" | "mid" | "senior" | "lead";
  employmentTypes: string[]; // ['full-time', 'contract', 'internship']
  locations: string[];
  remotePreference: "remote" | "hybrid" | "onsite" | "any";
  workAuth?: string;
  minSalary?: number;
  salaryCurrency: string; // 'USD', 'INR', 'EUR', 'GBP'
  dailyDigestOptIn: boolean;
  onboardingCompleted: boolean;
  eligibilityFilter?: boolean;
  updatedAt: string;
}

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
  dailyDigestOptIn: true,
  onboardingCompleted: false,
  eligibilityFilter: true,
  updatedAt: new Date().toISOString(),
};
