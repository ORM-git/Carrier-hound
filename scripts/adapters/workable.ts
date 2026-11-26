import { sourceEmploymentType } from '../utils/sourceEmploymentType';
import { SourceAdapter } from './types';
import { NormalizedJob, SourceConfig } from '../types';
import { politeFetchJson } from '../utils/polite-fetch';
import {
  cleanText,
  cleanAndTruncateDescription,
  detectRemote,
  detectCategory,
  detectSeniority,
  detectCountryCode,
  detectRemoteEligibility,
  normalizeDate,
} from '../utils/sanitizer';

interface WorkableJob {
  id?: string;
  title: string;
  shortcode: string;
  code?: string;
  city?: string;
  country?: string;
  countryCode?: string;
  state?: string;
  department?: string;
  publishedOn?: string;
  published?: string;
  type?: string;
  telecommuting?: boolean;
  url?: string;
  applicationUrl?: string;
  description?: string;
}

interface WorkableResponse {
  jobs?: WorkableJob[];
}

export class WorkableAdapter implements SourceAdapter {
  readonly type = 'workable';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://apply.workable.com/api/v1/widget/accounts/${slug}`;
    const data = await politeFetchJson<WorkableResponse>(url);

    if (!data || !Array.isArray(data.jobs)) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Workable\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return data.jobs
      .filter((j) => j && j.title && (j.shortcode || j.code))
      .map((j): NormalizedJob => {
        const title = cleanText(j.title);
        const locParts = [j.city, j.state, j.country].filter(Boolean);
        const location = locParts.length > 0 ? cleanText(locParts.join(', ')) : 'Unspecified';
        const remote = Boolean(j.telecommuting) || detectRemote(title, location);
        const jobType = sourceEmploymentType(title, j.type);
        const description = cleanAndTruncateDescription(j.description, 4000);
        const postedAt = normalizeDate(j.publishedOn || j.published);
        const category = source.category || detectCategory(title, [j.department || '']);
        const seniority = detectSeniority(title);
        const countryCode = j.countryCode ? j.countryCode.toUpperCase() : detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);
        const jobCode = j.shortcode || j.code;
        const applyUrl = j.applicationUrl || j.url || `https://apply.workable.com/${slug}/j/${jobCode}`;

        return {
          source: 'workable',
          source_type: 'ats',
          source_job_id: `${slug}-${jobCode}`,
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
          source_url: applyUrl,
          salary_text: null,
          salary_min: null,
          salary_max: null,
          currency: 'USD',
          salary_period: 'yearly',
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
