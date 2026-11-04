import { SourceAdapter } from './types';
import { NormalizedJob, SourceConfig } from '../types';
import { politeFetchJson } from '../utils/polite-fetch';
import {
  cleanText,
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

export interface GreenhousePayInputRange {
  min_cents?: number | null;
  max_cents?: number | null;
  currency_type?: string | null;
  title?: string | null;
  blurb?: string | null;
}

export interface GreenhouseJob {
  id: number | string;
  title: string;
  absolute_url: string;
  location?: {
    name?: string;
  };
  updated_at?: string;
  content?: string;
  metadata?: Array<{ name: string; value: any }>;
  pay_input_ranges?: GreenhousePayInputRange[] | null;
}

export interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
}

export class GreenhouseAdapter implements SourceAdapter {
  readonly type = 'greenhouse';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true&pay_transparency=true`;
    const data = await politeFetchJson<GreenhouseResponse>(url);

    if (!data || !Array.isArray(data.jobs)) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Greenhouse\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return data.jobs
      .filter((j) => j && j.title && j.absolute_url)
      .map((j): NormalizedJob => {
        const title = cleanText(j.title);
        const location = cleanText(j.location?.name || 'Unspecified');
        const remote = detectRemote(title, location);
        const jobType = detectJobType(title);
        const description = cleanAndTruncateDescription(j.content, 4000);

        // Structured pay transparency extraction
        let salaryText: string | null = null;
        let salaryMin: number | null = null;
        let salaryMax: number | null = null;
        let currency: string | undefined = undefined;
        let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

        const validRange = Array.isArray(j.pay_input_ranges)
          ? j.pay_input_ranges.find(
              (r) =>
                (r && r.min_cents != null && r.min_cents > 0) ||
                (r && r.max_cents != null && r.max_cents > 0)
            )
          : null;

        if (validRange) {
          const rawMin =
            validRange.min_cents != null && validRange.min_cents > 0
              ? validRange.min_cents / 100
              : null;
          const rawMax =
            validRange.max_cents != null && validRange.max_cents > 0
              ? validRange.max_cents / 100
              : null;

          salaryMin = rawMin != null ? Math.round(rawMin) : null;
          salaryMax = rawMax != null ? Math.round(rawMax) : null;

          if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) {
            const temp = salaryMin;
            salaryMin = salaryMax;
            salaryMax = temp;
          }

          if (validRange.currency_type && validRange.currency_type.trim()) {
            currency = validRange.currency_type.trim().toUpperCase();
          }

          // Greenhouse does not provide a native interval field.
          // Rule: No period guess from title/blurb text alone.
          // Infer only when currency is USD and text explicitly says hour.
          // Otherwise leave period unset (undefined).
          const context = `${validRange.title || ''} ${validRange.blurb || ''}`;
          if (currency === 'USD' && /\b(hour|hourly|\/hr)\b/i.test(context)) {
            salaryPeriod = 'hourly';
          } else {
            salaryPeriod = undefined;
          }

          if (salaryMin != null || salaryMax != null) {
            salaryText = formatSalary(salaryMin, salaryMax, currency || 'USD', salaryPeriod || 'yearly');
          }
        }

        // Fallback to description regex parsing ONLY if no structured range exists
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

        const postedAt = normalizeDate(j.updated_at);
        const category = source.category || detectCategory(title);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);

        return {
          source: 'greenhouse',
          source_type: 'ats',
          source_job_id: `${slug}-${j.id}`,
          title,
          company: companyName,
          company_slug: slug,
          location,
          country_code: countryCode,
          remote,
          remote_scope: remote ? 'remote' : 'onsite',
          remote_eligibility: remoteEligibility,
          job_type: jobType,
          seniority,
          description,
          apply_url: j.absolute_url,
          source_url: `https://boards.greenhouse.io/${slug}`,
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
