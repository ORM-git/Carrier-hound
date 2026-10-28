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

export class PersonioAdapter implements SourceAdapter {
  readonly type = 'personio';

  async fetchJobs(source: SourceConfig): Promise<NormalizedJob[]> {
    const slug = source.target.trim().toLowerCase();
    const url = `https://${slug}.jobs.personio.de/xml`;
    let xml = await politeFetchText(url);

    // Fallback to .com domain if .de returns empty
    if (!xml || !xml.includes('<position')) {
      xml = await politeFetchText(`https://${slug}.jobs.personio.com/xml`);
    }

    if (!xml || !xml.includes('<position')) {
      return [];
    }

    const companyName = source.name.replace(/\s*\(Personio\)$/i, '').trim();
    const nowIso = new Date().toISOString();

    const positions: string[] = [];
    const posRegex = /<position[\s\S]*?<\/position>/gi;
    let match: RegExpExecArray | null;
    while ((match = posRegex.exec(xml)) !== null) {
      positions.push(match[0]);
    }

    return positions
      .map((posXml): NormalizedJob | null => {
        const id = parseXmlTag(posXml, 'id');
        const nameRaw = parseXmlTag(posXml, 'name');
        if (!id || !nameRaw) return null;

        const title = cleanText(nameRaw);
        const office = parseXmlTag(posXml, 'office');
        const department =
          parseXmlTag(posXml, 'department') || parseXmlTag(posXml, 'recruitingCategory');
        const employmentType = parseXmlTag(posXml, 'employmentType');
        const schedule = parseXmlTag(posXml, 'schedule');
        const createdAt = parseXmlTag(posXml, 'createdAt');

        // Extract description values
        const descMatches = posXml.match(/<value[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/value>/gi) || [];
        const combinedDesc = descMatches
          .map((v) => v.replace(/<\/?value[^>]*>/gi, '').replace(/<!\[CDATA\[|\]\]>/gi, '').trim())
          .join('\n\n');

        const location = office ? cleanText(office) : 'Unspecified';
        const remote = detectRemote(title, location);
        const jobType = detectJobType(title, `${schedule} ${employmentType}`);
        const description = cleanAndTruncateDescription(combinedDesc, 4000);
        const postedAt = normalizeDate(createdAt);
        const category = source.category || detectCategory(title, [department]);
        const seniority = detectSeniority(title);
        const countryCode = detectCountryCode(location);
        const remoteEligibility = detectRemoteEligibility(location, remote);
        const applyUrl = `https://${slug}.jobs.personio.de/job/${id}`;

        return {
          source: 'personio',
          source_type: 'ats',
          source_job_id: `${slug}-${id}`,
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
      })
      .filter((j): j is NormalizedJob => j !== null);
  }
}
