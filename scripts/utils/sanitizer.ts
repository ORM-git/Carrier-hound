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
    const cut = Math.max(0, maxChars - 3);
    return text.substring(0, cut).trim() + '...';
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
 * Valid ISO 3166-1 alpha-2 2-letter country code set
 */
export const ISO_ALPHA2_CODES = new Set([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]);

/**
 * Common country name and aliases mapped to ISO 2-letter alpha-2 codes.
 */
export const COUNTRY_MAP: Record<string, string> = {
  'united states': 'US',
  'united states of america': 'US',
  'usa': 'US',
  'u.s.a.': 'US',
  'u.s.': 'US',
  'us': 'US',
  'india': 'IN',
  'united kingdom': 'GB',
  'great britain': 'GB',
  'england': 'GB',
  'scotland': 'GB',
  'wales': 'GB',
  'northern ireland': 'GB',
  'uk': 'GB',
  'u.k.': 'GB',
  'canada': 'CA',
  'germany': 'DE',
  'deutschland': 'DE',
  'singapore': 'SG',
  'australia': 'AU',
  'france': 'FR',
  'netherlands': 'NL',
  'the netherlands': 'NL',
  'holland': 'NL',
  'ireland': 'IE',
  'republic of ireland': 'IE',
  'japan': 'JP',
  'nippon': 'JP',
  'brazil': 'BR',
  'brasil': 'BR',
  'switzerland': 'CH',
  'sweden': 'SE',
  'spain': 'ES',
  'españa': 'ES',
  'italy': 'IT',
  'italia': 'IT',
  'poland': 'PL',
  'polska': 'PL',
  'mexico': 'MX',
  'méxico': 'MX',
  'israel': 'IL',
  'uae': 'AE',
  'u.a.e.': 'AE',
  'united arab emirates': 'AE',
  'austria': 'AT',
  'denmark': 'DK',
  'norway': 'NO',
  'finland': 'FI',
  'new zealand': 'NZ',
  'portugal': 'PT',
  'philippines': 'PH',
  'belgium': 'BE',
  'czech republic': 'CZ',
  'czechia': 'CZ',
  'romania': 'RO',
  'hungary': 'HU',
  'greece': 'GR',
  'south africa': 'ZA',
  'argentina': 'AR',
  'colombia': 'CO',
  'chile': 'CL',
  'south korea': 'KR',
  'korea, republic of': 'KR',
  'republic of korea': 'KR',
  'taiwan': 'TW',
  'estonia': 'EE',
  'lithuania': 'LT',
  'latvia': 'LV',
  'ukraine': 'UA',
  'turkey': 'TR',
  'türkiye': 'TR',
  'saudi arabia': 'SA',
  'indonesia': 'ID',
  'malaysia': 'MY',
  'thailand': 'TH',
  'vietnam': 'VN',
  'viet nam': 'VN',
  'nigeria': 'NG',
  'kenya': 'KE',
  'egypt': 'EG',
  'pakistan': 'PK',
  'croatia': 'HR',
  'serbia': 'RS',
  'bulgaria': 'BG',
  'slovakia': 'SK',
  'slovenia': 'SI',
  'luxembourg': 'LU',
  'iceland': 'IS',
  'cyprus': 'CY',
  'malta': 'MT',
  'costa rica': 'CR',
  'panama': 'PA',
  'uruguay': 'UY',
  'peru': 'PE',
  'ecuador': 'EC',
  'bangladesh': 'BD',
  'sri lanka': 'LK',
  'morocco': 'MA',
  'ghana': 'GH',
  'uganda': 'UG',
};

