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
} from '../utils/sanitizer';

interface JoinJob {
  id?: string | number;
  uuid?: string;
  title: string;
  city?: string;
  location?: string;
  remote?: boolean;
  isRemote?: boolean;
  employmentType?: string;
  publishedAt?: string;
  createdAt?: string;
  description?: string;
  url?: string;
}

interface JoinResponse {
  jobs?: JoinJob[];
}

export class JoinAdapter implements SourceAdapter {
  readonly type = 'join';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://join.com/api/companies/${slug}`;
    const data = await politeFetchJson<JoinResponse | JoinJob[]>(url);

    if (!data) return [];

    const rawList: JoinJob[] = Array.isArray(data)
      ? data
      : Array.isArray(data.jobs)
      ? data.jobs
      : [];

    const companyName = source.name.replace(/\s*\(Join\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return rawList
      .filter((j) => j && j.title && (j.id || j.uuid))
      .map((j): NormalizedJob => {
        const jobId = String(j.id || j.uuid);
        const title = cleanText(j.title);
        const location = cleanText(j.city || j.location || 'Unspecified');
        const remote = Boolean(j.remote || j.isRemote) || detectRemote(title, location);
        const countryCode = detectCountryCode(location);
        const applyUrl = j.url && j.url.startsWith('https://')
          ? j.url
          : `https://join.com/companies/${slug}/${jobId}`;

        return {
          source: 'join',
          source_type: 'ats',
          source_job_id: `${slug}-${jobId}`,
          title,
          company: companyName,
          company_slug: slug,
          location,
          country_code: countryCode,
          remote,
          remote_scope: remote ? 'remote' : 'onsite',
          remote_eligibility: detectRemoteEligibility(location, remote),
          job_type: detectJobType(title, j.employmentType || ''),
          seniority: detectSeniority(title),
          description: cleanAndTruncateDescription(j.description, 1500),
          apply_url: applyUrl,
          source_url: `https://join.com/companies/${slug}`,
          category: detectCategory(title),
          posted_at: j.publishedAt || j.createdAt || nowIso,
          discovered_at: nowIso,
          last_seen_at: nowIso,
          verified: true,
          is_active: true,
        };
      });
  }
}
