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
} from '../utils/sanitizer';

export interface BreezyJob {
  id: string;
  name: string;
  friendly_id?: string;
  url?: string;
  type?: {
    id?: string;
    name?: string;
  };
  location?: {
    name?: string;
    is_remote?: boolean;
    city?: string;
    state?: string;
    country?: {
      name?: string;
      code?: string;
    };
  };
  department?: string;
  published_at?: string;
  updated_at?: string;
  description?: string;
}

export class BreezyAdapter implements SourceAdapter {
  readonly type = 'breezy';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://${slug}.breezy.hr/json`;
    const data = await politeFetchJson<BreezyJob[]>(url);

    if (!Array.isArray(data)) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Breezy\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return data
      .filter((j) => j && j.name && j.id)
      .map((j): NormalizedJob => {
        const title = cleanText(j.name);
        const locParts = [
          j.location?.city,
          j.location?.state,
          j.location?.country?.name || j.location?.country?.code,
        ].filter(Boolean);
        const location =
          locParts.length > 0
            ? cleanText(locParts.join(', '))
            : cleanText(j.location?.name || 'Unspecified');
        const remote = Boolean(j.location?.is_remote) || detectRemote(title, location);
        const jobType = detectJobType(title, j.type?.name || j.type?.id || '');
        const description = cleanAndTruncateDescription(j.description, 4000);
        const postedAt = normalizeDate(j.published_at || j.updated_at);
        const category = source.category || detectCategory(title, [j.department || '']);
        const seniority = detectSeniority(title);
        const countryCode = j.location?.country?.code
          ? j.location.country.code.toUpperCase()
          : detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);
        const applyUrl = j.url || `https://${slug}.breezy.hr/p/${j.id}`;

        return {
          source: 'breezy',
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
