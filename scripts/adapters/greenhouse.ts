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

interface GreenhouseJob {
  id: number | string;
  title: string;
  absolute_url: string;
  location?: {
    name?: string;
  };
  updated_at?: string;
  content?: string;
  metadata?: Array<{ name: string; value: any }>;
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
}

export class GreenhouseAdapter implements SourceAdapter {
  readonly type = 'greenhouse';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
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
        const salary = parseSalary(description, { title, location });
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
          salary_text: salary.salary_text,
          salary_min: salary.salary_min,
          salary_max: salary.salary_max,
          currency: salary.currency,
          salary_period: salary.salary_period,
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
