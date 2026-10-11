/**
 * Text and metadata sanitization & normalization utilities
 */

/**
 * Strips HTML tags and unescapes common HTML entities into clean plain text.
 */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return '';
  let text = input;

  // Replace block elements and <br> with newlines
  text = text.replace(/<(?:br|\/p|\/div|\/li|h[1-6]|\/h[1-6])\s*\/?>/gi, '\n');

  // Strip all other HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Normalize consecutive whitespace and carriage returns
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');

  return text.trim();
}

/**
 * Trims and limits text length safely.
 */
export function cleanText(input: string | null | undefined, maxLength?: number): string {
  if (!input) return '';
  const cleaned = input.trim();
  if (maxLength && cleaned.length > maxLength) {
    return cleaned.slice(0, maxLength).trim() + '...';
  }
  return cleaned;
}

/**
 * Strips HTML, scripts, and extra whitespace, strictly capping at maxChars (default 4000).
 * Prevents bloated database storage for 100k jobs scale.
 */
export function cleanAndTruncateDescription(raw: string | null | undefined, maxChars = 4000): string | null {
  if (!raw || !raw.trim()) return null;
  // Remove script and style tags completely
  let text = raw.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  // Strip HTML
  text = stripHtml(text);
  if (!text) return null;
  if (text.length > maxChars) {
    return text.substring(0, maxChars).trim() + '...';
  }
  return text;
}

/**
 * Detects role seniority level matching database enum/check constraint.
 * Supported: 'entry' | 'mid' | 'senior' | 'staff' | 'lead' | 'director' | 'unknown'
 */
export function detectSeniority(title: string = ''): 'entry' | 'mid' | 'senior' | 'staff' | 'lead' | 'director' | 'unknown' {
  const t = title.toLowerCase();
  if (/\b(director|vp|vice president|head of|chief|cto|cpo|ceo|cfo|executive)\b/i.test(t)) {
    return 'director';
  }
  if (/\b(staff|principal|fellow|distinguished)\b/i.test(t)) {
    return 'staff';
  }
  if (/\b(lead|tech lead|team lead|engineering manager|manager|lead engineer|lead developer)\b/i.test(t)) {
    return 'lead';
  }
  if (/\b(senior|sr|sr\.|iii|iv|expert|specialist)\b/i.test(t)) {
    return 'senior';
  }
  if (/\b(intern|internship|trainee|apprentice|entry|associate|junior|jr|jr\.|graduate|grad|campus|new grad|co-op|level 1|l1)\b/i.test(t)) {
    return 'entry';
  }
  if (/\b(mid|ii|level 2|l2|l3|intermediate)\b/i.test(t)) {
    return 'mid';
  }
  return 'unknown';
}

/**
 * Common country name to ISO 2-letter alpha-2 map
 */
const COUNTRY_MAP: Record<string, string> = {
  'united states': 'US',
  'usa': 'US',
  'us': 'US',
  'india': 'IN',
  'united kingdom': 'GB',
  'uk': 'GB',
  'great britain': 'GB',
  'england': 'GB',
  'canada': 'CA',
  'germany': 'DE',
  'deutschland': 'DE',
  'singapore': 'SG',
  'australia': 'AU',
  'france': 'FR',
  'netherlands': 'NL',
  'ireland': 'IE',
  'japan': 'JP',
  'brazil': 'BR',
  'switzerland': 'CH',
  'sweden': 'SE',
  'spain': 'ES',
  'italy': 'IT',
  'poland': 'PL',
  'mexico': 'MX',
  'israel': 'IL',
  'uae': 'AE',
  'united arab emirates': 'AE',
  'dubai': 'AE',
  'austria': 'AT',
  'denmark': 'DK',
  'norway': 'NO',
  'finland': 'FI',
  'new zealand': 'NZ',
  'portugal': 'PT',
  'philippines': 'PH',
};

/**
 * Extracts 2-letter ISO country code from location string if detectable.
 */
export function detectCountryCode(location: string = ''): string | null {
  if (!location) return null;
  const loc = location.trim();
  const lower = loc.toLowerCase();

  // Explicit country matching
  for (const [name, code] of Object.entries(COUNTRY_MAP)) {
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    if (regex.test(lower)) {
      return code;
    }
  }

  // Common US state abbreviations (e.g. "San Francisco, CA" or "Austin, TX")
  if (/,?\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(loc)) {
    return 'US';
  }

  // Common Indian cities
  if (/\b(bengaluru|bangalore|hyderabad|mumbai|pune|gurgaon|gurugram|noida|delhi|chennai)\b/i.test(lower)) {
    return 'IN';
  }

  // Common UK cities
  if (/\b(london|manchester|edinburgh|cambridge|oxford|bristol)\b/i.test(lower)) {
    return 'GB';
  }

  return null;
}

