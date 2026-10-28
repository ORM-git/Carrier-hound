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

interface BambooHRJob {
  id?: string | number;
  jobOpeningId?: string | number;
  jobOpeningName?: string;
  title?: string;
  location?: {
    city?: string;
    state?: string;
    country?: string;
  };
  locationType?: string;
  isRemote?: boolean;
  department?: string;
  createdDate?: string;
  description?: string;
}

interface BambooHRResponse {
  result?: BambooHRJob[];
  jobs?: BambooHRJob[];
}

export class BambooHRAdapter implements SourceAdapter {
  readonly type = 'bamboohr';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://${slug}.bamboohr.com/careers/list`;
    const data = await politeFetchJson<BambooHRResponse | BambooHRJob[]>(url);

    if (!data) return [];

    const rawList: BambooHRJob[] = Array.isArray(data)
      ? data
      : Array.isArray(data.result)
      ? data.result
      : Array.isArray(data.jobs)
      ? data.jobs
      : [];

    const companyName = source.name.replace(/\s*\(BambooHR\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return rawList
      .filter((j) => j && (j.jobOpeningName || j.title) && (j.id || j.jobOpeningId))
      .map((j): NormalizedJob => {
        const jobId = String(j.id || j.jobOpeningId);
        const title = cleanText(j.jobOpeningName || j.title || '');
        const locParts = [j.location?.city, j.location?.state, j.location?.country].filter(Boolean);
        const location = cleanText(locParts.join(', ') || 'Unspecified');
        const remote = Boolean(j.isRemote) || j.locationType === 'remote' || detectRemote(title, location);
        const countryCode = detectCountryCode(location);
        const applyUrl = `https://${slug}.bamboohr.com/careers/${jobId}`;

        return {
          source: 'bamboohr',
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
          job_type: detectJobType(title),
          seniority: detectSeniority(title),
          description: cleanAndTruncateDescription(j.description, 1500),
          apply_url: applyUrl,
          source_url: `https://${slug}.bamboohr.com/careers`,
          category: detectCategory(title),
          posted_at: j.createdDate ? new Date(j.createdDate).toISOString() : nowIso,
          discovered_at: nowIso,
          last_seen_at: nowIso,
          verified: true,
          is_active: true,
        };
      });
  }
}
