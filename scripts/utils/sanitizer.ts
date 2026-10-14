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
 *
 * V2 Rules Alignment:
 * - director: only matches director, vp, vice president, head of, chief [X] officer, cto, cpo, ceo, cfo, executive director.
 *   Bare "executive", "Account Executive", and "Executive Assistant" are excluded.
 * - staff: matches staff, principal, distinguished.
 *   Excludes blocklisted non-tech/institutional roles: chief of staff, member of technical staff,
 *   nurse, accountant, fellow, fellowship, teacher, teaching, school, professor, attorney,
 *   transaction principal, principal (school), staff writer.
 *   Counsel, TPM, recruiter, UX researcher remain staff.
 * - senior: matches senior, sr, sr., level 3, sde 3, sde iii, software engineer iii BEFORE manager/lead.
 *   Mistakes removed: "specialist", "expert", bare "iii/iv", and bare "l3".
 * - mid management exemptions: "associate manager" and "assistant manager" map to 'mid' before manager/lead.
 * - lead: matches manager and contextual/role-word lead, excluding "lead gen", "lead generation", "leads", "lead capture".
 * - mid: matches mid-level, intermediate, level 2, l2, sde 2, sde ii, software engineer ii, and bare mid excluding "Mid-Market".
 * - entry: matches intern, internship, fresher, graduate, trainee, apprentice, junior, jr., level 1, l1, sde 1, and associate (excluding account/sales/consulting executives).
 *   "Data Entry" is strictly excluded from matching entry.
 * - unknown: default fallback.
 */
export function detectSeniority(title: string = ''): 'entry' | 'mid' | 'senior' | 'staff' | 'lead' | 'director' | 'unknown' {
  if (!title || typeof title !== 'string') return 'unknown';
  const t = title.trim();

  // 1. Director & Executive level
  // Matches: director, vp, vice president, head of, chief [X] officer, cto, cpo, ceo, cfo, coo, ciso, executive director.
  // EXCLUDES: bare "executive", "Account Executive", "Sales Executive", "Executive Assistant", "CRO" (e.g. CRO Specialist).
  if (
    /\b(director|vp|vice president|head of|executive director)\b/i.test(t) ||
    /\bchief\s+[a-z]+\s+officer\b/i.test(t) ||
    (/\bchief\b/i.test(t) && /\b(executive|technology|operating|financial|information|product|revenue|marketing)\b/i.test(t)) ||
    /\b(cto|cpo|ceo|cfo|coo|ciso)\b/i.test(t)
  ) {
    if (!/\bexecutive assistant\b/i.test(t) || /\b(director|vp|vice president)\b/i.test(t)) {
      return 'director';
    }
  }

  // 2. Staff & Principal level
  // Matches: staff, principal, distinguished.
  // EXCLUDES: Blocklisted non-tech/institutional roles:
  // - chief of staff, member of technical staff
  // - nurse, accountant, fellow, fellowship, teacher, teaching, school, professor, attorney
  // - "transaction principal", "principal (school)", "staff writer"
  // Note: "Principal Counsel", "Staff Technical Program Manager", "Staff UX Researcher",
  // "Principal Threat Researcher", "Senior Staff Program Manager", "Principal Recruiter" remain 'staff'.
  if (
    /\b(staff|principal|distinguished)\b/i.test(t) &&
    !/\b(chief of staff|member of technical staff|nurses?|accountants?|fellows?|fellowships?|teachers?|teaching|schools?|professors?|attorneys?|transaction principal|staff writer)\b/i.test(t) &&
    !/\bprincipal\s*\(\s*school\s*\)/i.test(t)
  ) {
    return 'staff';
  }

  // 3. Senior level (BEFORE manager/lead)
  // "Senior" wins over manager (Senior Engineering Manager -> senior) and account executive.
  // Removed mistakes: specialist, expert, bare iii/iv, bare l3.
  if (/\b(senior|sr\.?|level 3|sde 3|sde iii|software engineer iii)\b/i.test(t)) {
    return 'senior';
  }

  // 4. Mid-level management exemptions
  // Associate Manager and Assistant Manager win over general manager -> 'mid'
  if (/\b(associate manager|assistant manager)\b/i.test(t)) {
    return 'mid';
  }

  // 5. Manager titles & contextual role Leads -> 'lead'
  // EXCLUDES: "Lead Generation", "Lead Gen", "Leads", "Lead Capture".
  const isManager = /\b(manager|general manager)\b/i.test(t);
  const isRoleLead = (
    /(^|[,\-\/:|]\s*)lead\b/i.test(t) ||
    /\blead($|[,\-\/:|])/i.test(t) ||
    /\b(team lead|tech lead|engineering lead|product lead|shift lead|alliance lead|lead engineer|lead developer|lead architect|lead data scientist)\b/i.test(t)
  );
  const isLeadGen = /\b(lead gen(eration)?|leads|lead capture)\b/i.test(t);

  if ((isManager || isRoleLead) && !isLeadGen) {
    return 'lead';
  }

  // 6. Mid level (explicit mid / intermediate)
  // EXCLUDES: "Mid-Market" (e.g. "Sales Manager, Mid-Market - APAC" must not match mid).
  if (
    /\b(mid-level|intermediate|level 2|l2|sde 2|sde ii|software engineer ii)\b/i.test(t) ||
    (/\bmid\b/i.test(t) && !/\bmid-?market\b/i.test(t))
  ) {
    return 'mid';
  }

  // 7. Entry level & Internships
  // EXCLUDES: "Data Entry" (Data Entry Clerk -> unknown).
  // EXCLUDES: Sales/Account/Consulting Executives when matching "associate".
  if (/\b(intern|internship|fresher|graduate|grad|trainee|apprentice|co-op|campus|new grad)\b/i.test(t)) {
    return 'entry';
  }
  if (
    (/\b(junior|entry|entry-level|jr\.?|level 1|l1|sde 1|sde i|software engineer i)\b/i.test(t) ||
     (/\bassociate\b/i.test(t) && !/\b(account executive|sales executive|consulting executive)\b/i.test(t))) &&
    !/\bdata entry\b/i.test(t)
  ) {
    return 'entry';
  }

  // 8. Default unranked roles to unknown
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
 * Detects if a role is an internship/trainee role based on title and raw type.
 * Prevents false positives like "International" or "Internal Audit" while capturing
 * "Intern", "Co-op", "Apprentice", etc.
 */
export function detectJobType(title: string = '', rawType: string = ''): 'job' | 'internship' {
  if (!title && !rawType) return 'job';
  const cleanTitle = title.replace(/\b(international|internals?|cooperative)\b/gi, ' ');
  const cleanRaw = rawType.replace(/\b(international|internals?|cooperative)\b/gi, ' ');
  const combined = `${cleanTitle} ${cleanRaw}`;

  const isIntern = /\b(intern|interns|internship|internships|co-op|coop|trainee|trainees|apprentice|apprenticeship)\b/i.test(combined);
  if (!isIntern) return 'job';

  if (/\b(director|head|vp|vice president|manager)\s+of\s+.*intern/i.test(title)) {
    return 'job';
  }

  return 'internship';
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
