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

export interface AshbySecondaryLocation {
  location?: string;
  address?: {
    postalAddress?: {
      addressCountry?: string;
      addressLocality?: string;
      addressRegion?: string;
    };
  };
}

export interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: Array<AshbySecondaryLocation | string>;
  department?: string;
  isRemote?: boolean;
  isListed?: boolean;
  workplaceType?: string; // 'Remote', 'Hybrid', 'OnSite'
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
      // Ashby correctness: exclude unlisted jobs (isListed === false)
      .filter((j) => j && j.title && j.isListed !== false && (j.jobUrl || j.applyUrl))
      .map((j): NormalizedJob => {
        const title = cleanText(j.title);

        // Preserve primary and secondary locations
        const primaryLoc = cleanText(j.location || '');
        const secondaryLocs: string[] = [];
        if (Array.isArray(j.secondaryLocations)) {
          for (const sec of j.secondaryLocations) {
            const secLocStr = typeof sec === 'string' ? sec : sec?.location;
            if (secLocStr) {
              const cleaned = cleanText(secLocStr);
              if (cleaned && !secondaryLocs.includes(cleaned) && cleaned !== primaryLoc) {
                secondaryLocs.push(cleaned);
              }
            }
          }
        }
        const allLocs = [primaryLoc, ...secondaryLocs].filter(Boolean);
        const location = allLocs.length > 0 ? allLocs.join('; ') : 'Unspecified';

        // Distinguish workplaceType (Remote vs Hybrid vs OnSite)
        // Ashby sets isRemote: true for both Remote and Hybrid; distinguish them authoritatively
        const wp = (j.workplaceType || '').trim().toLowerCase();
        let remote = false;
        let remoteScope: 'remote' | 'hybrid' | 'onsite' = 'onsite';

        if (wp === 'hybrid') {
          remote = false;
          remoteScope = 'hybrid';
        } else if (wp === 'remote') {
          remote = true;
          remoteScope = 'remote';
        } else if (wp === 'onsite' || wp === 'on-site') {
          remote = false;
          remoteScope = 'onsite';
        } else {
          remote = detectRemote(title, location, j.isRemote);
          remoteScope = remote ? 'remote' : 'onsite';
        }

        const jobType = detectJobType(title);
        const rawDesc = j.descriptionPlain || stripHtml(j.descriptionHtml);
        const description = cleanAndTruncateDescription(rawDesc, 4000);

        // Structured compensation extraction
        let salaryText: string | null = null;
        let salaryMin: number | null = null;
        let salaryMax: number | null = null;
        let currency: string | undefined = undefined;
        let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

        if (j.compensation && typeof j.compensation === 'object') {
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

          // Count only valid numeric disclosed ranges (do not count empty compensation objects)
          const salaryComponent = allComponents.find(
            (c) =>
              c &&
              typeof c.compensationType === 'string' &&
              c.compensationType.trim().toLowerCase() === 'salary' &&
              ((c.minValue != null && c.minValue > 0) || (c.maxValue != null && c.maxValue > 0))
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
              // Interval is missing or unmapped: infer only if currency is USD and text says hour
              const textContext = `${j.compensation.compensationTierSummary || ''} ${j.compensation.summary || ''} ${j.title || ''}`;
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
              if (parsed.salary_min != null || parsed.salary_max != null) {
                salaryText = parsed.salary_text;
                salaryMin = parsed.salary_min;
                salaryMax = parsed.salary_max;
                currency = parsed.currency;
                salaryPeriod = parsed.salary_period;
              }
            }
          }
        }

        // 3. Fallback to description regex parsing ONLY if no structured compensation exists
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
          remote_scope: remoteScope,
          remote_eligibility: remoteEligibility,
          job_type: jobType,
          seniority,
          description,
          apply_url: applyUrl,
          source_url: j.jobUrl || `https://jobs.ashbyhq.com/${slug}`,
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
