/**
 * Caps jobs per company (maxPerCompany in any visible topWindow).
 * Prevents mass postings from one employer from flooding the recommended list.
 *
 * Uses company_id as primary cap key so unrevealed company names ("Verified Employer")
 * are correctly identified and capped without leaking company names to free users.
 *
 * Never drops jobs: always returns topItems plus deferredItems.
 */
export function capJobsPerCompany<
  T extends {
    company?: string | null;
    company_id?: string | null;
    companyId?: string | null;
  }
>(
  jobs: T[],
  maxPerCompany: number = 3,
  topWindow: number = 30
): T[] {
  if (!Array.isArray(jobs) || jobs.length === 0) return jobs;

  const topItems: T[] = [];
  const deferredItems: T[] = [];
  const companyCounts = new Map<string, number>();

  for (const job of jobs) {
    const rawCompanyId = (job.company_id || job.companyId || "").trim();
    const rawCompanyName = (job.company || "").trim();

    // Priority 1: company_id as primary cap key
    let compKey = rawCompanyId.toLowerCase();
    // Priority 2: company name fallback only when real name is revealed
    if (
      !compKey &&
      rawCompanyName &&
      rawCompanyName.toLowerCase() !== "verified employer" &&
      rawCompanyName.toLowerCase() !== "confidential employer"
    ) {
      compKey = rawCompanyName.toLowerCase();
    }

    // If neither company_id nor a real company name is available, place directly
    if (!compKey) {
      if (topItems.length < topWindow) {
        topItems.push(job);
      } else {
        deferredItems.push(job);
      }
      continue;
    }

    const currentCount = companyCounts.get(compKey) || 0;
    if (currentCount < maxPerCompany && topItems.length < topWindow) {
      companyCounts.set(compKey, currentCount + 1);
      topItems.push(job);
    } else {
      deferredItems.push(job);
    }
  }

  // Never drop jobs: always return topItems plus deferredItems
  return [...topItems, ...deferredItems];
}