const US_STATE_NAMES: Record<string, string> = {
  'alabama': 'US',
  'alaska': 'US',
  'arizona': 'US',
  'arkansas': 'US',
  'california': 'US',
  'colorado': 'US',
  'connecticut': 'US',
  'delaware': 'US',
  'florida': 'US',
  'hawaii': 'US',
  'idaho': 'US',
  'illinois': 'US',
  'indiana': 'US',
  'iowa': 'US',
  'kansas': 'US',
  'kentucky': 'US',
  'louisiana': 'US',
  'maine': 'US',
  'maryland': 'US',
  'massachusetts': 'US',
  'michigan': 'US',
  'minnesota': 'US',
  'mississippi': 'US',
  'missouri': 'US',
  'montana': 'US',
  'nebraska': 'US',
  'nevada': 'US',
  'new hampshire': 'US',
  'new jersey': 'US',
  'new mexico': 'US',
  'new york': 'US',
  'north carolina': 'US',
  'north dakota': 'US',
  'ohio': 'US',
  'oklahoma': 'US',
  'oregon': 'US',
  'pennsylvania': 'US',
  'rhode island': 'US',
  'south carolina': 'US',
  'south dakota': 'US',
  'tennessee': 'US',
  'texas': 'US',
  'utah': 'US',
  'vermont': 'US',
  'virginia': 'US',
  'washington': 'US',
  'west virginia': 'US',
  'wisconsin': 'US',
  'wyoming': 'US',
  'district of columbia': 'US',
};

const CANADIAN_PROVINCES: Record<string, string> = {
  'ontario': 'CA',
  'british columbia': 'CA',
  'quebec': 'CA',
  'québec': 'CA',
  'alberta': 'CA',
  'manitoba': 'CA',
  'saskatchewan': 'CA',
  'nova scotia': 'CA',
  'new brunswick': 'CA',
  'newfoundland': 'CA',
  'prince edward island': 'CA',
};

