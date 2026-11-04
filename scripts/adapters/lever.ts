import { SourceAdapter } from './types';
import { NormalizedJob, SourceConfig } from '../types';
import { politeFetchJson } from '../utils/polite-fetch';
import {
  cleanText,
  stripHtml,
  cleanAndTruncateDescription,
  detectRemote,
  detectJobType,
  detectCategory,
  detectSeniority,
  detectCountryCode,
  detectRemoteEligibility,
  normalizeDate,
  parseSalary,
  formatSalary,
} from '../utils/sanitizer';

export interface LeverSalaryRange {
  min?: number | null;
  max?: number | null;
  currency?: string | null;
  interval?: string | null; // e.g. "per-year-salary", "per-hour-wage", "per-month-salary"
}

export interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  categories?: {
    location?: string;
    commitment?: string;
    team?: string;
    department?: string;
    allLocations?: string[];
  };
  descriptionPlain?: string;
  description?: string;
  workplaceType?: string; // 'remote', 'hybrid', 'on-site'
  salaryRange?: LeverSalaryRange | null;
  salaryDescription?: string;
  salaryDescriptionPlain?: string;
}

export class LeverAdapter implements SourceAdapter {
  readonly type = 'lever';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const limit = 100;
    let skip = 0;
    const allJobs: LeverJob[] = [];
    const MAX_PAGES = 50; // Safety cap: max 5,000 jobs per board
    let pageCount = 0;

    // Check global host first; fallback to EU host (api.eu.lever.co) if global returns non-array/404
    let activeHost = 'https://api.lever.co';
    let firstUrl = `${activeHost}/v0/postings/${slug}?mode=json&limit=${limit}&skip=${skip}`;
    let pageData: LeverJob[] | null = null;
    try {
      pageData = await politeFetchJson<LeverJob[]>(firstUrl);
    } catch {
      // Global host failed/404, attempt EU host fallback
      activeHost = 'https://api.eu.lever.co';
      firstUrl = `${activeHost}/v0/postings/${slug}?mode=json&limit=${limit}&skip=${skip}`;
      try {
        pageData = await politeFetchJson<LeverJob[]>(firstUrl);
      } catch {
        pageData = null;
      }
    }

    if (!Array.isArray(pageData) && activeHost !== 'https://api.eu.lever.co') {
      activeHost = 'https://api.eu.lever.co';
      firstUrl = `${activeHost}/v0/postings/${slug}?mode=json&limit=${limit}&skip=${skip}`;
      try {
        pageData = await politeFetchJson<LeverJob[]>(firstUrl);
      } catch {
        pageData = null;
      }
    }

    // Paginate through postings: do not assume boards are capped at 100
    while (Array.isArray(pageData) && pageData.length > 0 && pageCount < MAX_PAGES) {
      pageCount++;
      allJobs.push(...pageData);

      if (pageData.length < limit) {
        break; // Board exhausted
      }

      skip += pageData.length;
      const nextUrl = `${activeHost}/v0/postings/${slug}?mode=json&limit=${limit}&skip=${skip}`;
      pageData = await politeFetchJson<LeverJob[]>(nextUrl);
    }

