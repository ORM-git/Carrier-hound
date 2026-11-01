/**
 * scripts/backfill-company-logos.ts
 *
 * Backfill script for self-hosted company logos in Supabase Storage.
 *
 * Requirements:
 * - Service role client (reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).
 * - Dry-run by default. Pass `--write` to apply uploads and database updates.
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
 * - Generic default filter:
 *     Skip any image URL shared by 3 or more companies.
 * - Allowed formats: raster images only (png, jpeg/jpg, webp, gif). SVG is strictly excluded.
 * - Homepage fallback for companies still without logo_url:
 *     Derive company website domain from job or company data (never guess).
 *     Fetch homepage, take largest apple-touch-icon or icon >= 128px with ratio 0.6..1.6.
 *     Prioritize companies appearing in the 200 most recent active jobs.
 * - In --write mode:
 *     Uploads to 'company-logos' bucket at <company_id>.<ext> (upsert: true).
 *     Deletes old file(s) when extension changes.
 *     Sets companies.logo_url to the public storage URL.
 * - In dry-run mode:
 *     Prints company, domain and candidate image URL per row.
 * - Prints found/missing/failed per ats_type summary table and rollback SQL:
 *     UPDATE companies SET logo_url = null WHERE logo_url LIKE '%company-logos%';
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createClient } from "@supabase/supabase-js";

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
  source: "icon" | "og:image" | "homepage-icon";
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
  status: "inspected" | "already_set" | "missing" | "failed";
  reason?: string;
}

export const MAX_IMAGE_BYTES = 2097152; // 2MB
export const REQUEST_TIMEOUT_MS = 10000; // 10s
export const CONCURRENCY = 8;

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 CareerMonkeBot/1.0";

export const ATS_HOST_KEYWORDS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "recruitee.com",
  "smartrecruiters.com",
  "workable.com",
  "careerpuck.com",
  "rippling-ats.com",
  "rippling.com",
  "myworkdayjobs.com",
  "icims.com",
  "breezy.hr",
  "bamboohr.com",
  "jazz.co",
  "jazzhr.com",
  "ashbyprd.com",
  "google.com",
  "greenhouse.com",
  "imagedelivery.net",
  "cloudflare.net",
  "cloudflarestatus.com",
  "arbeitnow.com",
  "hiring.cafe",
  "indeed.com",
  "linkedin.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "builtin.com",
  "wellfound.com",
  "angel.co",
];

export function isAtsHost(host: string): boolean {
  const h = host.toLowerCase().trim();
  return ATS_HOST_KEYWORDS.some((k) => h === k || h.endsWith("." + k));
}

export function cleanDomain(raw: string): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  try {
    if (host.includes("://")) {
      host = new URL(host).hostname;
    } else if (host.includes("/")) {
      host = host.split("/")[0];
    }
  } catch {
    return null;
  }
  host = host.replace(/:\d+$/, "");
  if (isAtsHost(host)) return null;
  const parts = host.split(".");
  if (parts.length < 2) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;

  const strippedPrefixes = [
    "www",
    "careers",
    "jobs",
    "app",
    "recruiting",
    "about",
    "company",
    "boards",
    "job-boards",
  ];
  let cur = parts;
  while (cur.length > 2 && strippedPrefixes.includes(cur[0])) {
    cur = cur.slice(1);
  }
  return cur.join(".");
}

export function deriveCompanyDomain(
  company: CompanyRow,
  jobsForCompany: JobInfo[],
  ashbyPublicWebsite?: string | null
): string | null {
  // 1. From company record: domain
  if (company.domain) {
    const d = cleanDomain(company.domain);
    if (d) return d;
  }

  // 2. From company record: careers_url
  if (company.careers_url) {
    try {
      const h = new URL(company.careers_url).hostname;
      const d = cleanDomain(h);
      if (d) return d;
    } catch {}
  }

  // 3. From job data: apply_url or source_url
  for (const j of jobsForCompany) {
    for (const u of [j.apply_url, j.source_url]) {
      if (!u) continue;
      try {
        const h = new URL(u).hostname;
        const d = cleanDomain(h);
        if (d) return d;
      } catch {}
    }
  }

  // 4. From Ashby board publicWebsite (if company is on Ashby)
  if (ashbyPublicWebsite) {
    try {
      const h = new URL(ashbyPublicWebsite).hostname;
      const d = cleanDomain(h);
      if (d) return d;
    } catch {}
  }

  // Never guess
  return null;
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

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function getImageDimensions(
  buffer: Buffer
): { width: number; height: number; type: string } | null {
  if (!buffer || buffer.length < 8) return null;

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    if (buffer.length >= 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height, type: "png" };
    }
  }

  // 2. GIF: GIF87a or GIF89a
  if (
    buffer.length >= 10 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return { width, height, type: "gif" };
  }

  // 3. JPEG: FF D8 ...
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 1) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF markers: 0xC0 to 0xCF, except 0xC4, 0xC8, 0xCC
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (offset + 8 < buffer.length) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height, type: "jpg" };
        }
      }
      if (offset + 3 < buffer.length) {
        const len = buffer.readUInt16BE(offset + 2);
        offset += 2 + len;
      } else {
        break;
      }
    }
  }

  // 4. WEBP: RIFF .... WEBP VP8 / VP8L / VP8X
  if (
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height, type: "webp" };
    } else if (chunk === "VP8L" && buffer.length >= 25) {
      if (buffer[20] === 0x2f) {
        const b1 = buffer[21];
        const b2 = buffer[22];
        const b3 = buffer[23];
        const b4 = buffer[24];
        const width = 1 + (((b2 & 0x3f) << 8) | b1);
        const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
        return { width, height, type: "webp" };
      }
    } else if (chunk === "VP8 " && buffer.length >= 30) {
      if (buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
        const width = buffer.readUInt16LE(26) & 0x3fff;
        const height = buffer.readUInt16LE(28) & 0x3fff;
        return { width, height, type: "webp" };
      }
    }
  }

  return null;
}

export function getCleanImageMeta(
  rawContentType: string,
  buffer: Buffer,
  urlStr: string
): { contentType: string; ext: string } | null {
  const ct = rawContentType.toLowerCase().trim();

  // Reject SVG explicitly
  if (
    ct.includes("svg") ||
    urlStr.toLowerCase().endsWith(".svg") ||
    urlStr.toLowerCase().includes(".svg?")
  ) {
    return null;
  }

  const dims = getImageDimensions(buffer);
  if (!dims) return null;

  switch (dims.type) {
    case "png":
      return { contentType: "image/png", ext: "png" };
    case "jpg":
      return { contentType: "image/jpeg", ext: "jpg" };
    case "webp":
      return { contentType: "image/webp", ext: "webp" };
    case "gif":
      return { contentType: "image/gif", ext: "gif" };
    default:
      return null;
  }
}

export function parsePageImages(
  html: string,
  baseUrl: string
): {
  iconUrls: Array<{ url: string; declaredSize: number }>;
  ogImageUrl: string | null;
} {
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

  let ogImageUrl: string | null = null;
  if (ogMatch && ogMatch[1]) {
    try {
      const raw = decodeHtmlEntities(ogMatch[1].trim());
      if (raw && !raw.endsWith(".svg") && !raw.includes(".svg?")) {
        ogImageUrl = new URL(raw, baseUrl).toString();
      }
    } catch {
      ogImageUrl = null;
    }
  }

  // Parse candidate icons (<link rel="apple-touch-icon" ...>, <link rel="icon" ...>)
  const iconUrls: Array<{ url: string; declaredSize: number }> = [];
  const linkRegex = /<link[^>]+>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0];
    const relMatch = tag.match(/rel=["']([^"']+)["']/i);
    if (!relMatch) continue;
    const rel = relMatch[1].toLowerCase();
    if (!rel.includes("icon")) continue;

    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeHtmlEntities(hrefMatch[1].trim());
    if (!href || href.endsWith(".svg") || href.includes(".svg?")) continue;

    let declaredSize = 0;
    const sizesMatch = tag.match(/sizes=["'](\d+)x(\d+)["']/i);
    if (sizesMatch) {
      declaredSize = Math.min(parseInt(sizesMatch[1], 10), parseInt(sizesMatch[2], 10));
    } else if (rel.includes("apple-touch-icon")) {
      declaredSize = 180;
    }

    try {
      const fullUrl = new URL(href, baseUrl).toString();
      iconUrls.push({ url: fullUrl, declaredSize });
    } catch {
      // ignore
    }
  }

  // Sort icons descending by declaredSize
  iconUrls.sort((a, b) => b.declaredSize - a.declaredSize);

  return { iconUrls, ogImageUrl };
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/png,image/jpeg,image/webp,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadAndValidateImage(url: string): Promise<{
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
} | null> {
  try {
    const imgRes = await fetchWithTimeout(url);
    if (!imgRes.ok) return null;

    const arrayBuf = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      return null;
    }

    const rawType = imgRes.headers.get("content-type") || "";
    const meta = getCleanImageMeta(rawType, buffer, url);
    if (!meta) return null;

    const dims = getImageDimensions(buffer);
    if (!dims || dims.width === 0 || dims.height === 0) return null;

    return {
      buffer,
      contentType: meta.contentType,
      ext: meta.ext,
      width: dims.width,
      height: dims.height,
    };
  } catch {
    return null;
  }
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
  if (ats === "ashby") {
    const m = html.match(/"publicWebsite":\s*"([^"]+)"/);
    if (m && m[1]) {
      ashbyPublicWebsite = decodeHtmlEntities(m[1].trim());
    }
  }

  const { iconUrls, ogImageUrl } = parsePageImages(html, activeBoardUrl);

  let iconCandidate: CandidateLogo | null = null;
  let ogCandidate: CandidateLogo | null = null;

  // 1. Inspect icon candidates (favicon / apple-touch-icon of at least 128px)
  for (const icon of iconUrls) {
    const imgData = await downloadAndValidateImage(icon.url);
    if (imgData && imgData.width >= 128 && imgData.height >= 128) {
      const ratio = imgData.width / imgData.height;
      if (ratio <= 1.6 && ratio >= 0.6) {
        iconCandidate = {
          company,
          ats,
          boardUrl: activeBoardUrl,
          imageUrl: icon.url,
          source: "icon",
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
    const imgData = await downloadAndValidateImage(ogImageUrl);
    if (imgData) {
      const ratio = imgData.width / imgData.height;
      if (ratio <= 1.6 && ratio >= 0.6) {
        ogCandidate = {
          company,
          ats,
          boardUrl: activeBoardUrl,
          imageUrl: ogImageUrl,
          source: "og:image",
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
    status: iconCandidate || ogCandidate ? "inspected" : "missing",
    reason: iconCandidate || ogCandidate ? undefined : "No square-ish icon or og:image found",
  };
}

export async function inspectCompanyHomepage(
  company: CompanyRow,
  domain: string
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

  const { iconUrls } = parsePageImages(html, finalUrl);

  // Also include root /apple-touch-icon.png if not present
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
    const imgData = await downloadAndValidateImage(icon.url);
    if (imgData && imgData.width >= 128 && imgData.height >= 128) {
      const ratio = imgData.width / imgData.height;
      if (ratio >= 0.6 && ratio <= 1.6) {
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
  }

  const best = selectLargestQualifyingIcon(downloadedCandidates);
  if (!best) return null;

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

export async function runBackfill() {
  const isWrite = process.argv.includes("--write");
  const limitIdx = process.argv.indexOf("--limit");
  const limitVal = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : undefined;

  console.log("=========================================================================");
  console.log("CAREERMONKE COMPANY LOGOS BACKFILL");
  console.log(`Mode: ${isWrite ? "LIVE WRITE (--write)" : "DRY RUN (default)"}`);
  if (limitVal) console.log(`Limit: ${limitVal} companies`);
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

  // Prioritize companies appearing in the 200 most recent active jobs
  const companies = [...allCompanies].sort((a, b) => {
    const aIsTop = top200Names.has(a.name.toLowerCase().trim()) || (a.id && top200Ids.has(a.id));
    const bIsTop = top200Names.has(b.name.toLowerCase().trim()) || (b.id && top200Ids.has(b.id));
    if (aIsTop && !bIsTop) return -1;
    if (!aIsTop && bIsTop) return 1;
    return a.name.localeCompare(b.name);
  });

  const companiesToEvaluate = limitVal ? companies.slice(0, limitVal) : companies;

  console.log(`Found ${companiesToEvaluate.length} companies to evaluate (prioritizing top 200 active job companies).\n`);

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

    // Rule: Prefer favicon / apple-touch-icon >= 128px unless shared generic default (count >= 3)
    if (insp.iconCandidate) {
      const count = urlFrequency.get(insp.iconCandidate.imageUrl) || 0;
      if (count < 3) {
        chosen = insp.iconCandidate;
      }
    }

    // Fallback: If no icon or icon is a shared generic default, use og:image (if not shared by >= 3)
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

  // Phase 3: Homepage Fallback for companies still without logo_url
  console.log("Phase 3: Running Homepage Fallback for companies still without logo_url...");
  console.log("Deriving website domains from job or company data (never guessing)...");

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

      const domain = deriveCompanyDomain(company, compJobs, inspection.ashbyPublicWebsite);
      if (domain) {
        try {
          const logo = await inspectCompanyHomepage(company, domain);
          if (logo) {
            fallbackCandidates.push({ candidate: logo, company });
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
  console.log(`\nFallback inspection complete. Found ${fallbackCandidates.length} candidate homepage icons.\n`);

  // Frequency analysis across fallback candidate icons (skip URLs shared by 3+)
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

  console.log(`Accepted ${fallbackAcceptedCount} homepage fallback logos after generic filter.\n`);

  // Dry-run output: print company, ATS/source, domain (if fallback), dims, and image URL
  console.log("=== CANDIDATE LOGOS PER ROW (DRY RUN) ===");
  for (const item of validCandidates) {
    if (item.source === "homepage-icon") {
      console.log(
        `[homepage  ] ${item.company.name.padEnd(28)} | domain: ${(item.domain || "").padEnd(22)} | ${item.width}x${item.height} (icon) | ${item.imageUrl}`
      );
    } else {
      console.log(
        `[${item.ats.padEnd(10)}] ${item.company.name.padEnd(28)} | ${item.width}x${item.height} (${item.source}) | ${item.imageUrl}`
      );
    }
  }
  console.log("=========================================\n");

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
            .update({ logo_url: publicUrl })
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
    console.log("=========================================\n");
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

  console.log("-- Rollback SQL:");
  console.log("UPDATE companies SET logo_url = null WHERE logo_url LIKE '%company-logos%';\n");

  if (!isWrite) {
    console.log("Dry-run complete. No files uploaded and no database rows updated.");
    console.log("To apply changes, run with: npx tsx scripts/backfill-company-logos.ts --write\n");
  } else {
    console.log("Live write complete.\n");
  }
}

import path from "node:path";

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