const CITY_TO_COUNTRY: Record<string, string> = {
  // US Cities
  'san francisco': 'US',
  'new york': 'US',
  'new york city': 'US',
  'nyc': 'US',
  'seattle': 'US',
  'austin': 'US',
  'boston': 'US',
  'chicago': 'US',
  'los angeles': 'US',
  'denver': 'US',
  'dallas': 'US',
  'san jose': 'US',
  'san diego': 'US',
  'portland': 'US',
  'miami': 'US',
  'washington dc': 'US',
  'washington, dc': 'US',
  'raleigh': 'US',
  'durham': 'US',
  'pittsburgh': 'US',
  'salt lake city': 'US',
  'minneapolis': 'US',
  'philadelphia': 'US',
  'phoenix': 'US',
  'houston': 'US',
  'detroit': 'US',
  'nashville': 'US',
  'charlotte': 'US',
  'orlando': 'US',
  'tampa': 'US',
  'las vegas': 'US',
  'baltimore': 'US',
  'columbus': 'US',
  'indianapolis': 'US',
  'fort wayne': 'US',
  'albuquerque': 'US',
  'santa fe': 'US',
  'wichita': 'US',
  'little rock': 'US',
  'jersey city': 'US',
  'newark': 'US',
  'hoboken': 'US',
  'kansas city': 'US',

  // Canada Cities
  'toronto': 'CA',
  'vancouver': 'CA',
  'montreal': 'CA',
  'montréal': 'CA',
  'ottawa': 'CA',
  'calgary': 'CA',
  'edmonton': 'CA',
  'waterloo': 'CA',
  'quebec city': 'CA',
  'halifax': 'CA',
  'victoria': 'CA',

  // UK Cities
  'london': 'GB',
  'manchester': 'GB',
  'edinburgh': 'GB',
  'cambridge': 'GB',
  'oxford': 'GB',
  'bristol': 'GB',
  'birmingham': 'GB',
  'glasgow': 'GB',
  'leeds': 'GB',
  'belfast': 'GB',
  'liverpool': 'GB',
  'sheffield': 'GB',
  'newcastle': 'GB',

  // India Cities
  'bengaluru': 'IN',
  'bangalore': 'IN',
  'hyderabad': 'IN',
  'mumbai': 'IN',
  'pune': 'IN',
  'gurgaon': 'IN',
  'gurugram': 'IN',
  'noida': 'IN',
  'delhi': 'IN',
  'new delhi': 'IN',
  'chennai': 'IN',
  'kolkata': 'IN',
  'ahmedabad': 'IN',
  'jaipur': 'IN',
  'kochi': 'IN',
  'trivandrum': 'IN',
  'thiruvananthapuram': 'IN',
  'indore': 'IN',
  'chandigarh': 'IN',

  // Germany Cities
  'berlin': 'DE',
  'munich': 'DE',
  'münchen': 'DE',
  'frankfurt': 'DE',
  'hamburg': 'DE',
  'cologne': 'DE',
  'köln': 'DE',
  'stuttgart': 'DE',
  'dusseldorf': 'DE',
  'düsseldorf': 'DE',
  'leipzig': 'DE',
  'dresden': 'DE',

  // France Cities
  'paris': 'FR',
  'lyon': 'FR',
  'toulouse': 'FR',
  'marseille': 'FR',
  'nantes': 'FR',
  'bordeaux': 'FR',
  'lille': 'FR',

  // Netherlands Cities
  'amsterdam': 'NL',
  'rotterdam': 'NL',
  'utrecht': 'NL',
  'eindhoven': 'NL',
  'the hague': 'NL',
  'den haag': 'NL',
  'delft': 'NL',

  // Ireland Cities
  'dublin': 'IE',
  'cork': 'IE',
  'galway': 'IE',
  'limerick': 'IE',

  // Australia Cities
  'sydney': 'AU',
  'melbourne': 'AU',
  'brisbane': 'AU',
  'perth': 'AU',
  'adelaide': 'AU',
  'canberra': 'AU',

  // Japan Cities
  'tokyo': 'JP',
  'osaka': 'JP',
  'kyoto': 'JP',
  'yokohama': 'JP',
  'fukuoka': 'JP',
  'nagoya': 'JP',
  'sapporo': 'JP',

  // Brazil Cities
  'são paulo': 'BR',
  'sao paulo': 'BR',
  'rio de janeiro': 'BR',
  'belo horizonte': 'BR',
  'curitiba': 'BR',
  'florianópolis': 'BR',
  'florianopolis': 'BR',
  'brasilia': 'BR',
  'brasília': 'BR',
  'porto alegre': 'BR',

  // Spain Cities
  'madrid': 'ES',
  'barcelona': 'ES',
  'valencia': 'ES',
  'seville': 'ES',
  'sevilla': 'ES',
  'malaga': 'ES',
  'málaga': 'ES',
  'bilbao': 'ES',

  // Italy Cities
  'milan': 'IT',
  'milano': 'IT',
  'rome': 'IT',
  'roma': 'IT',
  'turin': 'IT',
  'torino': 'IT',
  'bologna': 'IT',

  // Israel Cities
  'tel aviv': 'IL',
  'jerusalem': 'IL',
  'haifa': 'IL',
  'herzliya': 'IL',

  // Poland Cities
  'warsaw': 'PL',
  'warszawa': 'PL',
  'krakow': 'PL',
  'kraków': 'PL',
  'wroclaw': 'PL',
  'wrocław': 'PL',
  'gdansk': 'PL',
  'gdańsk': 'PL',

  // Sweden Cities
  'stockholm': 'SE',
  'gothenburg': 'SE',
  'göteborg': 'SE',
  'malmo': 'SE',
  'malmö': 'SE',

  // Switzerland Cities
  'zurich': 'CH',
  'zürich': 'CH',
  'geneva': 'CH',
  'genève': 'CH',
  'basel': 'CH',
  'lausanne': 'CH',
  'bern': 'CH',

  // Austria Cities
  'vienna': 'AT',
  'wien': 'AT',
  'graz': 'AT',
  'salzburg': 'AT',

  // Portugal Cities
  'lisbon': 'PT',
  'lisboa': 'PT',
  'porto': 'PT',

  // Denmark Cities
  'copenhagen': 'DK',
  'københavn': 'DK',
  'aarhus': 'DK',

  // Finland Cities
  'helsinki': 'FI',
  'espoo': 'FI',

  // Norway Cities
  'oslo': 'NO',
  'bergen': 'NO',

  // New Zealand Cities
  'auckland': 'NZ',
  'wellington': 'NZ',
  'christchurch': 'NZ',

  // Philippines Cities
  'manila': 'PH',
  'quezon city': 'PH',
  'cebu city': 'PH',
  'makati': 'PH',
  'taguig': 'PH',

  // Mexico Cities
  'mexico city': 'MX',
  'ciudad de méxico': 'MX',
  'cdmx': 'MX',
  'guadalajara': 'MX',
  'monterrey': 'MX',
  'cancun': 'MX',
  'cancún': 'MX',
  'tijuana': 'MX',
  'puebla': 'MX',

  // UAE
  'dubai': 'AE',
  'abu dhabi': 'AE',

  // Others
  'belgrade': 'RS',
  'beograd': 'RS',
  'bucharest': 'RO',
  'bucuresti': 'RO',
  'budapest': 'HU',
  'prague': 'CZ',
  'praha': 'CZ',
  'brussels': 'BE',
  'kyiv': 'UA',
  'kiev': 'UA',
  'istanbul': 'TR',
  'seoul': 'KR',
  'taipei': 'TW',
  'buenos aires': 'AR',
  'santiago': 'CL',
  'bogota': 'CO',
  'bogotá': 'CO',
  'cairo': 'EG',
  'lagos': 'NG',
  'nairobi': 'KE',
  'jakarta': 'ID',
  'kuala lumpur': 'MY',
  'bangkok': 'TH',
  'ho chi minh city': 'VN',
  'saigon': 'VN',
  'hanoi': 'VN',
  'karachi': 'PK',
};

