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

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  department?: string;
  isRemote?: boolean;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string;
    summary?: string;
  };
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

export class AshbyAdapter implements SourceAdapter {
  readonly type = 'ashby';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    const data = await politeFetchJson<AshbyResponse>(url);

    if (!data || !Array.isArray(data.jobs)) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Ashby\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    return data.jobs
      .filter((j) => j && j.title && (j.jobUrl || j.applyUrl))
      .map((j): NormalizedJob => {
        const title = cleanText(j.title);
        const location = cleanText(j.location || 'Unspecified');
        const remote = detectRemote(title, location, j.isRemote);
        const jobType = detectJobType(title);
        const rawDesc = j.descriptionPlain || stripHtml(j.descriptionHtml);
        const description = cleanAndTruncateDescription(rawDesc, 4000);

        const compSummary =
          j.compensation?.compensationTierSummary || j.compensation?.summary || '';
        const salary = compSummary
          ? parseSalary(compSummary, { title, location, isExplicitSalaryField: true })
          : parseSalary(description, { title, location });
        const postedAt = normalizeDate(j.publishedAt);
        const category = source.category || detectCategory(title, [j.department || '']);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);

        const applyUrl = j.applyUrl || j.jobUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`;

        return {
          source: 'ashby',
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
          source_url: j.jobUrl || `https://jobs.ashbyhq.com/${slug}`,
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
