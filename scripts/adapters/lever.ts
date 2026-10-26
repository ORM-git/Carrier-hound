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
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const data = await politeFetchJson<LeverJob[]>(url);

    if (!Array.isArray(data)) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Lever\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return data
      .filter((j) => j && j.text && (j.applyUrl || j.hostedUrl))
      .map((j): NormalizedJob => {
        const title = cleanText(j.text);
        const location = cleanText(j.categories?.location || 'Unspecified');
        const isRemoteWorkplace = j.workplaceType === 'remote';
        const remote = isRemoteWorkplace || detectRemote(title, location);
        const jobType = detectJobType(title, j.categories?.commitment || '');
        const rawDesc = j.descriptionPlain || stripHtml(j.description);
        const description = cleanAndTruncateDescription(rawDesc, 4000);

        // Structured salaryRange extraction
        let salaryText: string | null = null;
        let salaryMin: number | null = null;
        let salaryMax: number | null = null;
        let currency = 'USD';
        let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

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
            // Interval is missing or unmapped
            // Infer only when currency is USD and text says hour
            const textContext = `${j.text || ''}`;
            if (currency === 'USD' && /\b(hour|hourly|\/hr)\b/i.test(textContext)) {
              salaryPeriod = 'hourly';
            } else {
              salaryPeriod = undefined;
            }
          }

          if (salaryMin != null || salaryMax != null) {
            salaryText = formatSalary(salaryMin, salaryMax, currency, salaryPeriod);
          }
        }

        // Fallback to description regex parsing if no structured salaryRange exists
        if (!salaryText && salaryMin == null && salaryMax == null) {
          const fallback = parseSalary(description, { title, location });
          salaryText = fallback.salary_text;
          salaryMin = fallback.salary_min;
          salaryMax = fallback.salary_max;
          currency = fallback.currency;
          salaryPeriod = fallback.salary_period;
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
          remote_scope: remote ? 'remote' : j.workplaceType === 'hybrid' ? 'hybrid' : 'onsite',
          remote_eligibility: remoteEligibility,
          job_type: jobType,
          seniority,
          description,
          apply_url: j.applyUrl || j.hostedUrl,
          source_url: j.hostedUrl || `https://jobs.lever.co/${slug}`,
          salary_text: salaryText,
          salary_min: salaryMin,
          salary_max: salaryMax,
          currency,
          salary_period: salaryPeriod,
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
