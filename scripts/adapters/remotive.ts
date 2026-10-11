import { SourceAdapter } from './types';
import { NormalizedJob, SourceConfig } from '../types';
import { politeFetchJson } from '../utils/polite-fetch';
import {
  cleanText,
  cleanAndTruncateDescription,
  detectJobType,
  detectCategory,
  detectSeniority,
  detectCountryCode,
  detectRemoteEligibility,
  normalizeDate,
  parseSalary,
} from '../utils/sanitizer';

interface RemotiveJob {
  id: number | string;
  url: string;
  title: string;
  company_name: string;
  company_logo?: string;
  category?: string;
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

export class RemotiveAdapter implements SourceAdapter {
  readonly type = 'remotive';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const url = source.target || 'https://remotive.com/api/remote-jobs?limit=100';
    const data = await politeFetchJson<RemotiveResponse>(url);

    if (!data || !Array.isArray(data.jobs)) {
      return [];
    }

    const nowIso = new Date().toISOString();

    return data.jobs
      .filter((j) => j && j.title && j.company_name && j.url)
      .map((j): NormalizedJob => {
        const title = cleanText(j.title);
        const company = cleanText(j.company_name);
        const location = cleanText(j.candidate_required_location || 'Remote');
        const remote = true; // Remotive is 100% remote
        const jobType = detectJobType(title, j.job_type || '');
        const description = cleanAndTruncateDescription(j.description, 4000);
        const salary = j.salary
          ? parseSalary(j.salary, { title, location, isExplicitSalaryField: true })
          : parseSalary(description, { title, location });
        const postedAt = normalizeDate(j.publication_date);
        const category = source.category || detectCategory(title, [j.category || '']);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);

        return {
          source: 'remotive',
          source_type: 'feed',
          source_job_id: String(j.id),
          title,
          company,
          location,
          country_code: countryCode,
          remote,
          remote_scope: 'remote',
          remote_eligibility: remoteEligibility,
          job_type: jobType,
          seniority,
          description,
          apply_url: j.url,
          source_url: j.url,
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
