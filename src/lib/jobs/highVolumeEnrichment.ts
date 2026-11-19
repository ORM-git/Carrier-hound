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

/**
 * Write gate: every jobs row must carry a canonical source_id. The unique index on
 * (source_id, source_job_id) is partial (source_id IS NOT NULL), so a NULL row would bypass it.
 */
export function assertCanonicalSourceIds(rows: Array<{ source_id?: string | null }>): void {
  const missing = rows.filter((r) => typeof r.source_id !== 'string' || !r.source_id.trim()).length;
  if (missing > 0) {
    throw new Error(`Refusing jobs write: ${missing} row(s) have no canonical source_id`);
  }
}

const WHITESPACE_REGEX =/[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
const COMPANY_SUFFIX_REGEX = new RegExp(
  '(?<![\\p{L}\\p{N}_])(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\\.?(?![\\p{L}\\p{N}_])',
  'gui'
);

export function cleanLocationKey(locationKey?: string | null): string {
  if (!locationKey || typeof locationKey !== 'string') return '';
  let loc = locationKey.normalize('NFC').toLowerCase();
  loc = loc.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  loc = loc.replace(/ς|\u03c2/g, '\u03c3');
  loc = loc.replace(/\u0085/g, ' ');
  loc = loc.replace(WHITESPACE_REGEX, ' ').trim();
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

export function cleanCompany(company?: string | null): string {
  if (!company || typeof company !== 'string') return '';
  let c = company.normalize('NFKC').toLowerCase();
  c = c.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  c = c.replace(/ς|\u03c2/g, '\u03c3').replace(/ß/g, 'ss');
  c = c.replace(/\u0085/g, ' ');
  c = c.replace(COMPANY_SUFFIX_REGEX, ' ');
  c = c.replace(WHITESPACE_REGEX, ' ').trim();
  return c;
}

export function cleanTitle(title?: string | null): string {
  if (!title || typeof title !== 'string') return '';
  let t = title.normalize('NFKC').toLowerCase();
  t = t.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  t = t.replace(/ς|\u03c2/g, '\u03c3').replace(/ß/g, 'ss');
  t = t.replace(/\u0085/g, ' ');
  t = t.replace(WHITESPACE_REGEX, ' ').trim();
  return t;
}

export function cleanCountry(country?: string | null): string {
  if (!country || typeof country !== 'string') return '';
  let co = country.normalize('NFKC').toLowerCase();
  co = co.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  co = co.replace(/ς|\u03c2/g, '\u03c3').replace(/ß/g, 'ss');
  co = co.replace(/\u0085/g, ' ');
  co = co.replace(WHITESPACE_REGEX, ' ').trim();
  return co;
}

export function cleanLocation(location?: string | null): string {
  if (!location || typeof location !== 'string') return '';
  let loc = location.normalize('NFKC').toLowerCase();
  loc = loc.replace(/İ|\u0130/g, 'i').replace(/i\u0307/g, 'i');
  loc = loc.replace(/ς|\u03c2/g, '\u03c3').replace(/ß/g, 'ss');
  loc = loc.replace(/\u0085/g, ' ');
  loc = loc.split(',')[0];
  loc = loc.replace(WHITESPACE_REGEX, ' ').trim();
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

/** Minimum code points in the cleaned company and title before a row may be deduped. */
export const MIN_DEDUPE_FIELD_CHARS = 2;

/**
 * Dedupe key for "same role" grouping, or null when the row must never be deduped
 * (an empty or near-empty company/title would merge unrelated jobs into one group).
 */
export function dedupeKey(
  company?: string | null,
  title?: string | null,
  country?: string | null,
  location?: string | null
): string | null {
  if (
    Array.from(cleanCompany(company)).length < MIN_DEDUPE_FIELD_CHARS ||
    Array.from(cleanTitle(title)).length < MIN_DEDUPE_FIELD_CHARS
  ) {
    return null;
  }
  return computeSimilarityHashV2(company, title, country, location);
}

/**
 * Apply URL as a requisition identity: drops the fragment and a trailing slash, keeps the
 * query (it often carries the requisition id, e.g. ?gh_jid=123). '' when absent.
 */
export function normalizeApplyUrl(url?: string | null): string {
  const raw = (url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Same-role key that also carries requisition identity (apply URL). Two postings with
 * identical listing text but different apply URLs never share a key.
 */
export function requisitionDedupeKey(textKey: string | null, applyUrl?: string | null): string | null {
  return textKey && `${textKey}|${normalizeApplyUrl(applyUrl)}`;
}

/**
 * Role key (company + title + full location + apply URL), Unicode-safe. Null when company or title
 * is empty/too short: such jobs are never deduped (ASCII slugs collapsed non-Latin roles together).
 * The apply URL keeps two requisitions with identical listing text apart.
 */
export function boardRoleKey(j: {
  company?: string | null;
  title?: string | null;
  location?: string | null;
  apply_url?: string | null;
}): string | null {
  const k = dedupeKey(j.company, j.title);
  return requisitionDedupeKey(k && `${k}::${cleanLocationKey(j.location || 'unspecified')}`, j.apply_url);
}

/**
 * Cross-role dedup skip: the role key is already held by a DIFFERENT source. A holder from the
 * same source has a different source_job_id, so it is a distinct requisition and never skips.
 */
export function isCrossRoleDuplicate(roleSources: Map<string, Set<string>>, roleKey: string | null, source: string): boolean {
  const holders = roleKey ? roleSources.get(roleKey) : undefined;
  return !!holders && !holders.has(source);
}

/** Canonical `<vendor>:<board_token>` for a board row; throws when the board slug is missing. */
export function boardSourceId(j: { source: string; company_slug?: string }): string {
  return buildSourceId(j.source.replace(/-board$/, ''), j.company_slug || '');
}

export function addRoleSource(roleSources: Map<string, Set<string>>, roleKey: string | null, source: string): void {
  if (!roleKey) return;
  const holders = roleSources.get(roleKey);
  if (holders) holders.add(source);
  else roleSources.set(roleKey, new Set([source]));
}

export interface DedupeRow {
  id: string;
  company?: string | null;
  title?: string | null;
  country?: string | null;
  location?: string | null;
  last_seen_at?: string | null;
  /** Requisition identity: (source, source_job_id) is unique, so two rows of one source are distinct requisitions. */
  source?: string | null;
  source_job_id?: string | null;
  apply_url?: string | null;
  descLen: number;
}

type ExpiryItem = { id: string; keptId: string; key: string };

export interface DuplicateExpiryPlan {
  /** Every duplicate found, in expiry order. */
  candidates: ExpiryItem[];
  /** What this run would expire (empty when blocked). */
  toExpire: ExpiryItem[];
  /** Rows skipped because their key was empty or too short. */
  ineligible: number;
  /** Rows kept because their text-matching group holds distinct requisitions (same source, different job id). */
  distinctRequisitions: number;
  /** 1% of the active rows scanned (floored). */
  onePercent: number;
  /** True when duplicates exceed 1% of active rows and the override flag was not given. */
  blocked: boolean;
}

/**
 * Plans duplicate expiry: groups active rows by requisitionDedupeKey (listing text + apply URL),
 * keeps the row with the longest description (then latest last_seen_at), and caps the run at
 * maxExpire. A group with two rows from the same source is distinct requisitions and is never
 * expired. Refuses (blocked) when duplicates exceed 1% of the active rows unless allowOverOnePercent.
 */
export function planDuplicateExpiry(
  activeRows: DedupeRow[],
  opts: { maxExpire: number; allowOverOnePercent: boolean }
): DuplicateExpiryPlan {
  const groups = new Map<string, DedupeRow[]>();
  let ineligible = 0;
  let distinctRequisitions = 0;
  for (const r of activeRows) {
    const key = requisitionDedupeKey(dedupeKey(r.company, r.title, r.country, r.location), r.apply_url);
    if (!key) {
      ineligible++;
      continue;
    }
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const candidates: ExpiryItem[] = [];
  groups.forEach((group, key) => {
    if (group.length < 2) return;
    const sources = new Set(group.map((r) => (r.source || '').trim().toLowerCase()));
    if (sources.size < group.length) {
      distinctRequisitions += group.length;
      return;
    }
    group.sort((a, b) => b.descLen - a.descLen || (b.last_seen_at || '').localeCompare(a.last_seen_at || ''));
    for (let i = 1; i < group.length; i++) candidates.push({ id: group[i].id, keptId: group[0].id, key });
  });

  const onePercent = Math.floor(activeRows.length * 0.01);
  const blocked = candidates.length > onePercent && !opts.allowOverOnePercent;
  const toExpire = blocked ? [] : candidates.slice(0, Math.max(0, opts.maxExpire));
  return { candidates, toExpire, ineligible, distinctRequisitions, onePercent, blocked };
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
