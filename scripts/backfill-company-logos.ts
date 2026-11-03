/**
 * scripts/backfill-company-logos.ts
 *
 * Backfill script for company logos in Supabase database & Storage.
 *
 * Requirements:
 * - Service role client (reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).
 * - Dry-run by default. Pass `--write` to apply uploads and database updates.
 * - Pass `--missing-only` or `--schedule` to evaluate only companies currently without a logo.
 * - Fully idempotent.
 * - Derives candidate board URLs:
 *     greenhouse: https://job-boards.greenhouse.io/<slug> (fallback: https://boards.greenhouse.io/<slug>)
 *     ashby:      https://jobs.ashbyhq.com/<slug>
 *     lever:      https://jobs.lever.co/<slug>
 * - Favicon / apple-touch-icon vs og:image preference:
 *     If the page has a favicon or apple-touch-icon of at least 128px (width & height >= 128),
 *     use that over og:image. Otherwise fallback to og:image.
 * - Image dimensions check:
 *     Skip when width / height > 1.6 or < 0.6 (prefer square-ish images).
 *     Minimum dimension >= 32px (128px preferred for board icons).
 * - Generic default filter:
 *     Skip any image URL shared by 3 or more companies.
 * - Allowed formats: raster images only (png, jpeg/jpg, webp, gif). SVG is strictly excluded.
 * - Homepage & Free Logo Service Fallback for companies still without logo_url:
 *     1. Derive company website domain from job, company data, or board metadata (never guess).
 *     2. Fetch homepage, take largest apple-touch-icon or icon >= 32px with ratio 0.6..1.6.
 *     3. Free logo service fallback (Unavatar -> Google Favicons -> DuckDuckGo).
 *     Prioritize companies appearing in the 200 most recent active jobs.
 * - In --write mode:
 *     Uploads to 'company-logos' bucket at <company_id>.<ext> (upsert: true).
 *     Deletes old file(s) when extension changes.
 *     Sets companies.logo_url to the public storage URL (and sets companies.domain).
 * - In dry-run mode (default):
 *     Prints company, domain, source and candidate image URL per row.
 *     Generates and outputs the exact SQL queries for review before any DB write.
 * - Prints found/missing/failed per ats_type summary table and rollback SQL:
 *     UPDATE companies SET logo_url = null WHERE logo_url LIKE '%company-logos%';
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import {
  cleanDomain as libCleanDomain,
  isAtsHost as libIsAtsHost,
  deriveCompanyDomain as libDeriveCompanyDomain,
  getImageDimensions as libGetImageDimensions,
  getCleanImageMeta as libGetCleanImageMeta,
  fetchWithTimeout as libFetchWithTimeout,
  downloadAndValidateImage as libDownloadAndValidateImage,
  parsePageImages as libParsePageImages,
  fetchFreeLogoService as libFetchFreeLogoService,
  MAX_IMAGE_BYTES,
  REQUEST_TIMEOUT_MS,
  CONCURRENCY as LIB_CONCURRENCY,
  USER_AGENT,
  ATS_HOST_KEYWORDS,
} from "../src/lib/companies/logoResolver";

export interface CompanyRow {
  id: string;
  name: string;
  slug: string | null;
  domain?: string | null;
  careers_url?: string | null;
  ats_type: string | null;
  logo_url: string | null;
}

export interface JobInfo {
  company?: string | null;
  company_id?: string | null;
  apply_url?: string | null;
  source_url?: string | null;
}

export interface AtsStats {
  found: number;
  missing: number;
  failed: number;
  already_set: number;
  total: number;
}

export interface CandidateLogo {
  company: CompanyRow;
  ats: string;
  boardUrl: string;
  imageUrl: string;
  source: "icon" | "og:image" | "homepage-icon" | "free-service";
  serviceName?: string;
  domain?: string;
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
}

export interface CompanyInspection {
  company: CompanyRow;
  ats: string;
  boardUrl: string;
  iconCandidate: CandidateLogo | null;
  ogCandidate: CandidateLogo | null;
  ashbyPublicWebsite?: string | null;
  extractedDomain?: string | null;
  status: "inspected" | "already_set" | "missing" | "failed";
  reason?: string;
}

export { MAX_IMAGE_BYTES, REQUEST_TIMEOUT_MS, USER_AGENT, ATS_HOST_KEYWORDS };
export const CONCURRENCY = LIB_CONCURRENCY || 8;

export const isAtsHost = libIsAtsHost;
export const cleanDomain = libCleanDomain;
export const getImageDimensions = libGetImageDimensions;
export const getCleanImageMeta = libGetCleanImageMeta;
export const fetchWithTimeout = libFetchWithTimeout;
export const parsePageImages = libParsePageImages;
export const fetchFreeLogoService = libFetchFreeLogoService;

export function deriveCompanyDomain(
  company: CompanyRow,
  jobsForCompany: JobInfo[],
  ashbyPublicWebsite?: string | null,
  boardHtmlOrDomain?: string | null
): string | null {
  return libDeriveCompanyDomain(
    company,
    jobsForCompany,
    ashbyPublicWebsite,
    boardHtmlOrDomain
  );
}

export function selectLargestQualifyingIcon<
  T extends { width: number; height: number; url: string }
>(candidates: T[]): T | null {
  const qualifying = candidates.filter((item) => {
    if (item.width < 128 || item.height < 128) return false;
    const ratio = item.width / item.height;
    return ratio >= 0.6 && ratio <= 1.6;
  });

  if (qualifying.length === 0) return null;

  qualifying.sort((a, b) => {
    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    if (areaB !== areaA) return areaB - areaA;
    return b.width - a.width;
  });

  return qualifying[0];
}

export async function downloadAndValidateImage(
  url: string,
  minSize: number = 32
): Promise<{
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
} | null> {
  return libDownloadAndValidateImage(url, minSize);
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function inspectCompany(company: CompanyRow): Promise<CompanyInspection> {
  if (company.logo_url && company.logo_url.includes("company-logos")) {
    return {
      company,
      ats: company.ats_type || "unknown",
      boardUrl: "",
      iconCandidate: null,
      ogCandidate: null,
      status: "already_set",
      reason: "Already pointing to bucket",
    };
  }

  const ats = (company.ats_type || "unknown").toLowerCase().trim();
  const slug = (company.slug || "").trim();

  if (!slug) {
    return {
      company,
      ats,
      boardUrl: "",
      iconCandidate: null,
      ogCandidate: null,
      status: "missing",
      reason: "No slug",
    };
  }

  const candidateUrls: string[] = [];
  if (ats === "greenhouse") {
    candidateUrls.push(`https://job-boards.greenhouse.io/${slug}`);
    candidateUrls.push(`https://boards.greenhouse.io/${slug}`);
  } else if (ats === "ashby") {
    candidateUrls.push(`https://jobs.ashbyhq.com/${slug}`);
  } else if (ats === "lever") {
    candidateUrls.push(`https://jobs.lever.co/${slug}`);
  } else {
    return {
      company,
      ats,
      boardUrl: "",
      iconCandidate: null,
      ogCandidate: null,
      status: "missing",
      reason: `Unsupported ats_type: ${ats}`,
    };
  }

  let html = "";
  let activeBoardUrl = "";
  let lastError = "";

  for (const url of candidateUrls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      html = await res.text();
      activeBoardUrl = url;
      break;
    } catch (err: any) {
      lastError = err?.message || "Fetch failed";
    }
  }

  if (!html || !activeBoardUrl) {
    return {
      company,
      ats,
      boardUrl: "",
      iconCandidate: null,
      ogCandidate: null,
      status: "missing",
      reason: lastError || "Board page not reachable",
    };
  }

  // Extract Ashby publicWebsite if available
  let ashbyPublicWebsite: string | null = null;
  let extractedDomain: string | null = null;

  if (ats === "ashby") {
    const m = html.match(/"publicWebsite":\s*"([^"]+)"/);
    if (m && m[1]) {
      ashbyPublicWebsite = decodeHtmlEntities(m[1].trim());
      extractedDomain = cleanDomain(ashbyPublicWebsite);
    }
  } else if (ats === "greenhouse") {
    // 1. Schema.org Organization url
    const jsonLdMatch =
      html.match(/"@type":\s*"Organization"[^}]*"url":\s*"([^"]+)"/i) ||
      html.match(/"url":\s*"([^"]+)"[^}]*"@type":\s*"Organization"/i);
    if (jsonLdMatch && jsonLdMatch[1]) {
      extractedDomain = cleanDomain(jsonLdMatch[1]);
    }
    // 2. Anchor tags on board page
    if (!extractedDomain) {
      const aMatches = Array.from(html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)).map(
        (m) => m[1]
      );
      for (const h of aMatches) {
        if (!h.startsWith("http") && !h.startsWith("mailto:")) continue;
        const d = cleanDomain(h);
        if (d && !d.includes("greenhouse")) {
          extractedDomain = d;
          break;
        }
      }
    }
  } else if (ats === "lever") {
    const aMatches = Array.from(html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)).map(
      (m) => m[1]
    );
    for (const h of aMatches) {
      if (!h.startsWith("http") && !h.startsWith("mailto:")) continue;
      const d = cleanDomain(h);
      if (d && !d.includes("lever.co")) {
        extractedDomain = d;
        break;
      }
    }
  }

  const { iconUrls, ogImageUrl } = parsePageImages(html, activeBoardUrl);

  let iconCandidate: CandidateLogo | null = null;
  let ogCandidate: CandidateLogo | null = null;

  // 1. Inspect icon candidates (favicon / apple-touch-icon of at least 128px)
  for (const icon of iconUrls) {
    const imgData = await downloadAndValidateImage(icon.url, 128);
    if (imgData) {
      const ratio = imgData.width / imgData.height;
      if (ratio <= 1.6 && ratio >= 0.6) {
        iconCandidate = {
          company,
          ats,
          boardUrl: activeBoardUrl,
          imageUrl: icon.url,
          source: "icon",
          domain: extractedDomain || undefined,
          buffer: imgData.buffer,
          contentType: imgData.contentType,
          ext: imgData.ext,
          width: imgData.width,
          height: imgData.height,
        };
        break;
      }
    }
  }

  // 2. Inspect og:image candidate (aspect ratio between 0.6 and 1.6)
  if (ogImageUrl) {
    const imgData = await downloadAndValidateImage(ogImageUrl, 128);
    if (imgData) {
      const ratio = imgData.width / imgData.height;
      if (ratio <= 1.6 && ratio >= 0.6) {
        ogCandidate = {
          company,
          ats,
          boardUrl: activeBoardUrl,
          imageUrl: ogImageUrl,
          source: "og:image",
          domain: extractedDomain || undefined,
          buffer: imgData.buffer,
          contentType: imgData.contentType,
          ext: imgData.ext,
          width: imgData.width,
          height: imgData.height,
        };
      }
    }
  }

  return {
    company,
    ats,
    boardUrl: activeBoardUrl,
    iconCandidate,
    ogCandidate,
    ashbyPublicWebsite,
    extractedDomain,
    status: iconCandidate || ogCandidate ? "inspected" : "missing",
    reason: iconCandidate || ogCandidate ? undefined : "No square-ish icon or og:image found on board",
  };
}

export async function inspectCompanyHomepage(
  company: CompanyRow,
  domain: string,
  minSize: number = 32
): Promise<CandidateLogo | null> {
  const homeUrls = [`https://${domain}`, `https://www.${domain}`];
  let html = "";
  let finalUrl = "";

  for (const hUrl of homeUrls) {
    try {
      const res = await fetchWithTimeout(hUrl);
      if (res.ok) {
        html = await res.text();
        finalUrl = res.url || hUrl;
        break;
      }
    } catch {}
  }

  if (!html || !finalUrl) {
    return null;
  }

  const { iconUrls, ogImageUrl } = parsePageImages(html, finalUrl);

  try {
    const rootApple = new URL("/apple-touch-icon.png", finalUrl).toString();
    if (!iconUrls.some((i) => i.url === rootApple)) {
      iconUrls.push({ url: rootApple, declaredSize: 180 });
    }
  } catch {}

  const downloadedCandidates: Array<{
    url: string;
    width: number;
    height: number;
    contentType: string;
    ext: string;
    buffer: Buffer;
  }> = [];

  for (const icon of iconUrls) {
    const imgData = await downloadAndValidateImage(icon.url, minSize);
    if (imgData) {
      downloadedCandidates.push({
        url: icon.url,
        width: imgData.width,
        height: imgData.height,
        contentType: imgData.contentType,
        ext: imgData.ext,
        buffer: imgData.buffer,
      });
    }
  }

  let best = selectLargestQualifyingIcon(downloadedCandidates);

  if (!best && downloadedCandidates.length > 0) {
    downloadedCandidates.sort((a, b) => b.width * b.height - a.width * a.height);
    best = downloadedCandidates[0];
  }

  if (best) {
    return {
      company,
      ats: company.ats_type || "unknown",
      boardUrl: finalUrl,
      imageUrl: best.url,
      source: "homepage-icon",
      domain,
      buffer: best.buffer,
      contentType: best.contentType,
      ext: best.ext,
      width: best.width,
      height: best.height,
    };
  }

  if (ogImageUrl) {
    const imgData = await downloadAndValidateImage(ogImageUrl, minSize);
    if (imgData) {
      return {
        company,
        ats: company.ats_type || "unknown",
        boardUrl: finalUrl,
        imageUrl: ogImageUrl,
        source: "homepage-icon",
        domain,
        buffer: imgData.buffer,
        contentType: imgData.contentType,
        ext: imgData.ext,
        width: imgData.width,
        height: imgData.height,
      };
    }
  }

  return null;
}

export async function runBackfill() {
  const isWrite = process.argv.includes("--write");
  const missingOnly = process.argv.includes("--missing-only") || process.argv.includes("--schedule");
  const limitIdx = process.argv.indexOf("--limit");
  const limitVal = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : undefined;

  console.log("=========================================================================");
  console.log("CAREERMONKE COMPANY LOGOS BACKFILL & RE-CHECK ENGINE");
  console.log(`Mode:         ${isWrite ? "LIVE WRITE (--write)" : "DRY RUN (default, safe)"}`);
  console.log(`Missing Only: ${missingOnly ? "YES (--missing-only / --schedule)" : "NO (full evaluation)"}`);
  if (limitVal) console.log(`Limit:        ${limitVal} companies`);
  console.log("=========================================================================\n");

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.error("Error: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // 1. Fetch 200 most recent active jobs to prioritize companies
  console.log("Fetching recent active jobs for prioritization and domain derivation...");
  const { data: topRecentJobs } = await supabase
    .from("jobs")
    .select("company, company_id, apply_url, source_url, posted_at")
    .eq("status", "active")
    .order("posted_at", { ascending: false })
    .limit(200);

  const top200Names = new Set(
    (topRecentJobs || []).map((j) => j.company?.toLowerCase().trim()).filter(Boolean)
  );
  const top200Ids = new Set(
    (topRecentJobs || []).map((j) => j.company_id).filter(Boolean)
  );

  // 2. Fetch all jobs to index job URLs for domain derivation
  const { data: allActiveJobs } = await supabase
    .from("jobs")
    .select("company, company_id, apply_url, source_url");

  const jobsByCompany = new Map<string, JobInfo[]>();
  const jobsByCompanyId = new Map<string, JobInfo[]>();
  for (const j of allActiveJobs || []) {
    if (j.company) {
      const k = j.company.toLowerCase().trim();
      if (!jobsByCompany.has(k)) jobsByCompany.set(k, []);
      jobsByCompany.get(k)!.push(j);
    }
    if (j.company_id) {
      if (!jobsByCompanyId.has(j.company_id)) jobsByCompanyId.set(j.company_id, []);
      jobsByCompanyId.get(j.company_id)!.push(j);
    }
  }

  // 3. Fetch companies
  console.log("Fetching companies from database...");
  const { data: allCompanies, error } = await supabase
    .from("companies")
    .select("id, name, slug, domain, careers_url, ats_type, logo_url")
    .order("name", { ascending: true });

  if (error || !allCompanies) {
    console.error("Failed to query companies:", error);
    process.exit(1);
  }

  const totalCompaniesCount = allCompanies.length;
  const withLogoBefore = allCompanies.filter((c) => c.logo_url !== null).length;
  const withoutLogoBefore = totalCompaniesCount - withLogoBefore;

  console.log(`Database Baseline:`);
  console.log(`  Total Companies:       ${totalCompaniesCount}`);
  console.log(`  With Logo Before:      ${withLogoBefore} (${((withLogoBefore / totalCompaniesCount) * 100).toFixed(1)}%)`);
  console.log(`  Without Logo Before:   ${withoutLogoBefore} (${((withoutLogoBefore / totalCompaniesCount) * 100).toFixed(1)}%)\n`);

  // Filter if missing-only
  let candidateCompanies = [...allCompanies];
  if (missingOnly) {
    candidateCompanies = candidateCompanies.filter((c) => c.logo_url === null);
  }

  // Prioritize companies appearing in the 200 most recent active jobs
  const companies = candidateCompanies.sort((a, b) => {
    const aIsTop = top200Names.has(a.name.toLowerCase().trim()) || (a.id && top200Ids.has(a.id));
    const bIsTop = top200Names.has(b.name.toLowerCase().trim()) || (b.id && top200Ids.has(b.id));
    if (aIsTop && !bIsTop) return -1;
    if (!aIsTop && bIsTop) return 1;
    return a.name.localeCompare(b.name);
  });

  const companiesToEvaluate = limitVal ? companies.slice(0, limitVal) : companies;

  console.log(`Evaluating ${companiesToEvaluate.length} companies (prioritizing top 200 active job employers)...\n`);

  // Phase 1: Inspect companies on ATS boards
  console.log("Phase 1: Scanning board pages, icons, and og:image candidates...");
  const inspections: CompanyInspection[] = [];

  let completed = 0;
  const total = companiesToEvaluate.length;

  async function atsWorker(items: CompanyRow[]) {
    for (const company of items) {
      try {
        const result = await inspectCompany(company);
        inspections.push(result);
      } catch (err: any) {
        inspections.push({
          company,
          ats: company.ats_type || "unknown",
          boardUrl: "",
          iconCandidate: null,
          ogCandidate: null,
          status: "failed",
          reason: err.message,
        });
      }

      completed++;
      if (completed % 25 === 0 || completed === total) {
        process.stdout.write(`Progress: ${completed}/${total} companies inspected...\r`);
      }
    }
  }

  const chunks: CompanyRow[][] = Array.from({ length: CONCURRENCY }, () => []);
  companiesToEvaluate.forEach((item, index) => {
    chunks[index % CONCURRENCY].push(item);
  });

  await Promise.all(chunks.map((chunk) => atsWorker(chunk)));
  console.log(`\nPhase 1 complete. Inspected ${inspections.length} companies.\n`);

  // Phase 2: ATS frequency filter & initial candidate selection
  const urlFrequency = new Map<string, number>();
  for (const insp of inspections) {
    if (insp.iconCandidate) {
      const u = insp.iconCandidate.imageUrl;
      urlFrequency.set(u, (urlFrequency.get(u) || 0) + 1);
    }
    if (insp.ogCandidate) {
      const u = insp.ogCandidate.imageUrl;
      urlFrequency.set(u, (urlFrequency.get(u) || 0) + 1);
    }
  }

  const validCandidates: CandidateLogo[] = [];
  const statusCounts: Record<string, AtsStats> = {};
  let genericDefaultsSkipped = 0;

  const getStats = (ats: string): AtsStats => {
    const key = ats || "unknown";
    if (!statusCounts[key]) {
      statusCounts[key] = { found: 0, missing: 0, failed: 0, already_set: 0, total: 0 };
    }
    return statusCounts[key];
  };

  const companiesNeedingFallback: Array<{ company: CompanyRow; inspection: CompanyInspection }> = [];

  for (const insp of inspections) {
    const ats = (insp.company.ats_type || "unknown").toLowerCase().trim();
    const stats = getStats(ats);
    stats.total++;

    if (insp.status === "already_set") {
      stats.already_set++;
      continue;
    }
    if (insp.status === "failed") {
      stats.failed++;
      continue;
    }

    let chosen: CandidateLogo | null = null;

    if (insp.iconCandidate) {
      const count = urlFrequency.get(insp.iconCandidate.imageUrl) || 0;
      if (count < 3) {
        chosen = insp.iconCandidate;
      }
    }

    if (!chosen && insp.ogCandidate) {
      const count = urlFrequency.get(insp.ogCandidate.imageUrl) || 0;
      if (count < 3) {
        chosen = insp.ogCandidate;
      }
    }

    if (chosen) {
      stats.found++;
      validCandidates.push(chosen);
    } else {
      stats.missing++;
      if (insp.iconCandidate || insp.ogCandidate) {
        genericDefaultsSkipped++;
      }
      companiesNeedingFallback.push({ company: insp.company, inspection: insp });
    }
  }

  console.log(`Filtered out ${genericDefaultsSkipped} generic default images shared by 3+ companies.`);
  console.log(`Companies without logo after ATS scan: ${companiesNeedingFallback.length}\n`);

  // Phase 3: Homepage & Free Logo Service Fallback for companies still without logo_url
  console.log("Phase 3: Running Homepage & Free Logo Service Fallback (Unavatar -> Google -> DDG)...");
  console.log("Deriving website domains from jobs, companies, or board metadata (never guessing)...");

  interface FallbackCandidateItem {
    candidate: CandidateLogo;
    company: CompanyRow;
  }
  const fallbackCandidates: FallbackCandidateItem[] = [];
  let fallbackCompleted = 0;
  const fallbackTotal = companiesNeedingFallback.length;

  async function fallbackWorker(items: Array<{ company: CompanyRow; inspection: CompanyInspection }>) {
    for (const { company, inspection } of items) {
      const compJobs = [
        ...(jobsByCompany.get(company.name.toLowerCase().trim()) || []),
        ...(jobsByCompanyId.get(company.id) || []),
      ];

      const domain = deriveCompanyDomain(
        company,
        compJobs,
        inspection.ashbyPublicWebsite,
        inspection.extractedDomain
      );

      if (domain) {
        // Step 1: Try company website homepage
        try {
          const homeLogo = await inspectCompanyHomepage(company, domain, 32);
          if (homeLogo) {
            fallbackCandidates.push({ candidate: homeLogo, company });
            fallbackCompleted++;
            continue;
          }
        } catch {}

        // Step 2: Try free logo service fallback (Unavatar -> Google Favicons -> DuckDuckGo)
        try {
          const freeService = await fetchFreeLogoService(domain, 32);
          if (freeService) {
            fallbackCandidates.push({
              candidate: {
                company,
                ats: company.ats_type || "unknown",
                boardUrl: `https://${domain}`,
                imageUrl: freeService.imageUrl,
                source: "free-service",
                serviceName: freeService.serviceName,
                domain,
                buffer: freeService.buffer,
                contentType: freeService.contentType,
                ext: freeService.ext,
                width: freeService.width,
                height: freeService.height,
              },
              company,
            });
            fallbackCompleted++;
            continue;
          }
        } catch {}
      }

      fallbackCompleted++;
      if (fallbackCompleted % 10 === 0 || fallbackCompleted === fallbackTotal) {
        process.stdout.write(`Fallback progress: ${fallbackCompleted}/${fallbackTotal} inspected...\r`);
      }
    }
  }

  const fallbackChunks: Array<Array<{ company: CompanyRow; inspection: CompanyInspection }>> = Array.from(
    { length: CONCURRENCY },
    () => []
  );
  companiesNeedingFallback.forEach((item, index) => {
    fallbackChunks[index % CONCURRENCY].push(item);
  });

  await Promise.all(fallbackChunks.map((chunk) => fallbackWorker(chunk)));
  console.log(`\nFallback inspection complete. Found ${fallbackCandidates.length} candidate fallback logos.\n`);

  // Frequency analysis across fallback candidate icons (skip generic default icons shared across 3+ companies)
  const fallbackUrlFreq = new Map<string, number>();
  for (const { candidate } of fallbackCandidates) {
    const u = candidate.imageUrl;
    fallbackUrlFreq.set(u, (fallbackUrlFreq.get(u) || 0) + 1);
  }

  let fallbackAcceptedCount = 0;
  for (const { candidate, company } of fallbackCandidates) {
    const count = fallbackUrlFreq.get(candidate.imageUrl) || 0;
    if (count >= 3) {
      continue;
    }

    const ats = (company.ats_type || "unknown").toLowerCase().trim();
    const stats = getStats(ats);
    stats.found++;
    stats.missing = Math.max(0, stats.missing - 1);

    validCandidates.push(candidate);
    fallbackAcceptedCount++;
  }

  console.log(`Accepted ${fallbackAcceptedCount} fallback logos after generic filter.\n`);

  // Dry-run output: print candidate logos per row
  console.log("=== CANDIDATE LOGOS PER ROW ===");
  for (const item of validCandidates) {
    const tag = item.source === "homepage-icon" ? "homepage" : item.source === "free-service" ? item.serviceName || "free-svc" : item.ats;
    console.log(
      `[${tag.padEnd(10)}] ${item.company.name.padEnd(28)} | domain: ${(item.domain || "n/a").padEnd(22)} | ${item.width}x${item.height} (${item.source}) | ${item.imageUrl}`
    );
  }
  console.log("================================\n");

  // Exact SQL generation for review before any DB write
  console.log("=========================================================================");
  console.log("EXACT SQL QUERIES (DRY RUN / PRE-FLIGHT AUDIT)");
  console.log("=========================================================================");
  console.log("-- Target table: public.companies");
  console.log(`-- Total rows to update: ${validCandidates.length}\n`);

  const sampleSqlQueries: string[] = [];
  for (const item of validCandidates) {
    const targetStorageUrl = `${supabaseUrl}/storage/v1/object/public/company-logos/${item.company.id}.${item.ext}`;
    const escapedDomain = item.domain ? `'${item.domain.replace(/'/g, "''")}'` : "NULL";
    const sql = `UPDATE public.companies SET logo_url = '${targetStorageUrl}', domain = COALESCE(domain, ${escapedDomain}) WHERE id = '${item.company.id}'; -- ${item.company.name}`;
    sampleSqlQueries.push(sql);
  }

  // Print first 20 SQL queries + note if more
  for (const query of sampleSqlQueries.slice(0, 20)) {
    console.log(query);
  }
  if (sampleSqlQueries.length > 20) {
    console.log(`-- ... and ${sampleSqlQueries.length - 20} more UPDATE statements for remaining companies.`);
  }
  console.log("=========================================================================\n");

  // In write mode: upload and update
  if (isWrite) {
    console.log(`Uploading ${validCandidates.length} company logos to Supabase Storage...`);
    let uploadCount = 0;
    let failedCount = 0;
    const sampleUploaded: Array<{ name: string; url: string }> = [];

    for (const item of validCandidates) {
      const storagePath = `${item.company.id}.${item.ext}`;

      try {
        const otherExts = ["png", "jpg", "jpeg", "webp", "gif"].filter((e) => e !== item.ext);
        const oldPaths = otherExts.map((e) => `${item.company.id}.${e}`);
        if (item.company.logo_url && item.company.logo_url.includes("/company-logos/")) {
          try {
            const oldPath = item.company.logo_url.split("/company-logos/")[1]?.split("?")[0];
            if (oldPath && oldPath !== storagePath && !oldPaths.includes(oldPath)) {
              oldPaths.push(oldPath);
            }
          } catch {}
        }
        await supabase.storage.from("company-logos").remove(oldPaths);

        // Upload new image
        const { error: uploadError } = await supabase.storage
          .from("company-logos")
          .upload(storagePath, item.buffer, {
            contentType: item.contentType,
            upsert: true,
          });

        if (uploadError) {
          console.error(`Upload error for ${item.company.name}:`, uploadError.message);
          failedCount++;
          continue;
        }

        const { data: publicUrlData } = supabase.storage
          .from("company-logos")
          .getPublicUrl(storagePath);

        const publicUrl = publicUrlData?.publicUrl;
        if (publicUrl) {
          await supabase
            .from("companies")
            .update({
              logo_url: publicUrl,
              ...(item.domain && !item.company.domain ? { domain: item.domain } : {}),
            })
            .eq("id", item.company.id);
          uploadCount++;
          if (sampleUploaded.length < 5) {
            sampleUploaded.push({ name: item.company.name, url: publicUrl });
          }
        }
      } catch (err: any) {
        console.error(`Write error for ${item.company.name}:`, err.message);
        failedCount++;
      }
    }
    console.log(`Successfully uploaded and updated ${uploadCount} companies in database.\n`);
    const candidateSkipped = validCandidates.length - uploadCount - failedCount;
    console.log("=========================================");
    console.log("REAL BACKFILL WRITE EXECUTION TOTALS:");
    console.log(`  Uploaded: ${uploadCount}`);
    console.log(`  Failed:   ${failedCount}`);
    console.log(`  Skipped:  ${candidateSkipped}`);
    console.log("5 Sample Uploaded Company Logos:");
    for (const sample of sampleUploaded) {
      console.log(`  - ${sample.name}: ${sample.url}`);
    }
    console.log("=========================================");
  }

  // Summary Table
  console.log("-------------------------------------------------------------------------");
  console.log("ATS Type        | Found | Missing | Failed | Already Set | Total Scanned");
  console.log("-------------------------------------------------------------------------");

  let grandFound = 0;
  let grandMissing = 0;
  let grandFailed = 0;
  let grandAlreadySet = 0;
  let grandTotal = 0;

  const sortedAts = Object.keys(statusCounts).sort();
  for (const ats of sortedAts) {
    const s = statusCounts[ats];
    grandFound += s.found;
    grandMissing += s.missing;
    grandFailed += s.failed;
    grandAlreadySet += s.already_set;
    grandTotal += s.total;

    const pad = (v: any, len: number) => String(v).padEnd(len, " ");
    console.log(
      `${pad(ats, 15)} | ${pad(s.found, 5)} | ${pad(s.missing, 7)} | ${pad(s.failed, 6)} | ${pad(s.already_set, 11)} | ${s.total}`
    );
  }

  console.log("-------------------------------------------------------------------------");
  console.log(
    `TOTAL           | ${String(grandFound).padEnd(5)} | ${String(grandMissing).padEnd(7)} | ${String(grandFailed).padEnd(6)} | ${String(grandAlreadySet).padEnd(11)} | ${grandTotal}`
  );
  console.log("-------------------------------------------------------------------------\n");

  const projectedTotalWithLogo = withLogoBefore + validCandidates.length;
  console.log("=========================================================================");
  console.log("BEFORE VS AFTER COMPANY LOGO AUDIT REPORT");
  console.log("=========================================================================");
  console.log(`Total Companies in Database:       ${totalCompaniesCount}`);
  console.log(`Companies With Logo BEFORE:        ${withLogoBefore} (${((withLogoBefore / totalCompaniesCount) * 100).toFixed(1)}%)`);
  console.log(`Companies Without Logo BEFORE:     ${withoutLogoBefore} (${((withoutLogoBefore / totalCompaniesCount) * 100).toFixed(1)}%)`);
  console.log(`Newly Resolved in this run:        +${validCandidates.length}`);
  console.log(`Companies With Logo AFTER:         ${projectedTotalWithLogo} (${((projectedTotalWithLogo / totalCompaniesCount) * 100).toFixed(1)}%)`);
  console.log(`Remaining With Letter Placeholder: ${totalCompaniesCount - projectedTotalWithLogo} (${(((totalCompaniesCount - projectedTotalWithLogo) / totalCompaniesCount) * 100).toFixed(1)}%)`);
  console.log("=========================================================================\n");

  console.log("-- Rollback SQL:");
  console.log("UPDATE companies SET logo_url = null WHERE logo_url LIKE '%company-logos%';\n");

  if (!isWrite) {
    console.log("Dry-run complete. ZERO files uploaded and ZERO database rows modified.");
    console.log("To apply changes, review the SQL above and run: npx tsx scripts/backfill-company-logos.ts --write\n");
  } else {
    console.log("Live write complete.\n");
  }
}

const isDirectRun =
  process.argv[1] &&
  (path.basename(process.argv[1]) === "backfill-company-logos.ts" ||
    path.basename(process.argv[1]) === "backfill-company-logos.js");

if (isDirectRun) {
  runBackfill().catch((err) => {
    console.error("Unexpected error in backfill script:", err);
    process.exit(1);
  });
}
