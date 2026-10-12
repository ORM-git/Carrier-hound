import realCompanies from "../src/data/companies.json";

/**
 * Real verified companies actively hiring talent across global timezones.
 * Sourced directly from active ingested jobs in the Supabase database.
 * No invented companies or mock hiring counts.
 */
export interface WorldwideCompany {
  id: string;
  name: string;
  jobCount: number;
  slug: string;
  country?: string;
}

export const WORLDWIDE_COMPANIES: WorldwideCompany[] = realCompanies;
