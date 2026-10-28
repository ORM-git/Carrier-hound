/**
 * scripts/board-discovery.ts
 *
 * Automated ATS Board Discovery & Verification Engine.
 * Supports: Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Breezy, Teamtailor, Personio, BambooHR, Join.
 *
 * Operational Locks & Rules:
 * - Allowed sources only (public, no login, no scraping of third-party job boards):
 *     a) Common Crawl public URL index (index.commoncrawl.org).
 *     b) Public GitHub open datasets (Feashliaa/job-board-aggregator, AkshatBhat)
 *        [MIT Licensed, recorded in SOURCES.md].
 *     c) Token probing from public company-name lists: slugify variants and verify.
 * - Strictly forbidden domains: LinkedIn, Indeed, Naukri, Glassdoor, Jobright, Workday, ZipRecruiter, JobSpy.
 * - Rate limit: Strictly 1 req/s per host (MIN_DOMAIN_INTERVAL_MS = 1000).
 * - User-Agent: CareerMonkeBot/1.0.
 * - Retry on 429 with Retry-After backoff.
 * - Output: Writes candidates to data/ats-candidates.json or data/ats-candidates-all.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildAtsApiUrl, isAuthorizedAtsUrl, loadCompanyRegistry } from './board-ingest';
import { politeFetchJson, politeFetchText, isForbiddenDomain, sleep } from './utils/polite-fetch';
import { slugify, cleanText } from './utils/sanitizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AtsType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'smartrecruiters'
  | 'recruitee'
  | 'breezy'
  | 'teamtailor'
  | 'personio'
  | 'bamboohr'
  | 'join';

export type DiscoverySource = 'common_crawl' | 'github_open_dataset' | 'company_probe';

export interface DiscoveredTokenCandidate {
  company: string | null;
  ats: AtsType;
  token: string;
  discovery_source: DiscoverySource;
}

export interface AtsCandidate {
  company: string | null;
  ats: AtsType;
  token: string;
  job_count: number;
  verified_at: string;
  discovery_source: DiscoverySource;
}

export interface DiscoveryOptions {
  verifyLimit?: number;
  sourceFilter?: 'all' | DiscoverySource;
  atsFilter?: 'all' | AtsType;
  outputFilePath?: string;
  offlineFixtureMode?: boolean;
}

export interface DiscoveryStats {
  candidatesFoundTotal: number;
  candidatesFoundPerSource: Record<DiscoverySource, number>;
  candidatesTested: number;
  candidatesVerified: number;
  verifiedPerAts: Record<string, number>;
  estimatedTotalJobs: number;
  errorsCount: number;
  newBoardsCount: number;
  existingBoardsOverlapCount: number;
}

/**
 * Sanitizes and validates an ATS token string.
 */
export function sanitizeToken(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (cleaned.length < 2 || cleaned.length > 64) return '';
  if (/^\d+$/.test(cleaned)) return ''; // Numeric-only tokens skipped
  return cleaned;
}

/**
 * Infers a readable company name from a token.
 */