    if (allJobs.length === 0) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Lever\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return allJobs
      .filter((j) => j && j.text && (j.applyUrl || j.hostedUrl))
      .map((j): NormalizedJob => {
        const title = cleanText(j.text);

        // Preserve primary and secondary locations (allLocations)
        const primaryLoc = cleanText(j.categories?.location || '');
        const secondaryLocs = Array.isArray(j.categories?.allLocations)
          ? j.categories.allLocations.map((l) => cleanText(l)).filter((l) => l && l !== primaryLoc)
          : [];
        const combinedLocs = [primaryLoc, ...secondaryLocs].filter(Boolean);
        const location = combinedLocs.length > 0 ? combinedLocs.join('; ') : 'Unspecified';

        // Distinguish workplaceType (remote, hybrid, on-site)
        const wp = (j.workplaceType || '').trim().toLowerCase();
        let remote = false;
        let remoteScope: 'remote' | 'hybrid' | 'onsite' = 'onsite';

        if (wp === 'hybrid') {
          remote = false;
          remoteScope = 'hybrid';
        } else if (wp === 'remote') {
          remote = true;
          remoteScope = 'remote';
        } else if (wp === 'on-site' || wp === 'onsite') {
          remote = false;
          remoteScope = 'onsite';
        } else {
          remote = detectRemote(title, location);
          remoteScope = remote ? 'remote' : 'onsite';
        }

        const jobType = detectJobType(title, j.categories?.commitment || '');
        const rawDesc = j.descriptionPlain || stripHtml(j.description);
        const description = cleanAndTruncateDescription(rawDesc, 4000);

        // Structured salaryRange extraction
        let salaryText: string | null = null;
        let salaryMin: number | null = null;
        let salaryMax: number | null = null;
        let currency: string | undefined = undefined;
        let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

        // Reject empty or zero compensation objects
        if (
          j.salaryRange &&
          ((j.salaryRange.min != null && j.salaryRange.min > 0) ||
            (j.salaryRange.max != null && j.salaryRange.max > 0))
        ) {
          salaryMin =
            j.salaryRange.min != null && j.salaryRange.min > 0
              ? Math.round(j.salaryRange.min)
              : null;
          salaryMax =
            j.salaryRange.max != null && j.salaryRange.max > 0
              ? Math.round(j.salaryRange.max)
              : null;

          if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) {
            const temp = salaryMin;
            salaryMin = salaryMax;
            salaryMax = temp;
          }

          if (j.salaryRange.currency && j.salaryRange.currency.trim()) {
            currency = j.salaryRange.currency.trim().toUpperCase();
          }

          const rawInterval = (j.salaryRange.interval || '').toLowerCase();
          if (rawInterval.includes('hour') || rawInterval.includes('wage')) {
            salaryPeriod = 'hourly';
          } else if (rawInterval.includes('month')) {
            salaryPeriod = 'monthly';
          } else if (rawInterval.includes('year') || rawInterval.includes('annual')) {
            salaryPeriod = 'yearly';
          } else {
            // Interval is missing or unmapped: infer only if currency is USD and text says hour
            const textContext = `${j.text || ''}`;
            if (currency === 'USD' && /\b(hour|hourly|\/hr)\b/i.test(textContext)) {
              salaryPeriod = 'hourly';
            } else {
              salaryPeriod = undefined;
            }
          }

          if (salaryMin != null || salaryMax != null) {
            salaryText = formatSalary(salaryMin, salaryMax, currency || 'USD', salaryPeriod || 'yearly');
          }
        }

        // Fallback to description regex parsing ONLY if no structured salaryRange exists
        if (!salaryText && salaryMin == null && salaryMax == null) {
          const fallback = parseSalary(description, { title, location });
          if (fallback.salary_min != null || fallback.salary_max != null) {
            salaryText = fallback.salary_text;
            salaryMin = fallback.salary_min;
            salaryMax = fallback.salary_max;
            currency = fallback.currency;
            salaryPeriod = fallback.salary_period;
          }
        }

        const postedAt = j.createdAt ? new Date(j.createdAt).toISOString() : normalizeDate(null);
        const category =
          source.category ||
          detectCategory(title, [j.categories?.team || '', j.categories?.department || '']);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);

        return {
          source: 'lever',
          source_type: 'ats',
          source_job_id: `${slug}-${j.id}`,
          title,
          company: companyName,
          company_slug: slug,
          location,
          country_code: countryCode,
          remote,
          remote_scope: remoteScope,
          remote_eligibility: remoteEligibility,
          job_type: jobType,
          seniority,
          description,
          apply_url: j.applyUrl || j.hostedUrl,
          source_url: j.hostedUrl || `${activeHost.replace('api.', 'jobs.')}/${slug}`,
          salary_text: salaryText,
          salary_min: salaryMin,
          salary_max: salaryMax,
          currency: (salaryMin != null || salaryMax != null) ? currency : undefined,
          salary_period: (salaryMin != null || salaryMax != null) ? salaryPeriod : undefined,
          category,
          posted_at: postedAt,
          discovered_at: nowIso,
          last_seen_at: nowIso,
          verified: true,
          verified_at: nowIso,
          is_active: true,
        };
      });
  }
}
