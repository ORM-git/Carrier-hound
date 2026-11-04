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

export interface SmartRecruitersJob {
  id: string;
  name: string;
  uuid?: string;
  refNumber?: string;
  company?: {
    name?: string;
    identifier?: string;
  };
  location?: {
    city?: string;
    region?: string;
    country?: string;
    remote?: boolean;
    hybrid?: boolean;
    fullLocation?: string;
  };
  typeOfEmployment?: {
    id?: string;
    label?: string;
  };
  experienceLevel?: {
    id?: string;
    label?: string;
  };
  releasedDate?: string;
  creator?: {
    name?: string;
  };
  function?: {
    id?: string;
    label?: string;
  };
  department?: {
    id?: string;
    label?: string;
  };
  ref?: string;
}

export interface SmartRecruitersResponse {
  totalFound?: number;
  offset?: number;
  limit?: number;
  content?: SmartRecruitersJob[];
}

export interface SmartRecruitersCompensation {
  min?: number | null;
  max?: number | null;
  currency?: string | null;
  period?: string | null; // e.g. "YEARLY", "MONTHLY", "HOURLY"
}

export interface SmartRecruitersPostingDetail {
  id: string;
  name?: string;
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: {
    sections?: {
      companyDescription?: { title?: string; text?: string };
      jobDescription?: { title?: string; text?: string };
      qualifications?: { title?: string; text?: string };
      additionalInformation?: { title?: string; text?: string };
    };
  };
  compensation?: SmartRecruitersCompensation;
  location?: {
    city?: string;
    region?: string;
    country?: string;
    remote?: boolean;
    hybrid?: boolean;
    fullLocation?: string;
  };
}

/**
 * In-memory bounded LRU-style cache for SmartRecruiters posting details.
 * Prevents redundant detail fetches across pagination, dry-plan, and audit sweeps.
 */
const DETAIL_CACHE = new Map<string, SmartRecruitersPostingDetail>();
const MAX_CACHE_ENTRIES = 1000;

function getCachedDetail(cacheKey: string): SmartRecruitersPostingDetail | undefined {
  return DETAIL_CACHE.get(cacheKey);
}

function setCachedDetail(cacheKey: string, detail: SmartRecruitersPostingDetail): void {
  if (DETAIL_CACHE.size >= MAX_CACHE_ENTRIES) {
    const firstKey = DETAIL_CACHE.keys().next().value;
    if (firstKey) DETAIL_CACHE.delete(firstKey);
  }
  DETAIL_CACHE.set(cacheKey, detail);
}

export class SmartRecruitersAdapter implements SourceAdapter {
  readonly type = 'smartrecruiters';

  /**
   * Maximum detailed posting lookups per board run to stay bounded within request budgets.
   * Jobs beyond this bound gracefully fall back to list metadata and verified job link.
   */
  maxDetailFetchesPerBoard: number = 50;

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const limit = 100;
    let offset = 0;
    let totalFound: number | null = null;
    const allListJobs: SmartRecruitersJob[] = [];
    const MAX_PAGES = 50; // Safety cap: max 5,000 jobs per company board
    let pageCount = 0;