/**
 * Detects remote eligibility: 'worldwide' | 'country_restricted' | 'unknown'
 */
export function detectRemoteEligibility(
  location: string = '',
  remote: boolean = false
): 'worldwide' | 'country_restricted' | 'unknown' {
  if (!remote) return 'unknown';
  const lower = location.toLowerCase();
  if (
    lower.includes('anywhere') ||
    lower.includes('worldwide') ||
    lower.includes('global') ||
    lower.includes('all regions') ||
    lower.includes('work from anywhere')
  ) {
    return 'worldwide';
  }
  const country = detectCountryCode(location);
  if (country) {
    return 'country_restricted';
  }
  return 'worldwide';
}

/**
 * Detects if a job is remote based on title, location, or explicit boolean flags.
 */
export function detectRemote(
  title: string = '',
  location: string = '',
  explicitFlag?: boolean
): boolean {
  if (typeof explicitFlag === 'boolean') return explicitFlag;
  const combined = `${title} ${location}`.toLowerCase();
  return (
    combined.includes('remote') ||
    combined.includes('work from home') ||
    combined.includes('wfh') ||
    combined.includes('anywhere') ||
    combined.includes('telecommute') ||
    combined.includes('distributed')
  );
}

/**
 * Detects if a role is an internship/trainee role based on title.
 */
export function detectJobType(title: string = '', rawType: string = ''): 'job' | 'internship' {
  const combined = `${title} ${rawType}`.toLowerCase();
  const isIntern =
    combined.includes('intern') ||
    combined.includes('internship') ||
    combined.includes('trainee') ||
    combined.includes('apprentice') ||
    combined.includes('co-op');

  return isIntern ? 'internship' : 'job';
}

export { parseSalary, formatSalary } from '../../src/lib/salary/parser';
export type { ParsedSalary, ParseSalaryOptions, SalaryPeriod } from '../../src/lib/salary/parser';

/**
 * Normalizes any date into a valid ISO string. Falls back to current time.
 */
export function normalizeDate(input: string | number | Date | null | undefined): string {
  if (!input) return new Date().toISOString();
  try {
    const parsed = new Date(input);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  } catch {
    // fallback
  }
  return new Date().toISOString();
}

/**
 * Classifies job role into category tags compatible with CareerMonke frontend pills.
 */
export function detectCategory(title: string = '', tags: string[] = []): string {
  const combined = `${title} ${tags.join(' ')}`.toLowerCase();
  if (
    combined.includes('ai ') ||
    combined.includes('machine learning') ||
    combined.includes('ml ') ||
    combined.includes('deep learning') ||
    combined.includes('nlp') ||
    combined.includes('llm') ||
    combined.includes('data sci')
  ) {
    return 'ai';
  }
  if (
    combined.includes('devops') ||
    combined.includes('sre') ||
    combined.includes('infrastructure') ||
    combined.includes('cloud') ||
    combined.includes('platform') ||
    combined.includes('security')
  ) {
    return 'devops';
  }
  if (
    combined.includes('design') ||
    combined.includes('ui') ||
    combined.includes('ux') ||
    combined.includes('product design')
  ) {
    return 'design';
  }
  if (
    combined.includes('product manager') ||
    combined.includes('product management') ||
    combined.includes('head of product')
  ) {
    return 'product';
  }
  if (
    combined.includes('marketing') ||
    combined.includes('growth') ||
    combined.includes('content') ||
    combined.includes('seo')
  ) {
    return 'marketing';
  }
  if (
    combined.includes('data engineer') ||
    combined.includes('analytics') ||
    combined.includes('database') ||
    combined.includes('bi ')
  ) {
    return 'data';
  }
  if (
    combined.includes('qa') ||
    combined.includes('quality assurance') ||
    combined.includes('test engineer') ||
    combined.includes('sdit')
  ) {
    return 'qa-testing';
  }
  if (
    combined.includes('finance') ||
    combined.includes('accountant') ||
    combined.includes('payroll')
  ) {
    return 'finance';
  }
  if (
    combined.includes('recruiter') ||
    combined.includes('talent') ||
    combined.includes('human resources') ||
    combined.includes('hr ')
  ) {
    return 'hr';
  }
  if (
    combined.includes('sales') ||
    combined.includes('account executive') ||
    combined.includes('business development') ||
    combined.includes('bdr')
  ) {
    return 'sales';
  }

  return 'engineering';
}

/**
 * Standard slugify function for consistent dedupe keys and slugs
 */
export function slugify(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
