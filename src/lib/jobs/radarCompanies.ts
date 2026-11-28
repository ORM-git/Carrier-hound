/**
 * jobs_public masks the employer as the placeholder "Verified Employer" (supabase/migrations/20261010_lock_paid_jobs_data.sql).
 * The placeholder is not a company and says nothing about verification, so Radar must not list it as a top company.
 */
export const MASKED_COMPANY_PLACEHOLDER = "Verified Employer";

export function radarCompanyName(company: unknown): string | null {
  if (typeof company !== "string") return null;
  const name = company.trim();
  return name && name !== MASKED_COMPANY_PLACEHOLDER ? name : null;
}