/**
 * Resolves safe traps before generic lookups:
 * - New Mexico (US) vs Mexico (MX)
 * - Indiana (US) vs India (IN)
 * - Georgia state (US) vs Georgia country (GE) vs standalone Georgia (null)
 * - New Jersey (US) vs Jersey Channel Island (JE) vs standalone Jersey (null)
 * - Guinea (GN) vs New Guinea / Papua New Guinea (PG) vs Equatorial Guinea (GQ) vs Guinea-Bissau (GW)
 * - Arkansas (US) vs Kansas (US) vs Kansas City (US)
 */
function resolveTrapCases(lower: string): { code?: string; ambiguous?: boolean } | null {
  // Trap 5: Guinea vs New Guinea vs Equatorial Guinea vs Guinea-Bissau
  if (/\b(?:papua\s+new\s+guinea|new\s+guinea|port\s+moresby)\b/i.test(lower)) {
    return { code: 'PG' };
  }
  if (/\b(?:equatorial\s+guinea|malabo)\b/i.test(lower)) {
    return { code: 'GQ' };
  }
  if (/\b(?:guinea[- ]bissau|bissau)\b/i.test(lower)) {
    return { code: 'GW' };
  }
  if (/\b(?:republic\s+of\s+guinea|conakry)\b/i.test(lower)) {
    return { code: 'GN' };
  }
  if (/\bguinea\b/i.test(lower)) {
    return { code: 'GN' };
  }

  // Trap 2: New Mexico vs Mexico
  if (/\bnew\s+mexico\b/i.test(lower) || /\b(albuquerque|santa fe|las cruces)\b/i.test(lower)) {
    return { code: 'US' };
  }
  if (/\b(?:mexico\s+city|ciudad\s+de\s+m[eé]xico|cdmx|guadalajara|monterrey|canc[uú]n|tijuana|puebla)\b/i.test(lower)) {
    return { code: 'MX' };
  }
  if (/\b(?:mexico|m[eé]xico)\b/i.test(lower)) {
    return { code: 'MX' };
  }

  // Trap 1: India vs Indiana
  if (/\bindiana\b/i.test(lower) || /\b(indianapolis|fort wayne|bloomington|evansville|south bend)\b/i.test(lower)) {
    return { code: 'US' };
  }
  // Standalone "IN" or "Remote - IN", "Remote, IN" without city/qualifier is ambiguous (could be US state IN or ISO code for India)
  if (/^(?:remote\s*(?:[-–—:,]|in)?\s*)?in$/i.test(lower.trim())) {
    return { ambiguous: true };
  }
  // Standalone 2-letter "DE" or "CA" (including "Remote, CA", "Remote, DE", etc.) without US state context is ambiguous:
  // "DE" could be Germany (ISO) or Delaware (US state)
  // "CA" could be Canada (ISO) or California (US state)
  if (/^(?:remote\s*(?:[-–—:,]|in)?\s*)?(?:de|ca)$/i.test(lower.trim())) {
    return { ambiguous: true };
  }
  if (/\bindia\b/i.test(lower)) {
    return { code: 'IN' };
  }

  // Trap 3: Georgia state vs Georgia country
  // Georgia country indicators
  if (
    /\b(tbilisi|batumi|kutaisi|rustavi)\b/i.test(lower) ||
    /\bgeorgia\s*\((?:country|sakartvelo)\)/i.test(lower) ||
    /\bcountry\s+of\s+georgia\b/i.test(lower) ||
    /\bgeorgia\s*,\s*ge\b/i.test(lower)
  ) {
    return { code: 'GE' };
  }
  // Georgia state indicators: US context only (city list, athens, georgia, georgia, us/usa/united states, or , GA)
  if (
    /\b(atlanta|savannah|alpharetta|augusta|marietta|macon|roswell)\b/i.test(lower) ||
    /\bathens\s*,\s*georgia\b/i.test(lower) ||
    /\bgeorgia\s*,\s*(?:us|usa|united states)\b/i.test(lower) ||
    /\bga\s*,\s*(?:us|usa|united states)\b/i.test(lower) ||
    /(?:,\s*)ga(?:\s*|\b|$)/i.test(lower)
  ) {
    return { code: 'US' };
  }
  // Standalone "Georgia", "Remote, Georgia", "Remote in Georgia", etc. is ambiguous
  if (/^(?:remote\s*(?:[-–—:,]|in)?\s*)?georgia$/i.test(lower.trim())) {
    return { ambiguous: true };
  }

  // Trap 4: Jersey (New Jersey vs Island of Jersey)
  if (
    /\bnew\s+jersey\b/i.test(lower) ||
    /\b(jersey\s+city|newark|hoboken|trenton|princeton|camden|paterson)\b/i.test(lower) ||
    /\bnj\s*,\s*(?:us|usa|united states)\b/i.test(lower)
  ) {
    return { code: 'US' };
  }
  if (
    /\b(saint\s+helier|st\.?\s*helier)\b/i.test(lower) ||
    /\bjersey\s*,\s*(?:channel\s+islands?|uk|je)\b/i.test(lower) ||
    /\bchannel\s+islands?\b/i.test(lower)
  ) {
    return { code: 'JE' };
  }
  // Standalone "Jersey" or "Remote - Jersey" is ambiguous
  if (/^(?:remote\s*[-–—:]\s*)?jersey$/i.test(lower.trim())) {
    return { ambiguous: true };
  }

  // Trap 6: Kansas vs Kansas-like names
  if (/\barkansas\b/i.test(lower) || /\b(little rock|fayetteville|fort smith|springdale)\b/i.test(lower)) {
    return { code: 'US' };
  }
  if (/\bkansas\s+city\b/i.test(lower)) {
    return { code: 'US' };
  }
  if (/\bkansas\b/i.test(lower) || /\b(wichita|overland park|topeka|olathe)\b/i.test(lower)) {
    return { code: 'US' };
  }

  return null;
}

