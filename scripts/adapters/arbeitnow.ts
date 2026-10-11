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
} from '../utils/sanitizer';

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  location?: string;
  created_at?: number;
  tags?: string[];
  job_types?: string[];
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
}

export class ArbeitnowAdapter implements SourceAdapter {
  readonly type = 'arbeitnow';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const url = source.target || 'https://www.arbeitnow.com/api/job-board-api';
    const data = await politeFetchJson<ArbeitnowResponse>(url);

    if (!data || !Array.isArray(data.data)) {
      return [];
    }

    const nowIso = new Date().toISOString();

    return data.data
      .filter((j) => j && j.title && j.company_name && (j.url || j.slug))
      .map((j): NormalizedJob => {
        const title = cleanText(j.title);
        const company = cleanText(j.company_name);
        const location = cleanText(j.location || (j.remote ? 'Remote' : 'Unspecified'));
        const remote = detectRemote(title, location, j.remote);
        const jobType = detectJobType(title, (j.job_types || []).join(' '));
        const description = cleanAndTruncateDescription(j.description, 4000);
        const salary = parseSalary(description, { title, location });
        const postedAt = j.created_at
          ? new Date(j.created_at * 1000).toISOString()
          : normalizeDate(null);
        const category = source.category || detectCategory(title, j.tags || []);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);
        const applyUrl = j.url || `https://www.arbeitnow.com/jobs/${j.slug}`;

        return {
          source: 'arbeitnow',
          source_type: 'feed',
          source_job_id: j.slug,
          title,
          company,
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
          salary_text: salary.salary_text,
          salary_min: salary.salary_min,
          salary_max: salary.salary_max,
          currency: salary.currency,
          salary_period: salary.salary_period,
          category,
          posted_at: postedAt,
          discovered_at: nowIso,
          last_seen_at: nowIso,
          verified: false,
          verified_at: null,
          is_active: true,
        };
      });
  }
}
