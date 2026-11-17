/**
 * High-Volume Job Ingestion Identity & Similarity Helpers (v2)
 *
 * Implements byte-for-byte parity with PostgreSQL public.compute_job_similarity_hash_v2()
 * and Python scripts.scraper.enrichment.compute_similarity_hash_v2().
 */

import * as crypto from 'crypto';

export const COMPANY_CATEGORIES = [
  'MNC_BIGTECH',
  'HIGH_PRODUCT_YC',
  'OTHER_STARTUPS',
  'INDIAN_IT_AND_OTHER',
] as const;
export type CompanyCategory = (typeof COMPANY_CATEGORIES)[number];

export const ROLE_CATEGORIES = ['SDE', 'AI_ML', 'CLOUD', 'DATA', 'OTHER'] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

// ============================================================================
// 1. AUTHORITATIVE WRITE IDENTITY
// ============================================================================

export function buildSourceId(vendor: string, boardToken: string): string {
  if (!vendor || typeof vendor !== 'string' || !vendor.trim()) {
    throw new Error('vendor must be a non-empty string');
  }
  if (!boardToken || typeof boardToken !== 'string' || !boardToken.trim()) {
    throw new Error('boardToken must be a non-empty string');
  }
  return `${vendor.trim().toLowerCase()}:${boardToken.trim().toLowerCase()}`;
}

export function cleanLocationKey(locationKey?: string | null): string {
  if (!locationKey || typeof locationKey !== 'string') return '';
  let loc = locationKey.normalize('NFC').toLowerCase();
  loc = loc.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  loc = loc.replace(/ς|\u03c2/g, '\u03c3');
  loc = loc.replace(/\u0085/g, ' ');
  loc = loc.replace(/\s+/g, ' ').trim();
  return loc;
}

