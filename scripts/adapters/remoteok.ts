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
} from '../utils/sanitizer';

interface RemoteOKJob {
  id?: string | number;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
  apply_url?: string;
}

export class RemoteOKAdapter implements SourceAdapter {
  readonly type = 'remoteok';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const url = source.target || 'https://remoteok.com/api';
    const data = await politeFetchJson<any[]>(url);

    if (!Array.isArray(data)) {
      return [];
    }

    // First item is legal notice metadata, filter it out
    const jobs: RemoteOKJob[] = data.filter((item) => item && item.position && item.company);
    const nowIso = new Date().toISOString();

    return jobs
      .filter((j) => j && j.position && j.company && (j.url || j.apply_url))
      .map((j): NormalizedJob => {
        const title = cleanText(j.position);
        const company = cleanText(j.company);
        const location = cleanText(j.location || 'Remote');
        const remote = true; // RemoteOK is 100% remote
        const jobType = detectJobType(title);
        const description = cleanAndTruncateDescription(j.description, 4000);

        const salaryMin = typeof j.salary_min === 'number' && j.salary_min > 0 ? j.salary_min : null;
        const salaryMax = typeof j.salary_max === 'number' && j.salary_max > 0 ? j.salary_max : null;
        let salaryText: string | null = null;
        if (salaryMin && salaryMax) {
          salaryText = `$${(salaryMin / 1000).toFixed(0)}k - $${(salaryMax / 1000).toFixed(0)}k`;
        } else if (salaryMin) {
          salaryText = `From $${(salaryMin / 1000).toFixed(0)}k`;
        }

        const postedAt = normalizeDate(j.date ?? (j.epoch == null ? null : j.epoch * 1000));
        const category = source.category || detectCategory(title, j.tags || []);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);
        const applyUrl = j.apply_url || j.url || `https://remoteok.com/remote-jobs/${j.id}`;

        return {
          source: 'remoteok',
          source_type: 'feed',
          source_job_id: String(j.id || encodeURIComponent(title + company)),
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
          apply_url: applyUrl,
          source_url: j.url || applyUrl,
          salary_text: salaryText,
          salary_min: salaryMin,
          salary_max: salaryMax,
          currency: 'USD',
          salary_period: 'yearly',
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
