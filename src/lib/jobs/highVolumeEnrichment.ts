/**
 * High-Volume Job Ingestion Identity & Similarity Helpers (v2)
 *
 * Implements byte-for-byte parity with PostgreSQL public.compute_job_similarity_hash_v2()
 * and Python scripts.scraper.enrichment.compute_similarity_hash_v2().
 */

// Browser/Edge-safe: no Node built-ins here (this module is bundled into client and Edge code).
// Hashing uses the pure-JS sha256Hex below.
const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

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
      const locLen = utf8Len(cleanLoc);
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

  const cLen = utf8Len(c);
  const tLen = utf8Len(t);
  const coLen = utf8Len(co);
  const locLen = utf8Len(loc);

  return `v2|c:${cLen}:${c}|t:${tLen}:${t}|co:${coLen}:${co}|loc:${locLen}:${loc}`;
}

export function computeSimilarityHashV2(
  company?: string | null,
  title?: string | null,
  country?: string | null,
  location?: string | null
): string {
  return sha256Hex(buildSimilarityPayloadV2(company, title, country, location));
}

/**
 * Backward-compatible alias pointing to computeSimilarityHashV2.
 */
export function computeDedupeHash(
  company: string | null | undefined,
  title: string | null | undefined,
  country?: string | null,
  location?: string | null
): string {
  const normCompany = (company || '')
    .toLowerCase()
    .trim()
    .replace(/\b(inc|llc|ltd|corp|corporation|limited|pvt|private|gmbh|plc|co)\b\.?/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const normTitle = (title || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const rawCountry = (country || '').trim();
  const normCountry = (rawCountry || 'any')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || 'any';

  const firstCityPart = (location || '').split(',')[0] || '';
  const normCity = firstCityPart
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || 'any';

  const payload = `${normCompany}|${normTitle}|${normCountry}|${normCity}`;
  return sha256Hex(payload);
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
 * Apply URL as a requisition identity: drops a trailing path slash, keeps the query and the
 * fragment (either can carry the requisition id, e.g. ?gh_jid=123 or #/jobs/123). '' when absent.
 */
export function normalizeApplyUrl(url?: string | null): string {
  const raw = (url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Same-role key that also carries requisition identity (apply URL). Two postings with
 * identical listing text but different apply URLs never share a key. Null when the apply URL
 * is missing: without an identity the row is kept, never inferred to match another.
 */
export function requisitionDedupeKey(textKey: string | null, applyUrl?: string | null): string | null {
  const url = normalizeApplyUrl(applyUrl);
  return textKey && url ? `${textKey}|${url}` : null;
}

/**
 * Run-scoped dedupe by requisition identity, shared by board-ingest and ingest. A job is a
 * duplicate only when it repeats a seen (source, source_job_id), or its apply URL is already held
 * by a DIFFERENT source. Same-source jobs with different ids are distinct requisitions and are
 * always kept, even with identical text or a shared apply URL. Listing text alone never matches.
 */
export class RequisitionTracker {
  private readonly ids = new Set<string>();
  private readonly urlSources = new Map<string, Set<string>>();

  isDuplicate(job: { source: string; source_job_id: string; apply_url?: string | null }): boolean {
    if (this.ids.has(`${job.source}\u0000${job.source_job_id}`)) return true;
    return isCrossRoleDuplicate(this.urlSources, normalizeApplyUrl(job.apply_url) || null, job.source);
  }

  add(job: { source: string; source_job_id: string; apply_url?: string | null }): void {
    this.ids.add(`${job.source}\u0000${job.source_job_id}`);
    addRoleSource(this.urlSources, normalizeApplyUrl(job.apply_url) || null, job.source);
  }
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


const MNC_BIGTECH_SLUGS = new Set([
  'google', 'alphabet', 'meta', 'facebook', 'apple', 'amazon', 'aws', 'microsoft',
  'netflix', 'nvidia', 'uber', 'airbnb', 'salesforce', 'adobe', 'oracle', 'ibm',
  'intel', 'amd', 'qualcomm', 'cisco', 'sap', 'vmware', 'broadcom', 'paypal',
  'intuit', 'servicenow', 'workday', 'atlassian', 'snowflake', 'snowflakecomputing',
  'datadog', 'palantir', 'splunk', 'crowdstrike', 'paloaltonetworks', 'zscaler',
  'zscalerredcanary', 'cloudflare', 'mongodb', 'elastic', 'twilio', 'okta',
  'docusign', 'zoom', 'dropbox', 'box', 'shopify', 'spotify', 'pinterest',
  'reddit', 'snap', 'lyft', 'doordash', 'doordashusa', 'doordashindia',
  'instacart', 'wayfair', 'ebay', 'booking', 'expedia', 'tripadvisor', 'agoda',
  'bloomberg', 'goldmansachs', 'jpmorgan', 'morganstanley', 'blackrock', 'citadel',
  'twosigma', 'janestreet', 'hrt', 'visa', 'mastercard', 'americanexpress',
  'fidelity', 'capitalone', 'barclays', 'hsbc', 'deutschebank', 'ubs',
  'walmart', 'target', 'tesco', 'nike', 'disney', 'sony', 'samsung', 'lg',
  'siemens', 'bosch', 'philips', 'ge', 'honeywell', 'dell', 'hp', 'lenovo',
  'asus', 'ericsson', 'nokia', 'canonical', 'redhat', 'suse', 'github', 'gitlab',
  'linkedin', 'robinhood', 'coinbase', 'block', 'square', 'affirm', 'sofi',
  'klaviyo', 'hubspot', 'zendesk', 'freshworks', 'zoho', 'unity', 'epicgames',
  'roblox', 'ea', 'activision', 'riotgames', 'autodesk', 'synopsys', 'cadence',
  'arm', 'asml', 'tsmc', 'micron', 'western-digital', 'seagate', 'netapp',
  'purestorage', 'nutanix', 'akamai', 'fastly', 'hashi', 'hashicorp', 'confluent',
]);

const HIGH_PRODUCT_YC_SLUGS = new Set([
  'stripe', 'openai', 'anthropic', 'perplexity', 'perplexityai', 'linear',
  'notion', 'figma', 'vercel', 'supabase', 'planetscale', 'neon', 'render',
  'railway', 'fly', 'replit', 'cursor', 'anysphere', 'cognition', 'elevenlabs',
  'cohere', 'mistral', 'huggingface', 'scale', 'scaleai', 'anyscale', 'modal',
  'baseten', 'together', 'togetherai', 'fireworks', 'groq', 'weightsandbiases',
  'wandb', 'langchain', 'pinecone', 'weaviate', 'qdrant', 'milvus', 'chroma',
  'databricks', 'dbt', 'dbtlabs', 'fivetran', 'airbyte', 'temporal', 'prefect',
  'dagster', 'clickhouse', 'timescale', 'cockroachlabs', 'yugabyte', 'grafanalabs',
  'grafana', 'posthog', 'amplitude', 'mixpanel', 'segment', 'sentry', 'launchdarkly',
  'retool', 'airtable', 'webflow', 'framer', 'canva', 'miro', 'loom', 'calendly',
  'zapier', 'make', 'n8n', 'ashby', 'deel', 'rippling', 'gusto', 'remote',
  'oyster', 'lattice', 'carta', 'brex', 'ramp', 'mercury', 'plaid', 'adye',
  'adyen', 'checkout', 'marqeta', 'wise', 'revolut', 'monzo', 'chime',
  'vanta', 'drata', 'secureframe', 'snyk', 'wiz', 'orca', 'lacework',
  '1password', 'bitwarden', 'tailscale', 'ngrok', 'Teleport', 'teleport',
  'postman', 'insomnia', 'kong', 'apollo', 'hasura', 'prisma', 'turso',
  'upstash', 'inngest', 'trigger', 'resend', 'loops', 'clerk', 'workos',
  'stytch', 'auth0', 'descope', 'razorpay', 'cred', 'zerodha', 'groww',
  'swiggy', 'zomato', 'meesho', 'phonepe', 'zepto', 'blinkit', 'flipkart',
  'postman', 'browserstack', 'chargebee', 'clevertap', 'sarvam', 'krutim',
]);

const INDIAN_IT_AND_OTHER_SLUGS = new Set([
  'tcs', 'tataconsultancyservices', 'infosys', 'wipro', 'hcl', 'hcltech',
  'techmahindra', 'cognizant', 'capgemini', 'accenture', 'deloitte', 'pwc',
  'ey', 'ernstandyoung', 'kpmg', 'ltimindtree', 'mindtree', 'ltts', 'mphasis',
  'persistent', 'persistentsystems', 'coforge', 'hexaware', 'zensar', 'birlasoft',
  'cyient', 'sonata', 'kpit', 'tataelxsi', 'happiestminds', 'mastek', 'newgen',
  'intellectdesign', 'ramco', 'subex', 'nucleusteq', 'infogain', 'ust',
  'ustglobal', 'virtusa', 'epam', 'globant', 'luxoft', 'endava', 'thoughtworks',
  'publicissapient', 'nttdata', 'atos', 'dxc', 'dxctechnology', 'cgi',
  'unisys', 'kyndryl', 'genpact', 'wns', 'exl', 'firstsource', 'hindujaglobal',
  'teleperformance', 'concentrix', 'taskus', 'sutherland', 'mu-sigma', 'musigma',
  'fractal', 'tigeranalytics', 'latentview', 'tredence', 'quantiphi', 'nagarro',
  'igtsolutions', 'yash', 'yashtechnologies', 'marlabs', 'cigniti', 'testingxperts',
  'infosysbpm', 'tcsion', 'wiproenterprises', 'jio', 'airtel', 'paytm', 'ola',
  'byjus', 'unacademy', 'upgrad', 'nykaa', 'lenskart', 'policybazaar',
  'makemytrip', 'infoedge', 'naukri', 'delhivery', 'shiprocket', 'cars24',
]);

function normalizeToken(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Classifies a company into one of the 4 canonical categories:
 * 'MNC_BIGTECH' | 'HIGH_PRODUCT_YC' | 'OTHER_STARTUPS' | 'INDIAN_IT_AND_OTHER'
 */
export function detectCompanyCategory(
  companyName: string | null | undefined,
  slug?: string | null,
  domain?: string | null,
  countryCode?: string | null
): CompanyCategory {
  const normName = normalizeToken(companyName);
  const normSlug = normalizeToken(slug);
  const normDomain = normalizeToken(domain ? domain.split('.')[0] : '');

  const candidates = [normSlug, normName, normDomain].filter(Boolean);

  for (const token of candidates) {
    if (MNC_BIGTECH_SLUGS.has(token)) return 'MNC_BIGTECH';
    if (HIGH_PRODUCT_YC_SLUGS.has(token)) return 'HIGH_PRODUCT_YC';
    if (INDIAN_IT_AND_OTHER_SLUGS.has(token)) return 'INDIAN_IT_AND_OTHER';
  }

  for (const token of candidates) {
    for (const mnc of Array.from(MNC_BIGTECH_SLUGS)) {
      if (mnc.length >= 5 && token.startsWith(mnc)) return 'MNC_BIGTECH';
    }
    for (const yc of Array.from(HIGH_PRODUCT_YC_SLUGS)) {
      if (yc.length >= 5 && token.startsWith(yc)) return 'HIGH_PRODUCT_YC';
    }
    for (const it of Array.from(INDIAN_IT_AND_OTHER_SLUGS)) {
      if (it.length >= 5 && token.startsWith(it)) return 'INDIAN_IT_AND_OTHER';
    }
  }

  const rawLower = `${companyName || ''} ${slug || ''} ${domain || ''}`.toLowerCase();
  if (
    /\b(consultancy|consulting|services|outsourcing|infotech|technologies pvt|solutions pvt|staffing|bpo)\b/i.test(rawLower) ||
    (countryCode && countryCode.toUpperCase() === 'IN' && /\b(limited|ltd|pvt)\b/i.test(rawLower))
  ) {
    return 'INDIAN_IT_AND_OTHER';
  }

  return 'OTHER_STARTUPS';
}

/**
 * Classifies a job into one of the 5 canonical role categories:
 * 'SDE' | 'AI_ML' | 'CLOUD' | 'DATA' | 'OTHER'
 */
export function detectRoleCategory(
  title: string | null | undefined,
  category?: string | null,
  skillsOrTags?: string[] | null
): RoleCategory {
  const t = (title || '').toLowerCase();
  const c = (category || '').toLowerCase();
  const tags = Array.isArray(skillsOrTags) ? skillsOrTags.join(' ').toLowerCase() : '';
  const combined = `${t} ${c} ${tags}`;

  // 1. AI_ML
  if (
    c === 'ai' ||
    c === 'ai-ml' ||
    c === 'ai_ml' ||
    /\b(ai|ml|machine learning|deep learning|llm|genai|generative ai|nlp|natural language|computer vision|data scientist|research scientist|applied scientist|mlops|prompt engineer|neural)\b/i.test(t)
  ) {
    return 'AI_ML';
  }

  // 2. CLOUD (Cloud, DevOps, SRE, Platform, Infra, Security)
  if (
    c === 'devops' ||
    c === 'cloud' ||
    c === 'cyber-security' ||
    /\b(cloud|devops|sre|site reliability|infrastructure|platform engineer|kubernetes|aws|gcp|azure|terraform|devsecops|security engineer|cybersecurity|network engineer|systems engineer|linux administrator)\b/i.test(t)
  ) {
    return 'CLOUD';
  }

  // 3. DATA (Data Engineering, Analytics, BI, Database)
  if (
    c === 'data' ||
    c === 'data-analytics' ||
    /\b(data engineer|data analyst|analytics engineer|business intelligence|\bbi\b|etl|data warehouse|database administrator|\bdba\b|snowflake|databricks|spark engineer|data platform|data architecture|data architect)\b/i.test(t)
  ) {
    return 'DATA';
  }

  // 4. SDE (Software Development, Backend, Frontend, Full Stack, Mobile, QA/SDET, Embedded)
  if (
    c === 'engineering' ||
    c === 'software' ||
    c === 'qa-testing' ||
    /\b(software|sde|developer|engineer|backend|back-end|frontend|front-end|full stack|full-stack|fullstack|mobile|ios|android|react|node|python|java|golang|rust|c\+\+|dotnet|\.net|web|application|firmware|embedded|qa|sdet|test engineer|architect|programmer|coder)\b/i.test(combined)
  ) {
    // Exclude non-engineering manager/director roles if title is clearly sales/marketing/hr/finance
    if (!/\b(account executive|sales|recruiter|talent|marketing|finance|accountant|legal|counsel|human resources|customer success)\b/i.test(t)) {
      return 'SDE';
    }
  }

  return 'OTHER';
}

/**
 * Curated canonical technical keyword dictionary for fast extraction of top 8 skills from JD & title.
 */
const TECHNICAL_KEYWORD_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'TypeScript', regex: /\btypescript\b/i },
  { label: 'JavaScript', regex: /\b(javascript|es6|ecmascript)\b/i },
  { label: 'Python', regex: /\bpython\b/i },
  { label: 'Java', regex: /\bjava\b/i },
  { label: 'Go', regex: /\b(golang|go\s+language)\b/i },
  { label: 'Rust', regex: /\brust\b/i },
  { label: 'C++', regex: /(?:^|[\s,(\/])c\+\+(?:$|[\s,).\/])/i },
  { label: 'C#', regex: /(?:^|[\s,(\/])c#|(?:^|[\s,(\/])\.net\b/i },
  { label: 'React', regex: /\b(react|reactjs|react\.js)\b/i },
  { label: 'Next.js', regex: /\b(next\.js|nextjs)\b/i },
  { label: 'Node.js', regex: /\b(node\.js|nodejs)\b/i },
  { label: 'Vue.js', regex: /\b(vue|vuejs|vue\.js)\b/i },
  { label: 'Angular', regex: /\bangular\b/i },
  { label: 'Svelte', regex: /\bsvelte\b/i },
  { label: 'GraphQL', regex: /\bgraphql\b/i },
  { label: 'REST API', regex: /\b(rest\s*apis?|restful)\b/i },
  { label: 'gRPC', regex: /\bgrpc\b/i },
  { label: 'SQL', regex: /\bsql\b/i },
  { label: 'PostgreSQL', regex: /\b(postgresql|postgres)\b/i },
  { label: 'MySQL', regex: /\bmysql\b/i },
  { label: 'MongoDB', regex: /\bmongodb\b/i },
  { label: 'Redis', regex: /\bredis\b/i },
  { label: 'Kafka', regex: /\bkafka\b/i },
  { label: 'RabbitMQ', regex: /\brabbitmq\b/i },
  { label: 'Elasticsearch', regex: /\b(elasticsearch|opensearch)\b/i },
  { label: 'AWS', regex: /\b(aws|amazon web services)\b/i },
  { label: 'GCP', regex: /\b(gcp|google cloud)\b/i },
  { label: 'Azure', regex: /\bazure\b/i },
  { label: 'Docker', regex: /\bdocker\b/i },
  { label: 'Kubernetes', regex: /\b(kubernetes|k8s)\b/i },
  { label: 'Terraform', regex: /\bterraform\b/i },
  { label: 'Ansible', regex: /\bansible\b/i },
  { label: 'CI/CD', regex: /\b(ci\/cd|github actions|gitlab ci|jenkins)\b/i },
  { label: 'Linux', regex: /\b(linux|unix)\b/i },
  { label: 'PyTorch', regex: /\bpytorch\b/i },
  { label: 'TensorFlow', regex: /\btensorflow\b/i },
  { label: 'LLM', regex: /\b(llms?|large language models?)\b/i },
  { label: 'GenAI', regex: /\b(genai|generative ai)\b/i },
  { label: 'RAG', regex: /\b(rag|retrieval[- ]augmented)\b/i },
  { label: 'LangChain', regex: /\blangchain\b/i },
  { label: 'NLP', regex: /\b(nlp|natural language processing)\b/i },
  { label: 'Computer Vision', regex: /\bcomputer vision\b/i },
  { label: 'Machine Learning', regex: /\bmachine learning\b/i },
  { label: 'Deep Learning', regex: /\bdeep learning\b/i },
  { label: 'MLOps', regex: /\bmlops\b/i },
  { label: 'Spark', regex: /\b(apache spark|pyspark|spark)\b/i },
  { label: 'Snowflake', regex: /\bsnowflake\b/i },
  { label: 'Databricks', regex: /\bdatabricks\b/i },
  { label: 'BigQuery', regex: /\bbigquery\b/i },
  { label: 'Airflow', regex: /\bairflow\b/i },
  { label: 'dbt', regex: /\bdbt\b/i },
  { label: 'Pandas', regex: /\bpandas\b/i },
  { label: 'Scikit-Learn', regex: /\b(scikit-learn|sklearn)\b/i },
  { label: 'Spring Boot', regex: /\b(spring boot|spring)\b/i },
  { label: 'Django', regex: /\bdjango\b/i },
  { label: 'FastAPI', regex: /\bfastapi\b/i },
  { label: 'Flask', regex: /\bflask\b/i },
  { label: 'Ruby on Rails', regex: /\b(ruby on rails|rails|ruby)\b/i },
  { label: 'PHP', regex: /\b(php|laravel)\b/i },
  { label: 'Kotlin', regex: /\bkotlin\b/i },
  { label: 'Swift', regex: /\bswift\b/i },
  { label: 'Flutter', regex: /\bflutter\b/i },
  { label: 'React Native', regex: /\breact native\b/i },
  { label: 'iOS', regex: /\bios\b/i },
  { label: 'Android', regex: /\bandroid\b/i },
  { label: 'Microservices', regex: /\bmicroservices\b/i },
  { label: 'Distributed Systems', regex: /\bdistributed systems\b/i },
  { label: 'System Design', regex: /\bsystem design\b/i },
  { label: 'Tailwind CSS', regex: /\btailwind\b/i },
  { label: 'Prisma', regex: /\bprisma\b/i },
  { label: 'Supabase', regex: /\bsupabase\b/i },
  { label: 'DynamoDB', regex: /\bdynamodb\b/i },
  { label: 'Cassandra', regex: /\bcassandra\b/i },
  { label: 'ClickHouse', regex: /\bclickhouse\b/i },
  { label: 'Prometheus', regex: /\bprometheus\b/i },
  { label: 'Grafana', regex: /\bgrafana\b/i },
  { label: 'Datadog', regex: /\bdatadog\b/i },
  { label: 'Playwright', regex: /\bplaywright\b/i },
  { label: 'Cypress', regex: /\bcypress\b/i },
  { label: 'Selenium', regex: /\bselenium\b/i },
];

/**
 * Extracts up to `maxKeywords` (default 8) matched technical skills from existing skills, title, and JD.
 */
export function extractTopKeywords(
  title?: string | null,
  description?: string | null,
  existingSkills?: string[] | null | number,
  maxKeywords: number = 8
): string[] {
  let effectiveSkills: string[] | null = null;
  let effectiveLimit = maxKeywords;

  if (typeof existingSkills === 'number') {
    effectiveLimit = existingSkills;
  } else if (Array.isArray(existingSkills)) {
    effectiveSkills = existingSkills;
  }

  const result: string[] = [];
  const seenLower = new Set<string>();

  const pushUnique = (kw: string) => {
    const trimmed = kw.trim();
    if (!trimmed || trimmed.length > 35) return;
    const lower = trimmed.toLowerCase();
    if (seenLower.has(lower)) return;
    seenLower.add(lower);
    result.push(trimmed);
  };

  if (Array.isArray(effectiveSkills)) {
    for (const sk of effectiveSkills) {
      if (typeof sk === 'string' && sk.trim()) {
        pushUnique(sk);
        if (result.length >= effectiveLimit) return result.slice(0, effectiveLimit);
      }
    }
  }

  // First pass: match title (highest signal)
  const titleText = title || '';
  if (titleText) {
    for (const { label, regex } of TECHNICAL_KEYWORD_PATTERNS) {
      if (regex.test(titleText)) {
        pushUnique(label);
        if (result.length >= effectiveLimit) return result.slice(0, effectiveLimit);
      }
    }
  }

  // Second pass: match description (JD)
  const descText = description || '';
  if (descText) {
    for (const { label, regex } of TECHNICAL_KEYWORD_PATTERNS) {
      if (regex.test(descText)) {
        pushUnique(label);
        if (result.length >= effectiveLimit) return result.slice(0, effectiveLimit);
      }
    }
  }

  return result.slice(0, effectiveLimit);
}

/**
 * Returns source priority:
 * 1 = Direct ATS board ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', etc.)
 * 2 = Aggregators / Feeds ('adzuna', 'remotive', 'arbeitnow', 'remoteok', 'weworkremotely', etc.)
 */
export function getSourcePriority(sourceType?: string | null, source?: string | null): 1 | 2 {
  const st = (sourceType || '').toLowerCase().trim();
  if (st === 'ats' || st === 'direct') return 1;
  const s = (source || '').toLowerCase().trim();
  if (
    s === 'greenhouse' ||
    s === 'lever' ||
    s === 'ashby' ||
    s === 'smartrecruiters' ||
    s === 'recruitee' ||
    s === 'workable' ||
    s === 'breezy' ||
    s === 'teamtailor' ||
    s === 'personio' ||
    s === 'bamboohr' ||
    s === 'join'
  ) {
    return 1;
  }
  return 2;
}

/**
 * Pure synchronous FIPS 180-4 SHA-256 implementation (works identically in Edge Runtime & Node CLI).
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(asciiOrUtf8: string): string {
  const bytes = new TextEncoder().encode(asciiOrUtf8);
  const bitLen = bytes.length * 8;
  const totalBytes = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(totalBytes - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalBytes - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Computes deterministic SHA-256 hex digest of normalized company + normalized title + country + city.
 * Matches PostgreSQL `public.compute_job_dedupe_hash(company, title, country, location)` byte-for-byte.
 */