export type AtsCountryInput =
  | string
  | {
      country?: string | null;
      countryCode?: string | null;
      location?: string | null;
    }
  | null
  | undefined;

/**
 * Extracts 2-letter ISO country code from location string and/or ATS source fields.
 * Safe against known geographical traps:
 * - India vs Indiana
 * - Mexico vs New Mexico
 * - Georgia state vs Georgia country
 * - Jersey vs New Jersey
 * - Guinea vs New Guinea / Equatorial Guinea / Guinea-Bissau
 * - Kansas vs Arkansas vs Kansas City
 * Ambiguous locations strictly remain null (never guesses).
 */
export function detectCountryCode(
  location: string = '',
  atsField?: AtsCountryInput
): string | null {
  // Step 1: Parse ATS country field if provided
  let atsCountryCode: string | null = null;
  if (atsField) {
    let rawAts: string | null = null;
    if (typeof atsField === 'string') {
      rawAts = atsField.trim();
    } else if (typeof atsField === 'object' && atsField !== null) {
      if (atsField.countryCode && typeof atsField.countryCode === 'string') {
        const directCode = atsField.countryCode.trim().toUpperCase();
        if (ISO_ALPHA2_CODES.has(directCode)) {
          atsCountryCode = directCode;
        }
      }
      if (!atsCountryCode && atsField.country && typeof atsField.country === 'string') {
        rawAts = atsField.country.trim();
      }
    }

    if (!atsCountryCode && rawAts) {
      const upper = rawAts.toUpperCase();
      if (ISO_ALPHA2_CODES.has(upper)) {
        atsCountryCode = upper;
      } else {
        const lower = rawAts.toLowerCase();
        const nonCountryStubs = new Set([
          'remote', 'worldwide', 'global', 'anywhere', 'hybrid', 'in-office', 'onsite', 'none', 'n/a'
        ]);
        if (!nonCountryStubs.has(lower)) {
          const trap = resolveTrapCases(lower);
          if (trap?.code) {
            atsCountryCode = trap.code;
          } else if (!trap?.ambiguous && COUNTRY_MAP[lower]) {
            atsCountryCode = COUNTRY_MAP[lower];
          }
        }
      }
    }
  }

  // Step 2: Location parsing
  if (!location || typeof location !== 'string') {
    return atsCountryCode;
  }
  const loc = location.trim();
  if (!loc) {
    return atsCountryCode;
  }

  const lower = loc.toLowerCase();

  // Pure broad region / remote indicators (return ATS country or null)
  const broadRegions = new Set([
    'remote',
    'worldwide',
    'global',
    'anywhere',
    'work from anywhere',
    'distributed',
    'flexible',
    'hybrid',
    'in-office',
    'onsite',
    'remote - worldwide',
    'remote - global',
    'remote - emea',
    'remote - apac',
    'remote - latam',
    'remote - americas',
    'remote - europe',
    'all regions',
    'multiple locations',
    'various locations',
    'emea',
    'apac',
    'latam',
    'americas',
    'europe',
    'north america',
    'eu',
    'european union',
    'asia',
    'africa',
    'middle east',
  ]);
  if (broadRegions.has(lower)) {
    return atsCountryCode;
  }

  // Multi-country delimiter check (e.g. "US or Canada", "US / UK", "US, UK, CA")
  if (/\b(?:us|usa|ca|uk|gb|eu|india|germany)\b.*(?:\/|\||\bor\b|,\s*and\b).*\b(?:us|usa|ca|uk|gb|eu|india|germany)\b/i.test(loc)) {
    return null; // Ambiguous stays null
  }

  // Check known traps first
  const trapResult = resolveTrapCases(lower);
  if (trapResult) {
    if (trapResult.ambiguous) {
      return null;
    }
    if (trapResult.code) {
      // If ATS gave an explicit conflicting country, resolve safely
      if (atsCountryCode && atsCountryCode !== trapResult.code) {
        return null;
      }
      return trapResult.code;
    }
  }

  // Collect candidate country codes from location text
  const detectedCandidates = new Set<string>();

  // Format 1: "Remote - <Country>" or "Remote: <Country>"
  const remoteMatch = loc.match(/^remote\s*[-–—:]\s*(.+)$/i);
  if (remoteMatch) {
    const target = remoteMatch[1].trim().toLowerCase();
    if (COUNTRY_MAP[target]) {
      detectedCandidates.add(COUNTRY_MAP[target]);
    }
    const targetUpper = target.toUpperCase();
    if (ISO_ALPHA2_CODES.has(targetUpper)) {
      detectedCandidates.add(targetUpper);
    }
  }

  const US_STATE_CODES = new Set([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
    'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
    'VA', 'WA', 'WV', 'WI', 'WY', 'DC'
  ]);

  const CANADIAN_PROVINCE_CODES = new Set([
    'ON', 'BC', 'QC', 'AB', 'MB', 'SK', 'NS', 'NB', 'PE', 'NL', 'YT', 'NT', 'NU'
  ]);

  // Format 2: Segments separated by commas, semicolons, dashes, slashes, or "or"/"and"
  const parts = loc.split(/[,;\-\/|]|\s+(?:or|and)\s+/i).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const partLower = part.toLowerCase();
    const partUpper = part.toUpperCase();

    if (COUNTRY_MAP[partLower]) {
      detectedCandidates.add(COUNTRY_MAP[partLower]);
    }

    // US State name
    if (US_STATE_NAMES[partLower]) {
      detectedCandidates.add('US');
    }
    // Canadian province name
    if (CANADIAN_PROVINCES[partLower]) {
      detectedCandidates.add('CA');
    }
    // City
    if (CITY_TO_COUNTRY[partLower]) {
      detectedCandidates.add(CITY_TO_COUNTRY[partLower]);
    }

    // Two-letter postal / ISO code disambiguation:
    if (partUpper.length === 2) {
      if (partUpper === 'US') {
        detectedCandidates.add('US');
      } else if (partUpper === 'UK' || partUpper === 'GB') {
        detectedCandidates.add('GB');
      } else if (partUpper === 'DE') {
        // "DE" is Germany ISO code or Delaware US state.
        // Only treat as US if US state context is present (e.g. preceded by comma: "Wilmington, DE")
        // and not preceded by "Remote, DE"
        if (
          ((/(?:,\s*)DE\b/i.test(loc) && !/\bremote\s*,\s*DE\b/i.test(loc)) || /\bDE\s*,\s*(?:US|USA)\b/i.test(loc))
        ) {
          if (!/\b(?:germany|deutschland|berlin|munich|hamburg|frankfurt)\b/i.test(loc)) {
            detectedCandidates.add('US');
          } else {
            detectedCandidates.add('DE');
          }
        } else if (/\b(?:germany|deutschland|berlin|munich|hamburg|frankfurt)\b/i.test(loc)) {
          detectedCandidates.add('DE');
        }
      } else if (partUpper === 'CA') {
        // "CA" is Canada ISO code or California US state.
        // Only treat as US if US state context is present (e.g. preceded by comma: "San Francisco, CA")
        // and not preceded by "Remote, CA"
        if (
          ((/(?:,\s*)CA\b/i.test(loc) && !/\bremote\s*,\s*CA\b/i.test(loc)) || /\bCA\s*,\s*(?:US|USA)\b/i.test(loc))
        ) {
          if (!/\b(?:canada|ontario|quebec|british columbia|alberta|toronto|vancouver|montreal|ottawa)\b/i.test(loc)) {
            detectedCandidates.add('US');
          } else {
            detectedCandidates.add('CA');
          }
        } else if (/\b(?:canada|ontario|quebec|british columbia|alberta|toronto|vancouver|montreal|ottawa)\b/i.test(loc)) {
          detectedCandidates.add('CA');
        }
      } else if (US_STATE_CODES.has(partUpper)) {
        // If it's a known US state code (e.g. NY, TX, MA, WA) attached to a city or in US postal format
        detectedCandidates.add('US');
      } else if (CANADIAN_PROVINCE_CODES.has(partUpper)) {
        detectedCandidates.add('CA');
      } else if (
        ISO_ALPHA2_CODES.has(partUpper) &&
        partUpper !== 'IN' &&
        partUpper !== 'GA' &&
        partUpper !== 'OR' &&
        partUpper !== 'ME' &&
        partUpper !== 'NO' &&
        partUpper !== 'ID' &&
        partUpper !== 'SO' &&
        partUpper !== 'IT' &&
        partUpper !== 'AT' &&
        partUpper !== 'BE'
      ) {
        detectedCandidates.add(partUpper);
      }
    }
  }

  // Format 3: Explicit US state code regex (e.g. "Austin, TX")
  if (/(?:,\s*|\b)(?:AL|AK|AZ|AR|CO|CT|FL|HI|ID|IL|IA|KS|KY|LA|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/.test(loc)) {
    detectedCandidates.add('US');
  }

  // State code IN or GA preceded by a comma and not in "India"
  if (/(?:,\s*)(?:IN|GA)(?:\s*,\s*(?:US|USA|United States))?(?:\s*|\b|$)/.test(loc) && !loc.toLowerCase().includes('india')) {
    detectedCandidates.add('US');
  }

  // State code DE or CA preceded by a comma (US state context like "Wilmington, DE", "San Francisco, CA")
  // Excludes "Remote, DE" and "Remote, CA" which are ambiguous
  if (/(?:,\s*)(?:DE|CA)(?:\s*,\s*(?:US|USA|United States))?(?:\s*|\b|$)/.test(loc) && !/\bremote\s*,\s*(?:DE|CA)\b/i.test(loc)) {
    const isCanadaContext = /\b(?:canada|ontario|quebec|british columbia|alberta|toronto|vancouver|montreal)\b/i.test(loc);
    const isGermanyContext = /\b(?:germany|deutschland|berlin|munich|hamburg|frankfurt)\b/i.test(loc);
    if (!isCanadaContext && !isGermanyContext) {
      detectedCandidates.add('US');
    }
  }

  // Format 4: Canadian province codes with comma (e.g. "Vancouver, BC" or "Toronto, ON")
  if (/(?:,\s*)(?:ON|BC|QC|AB|MB|SK|NS|NB|PE)\b/.test(loc)) {
    detectedCandidates.add('CA');
  }

  // Format 5: Direct full-string country name search (word boundary)
  for (const [name, code] of Object.entries(COUNTRY_MAP)) {
    if (name.length <= 2) continue; // Skip 2-letter tokens in full search to avoid word collision
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    if (regex.test(lower)) {
      detectedCandidates.add(code);
    }
  }

  // Format 6: Direct full-string city search
  for (const [city, code] of Object.entries(CITY_TO_COUNTRY)) {
    const regex = new RegExp(`\\b${city}\\b`, 'i');
    if (regex.test(lower)) {
      detectedCandidates.add(code);
    }
  }

  // Evaluation of candidates
  if (detectedCandidates.size === 1) {
    const code = Array.from(detectedCandidates)[0];
    if (atsCountryCode && atsCountryCode !== code) {
      // Conflict between location and ATS field -> ambiguous
      return null;
    }
    return code;
  }

  if (detectedCandidates.size > 1) {
    // Multiple distinct countries detected (e.g. "London or New York") -> ambiguous stays null
    return null;
  }

  return atsCountryCode || null;
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
    /\bai\b/i.test(combined) ||
    combined.includes('machine learning') ||
    /\bml\b/i.test(combined) ||
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
    /\b(ui|ux)\b/i.test(combined) ||
    combined.includes('product design') ||
    combined.includes('graphic design')
  ) {
    return 'design';
  }
  if (
    combined.includes('product manager') ||
    combined.includes('product management') ||
    combined.includes('head of product') ||
    combined.includes('program manager') ||
    combined.includes('program management') ||
    combined.includes('project manager') ||
    combined.includes('project management') ||
    /\btpm\b/i.test(combined) ||
    combined.includes('scrum master')
  ) {
    return 'product';
  }
  if (
    combined.includes('marketing') ||
    combined.includes('growth') ||
    combined.includes('content') ||
    combined.includes('seo') ||
    /\binfluencer\b/i.test(combined) ||
    /\bsocial\b/i.test(combined) ||
    /\bculture\b/i.test(combined) ||
    /\bcommunity\b/i.test(combined) ||
    /\bbrand\b/i.test(combined) ||
    combined.includes('public relations')
  ) {
    return 'marketing';
  }
  if (
    combined.includes('data ') ||
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
