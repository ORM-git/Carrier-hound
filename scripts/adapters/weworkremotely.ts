import { SourceAdapter } from './types';
import { NormalizedJob, SourceConfig } from '../types';
import { politeFetchText } from '../utils/polite-fetch';
import {
  cleanText,
  cleanAndTruncateDescription,
  detectJobType,
  detectCategory,
  detectSeniority,
  normalizeDate,
  parseSalary,
} from '../utils/sanitizer';

export class WeWorkRemotelyAdapter implements SourceAdapter {
  readonly type = 'weworkremotely';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const url =
      source.target || 'https://weworkremotely.com/categories/remote-programming-jobs.rss';
    const xml = await politeFetchText(url);

    if (!xml) return [];

    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    const items: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null) {
      items.push(match[1]);
    }

    const nowIso = new Date().toISOString();

    return items
      .map((itemXml): NormalizedJob | null => {
        const getTag = (tag: string): string => {
          // Check for CDATA first
          const cdataMatch = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(itemXml);
          if (cdataMatch) return cdataMatch[1].trim();

          const normalMatch = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(itemXml);
          return normalMatch ? normalMatch[1].trim() : '';
        };

        const rawTitle = getTag('title');
        const link = getTag('link') || getTag('guid');
        const pubDate = getTag('pubDate');
        const rawDesc = getTag('description');

        if (!rawTitle || !link) return null;

        // WWR title format is typically "Company: Job Title"
        let company = 'Unknown';
        let title = rawTitle;
        if (rawTitle.includes(':')) {
          const parts = rawTitle.split(':');
          company = cleanText(parts[0]);
          title = cleanText(parts.slice(1).join(':'));
        }

        const description = cleanAndTruncateDescription(rawDesc, 4000);
        const salary = parseSalary(description, { title, location: 'Remote' });
        const jobType = detectJobType(title);
        const seniority = detectSeniority(title);
        const postedAt = normalizeDate(pubDate);
        const category = source.category || detectCategory(title);

        // Extract ID from link or guid
        const idMatch = link.match(/\/remote-jobs\/([^/?#]+)/) || link.match(/id=([^&#]+)/);
        const sourceJobId = idMatch ? idMatch[1] : encodeURIComponent(link);

        return {
          source: 'weworkremotely',
          source_type: 'feed',
          source_job_id: sourceJobId,
          title,
          company,
          location: 'Remote',
          country_code: null,
          remote: true,
          remote_scope: 'remote',
          remote_eligibility: 'worldwide',
          job_type: jobType,
          seniority,
          description,
          apply_url: link,
          source_url: link,
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
      })
      .filter((j): j is NormalizedJob => j !== null);
  }
}
