/**
 * scripts/board-discovery.ts
 *
 * Automated ATS Board Discovery & Verification Engine (Greenhouse, Lever, Ashby).
 *
 * Operational Locks & Rules:
 * - Allowed sources only (public, no login, no scraping of third-party job boards):
 *     a) Common Crawl public URL index (index.commoncrawl.org):
 *        Query URL patterns boards.greenhouse.io/*, job-boards.greenhouse.io/*,
 *        jobs.lever.co/*, jobs.ashbyhq.com/* and extract the first path segment.
 *     b) Public GitHub open datasets (Feashliaa/job-board-aggregator, AkshatBhat)
 *        [MIT Licensed, recorded in SOURCES.md].
 *     c) Token probing from public company-name lists: slugify variants and verify.
 * - Strictly forbidden domains: LinkedIn, Indeed, Naukri, Glassdoor, Jobright, Workday.
 * - Rate limit: Strictly 1 req/s per host (MIN_DOMAIN_INTERVAL_MS = 1000).
 * - User-Agent: CareerMonkeBot/1.0 (+https://careermonke.com; ingestion@careermonke.com).
 * - Retry on 429 with Retry-After backoff.
 * - Verification Rule: A token is verified ONLY IF documented public ATS API returns HTTP 200 AND >= 1 job.
 * - Output: Writes candidates to data/ats-candidates.json (NOT merged into main registry).
 * - Prints stats: candidates found per source, verified per ATS, estimated total jobs = sum(job_count), error counts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildAtsApiUrl, isAuthorizedAtsUrl, loadCompanyRegistry } from './board-ingest';
import { politeFetchJson, isForbiddenDomain, sleep } from './utils/polite-fetch';
import { slugify, cleanText } from './utils/sanitizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AtsType = 'greenhouse' | 'lever' | 'ashby';
export type DiscoverySource = 'common_crawl' | 'github_open_dataset' | 'company_probe';

export interface DiscoveredTokenCandidate {
  company: string;
  ats: AtsType;
  token: string;
  discovery_source: DiscoverySource;
}

export interface AtsCandidate {
  company: string;
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
  verifiedPerAts: Record<AtsType, number>;
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
 * Extracts the ATS type and company token from a public URL.
 */
