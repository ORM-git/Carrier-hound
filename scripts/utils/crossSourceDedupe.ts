/**
 * Cross-source dedupe against rows already in the database (Backend sheet rank 98).
 *
 * scripts/ingest.ts de-duplicates Tier 1 (ATS) vs Tier 2 (aggregator feed) roles
 * only inside one run. A feed job whose role (company + title + country) is
 * already active in the DB from a verified ATS source would still be inserted as
 * a second row. `dropFeedJobsAlreadyCoveredByAts` removes those feed jobs before
 * upsert. It never touches ATS jobs, and it FAILS OPEN: on any query error
 * every job is kept (ingest must not lose data because a check failed).
 */

import { slugify } from "./sanitizer";

export interface DedupeJob {
  company: string;
  title: string;
  country_code?: string | null;
}

/** Same key shape scripts/ingest.ts uses for the in-run ATS vs feed check. */
export function roleDedupeKey(job: DedupeJob): string {
  return `${slugify(job.company)}::${slugify(job.title)}::${job.country_code || "any"}`;
}

const COMPANY_CHUNK = 50;

export async function dropFeedJobsAlreadyCoveredByAts<T extends DedupeJob>(
  supabase: any,
  jobs: T[]
): Promise<{ kept: T[]; dropped: number; checked: boolean }> {
  if (!supabase || jobs.length === 0) return { kept: jobs.slice(), dropped: 0, checked: false };
  try {
    const companies: string[] = [];
    const seenCompany: Record<string, boolean> = {};
    jobs.forEach((j) => {
      if (j.company && !seenCompany[j.company]) {
        seenCompany[j.company] = true;
        companies.push(j.company);
      }
    });

    const atsKeys: Record<string, boolean> = {};
    for (let i = 0; i < companies.length; i += COMPANY_CHUNK) {
      const slice = companies.slice(i, i + COMPANY_CHUNK);
      const { data, error } = await supabase
        .from("jobs")
        .select("company, title, country_code")
        .in("company", slice)
        .eq("is_active", true)
        .eq("verified", true);
      if (error) return { kept: jobs.slice(), dropped: 0, checked: false };
      if (Array.isArray(data)) {
        data.forEach((row: DedupeJob) => {
          atsKeys[roleDedupeKey(row)] = true;
        });
      }
    }

    const kept: T[] = [];
    let dropped = 0;
    jobs.forEach((j) => {
      if (atsKeys[roleDedupeKey(j)]) dropped++;
      else kept.push(j);
    });
    return { kept, dropped, checked: true };
  } catch {
    return { kept: jobs.slice(), dropped: 0, checked: false };
  }
}
