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

export interface AshbyCompensationComponent {
  id?: string;
  summary?: string;
  compensationType?: string; // "Salary", "EquityPercentage", "Bonus"
  interval?: string; // "1 YEAR", "1 HOUR", "1 MONTH", "NONE"
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

export interface AshbyCompensationTier {
  id?: string;
  tierSummary?: string;
  title?: string | null;
  additionalInformation?: string | null;
  components?: AshbyCompensationComponent[];
}

export interface AshbyCompensation {
  compensationTierSummary?: string;
  scrapeableCompensationSalarySummary?: string;
  summary?: string;
  compensationTiers?: AshbyCompensationTier[];
  summaryComponents?: AshbyCompensationComponent[];
}

export interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  department?: string;
  isRemote?: boolean;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: AshbyCompensation;
}

export interface AshbyResponse {
  jobs?: AshbyJob[];
}

export class AshbyAdapter implements SourceAdapter {
  readonly type = 'ashby';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
    const data = await politeFetchJson<AshbyResponse>(url);

    if (!data || !Array.isArray(data.jobs)) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Ashby\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return data.jobs
      .filter((j) => j && j.title && (j.jobUrl || j.applyUrl))
      .map((j): NormalizedJob => {
        const title = cleanText(j.title);
        const location = cleanText(j.location || 'Unspecified');
        const remote = detectRemote(title, location, j.isRemote);
        const jobType = detectJobType(title);
        const rawDesc = j.descriptionPlain || stripHtml(j.descriptionHtml);
        const description = cleanAndTruncateDescription(rawDesc, 4000);

        // Structured compensation extraction
        let salaryText: string | null = null;
        let salaryMin: number | null = null;
        let salaryMax: number | null = null;
        let currency = 'USD';
        let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

        if (j.compensation) {
          // 1. Check structured compensation tiers/components
          const allComponents: AshbyCompensationComponent[] = [];
          if (Array.isArray(j.compensation.compensationTiers)) {
            for (const tier of j.compensation.compensationTiers) {
              if (Array.isArray(tier.components)) {
                allComponents.push(...tier.components);
              }
            }
          }
          if (Array.isArray(j.compensation.summaryComponents)) {
            allComponents.push(...j.compensation.summaryComponents);
          }

          const salaryComponent = allComponents.find(
            (c) =>
              c &&
              typeof c.compensationType === 'string' &&
              c.compensationType.trim().toLowerCase() === 'salary'
          );

          if (salaryComponent) {
            salaryMin =
              salaryComponent.minValue != null && salaryComponent.minValue > 0
                ? Math.round(salaryComponent.minValue)
                : null;
            salaryMax =
              salaryComponent.maxValue != null && salaryComponent.maxValue > 0
                ? Math.round(salaryComponent.maxValue)
                : null;

            if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) {
              const temp = salaryMin;
              salaryMin = salaryMax;
              salaryMax = temp;
            }

            if (salaryComponent.currencyCode && salaryComponent.currencyCode.trim()) {
              currency = salaryComponent.currencyCode.trim().toUpperCase();
            }

            const rawInterval = (salaryComponent.interval || '').toUpperCase();
            if (rawInterval.includes('HOUR')) {
              salaryPeriod = 'hourly';
            } else if (rawInterval.includes('MONTH')) {
              salaryPeriod = 'monthly';
            } else if (rawInterval.includes('YEAR')) {
              salaryPeriod = 'yearly';
            } else {
              // Interval is missing or unmapped
              // Infer only when currency is USD and text says hour
              const textContext = `${j.compensation.compensationTierSummary || ''} ${j.compensation.summary || ''} ${j.title || ''}`;
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

          // 2. If no numeric components found, check compensation summary strings
          if (!salaryText && salaryMin == null && salaryMax == null) {
            const compSummary =
              j.compensation.scrapeableCompensationSalarySummary ||
              j.compensation.compensationTierSummary ||
              j.compensation.summary ||
              '';
            if (compSummary) {
              const parsed = parseSalary(compSummary, {
                title,
                location,
                isExplicitSalaryField: true,
              });
              salaryText = parsed.salary_text;
              salaryMin = parsed.salary_min;
              salaryMax = parsed.salary_max;
              currency = parsed.currency;
              salaryPeriod = parsed.salary_period;
            }
          }
        }

        // 3. Fallback to description regex parsing if no compensation found
        if (!salaryText && salaryMin == null && salaryMax == null) {
          const fallback = parseSalary(description, { title, location });
          salaryText = fallback.salary_text;
          salaryMin = fallback.salary_min;
          salaryMax = fallback.salary_max;
          currency = fallback.currency;
          salaryPeriod = fallback.salary_period;
        }

        const postedAt = normalizeDate(j.publishedAt);
        const category = source.category || detectCategory(title, [j.department || '']);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);

        const applyUrl = j.applyUrl || j.jobUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`;

        return {
          source: 'ashby',
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
          apply_url: applyUrl,
          source_url: j.jobUrl || `https://jobs.ashbyhq.com/${slug}`,
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