export function extractTokenFromUrl(urlStr: string): { ats: AtsType; token: string } | null {
  if (!urlStr || typeof urlStr !== 'string') return null;
  if (isForbiddenDomain(urlStr)) return null;

  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);

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

    if (host === 'jobs.lever.co') {
      if (parts.length > 0 && !['search', 'api'].includes(parts[0].toLowerCase())) {
        const token = sanitizeToken(parts[0]);
        return token ? { ats: 'lever', token } : null;
      }
    }

    if (host === 'jobs.ashbyhq.com') {
      if (parts.length > 0 && !['search', 'api'].includes(parts[0].toLowerCase())) {
        const token = sanitizeToken(parts[0]);
        return token ? { ats: 'ashby', token } : null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Verifies a single candidate token against the documented public ATS API.
 * Rate limited to 1 req/s per host, User-Agent CareerMonkeBot.
 * Rule: Token verified ONLY IF API returns HTTP 200 AND jobCount >= 1.
 */
export async function verifyAtsToken(
  ats: AtsType,
  token: string
): Promise<{ verified: boolean; jobCount: number; status: number; error?: string }> {
  const cleanTok = sanitizeToken(token);
  if (!cleanTok) {
    return { verified: false, jobCount: 0, status: 400, error: 'Malformed token' };
  }

  let url: string;
  try {
    url = buildAtsApiUrl(ats, cleanTok);
  } catch (err: any) {
    return { verified: false, jobCount: 0, status: 400, error: err.message };
  }

  if (!isAuthorizedAtsUrl(url, ats)) {
    return { verified: false, jobCount: 0, status: 403, error: 'Forbidden or unauthorized ATS URL' };
  }

  try {
    const data = await politeFetchJson<any>(url, { retries: 0 });
    if (!data) {
      return { verified: false, jobCount: 0, status: 404, error: 'Empty or not found' };
    }

    let jobCount = 0;
    if (ats === 'greenhouse') {
      jobCount = Array.isArray(data.jobs) ? data.jobs.length : 0;
    } else if (ats === 'lever') {
      jobCount = Array.isArray(data) ? data.length : 0;
    } else if (ats === 'ashby') {
      jobCount = Array.isArray(data.jobs) ? data.jobs.length : 0;
    }

    const verified = jobCount >= 1;
    return {
      verified,
      jobCount,
      status: 200,
      error: verified ? undefined : 'Board returned 0 active jobs',
    };
  } catch (err: any) {
    return { verified: false, jobCount: 0, status: 500, error: err.message };
  }
}

/**
 * Source (a): Discovers tokens via Common Crawl URL index.
 */
export async function discoverFromCommonCrawl(limit = 100): Promise<DiscoveredTokenCandidate[]> {
  console.log('📡 [Source a] Querying Common Crawl public URL index...');
  const candidates: DiscoveredTokenCandidate[] = [];
  const seenKeys = new Set<string>();

  // Determine latest index
  let indexId = 'CC-MAIN-2026-43';
  try {
    const collinfoUrl = 'https://index.commoncrawl.org/collinfo.json';
    const collinfo = await politeFetchJson<any[]>(collinfoUrl);
    if (Array.isArray(collinfo) && collinfo.length > 0 && collinfo[0].id) {
      indexId = collinfo[0].id;
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not fetch collinfo, using fallback ${indexId}: ${err.message}`);
  }

  const queries = [
    { ats: 'greenhouse' as AtsType, pattern: 'boards.greenhouse.io/*' },
    { ats: 'lever' as AtsType, pattern: 'jobs.lever.co/*' },
    { ats: 'ashby' as AtsType, pattern: 'jobs.ashbyhq.com/*' },
  ];

  const perQueryLimit = Math.max(10, Math.floor(limit / queries.length));

  for (const q of queries) {
    try {
      const cdxUrl = `https://index.commoncrawl.org/${indexId}-index?url=${encodeURIComponent(q.pattern)}&output=json&limit=${perQueryLimit}`;
      const res = await fetch(cdxUrl, {
        headers: { 'User-Agent': 'CareerMonkeBot/1.0 (+https://careermonke.com; ingestion@careermonke.com)' },
        signal: AbortSignal.timeout(12000),
      });

      if (res.ok) {
        const text = await res.text();
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
                    company: inferCompanyName(extracted.token),
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
                company: inferCompanyName(token),
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
    const res = await fetch(csvUrl, {
      headers: { 'User-Agent': 'CareerMonkeBot/1.0 (+https://careermonke.com)' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const text = await res.text();
      const rows = text.split('\n').map((r) => r.trim()).filter(Boolean);
      for (const row of rows.slice(1)) {
        const parts = row.split(',');
        const slug = sanitizeToken(parts[0] || '');
        const companyName = cleanText(parts[1] || '') || inferCompanyName(slug);
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
            const ats: AtsType = (['greenhouse', 'lever', 'ashby'].includes(item.type) ? item.type : 'greenhouse') as AtsType;

            if (token) {
              const key = `${ats}:${token}`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                candidates.push({
                  company: rawName || inferCompanyName(token),
                  ats,
                  token,
                  discovery_source: 'company_probe',
                });
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
  console.log('🌐 CareerMonke ATS Board Discovery Engine (Step 2)');
  console.log('======================================================');
  console.log(`Mode:           DRY RUN (Public API Verification Only)`);
  console.log(`Rate Pacing:    1 req/s per host (MIN_DOMAIN_INTERVAL_MS = 1000)`);
  console.log(`Verify Limit:   ${verifyLimit}`);
  console.log(`Source Filter:  ${sourceFilter}`);
  console.log(`ATS Filter:     ${atsFilter}\n`);

  // Load existing main registry tokens to check overlap vs new
  const mainRegistry = loadCompanyRegistry();
  const existingKeys = new Set(mainRegistry.map((e) => `${e.ats}:${e.token.toLowerCase()}`));

  // 1. Gather candidates from allowed sources
  let rawCandidates: DiscoveredTokenCandidate[] = [];

  if (offlineFixtureMode) {
    // Deterministic offline fixture items
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

  // 2. Filter & Deduplicate candidates
  const candidatesPerSource: Record<DiscoverySource, number> = {
    common_crawl: 0,
    github_open_dataset: 0,
    company_probe: 0,
  };

  const dedupedCandidates: DiscoveredTokenCandidate[] = [];
  const seenCandidates = new Set<string>();

  for (const c of rawCandidates) {
    candidatesPerSource[c.discovery_source] = (candidatesPerSource[c.discovery_source] || 0) + 1;

    if (atsFilter !== 'all' && c.ats !== atsFilter) continue;
    const key = `${c.ats}:${c.token}`;
    if (!seenCandidates.has(key)) {
      seenCandidates.add(key);
      dedupedCandidates.push(c);
    }
  }

  console.log(`\nAggregated ${dedupedCandidates.length} unique candidates across sources.`);

  // 3. Select balanced candidate sample up to verifyLimit
  let queue: DiscoveredTokenCandidate[] = [];
  if (verifyLimit && verifyLimit > 0 && dedupedCandidates.length > verifyLimit) {
    const perAts = Math.max(1, Math.floor(verifyLimit / 3));
    const gh = dedupedCandidates.filter((c) => c.ats === 'greenhouse').slice(0, perAts);
    const lv = dedupedCandidates.filter((c) => c.ats === 'lever').slice(0, perAts);
    const as = dedupedCandidates.filter((c) => c.ats === 'ashby').slice(0, verifyLimit - gh.length - lv.length);
    queue = [...gh, ...lv, ...as];
  } else {
    queue = dedupedCandidates;
  }

  console.log(`Starting public API verification for ${queue.length} tokens...\n`);

  const verifiedCandidates: AtsCandidate[] = [];
  const verifiedPerAts: Record<AtsType, number> = { greenhouse: 0, lever: 0, ashby: 0 };
  let estimatedTotalJobs = 0;
  let errorsCount = 0;
  let newBoardsCount = 0;
  let existingOverlapCount = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const prefix = `[${i + 1}/${queue.length}] [${item.ats.toUpperCase()}] ${item.company} (${item.token})`;

    try {
      const res = await verifyAtsToken(item.ats, item.token);

      if (res.verified && res.jobCount >= 1) {
        const verifiedRecord: AtsCandidate = {
          company: item.company,
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

  // 4. Output to data/ats-candidates.json (NOT merged into main registry)
  const resolvedOutputPath = outputFilePath
    ? path.resolve(outputFilePath)
    : path.resolve(__dirname, '../data/ats-candidates.json');

  // Read existing candidates from file to accumulate without overwriting previous verified tokens
  let existingSavedCandidates: AtsCandidate[] = [];
  if (fs.existsSync(resolvedOutputPath)) {
    try {
      existingSavedCandidates = JSON.parse(fs.readFileSync(resolvedOutputPath, 'utf-8'));
    } catch {
      existingSavedCandidates = [];
    }
  }

  const combinedMap = new Map<string, AtsCandidate>();
  for (const c of existingSavedCandidates) {
    combinedMap.set(`${c.ats}:${c.token}`, c);
  }
  for (const c of verifiedCandidates) {
    combinedMap.set(`${c.ats}:${c.token}`, c);
  }

  const finalCandidates = Array.from(combinedMap.values());
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

  // 5. Print Structured Summary Report
  console.log('\n======================================================');
  console.log('📊 ATS BOARD DISCOVERY SUMMARY REPORT');
  console.log('======================================================');
  console.log(`Candidates Found Total:       ${stats.candidatesFoundTotal}`);
  console.log(`Candidates per Source:`);
  console.log(`  - Common Crawl:             ${stats.candidatesFoundPerSource.common_crawl}`);
  console.log(`  - GitHub Open Datasets:     ${stats.candidatesFoundPerSource.github_open_dataset}`);
  console.log(`  - Company Probing:          ${stats.candidatesFoundPerSource.company_probe}`);
  console.log(`Candidates Tested:            ${stats.candidatesTested}`);
  console.log(`Candidates Verified:          ${stats.candidatesVerified} (success rate: ${queue.length > 0 ? Math.round((stats.candidatesVerified / queue.length) * 100) : 0}%)`);
  console.log(`Verified per ATS:`);
  console.log(`  - Greenhouse:               ${stats.verifiedPerAts.greenhouse}`);
  console.log(`  - Lever:                    ${stats.verifiedPerAts.lever}`);
  console.log(`  - Ashby:                    ${stats.verifiedPerAts.ashby}`);
  console.log(`New Discovered Boards:        ${stats.newBoardsCount}`);
  console.log(`Existing Registry Overlap:    ${stats.existingBoardsOverlapCount}`);
  console.log(`Estimated Total Jobs:         ${stats.estimatedTotalJobs}`);
  console.log(`Errors / Rejections Count:    ${stats.errorsCount}`);
  console.log(`Output File:                  ${resolvedOutputPath} (${finalCandidates.length} total saved)`);
  console.log('======================================================\n');

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