    // Paginate through listings using offset and totalFound
    while (pageCount < MAX_PAGES) {
      pageCount++;
      const listUrl = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${limit}&offset=${offset}`;
      const data = await politeFetchJson<SmartRecruitersResponse>(listUrl);

      if (!data || !Array.isArray(data.content) || data.content.length === 0) {
        break;
      }

      allListJobs.push(...data.content);

      if (typeof data.totalFound === 'number') {
        totalFound = data.totalFound;
      }

      offset += data.content.length;

      // Stop condition: collected all postings according to totalFound or received partial page
      if (totalFound != null && allListJobs.length >= totalFound) {
        break;
      }
      if (data.content.length < limit) {
        break;
      }
    }

    if (allListJobs.length === 0) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(SmartRecruiters\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    const validJobs = allListJobs.filter((j) => j && j.name && j.id);

    // Bounded cached detail fetching: fetch details up to maxDetailFetchesPerBoard
    let detailFetchesCount = 0;
    const detailMap = new Map<string, SmartRecruitersPostingDetail>();

    for (const j of validJobs) {
      const cacheKey = `${slug}:${j.id}`;
      const cached = getCachedDetail(cacheKey);
      if (cached) {
        detailMap.set(j.id, cached);
      } else if (detailFetchesCount < this.maxDetailFetchesPerBoard) {
        detailFetchesCount++;
        try {
          const detailUrl = `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${j.id}`;
          const detail = await politeFetchJson<SmartRecruitersPostingDetail>(detailUrl);
          if (detail && detail.id) {
            setCachedDetail(cacheKey, detail);
            detailMap.set(j.id, detail);
          }
        } catch {
          // Graceful fallback: detail fetch failure leaves detailMap empty for this job
        }
      }
    }

    return validJobs.map((j): NormalizedJob => {
      const title = cleanText(j.name);
      const detail = detailMap.get(j.id);

      // Location resolution: detail takes precedence if richer
      const locObj = detail?.location || j.location;
      const locParts = [locObj?.city, locObj?.region, locObj?.country].filter(Boolean);
      const location = locParts.length > 0 ? cleanText(locParts.join(', ')) : 'Unspecified';

      // Workplace / Remote detection
      const isHybrid = Boolean(locObj?.hybrid);
      const isRemote = Boolean(locObj?.remote);
      let remote = false;
      let remoteScope: 'remote' | 'hybrid' | 'onsite' = 'onsite';

      if (isHybrid) {
        remote = false;
        remoteScope = 'hybrid';
      } else if (isRemote) {
        remote = true;
        remoteScope = 'remote';
      } else {
        remote = detectRemote(title, location);
        remoteScope = remote ? 'remote' : 'onsite';
      }

      const jobType = detectJobType(title, j.typeOfEmployment?.label || '');
      const postedAt = normalizeDate(j.releasedDate);
      const category =
        source.category ||
        detectCategory(title, [j.function?.label || '', j.department?.label || '']);
      const seniority = detectSeniority(title);
      const countryCode = locObj?.country ? locObj.country.toUpperCase() : detectCountryCode(location);
      const remoteEligibility = detectRemoteEligibility(location, remote);

      // Apply URL & Source URL: prefer documented employer applyUrl and postingUrl
      const fallbackUrl = `https://jobs.smartrecruiters.com/${slug}/${j.id}`;
      const applyUrl = detail?.applyUrl || detail?.postingUrl || fallbackUrl;
      const sourceUrl = detail?.postingUrl || detail?.applyUrl || fallbackUrl;

      // Real description from jobAd sections
      let description: string;
      if (detail?.jobAd?.sections) {
        const sec = detail.jobAd.sections;
        const sectionsText = [
          sec.companyDescription?.text,
          sec.jobDescription?.text,
          sec.qualifications?.text,
          sec.additionalInformation?.text,
        ].filter(Boolean).join('\n\n');
        description = sectionsText ? cleanAndTruncateDescription(sectionsText, 4000) : `${title} at ${companyName}`;
      } else {
        description = `${title} at ${companyName}`;
      }

      // Structured salary extraction
      let salaryText: string | null = null;
      let salaryMin: number | null = null;
      let salaryMax: number | null = null;
      let currency: string | undefined = undefined;
      let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

      if (detail?.compensation && typeof detail.compensation === 'object') {
        const rawComp = detail.compensation;
        const minVal = typeof rawComp.min === 'number' && rawComp.min > 0 ? Math.round(rawComp.min) : null;
        const maxVal = typeof rawComp.max === 'number' && rawComp.max > 0 ? Math.round(rawComp.max) : null;

        if (minVal != null || maxVal != null) {
          salaryMin = minVal;
          salaryMax = maxVal;
          if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) {
            salaryMin = maxVal;
            salaryMax = minVal;
          }

          if (rawComp.currency && rawComp.currency.trim()) {
            currency = rawComp.currency.trim().toUpperCase();
          }

          const rawPeriod = (rawComp.period || '').toLowerCase();
          if (rawPeriod.includes('hour')) {
            salaryPeriod = 'hourly';
          } else if (rawPeriod.includes('month')) {
            salaryPeriod = 'monthly';
          } else if (rawPeriod.includes('year') || rawPeriod.includes('annu')) {
            salaryPeriod = 'yearly';
          } else {
            salaryPeriod = undefined;
          }

          if (currency) {
            salaryText = formatSalary(salaryMin, salaryMax, currency, salaryPeriod || 'yearly');
          }
        }
      }

      // Fallback to description regex parsing if no structured compensation exists
      if (!salaryText && salaryMin == null && salaryMax == null && description !== `${title} at ${companyName}`) {
        const fallback = parseSalary(description, { title, location });
        if (fallback.salary_min != null || fallback.salary_max != null) {
          salaryText = fallback.salary_text;
          salaryMin = fallback.salary_min;
          salaryMax = fallback.salary_max;
          currency = fallback.currency;
          salaryPeriod = fallback.salary_period;
        }
      }

      return {
        source: 'smartrecruiters',
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
        source_url: sourceUrl,
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
