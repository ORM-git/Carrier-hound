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
} from '../utils/sanitizer';

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  categories?: {
    location?: string;
    commitment?: string;
    team?: string;
    department?: string;
    allLocations?: string[];
  };
  descriptionPlain?: string;
  description?: string;
  workplaceType?: string; // 'remote', 'hybrid', 'on-site'
}

export class LeverAdapter implements SourceAdapter {
  readonly type = 'lever';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const data = await politeFetchJson<LeverJob[]>(url);

    if (!Array.isArray(data)) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Lever\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return data
      .filter((j) => j && j.text && (j.applyUrl || j.hostedUrl))
      .map((j): NormalizedJob => {
        const title = cleanText(j.text);
        const location = cleanText(j.categories?.location || 'Unspecified');
        const isRemoteWorkplace = j.workplaceType === 'remote';
        const remote = isRemoteWorkplace || detectRemote(title, location);
        const jobType = detectJobType(title, j.categories?.commitment || '');
        const rawDesc = j.descriptionPlain || stripHtml(j.description);
        const description = cleanAndTruncateDescription(rawDesc, 4000);
        const salary = parseSalary(description, { title, location });
        const postedAt = j.createdAt ? new Date(j.createdAt).toISOString() : normalizeDate(null);
        const category =
          source.category ||
          detectCategory(title, [j.categories?.team || '', j.categories?.department || '']);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);

        return {
          source: 'lever',
          source_type: 'ats',
          source_job_id: `${slug}-${j.id}`,
          title,
          company: companyName,
          company_slug: slug,
          location,
          country_code: countryCode,
          remote,
          remote_scope: remote ? 'remote' : j.workplaceType === 'hybrid' ? 'hybrid' : 'onsite',
          remote_eligibility: remoteEligibility,
          job_type: jobType,
          seniority,
          description,
          apply_url: j.applyUrl || j.hostedUrl,
          source_url: j.hostedUrl || `https://jobs.lever.co/${slug}`,
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
