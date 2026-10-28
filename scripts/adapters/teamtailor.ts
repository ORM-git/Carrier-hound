import { SourceAdapter } from './types';
import { NormalizedJob, SourceConfig } from '../types';
import { politeFetchText } from '../utils/polite-fetch';
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

function parseXmlTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

export class TeamtailorAdapter implements SourceAdapter {
  readonly type = 'teamtailor';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://${slug}.teamtailor.com/jobs.rss`;
    const xml = await politeFetchText(url);

    if (!xml || !xml.includes('<item')) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Teamtailor\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    const items: string[] = [];
    const itemRegex = /<item[\s\S]*?<\/item>/gi;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) !== null) {
      items.push(match[0]);
    }

    return items
      .map((itemXml): NormalizedJob | null => {
        const titleRaw = parseXmlTag(itemXml, 'title');
        const link = parseXmlTag(itemXml, 'link') || parseXmlTag(itemXml, 'guid');
        if (!titleRaw || !link) return null;

        const title = cleanText(titleRaw);
        const guid = parseXmlTag(itemXml, 'guid') || link;
        const pubDate = parseXmlTag(itemXml, 'pubDate');
        const city = parseXmlTag(itemXml, 'tt:city') || parseXmlTag(itemXml, 'city');
        const country = parseXmlTag(itemXml, 'tt:country') || parseXmlTag(itemXml, 'country');
        const status = parseXmlTag(itemXml, 'tt:status') || parseXmlTag(itemXml, 'status');
        const department =
          parseXmlTag(itemXml, 'tt:department') ||
          parseXmlTag(itemXml, 'department') ||
          parseXmlTag(itemXml, 'tt:role');
        const rawDesc = parseXmlTag(itemXml, 'description');

        const locParts = [city, country].filter(Boolean);
        const location = locParts.length > 0 ? cleanText(locParts.join(', ')) : 'Unspecified';
        const remote = status.toLowerCase() === 'remote' || detectRemote(title, location);
        const jobType = detectJobType(title);
        const description = cleanAndTruncateDescription(rawDesc, 4000);
        const postedAt = normalizeDate(pubDate);
        const category = source.category || detectCategory(title, [department]);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(country || location);
        const remoteEligibility = detectRemoteEligibility(location, remote);

        // Derive unique job ID from guid or path
        const idMatch = link.match(/\/jobs\/([0-9a-zA-Z-]+)/);
        const jobId = idMatch ? idMatch[1] : guid.replace(/[^a-zA-Z0-9-]/g, '-').slice(-32);

        return {
          source: 'teamtailor',
          source_type: 'ats',
          source_job_id: `${slug}-${jobId}`,
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
          apply_url: link,
          source_url: link,
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
      })
      .filter((j): j is NormalizedJob => j !== null);
  }
}