export function inferCompanyName(token: string): string {
  if (!token) return 'Unknown';
  return token
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Deduplicates candidate tokens per ATS type (key: `${ats}:${token.toLowerCase()}`).
 */
export function dedupeCandidates<T extends { ats: string; token: string }>(candidates: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const c of candidates) {
    if (!c || !c.ats || !c.token) continue;
    const cleanTok = sanitizeToken(c.token);
    if (!cleanTok) continue;
    const key = `${c.ats.toLowerCase()}:${cleanTok}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({
        ...c,
        token: cleanTok,
      });
    }
  }

  return result;
}

/**
 * Merges two candidate lists and deduplicates them per ATS.
 */
export function mergeAndDedupeCandidates<T extends { ats: string; token: string }>(
  existingList: T[],
  newList: T[]
): T[] {
  return dedupeCandidates([...existingList, ...newList]);
}

/**
 * Extracts the ATS type and company token from a public URL.
 */
export function extractTokenFromUrl(urlStr: string): { ats: AtsType; token: string } | null {
  if (!urlStr || typeof urlStr !== 'string') return null;
  if (isForbiddenDomain(urlStr)) return null;

  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);

    // Greenhouse
    if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
      if (parts[0] === 'embed' && u.searchParams.get('for')) {
        const token = sanitizeToken(u.searchParams.get('for') || '');
        return token ? { ats: 'greenhouse', token } : null;
      }
      if (parts.length > 0 && !['embed', 'jobs', 'search', 'api'].includes(parts[0].toLowerCase())) {
        const token = sanitizeToken(parts[0]);
        return token ? { ats: 'greenhouse', token } : null;
      }
    }

    // Lever
    if (host === 'jobs.lever.co') {
      if (parts.length > 0 && !['search', 'api'].includes(parts[0].toLowerCase())) {
        const token = sanitizeToken(parts[0]);
        return token ? { ats: 'lever', token } : null;
      }
    }

    // Ashby
    if (host === 'jobs.ashbyhq.com') {
      if (parts.length > 0 && !['search', 'api'].includes(parts[0].toLowerCase())) {
        const token = sanitizeToken(parts[0]);
        return token ? { ats: 'ashby', token } : null;
      }
    }

    // Workable: apply.workable.com/<token>
    if (host === 'apply.workable.com') {
      if (parts.length > 0 && !['search', 'api', 'widget', 'j', 'careers'].includes(parts[0].toLowerCase())) {
        const token = sanitizeToken(parts[0]);
        return token ? { ats: 'workable', token } : null;
      }
    }

    // SmartRecruiters: jobs.smartrecruiters.com/<token>
    if (host === 'jobs.smartrecruiters.com') {
      if (parts.length > 0 && !['search', 'api'].includes(parts[0].toLowerCase())) {
        const token = sanitizeToken(parts[0]);
        return token ? { ats: 'smartrecruiters', token } : null;
      }
    }

    // Recruitee: <token>.recruitee.com
    if (host.endsWith('.recruitee.com')) {
      const sub = host.replace('.recruitee.com', '').split('.').pop() || '';
      if (!['www', 'api', 'app', 'careers', 'blog', 'support', 'status'].includes(sub)) {
        const token = sanitizeToken(sub);
        return token ? { ats: 'recruitee', token } : null;
      }
    }

    // Breezy: <token>.breezy.hr
    if (host.endsWith('.breezy.hr')) {
      const sub = host.replace('.breezy.hr', '').split('.').pop() || '';
      if (!['www', 'api', 'app', 'careers', 'blog', 'support', 'status'].includes(sub)) {
        const token = sanitizeToken(sub);
        return token ? { ats: 'breezy', token } : null;
      }
    }

    // BambooHR: <token>.bamboohr.com/careers
    if (host.endsWith('.bamboohr.com')) {
      const sub = host.replace('.bamboohr.com', '').split('.').pop() || '';
      if (!['www', 'api', 'app', 'careers', 'blog', 'support', 'status'].includes(sub)) {
        const token = sanitizeToken(sub);
        return token ? { ats: 'bamboohr', token } : null;
      }
    }

    // Teamtailor: <token>.teamtailor.com
    if (host.endsWith('.teamtailor.com')) {
      const sub = host.replace('.teamtailor.com', '').split('.').pop() || '';
      if (!['www', 'api', 'app', 'careers', 'blog', 'support', 'status'].includes(sub)) {
        const token = sanitizeToken(sub);
        return token ? { ats: 'teamtailor', token } : null;
      }
    }

    // Personio: <token>.jobs.personio.de or <token>.jobs.personio.com or <token>.personio.de / .com
    if (host.includes('.personio.')) {
      const cleanHost = host
        .replace('.jobs.personio.de', '')
        .replace('.jobs.personio.com', '')
        .replace('.personio.de', '')
        .replace('.personio.com', '');
      const sub = cleanHost.split('.').pop() || '';
      if (!['www', 'api', 'app', 'careers', 'blog', 'support', 'status', 'jobs'].includes(sub)) {
        const token = sanitizeToken(sub);
        return token ? { ats: 'personio', token } : null;
      }
    }

    // Join: <token>.join.com or join.com/companies/<token>
    if (host === 'join.com' || host === 'www.join.com') {
      if (parts[0] === 'companies' && parts.length > 1) {
        const token = sanitizeToken(parts[1]);
        return token ? { ats: 'join', token } : null;
      }
    } else if (host.endsWith('.join.com')) {
      const sub = host.replace('.join.com', '').split('.').pop() || '';
      if (!['www', 'api', 'app', 'careers', 'blog', 'support', 'status'].includes(sub)) {
        const token = sanitizeToken(sub);
        return token ? { ats: 'join', token } : null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Verifies a single candidate token against the documented public ATS API.
 * Rate limited to 1 req/s per host, User-Agent CareerMonkeBot/1.0.
 */
export async function verifyAtsToken(
  ats: AtsType,
  token: string
): Promise<{
  verified: boolean;
  jobCount: number;
  status: number;
  companyName: string | null;
  error?: string;
}> {
  const cleanTok = sanitizeToken(token);
  if (!cleanTok) {
    return { verified: false, jobCount: 0, status: 400, companyName: null, error: 'Malformed token' };
  }

  let url: string;
  try {
    url = buildAtsApiUrl(ats as any, cleanTok);
  } catch (err: any) {
    return { verified: false, jobCount: 0, status: 400, companyName: null, error: err.message };
  }

  if (!isAuthorizedAtsUrl(url, ats)) {
    return { verified: false, jobCount: 0, status: 403, companyName: null, error: 'Forbidden or unauthorized ATS URL' };
  }

  try {
    const data = await politeFetchJson<any>(url, { retries: 0 });
    if (!data) {
      return { verified: false, jobCount: 0, status: 404, companyName: null, error: 'Empty or not found' };
    }

    let jobCount = 0;
    let companyName: string | null = null;

    if (ats === 'greenhouse') {
      jobCount = Array.isArray(data.jobs) ? data.jobs.length : 0;
      if (Array.isArray(data.jobs) && data.jobs.length > 0 && data.jobs[0]?.company_name) {
        companyName = String(data.jobs[0].company_name).trim() || null;
      }
    } else if (ats === 'lever') {
      jobCount = Array.isArray(data) ? data.length : 0;
    } else if (ats === 'ashby') {
      jobCount = Array.isArray(data.jobs) ? data.jobs.length : 0;
    } else if (ats === 'workable') {
      jobCount = Array.isArray(data.jobs) ? data.jobs.length : 0;
    } else if (ats === 'smartrecruiters') {
      jobCount = Array.isArray(data.content) ? data.content.length : 0;
    } else if (ats === 'recruitee') {
      jobCount = Array.isArray(data.offers) ? data.offers.length : 0;
    } else if (ats === 'breezy') {
      jobCount = Array.isArray(data) ? data.length : 0;
    }

    const verified = jobCount >= 1;
    return {
      verified,
      jobCount,
      status: 200,
      companyName,
      error: verified ? undefined : 'Board returned 0 active jobs',
    };
  } catch (err: any) {
    const status = err.message?.includes('404') ? 404 : 500;
    return { verified: false, jobCount: 0, status, companyName: null, error: err.message };
  }
}

/**
 * Source (a): Discovers tokens via Common Crawl URL index.
 */
export async function discoverFromCommonCrawl(limit = 100): Promise<DiscoveredTokenCandidate[]> {
  console.log('📡 [Source a] Querying Common Crawl public URL index...');
  const candidates: DiscoveredTokenCandidate[] = [];
  const seenKeys = new Set<string>();

  let indexId = 'CC-MAIN-2026-43';
  try {
    const collinfoUrl = 'https://index.commoncrawl.org/collinfo.json';
    const collinfo = await politeFetchJson<any[]>(collinfoUrl, { skipRobotsCheck: true, timeoutMs: 8000 });
    if (Array.isArray(collinfo) && collinfo.length > 0 && collinfo[0].id) {
      indexId = collinfo[0].id;
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not fetch collinfo, using fallback ${indexId}: ${err.message}`);
  }

  const queries = [
    { ats: 'greenhouse' as AtsType, pattern: 'boards.greenhouse.io/*' },
    { ats: 'greenhouse' as AtsType, pattern: 'job-boards.greenhouse.io/*' },
    { ats: 'lever' as AtsType, pattern: 'jobs.lever.co/*' },
    { ats: 'ashby' as AtsType, pattern: 'jobs.ashbyhq.com/*' },
    { ats: 'workable' as AtsType, pattern: 'apply.workable.com/*' },
    { ats: 'recruitee' as AtsType, pattern: '*.recruitee.com/*' },
    { ats: 'breezy' as AtsType, pattern: '*.breezy.hr/*' },
    { ats: 'bamboohr' as AtsType, pattern: '*.bamboohr.com/careers/*' },
    { ats: 'personio' as AtsType, pattern: '*.personio.de/*' },
    { ats: 'personio' as AtsType, pattern: '*.personio.com/*' },
    { ats: 'join' as AtsType, pattern: 'join.com/companies/*' },
  ];

  const perQueryLimit = Math.max(10, Math.floor(limit / queries.length));

  for (const q of queries) {
    try {
      const cdxUrl = `https://index.commoncrawl.org/${indexId}-index?url=${encodeURIComponent(q.pattern)}&output=json&limit=${perQueryLimit}`;
      const text = await politeFetchText(cdxUrl, { skipRobotsCheck: true, timeoutMs: 12000 });

      const lines = text.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.url) {
            const extracted = extractTokenFromUrl(parsed.url);
            if (extracted) {
              const key = `${extracted.ats}:${extracted.token}`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                candidates.push({
                  company: null,
                  ats: extracted.ats,
                  token: extracted.token,
                  discovery_source: 'common_crawl',
                });
              }
            }
          }
        } catch {
          // Ignore corrupted line
        }
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Common Crawl query failed for ${q.pattern}: ${err.message}`);
    }
  }

  console.log(`   Found ${candidates.length} candidates from Common Crawl.`);
  return candidates;
}

/**
 * Source (b): Discovers tokens from open-source GitHub datasets (Feashliaa & AkshatBhat).
 */
export async function discoverFromGitHubDatasets(): Promise<DiscoveredTokenCandidate[]> {
  console.log('📂 [Source b] Fetching public GitHub open datasets (MIT Licensed)...');
  const candidates: DiscoveredTokenCandidate[] = [];
  const seenKeys = new Set<string>();

  const datasets: Array<{ ats: AtsType; url: string }> = [
    { ats: 'greenhouse', url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/greenhouse_companies.json' },
    { ats: 'lever', url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/lever_companies.json' },
    { ats: 'ashby', url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/ashby_companies.json' },
    { ats: 'bamboohr', url: 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/bamboohr_companies.json' },
  ];

  for (const ds of datasets) {
    try {
      const data = await politeFetchJson<string[]>(ds.url);
      if (Array.isArray(data)) {
        for (const item of data) {
          const token = sanitizeToken(item);
          if (token) {
            const key = `${ds.ats}:${token}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              candidates.push({
                company: null,
                ats: ds.ats,
                token,
                discovery_source: 'github_open_dataset',
              });
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`   ⚠️ GitHub dataset fetch error for ${ds.ats}: ${err.message}`);
    }
  }

  // Also query AkshatBhat Ashby CSV dataset
  try {
    const csvUrl = 'https://raw.githubusercontent.com/AkshatBhat/find-companies-using-ashby-job-boards/main/examples/example_verified_ashby_slugs.csv';
    const text = await politeFetchText(csvUrl, { timeoutMs: 8000 });
    const rows = text.split('\n').map((r) => r.trim()).filter(Boolean);
    for (const row of rows.slice(1)) {
      const parts = row.split(',');
      const slug = sanitizeToken(parts[0] || '');
      const companyName = cleanText(parts[1] || '') || null;
      if (slug) {
        const key = `ashby:${slug}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          candidates.push({
            company: companyName,
            ats: 'ashby',
            token: slug,
            discovery_source: 'github_open_dataset',
          });
        }
      }
    }
  } catch (err: any) {
    console.warn(`   ⚠️ AkshatBhat CSV fetch error: ${err.message}`);
  }

  console.log(`   Found ${candidates.length} candidates from GitHub open datasets.`);
  return candidates;
}

/**
 * Source (c): Discovers tokens via company name probing against existing seed lists.
 */
export function discoverFromCompanyProbing(): DiscoveredTokenCandidate[] {
  console.log('🔍 [Source c] Generating candidates from internal company datasets...');
  const candidates: DiscoveredTokenCandidate[] = [];
  const seenKeys = new Set<string>();

  const configFiles = [
    path.resolve(__dirname, 'config/companies-phase2.json'),
    path.resolve(__dirname, '../src/data/companies.json'),
    path.resolve(__dirname, '../data/ats-company-registry.json'),
  ];

  const ATS_LIST: AtsType[] = [
    'greenhouse',
    'lever',
    'ashby',
    'workable',
    'smartrecruiters',
    'recruitee',
    'breezy',
    'teamtailor',
    'personio',
    'bamboohr',
    'join',
  ];

  for (const file of configFiles) {
    if (fs.existsSync(file)) {
      try {
        const items = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (Array.isArray(items)) {
          for (const item of items) {
            const rawName = item.name || item.company || '';
            const rawSlug = item.slug || item.target || slugify(rawName);
            const token = sanitizeToken(rawSlug);

            if (token) {
              for (const ats of ATS_LIST) {
                const key = `${ats}:${token}`;
                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  candidates.push({
                    company: rawName || null,
                    ats,
                    token,
                    discovery_source: 'company_probe',
                  });
                }
              }
            }
          }
        }
      } catch (err: any) {
        console.warn(`   ⚠️ Error reading company probe source ${file}: ${err.message}`);
      }
    }
  }

  console.log(`   Found ${candidates.length} candidates from company probing.`);
  return candidates;
}

/**
 * Runs the Board Discovery Pipeline (Dry-Run / Verification Mode).
 */
export async function runBoardDiscovery(options: DiscoveryOptions = {}): Promise<{
  candidates: AtsCandidate[];
  stats: DiscoveryStats;
}> {
  const {
    verifyLimit = 50,
    sourceFilter = 'all',
    atsFilter = 'all',
    outputFilePath,
    offlineFixtureMode = false,
  } = options;

  console.log('\n======================================================');
  console.log('🌐 CareerMonke ATS Board Discovery Engine');
  console.log('======================================================');
  console.log(`Mode:           DRY RUN (Public API Verification Only)`);
  console.log(`Rate Pacing:    1 req/s per host (MIN_DOMAIN_INTERVAL_MS = 1000)`);
  console.log(`Verify Limit:   ${verifyLimit}`);
  console.log(`Source Filter:  ${sourceFilter}`);
  console.log(`ATS Filter:     ${atsFilter}\n`);

  const mainRegistry = loadCompanyRegistry();
  const existingKeys = new Set(mainRegistry.map((e) => `${e.ats}:${e.token.toLowerCase()}`));

  let rawCandidates: DiscoveredTokenCandidate[] = [];

  if (offlineFixtureMode) {
    rawCandidates = [
      { company: 'Stripe', ats: 'greenhouse', token: 'stripe', discovery_source: 'company_probe' },
      { company: 'Spotify', ats: 'lever', token: 'spotify', discovery_source: 'github_open_dataset' },
      { company: 'OpenAI', ats: 'ashby', token: 'openai', discovery_source: 'common_crawl' },
    ];
  } else {
    if (sourceFilter === 'all' || sourceFilter === 'common_crawl') {
      const cc = await discoverFromCommonCrawl(150);
      rawCandidates.push(...cc);
    }
    if (sourceFilter === 'all' || sourceFilter === 'github_open_dataset') {
      const gh = await discoverFromGitHubDatasets();
      rawCandidates.push(...gh);
    }
    if (sourceFilter === 'all' || sourceFilter === 'company_probe') {
      const cp = discoverFromCompanyProbing();
      rawCandidates.push(...cp);
    }
  }

  const candidatesPerSource: Record<DiscoverySource, number> = {
    common_crawl: 0,
    github_open_dataset: 0,
    company_probe: 0,
  };

  const filteredCandidates: DiscoveredTokenCandidate[] = [];
  for (const c of rawCandidates) {
    candidatesPerSource[c.discovery_source] = (candidatesPerSource[c.discovery_source] || 0) + 1;
    if (atsFilter !== 'all' && c.ats !== atsFilter) continue;
    filteredCandidates.push(c);
  }

  const dedupedCandidates = dedupeCandidates(filteredCandidates);
  console.log(`\nAggregated ${dedupedCandidates.length} unique candidates across sources.`);

  let queue: DiscoveredTokenCandidate[] = [];
  if (verifyLimit && verifyLimit > 0 && dedupedCandidates.length > verifyLimit) {
    queue = dedupedCandidates.slice(0, verifyLimit);
  } else {
    queue = dedupedCandidates;
  }

  console.log(`Starting public API verification for ${queue.length} tokens...\n`);

  const verifiedCandidates: AtsCandidate[] = [];
  const verifiedPerAts: Record<string, number> = {};
  let estimatedTotalJobs = 0;
  let errorsCount = 0;
  let newBoardsCount = 0;
  let existingOverlapCount = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const prefix = `[${i + 1}/${queue.length}] [${item.ats.toUpperCase()}] ${item.company || 'Unknown'} (${item.token})`;

    try {
      const res = await verifyAtsToken(item.ats, item.token);

      if (res.verified && res.jobCount >= 1) {
        const verifiedRecord: AtsCandidate = {
          company: res.companyName || item.company || null,
          ats: item.ats,
          token: item.token,
          job_count: res.jobCount,
          verified_at: new Date().toISOString(),
          discovery_source: item.discovery_source,
        };

        verifiedCandidates.push(verifiedRecord);
        verifiedPerAts[item.ats] = (verifiedPerAts[item.ats] || 0) + 1;
        estimatedTotalJobs += res.jobCount;

        const isNew = !existingKeys.has(`${item.ats}:${item.token}`);
        if (isNew) newBoardsCount++;
        else existingOverlapCount++;

        console.log(`   ✅ ${prefix}: VERIFIED (${res.jobCount} jobs${isNew ? ', NEW' : ', existing'})`);
      } else {
        errorsCount++;
        console.log(`   ❌ ${prefix}: REJECTED (${res.error || '0 jobs / 404'})`);
      }
    } catch (err: any) {
      errorsCount++;
      console.warn(`   ⚠️ ${prefix}: Error (${err.message})`);
    }
  }

  const resolvedOutputPath = outputFilePath
    ? path.resolve(outputFilePath)
    : path.resolve(__dirname, '../data/ats-candidates.json');

  let existingSavedCandidates: AtsCandidate[] = [];
  if (fs.existsSync(resolvedOutputPath)) {
    try {
      existingSavedCandidates = JSON.parse(fs.readFileSync(resolvedOutputPath, 'utf-8'));
    } catch {
      existingSavedCandidates = [];
    }
  }

  const finalCandidates = mergeAndDedupeCandidates(existingSavedCandidates, verifiedCandidates);
  fs.writeFileSync(resolvedOutputPath, JSON.stringify(finalCandidates, null, 2), 'utf-8');

  const stats: DiscoveryStats = {
    candidatesFoundTotal: dedupedCandidates.length,
    candidatesFoundPerSource: candidatesPerSource,
    candidatesTested: queue.length,
    candidatesVerified: verifiedCandidates.length,
    verifiedPerAts,
    estimatedTotalJobs,
    errorsCount,
    newBoardsCount,
    existingBoardsOverlapCount: existingOverlapCount,
  };

  return { candidates: verifiedCandidates, stats };
}

// Direct CLI invocation
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  const limitIdx = args.findIndex((a) => a === '--limit');
  const verifyLimit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 30;

  const srcIdx = args.findIndex((a) => a === '--source');
  const sourceFilter = srcIdx !== -1 ? (args[srcIdx + 1] as any) : 'all';

  const atsIdx = args.findIndex((a) => a === '--ats');
  const atsFilter = atsIdx !== -1 ? (args[atsIdx + 1] as any) : 'all';

  runBoardDiscovery({ verifyLimit, sourceFilter, atsFilter })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal Discovery Error:', err);
      process.exit(1);
    });
}