export function buildScopedJobIdentity(
  sourceId: string,
  providerJobId: string,
  locationKey?: string | null
): { sourceId: string; sourceJobId: string } {
  if (!sourceId || typeof sourceId !== 'string' || !sourceId.trim()) {
    throw new Error('sourceId must be a non-empty string');
  }
  if (!providerJobId || typeof providerJobId !== 'string' || !providerJobId.trim()) {
    throw new Error('providerJobId must be a non-empty string');
  }

  const cleanSourceId = sourceId.trim().toLowerCase();
  const cleanPid = providerJobId.trim().replace(/%/g, '%25').replace(/#/g, '%23');

  let cleanJobId = cleanPid;
  if (locationKey && typeof locationKey === 'string' && locationKey.trim()) {
    const cleanLoc = cleanLocationKey(locationKey);
    if (cleanLoc) {
      const locLen = Buffer.byteLength(cleanLoc, 'utf8');
      cleanJobId = `${cleanPid}#${locLen}:${cleanLoc}`;
    }
  }

  return { sourceId: cleanSourceId, sourceJobId: cleanJobId };
}

// ============================================================================
// 2. VERSIONED SIMILARITY CONTRACT (v2 LENGTH-FRAMED UTF-8 SHA-256)
// ============================================================================

const COMPANY_SUFFIX_REGEX = /\b(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\b\.?/gi;

export function cleanCompany(company?: string | null): string {
  if (!company || typeof company !== 'string') return '';
  let c = company.normalize('NFC').toLowerCase();
  c = c.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  c = c.replace(/ς|\u03c2/g, '\u03c3');
  c = c.replace(/\u0085/g, ' ');
  c = c.replace(COMPANY_SUFFIX_REGEX, ' ');
  c = c.replace(/\s+/g, ' ').trim();
  return c;
}

export function cleanTitle(title?: string | null): string {
  if (!title || typeof title !== 'string') return '';
  let t = title.normalize('NFC').toLowerCase();
  t = t.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  t = t.replace(/ς|\u03c2/g, '\u03c3');
  t = t.replace(/\u0085/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function cleanCountry(country?: string | null): string {
  if (!country || typeof country !== 'string') return '';
  let co = country.normalize('NFC').toLowerCase();
  co = co.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  co = co.replace(/ς|\u03c2/g, '\u03c3');
  co = co.replace(/\u0085/g, ' ');
  co = co.replace(/\s+/g, ' ').trim();
  return co;
}

export function cleanLocation(location?: string | null): string {
  if (!location || typeof location !== 'string') return '';
  let loc = location.normalize('NFC').toLowerCase();
  loc = loc.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  loc = loc.replace(/ς|\u03c2/g, '\u03c3');
  loc = loc.replace(/\u0085/g, ' ');
  loc = loc.split(',')[0];
  loc = loc.replace(/\s+/g, ' ').trim();
  return loc;
}

export function buildSimilarityPayloadV2(
  company?: string | null,
  title?: string | null,
  country?: string | null,
  location?: string | null
): string {
  const c = cleanCompany(company);
  const t = cleanTitle(title);
  const co = cleanCountry(country);
  const loc = cleanLocation(location);

  const cLen = Buffer.byteLength(c, 'utf8');
  const tLen = Buffer.byteLength(t, 'utf8');
  const coLen = Buffer.byteLength(co, 'utf8');
  const locLen = Buffer.byteLength(loc, 'utf8');

  return `v2|c:${cLen}:${c}|t:${tLen}:${t}|co:${coLen}:${co}|loc:${locLen}:${loc}`;
}

export function computeSimilarityHashV2(
  company?: string | null,
  title?: string | null,
  country?: string | null,
  location?: string | null
): string {
  const payload = buildSimilarityPayloadV2(company, title, country, location);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Backward-compatible alias pointing to computeSimilarityHashV2.
 */
export function computeDedupeHash(
  company?: string | null,
  title?: string | null,
  country?: string | null,
  location?: string | null
): string {
  return computeSimilarityHashV2(company, title, country, location);
}

// ============================================================================
// 3. ENRICHMENT CLASSIFIERS
// ============================================================================

export function classifyRoleCategory(
  title?: string | null,
  description?: string | null
): RoleCategory {
  const t = (title || '').toLowerCase();
  const desc = (description || '').slice(0, 500).toLowerCase();
  const combined = `${t} ${desc}`;

  if (
    /\b(ai|ml|machine learning|deep learning|llm|genai|generative ai|computer vision|nlp|data scientist|research scientist|applied scientist|prompt engineer)\b/.test(
      t
    )
  ) {
    return 'AI_ML';
  }
  if (
    /\b(cloud|devops|site reliability|sre|platform engineer|infrastructure|systems engineer|k8s|kubernetes|terraform|sysadmin|devsecops|security engineer|network engineer)\b/.test(
      t
    )
  ) {
    return 'CLOUD';
  }
  if (
    /\b(data engineer|data analyst|analytics engineer|business intelligence|\bbi\b|etl|data warehouse|database administrator|\bdba\b|snowflake|databricks|spark)\b/.test(
      t
    )
  ) {
    return 'DATA';
  }
  if (
    /\b(software|sde|developer|engineer|backend|back-end|frontend|front-end|full stack|full-stack|fullstack|mobile|ios|android|web|firmware|embedded|qa|sdet|architect|programmer)\b/.test(
      combined
    ) &&
    !/\b(account executive|sales|recruiter|talent|marketing|finance|accountant|legal|counsel|human resources|customer success)\b/.test(
      t
    )
  ) {
    return 'SDE';
  }
  return 'OTHER';
}

const REMOTE_KEYWORDS_REGEX = /\b(remote|work from home|wfh|telecommute|distributed|anywhere|virtual)\b/i;
const ONSITE_KEYWORDS_REGEX = /\b(on-site|onsite|in-office|in office|hybrid)\b/i;

export function detectRemoteStatus(
  location?: string | null,
  title?: string | null,
  description?: string | null,
  rawRemote?: boolean | null
): boolean {
  const loc = (location || '').toLowerCase();
  const t = (title || '').toLowerCase();

  if (REMOTE_KEYWORDS_REGEX.test(loc) || ['remote', 'telecommute', 'anywhere'].includes(loc.trim())) {
    return true;
  }
  if (REMOTE_KEYWORDS_REGEX.test(t)) {
    return true;
  }
  if (rawRemote === true) {
    if (ONSITE_KEYWORDS_REGEX.test(loc) && !REMOTE_KEYWORDS_REGEX.test(loc)) {
      return false;
    }
    return true;
  }
  return false;
}

const COMMON_TECH_SKILLS = [
  'Python', 'TypeScript', 'JavaScript', 'Java', 'Go', 'Rust', 'C++', 'C#',
  'React', 'Next.js', 'Node.js', 'Vue.js', 'Angular', 'GraphQL', 'REST API',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Kafka', 'Elasticsearch',
  'AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform', 'CI/CD',
  'PyTorch', 'TensorFlow', 'LLM', 'GenAI', 'Spark', 'Snowflake', 'Airflow',
];

export function extractTopKeywords(
  title?: string | null,
  description?: string | null,
  maxKeywords = 8
): string[] {
  const text = `${title || ''} ${(description || '').slice(0, 1000)}`.toLowerCase();
  const matched: string[] = [];
  for (const skill of COMMON_TECH_SKILLS) {
    const regex = new RegExp(`\\b${skill.replace(/[.+]/g, '\\$&')}\\b`, 'i');
    if (regex.test(text)) {
      matched.push(skill);
      if (matched.length >= maxKeywords) break;
    }
  }
  return matched;
}
