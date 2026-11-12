/**
 * scripts/backfill-company-logos.ts
 *
 * Backfill script for company logos in Supabase database & Storage.
 *
 * Requirements:
 * - Service role client (reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).
 * - Dry-run by default. Writes a reviewed manifest and prints a scoped `--write` command
 *   preserving every selection flag (--live-only, --missing-only, --force, --limit, --offset, --manifest).
 * - Pass `--live-only` to target companies with live jobs (`status = 'active' AND is_active = true`),
 *   matched by `company_id` with `lower(btrim(jobs.company)) = lower(btrim(companies.name))`
 *   fallback when `company_id IS NULL`, ordered by active job count descending.
 * - Pass `--missing-only` or `--schedule` to evaluate only companies currently without a logo.
 * - Pass `--force` to re-evaluate rows already hosted in the `company-logos` bucket.
 * - Pass `--limit <n>` and `--offset <n>` to process chunks cleanly.
 * - Image validation performs header and dimension sniffing (raster headers only, SVG rejected; not full pixel decoding).
 * - Versioned storage keys (<company_id>-<hash>.<ext>) preserve prior objects across DB writes so
 *   run-only rollback SQL remains valid; on DB failure the newly uploaded object is removed.
 * - Fully idempotent & polite (max concurrency 8, >= 1s between requests per host,
 *   retry once on 5xx, never retry 404).
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
  status?: string | null;
  is_active?: boolean | null;
  posted_at?: string | null;
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

export interface BackfillCliArgs {
  isWrite: boolean;
  liveOnly: boolean;
  missingOnly: boolean;
  force: boolean;
  limit: number | undefined;
  offset: number;
  manifestPath?: string;
}

export type FetcherFn = (url: string) => Promise<Response>;

export interface PoliteFetcherOptions {
  fetchFn?: FetcherFn;
  minHostIntervalMs?: number;
  maxRetries5xx?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export { MAX_IMAGE_BYTES, REQUEST_TIMEOUT_MS, USER_AGENT, ATS_HOST_KEYWORDS };
export const MAX_CONCURRENCY = 8;
export const CONCURRENCY = MAX_CONCURRENCY;
export const MIN_HOST_INTERVAL_MS = 1000;
export const COMPANY_LOGOS_BUCKET = "company-logos";

export const isAtsHost = libIsAtsHost;
export const cleanDomain = libCleanDomain;
export const getImageDimensions = libGetImageDimensions;
export const getCleanImageMeta = libGetCleanImageMeta;
export const fetchWithTimeout = libFetchWithTimeout;
export const parsePageImages = libParsePageImages;
export const fetchFreeLogoService = libFetchFreeLogoService;

function normalizeCompanyKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function parseBackfillCliArgs(argv: string[]): BackfillCliArgs {
  const isWrite = argv.includes("--write");
  const liveOnly = argv.includes("--live-only");
  const missingOnly = argv.includes("--missing-only") || argv.includes("--schedule");
  const force = argv.includes("--force");

  const getFlagValue = (flag: string): string | undefined => {
    const eqPrefix = `${flag}=`;
    const eqArg = argv.find((a) => a.startsWith(eqPrefix));
    if (eqArg !== undefined) {
      return eqArg.slice(eqPrefix.length);
    }
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const raw = argv[idx + 1];
    if (!raw || raw.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return raw;
  };

  const parseIntFlag = (flag: string): number | undefined => {
    const raw = getFlagValue(flag);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Invalid integer value for ${flag}: ${raw}`);
    }
    return parsed;
  };

  const limit = parseIntFlag("--limit");
  if (limit !== undefined && limit <= 0) {
    throw new Error(`--limit must be a positive integer, got ${limit}`);
  }

  const offset = parseIntFlag("--offset") ?? 0;
  if (offset < 0) {
    throw new Error(`--offset must be a non-negative integer, got ${offset}`);
  }

  const manifestPath = getFlagValue("--manifest");

  return { isWrite, liveOnly, missingOnly, force, limit, offset, manifestPath };
}

/**
 * Formats an apply command preserving every dry-run selection flag (and optional manifest path)
 * so running `--write` evaluates the exact same scoped selection.
 */
export function buildWriteApplyCommand(
  cli: BackfillCliArgs,
  manifestPath: string | undefined = cli.manifestPath
): string {
  const parts = ["npx", "tsx", "scripts/backfill-company-logos.ts"];
  if (cli.liveOnly) parts.push("--live-only");
  if (cli.missingOnly) parts.push("--missing-only");
  if (cli.force) parts.push("--force");
  if (cli.offset > 0) parts.push("--offset", String(cli.offset));
  if (cli.limit !== undefined) parts.push("--limit", String(cli.limit));
  if (manifestPath) parts.push("--manifest", manifestPath);
  parts.push("--write");
  return parts.join(" ");
}

export function computeBufferShortHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12);
}

/**
 * Builds a content-hashed storage key (`<company_id>-<hash>.<ext>`) so new uploads never
 * overwrite previous objects before DB commit and prior versions remain valid for rollback.
 */
export function buildLogoStoragePath(companyId: string, buffer: Buffer, ext: string): string {
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  return `${companyId}-${computeBufferShortHash(buffer)}.${safeExt}`;
}

export function getDefaultManifestPath(timestamp: number = Date.now()): string {
  return path.join(os.tmpdir(), `careermonke-logo-backfill-manifest-${timestamp}.json`);
}

export function extractStoragePathFromLogoUrl(
  logoUrl: string | null | undefined
): string | null {
  if (!logoUrl || typeof logoUrl !== "string") return null;
  try {
    const parsed = new URL(logoUrl.trim());
    const marker = `/${COMPANY_LOGOS_BUCKET}/`;
    const idx = parsed.pathname.indexOf(marker);
    if (idx === -1) return null;
    const rel = parsed.pathname.slice(idx + marker.length).replace(/^\/+/, "");
    return rel || null;
  } catch {
    return null;
  }
}

/**
 * Matches only URLs hosted in our Supabase Storage `'company-logos'` bucket.
 * External URLs or other buckets return false so they get re-hosted.
 */
export function isSelfHostedLogoUrl(
  logoUrl: string | null | undefined,
  supabaseUrl?: string
): boolean {
  if (!logoUrl || typeof logoUrl !== "string") return false;
  try {
    const parsed = new URL(logoUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (supabaseUrl) {
      const expectedHost = new URL(supabaseUrl).host.toLowerCase();
      if (parsed.host.toLowerCase() !== expectedHost) {
        return false;
      }
    } else if (!parsed.host.toLowerCase().endsWith(".supabase.co")) {
      return false;
    }
    return parsed.pathname.includes(`/${COMPANY_LOGOS_BUCKET}/`);
  } catch {
    return false;
  }
}

/**
 * Enforces >= minHostIntervalMs (default 1000ms) between requests per host across
 * concurrent workers, retries once on 5xx, and never retries 404 (or other non-5xx).
 */
export function createPoliteFetcher(options: PoliteFetcherOptions = {}): FetcherFn {
  const fetchFn = options.fetchFn ?? ((url: string) => libFetchWithTimeout(url));
  const minHostIntervalMs = options.minHostIntervalMs ?? MIN_HOST_INTERVAL_MS;
  const maxRetries5xx = options.maxRetries5xx ?? 1;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const hostTails = new Map<string, Promise<void>>();
  const hostLastDoneAt = new Map<string, number>();

  async function runWithHostSlot(url: string): Promise<Response> {
    let host = "default";
    try {
      host = new URL(url).host.toLowerCase() || "default";
    } catch {}

    const prevTail = hostTails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queuedTail = prevTail.then(() => currentTail);
    hostTails.set(host, queuedTail);

    await prevTail;
    try {
      const lastDone = hostLastDoneAt.get(host);
      if (lastDone !== undefined && minHostIntervalMs > 0) {
        const waitMs = lastDone + minHostIntervalMs - now();
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
      return await fetchFn(url);
    } finally {
      hostLastDoneAt.set(host, now());
      release();
    }
  }

  return async (url: string): Promise<Response> => {
    let attempt = 0;
    while (true) {
      const res = await runWithHostSlot(url);
      if (res.status >= 500 && res.status < 600 && attempt < maxRetries5xx) {
        attempt++;
        try {
          await res.body?.cancel();
        } catch {}
        continue;
      }
      return res;
    }
  };
}

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
  minSize: number = 32,
  fetcher?: FetcherFn
): Promise<{
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
} | null> {
  return libDownloadAndValidateImage(url, minSize, fetcher);
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function inspectCompany(
  company: CompanyRow,
  options: { force?: boolean; supabaseUrl?: string; fetcher?: FetcherFn } = {}
): Promise<CompanyInspection> {
  const isHosted = isSelfHostedLogoUrl(company.logo_url, options.supabaseUrl);
  const fetcher = options.fetcher ?? fetchWithTimeout;

  if (!options.force && isHosted) {
    return {
      company,
      ats: company.ats_type || "unknown",
      boardUrl: "",
      iconCandidate: null,
      ogCandidate: null,
      status: "already_set",
      reason: "Already hosted in company-logos bucket",
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
      const res = await fetcher(url);
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
    const imgData = await downloadAndValidateImage(icon.url, 128, fetcher);
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
    const imgData = await downloadAndValidateImage(ogImageUrl, 128, fetcher);
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
  minSize: number = 32,
  fetcher: FetcherFn = fetchWithTimeout
): Promise<CandidateLogo | null> {
  const homeUrls = [`https://${domain}`, `https://www.${domain}`];
  let html = "";
  let finalUrl = "";

  for (const hUrl of homeUrls) {
    try {
      const res = await fetcher(hUrl);
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
    const imgData = await downloadAndValidateImage(icon.url, minSize, fetcher);
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
    const imgData = await downloadAndValidateImage(ogImageUrl, minSize, fetcher);
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

export interface LiveMatchResult {
  matchedCounts: Map<string, number>;
  jobsByCompanyId: Map<string, JobInfo[]>;
  jobsByCompanyName: Map<string, JobInfo[]>;
  unmatchedNames: Array<{ name: string; count: number }>;
  matchedLiveJobCount: number;
}

export interface ReviewedManifestEntry {
  companyId: string;
  companyName: string;
  source: CandidateLogo["source"];
  serviceName?: string;
  sourceImageUrl: string;
  storagePath: string;
  targetLogoUrl: string;
  ext: string;
  domain: string | null;
  previousLogoUrl: string | null;
  previousDomain: string | null;
}

export interface BackfillManifest {
  version: 1;
  createdAt: string;
  selection: {
    liveOnly: boolean;
    missingOnly: boolean;
    force: boolean;
    limit: number | null;
    offset: number;
  };
  entries: ReviewedManifestEntry[];
}

export interface CandidateSelectionInput {
  allCompanies: CompanyRow[];
  liveJobs: JobInfo[];
  topRecentJobs?: JobInfo[];
  liveOnly: boolean;
  missingOnly: boolean;
  force: boolean;
  supabaseUrl?: string;
  limit?: number;
  offset?: number;
  manifest?: BackfillManifest;
}

export interface CandidateSelectionResult {
  companiesToEvaluate: CompanyRow[];
  activeJobCounts: Map<string, number>;
  skippedAlreadyHosted: number;
  totalMatchedLiveCompanies: number;
  unmatchedNames: Array<{ name: string; count: number }>;
  jobsByCompanyId: Map<string, JobInfo[]>;
  jobsByCompanyName: Map<string, JobInfo[]>;
}

/**
 * Matches live jobs (status = 'active' AND is_active = true) to companies:
 * first via jobs.company_id, and when company_id IS NULL via
 * lower(btrim(jobs.company)) = lower(btrim(companies.name)).
 */
export function matchLiveJobsToCompanies(
  liveJobs: JobInfo[],
  allCompanies: CompanyRow[]
): LiveMatchResult {
  const companyById = new Map<string, CompanyRow>();
  const companyByName = new Map<string, CompanyRow>();

  for (const company of allCompanies) {
    if (company.id) {
      companyById.set(company.id, company);
    }
    const norm = normalizeCompanyKey(company.name);
    if (norm) {
      const existing = companyByName.get(norm);
      if (!existing || (!existing.domain && company.domain)) {
        companyByName.set(norm, company);
      }
    }
  }

  const matchedCounts = new Map<string, number>();
  const jobsByCompanyId = new Map<string, JobInfo[]>();
  const jobsByCompanyName = new Map<string, JobInfo[]>();
  const unmatchedMap = new Map<string, { name: string; count: number }>();
  let matchedLiveJobCount = 0;

  const recordJobUrlIndexes = (company: CompanyRow, job: JobInfo) => {
    if (!jobsByCompanyId.has(company.id)) jobsByCompanyId.set(company.id, []);
    jobsByCompanyId.get(company.id)!.push(job);
    const norm = normalizeCompanyKey(company.name);
    if (norm) {
      if (!jobsByCompanyName.has(norm)) jobsByCompanyName.set(norm, []);
      jobsByCompanyName.get(norm)!.push(job);
    }
  };

  for (const job of liveJobs) {
    if (job.status !== undefined && job.status !== "active") continue;
    if (job.is_active !== undefined && job.is_active !== true) continue;

    let matched: CompanyRow | undefined;
    const rawCompanyId = job.company_id ? String(job.company_id).trim() : "";

    if (rawCompanyId) {
      matched = companyById.get(rawCompanyId);
    } else {
      const normJobName = normalizeCompanyKey(job.company);
      if (normJobName) {
        matched = companyByName.get(normJobName);
      }
    }

    if (matched) {
      matchedCounts.set(matched.id, (matchedCounts.get(matched.id) ?? 0) + 1);
      matchedLiveJobCount++;
      recordJobUrlIndexes(matched, job);
    } else {
      const display = String(job.company ?? "").trim() || (rawCompanyId ? `company_id:${rawCompanyId}` : "(empty)");
      const key = normalizeCompanyKey(display);
      const entry = unmatchedMap.get(key);
      if (entry) {
        entry.count++;
      } else {
        unmatchedMap.set(key, { name: display, count: 1 });
      }
    }
  }

  const unmatchedNames = Array.from(unmatchedMap.values()).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  );

  return {
    matchedCounts,
    jobsByCompanyId,
    jobsByCompanyName,
    unmatchedNames,
    matchedLiveJobCount,
  };
}

/**
 * Selects, filters, orders, and paginates candidate companies for backfill.
 */
export function selectCandidateCompanies(
  input: CandidateSelectionInput
): CandidateSelectionResult {
  const {
    allCompanies,
    liveJobs,
    topRecentJobs = [],
    liveOnly,
    missingOnly,
    force,
    supabaseUrl,
    limit,
    offset = 0,
    manifest,
  } = input;

  const manifestIds = manifest
    ? new Set(manifest.entries.map((e) => e.companyId))
    : null;

  const liveMatch = matchLiveJobsToCompanies(liveJobs, allCompanies);
  const jobsByCompanyId = new Map<string, JobInfo[]>(liveMatch.jobsByCompanyId);
  const jobsByCompanyName = new Map<string, JobInfo[]>(liveMatch.jobsByCompanyName);

  // Also index any remaining job URLs passed in liveJobs when not running liveOnly
  if (!liveOnly) {
    for (const j of liveJobs) {
      if (j.company) {
        const k = normalizeCompanyKey(j.company);
        if (k) {
          if (!jobsByCompanyName.has(k)) jobsByCompanyName.set(k, []);
          jobsByCompanyName.get(k)!.push(j);
        }
      }
      if (j.company_id) {
        if (!jobsByCompanyId.has(j.company_id)) jobsByCompanyId.set(j.company_id, []);
        jobsByCompanyId.get(j.company_id)!.push(j);
      }
    }
  }

  let ordered: CompanyRow[];
  if (liveOnly) {
    ordered = allCompanies
      .filter((c) => (liveMatch.matchedCounts.get(c.id) ?? 0) > 0)
      .sort((a, b) => {
        const diff =
          (liveMatch.matchedCounts.get(b.id) ?? 0) -
          (liveMatch.matchedCounts.get(a.id) ?? 0);
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name);
      });
  } else {
    const top200Names = new Set(
      topRecentJobs.map((j) => normalizeCompanyKey(j.company)).filter(Boolean)
    );
    const top200Ids = new Set(
      topRecentJobs.map((j) => j.company_id).filter(Boolean)
    );
    ordered = [...allCompanies].sort((a, b) => {
      const aIsTop =
        top200Names.has(normalizeCompanyKey(a.name)) ||
        (a.id ? top200Ids.has(a.id) : false);
      const bIsTop =
        top200Names.has(normalizeCompanyKey(b.name)) ||
        (b.id ? top200Ids.has(b.id) : false);
      if (aIsTop && !bIsTop) return -1;
      if (!aIsTop && bIsTop) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  const totalMatchedLiveCompanies = liveOnly ? ordered.length : 0;

  let skippedAlreadyHosted = 0;
  const filtered: CompanyRow[] = [];
  for (const company of ordered) {
    if (manifestIds && !manifestIds.has(company.id)) {
      continue;
    }
    if (missingOnly && company.logo_url !== null) {
      continue;
    }
    if (!force && isSelfHostedLogoUrl(company.logo_url, supabaseUrl)) {
      skippedAlreadyHosted++;
      continue;
    }
    filtered.push(company);
  }

  // When a reviewed manifest is provided, it already defines the exact reviewed slice;
  // do not re-slice by offset/limit (and never broaden past manifest company IDs).
  const companiesToEvaluate = manifestIds
    ? filtered
    : filtered.slice(offset, limit !== undefined ? offset + limit : undefined);

  return {
    companiesToEvaluate,
    activeJobCounts: liveMatch.matchedCounts,
    skippedAlreadyHosted,
    totalMatchedLiveCompanies,
    unmatchedNames: liveMatch.unmatchedNames,
    jobsByCompanyId,
    jobsByCompanyName,
  };
}

function escapeSqlLiteral(val: string): string {
  return val.replace(/'/g, "''");
}

function toSqlNullableText(val: string | null | undefined): string {
  if (val === null || val === undefined || val === "") return "NULL";
  return `'${escapeSqlLiteral(val)}'`;
}

export interface GeneratedSqlRow {
  companyId: string;
  companyName: string;
  storagePath: string;
  targetLogoUrl: string;
  updateSql: string;
  rollbackSql: string;
}

/**
 * Generates exact forward UPDATE statements and per-company rollback SQL.
 * Uses content-hashed versioned storage keys (`<company_id>-<hash>.<ext>`) and refuses
 * non-self-hosted target URLs so /api/ticker constraints are never violated.
 */
export function buildCompanyLogoSql(
  candidates: CandidateLogo[],
  supabaseUrl: string,
  resolvePublicUrl?: (storagePath: string) => string
): GeneratedSqlRow[] {
  const baseUrl = supabaseUrl.replace(/\/+$/, "");
  const rows: GeneratedSqlRow[] = [];

  for (const item of candidates) {
    const storagePath = buildLogoStoragePath(item.company.id, item.buffer, item.ext);
    const targetLogoUrl = resolvePublicUrl
      ? resolvePublicUrl(storagePath)
      : `${baseUrl}/storage/v1/object/public/${COMPANY_LOGOS_BUCKET}/${storagePath}`;

    if (!isSelfHostedLogoUrl(targetLogoUrl, supabaseUrl)) {
      throw new Error(
        `Refusing non-self-hosted logo_url for ${item.company.name}: ${targetLogoUrl}`
      );
    }

    const shouldSetDomain = Boolean(item.domain && !item.company.domain?.trim());
    const escapedId = escapeSqlLiteral(item.company.id);
    const escapedTargetUrl = escapeSqlLiteral(targetLogoUrl);

    const updateSql = shouldSetDomain
      ? `UPDATE public.companies SET logo_url = '${escapedTargetUrl}', domain = ${toSqlNullableText(item.domain)} WHERE id = '${escapedId}'; -- ${item.company.name}`
      : `UPDATE public.companies SET logo_url = '${escapedTargetUrl}' WHERE id = '${escapedId}'; -- ${item.company.name}`;

    const rollbackSql = shouldSetDomain
      ? `UPDATE public.companies SET logo_url = ${toSqlNullableText(item.company.logo_url)}, domain = ${toSqlNullableText(item.company.domain ?? null)} WHERE id = '${escapedId}'; -- rollback ${item.company.name}`
      : `UPDATE public.companies SET logo_url = ${toSqlNullableText(item.company.logo_url)} WHERE id = '${escapedId}'; -- rollback ${item.company.name}`;

    rows.push({
      companyId: item.company.id,
      companyName: item.company.name,
      storagePath,
      targetLogoUrl,
      updateSql,
      rollbackSql,
    });
  }

  return rows;
}

/**
 * Builds transactional run-only rollback SQL scoped strictly to the exact company IDs
 * touched in this run with their prior `logo_url` (and `domain` if modified) values.
 */
export function buildRunRollbackSql(rows: GeneratedSqlRow[]): string {
  if (rows.length === 0) {
    return "-- Run-only Rollback SQL: 0 companies updated in this run; no rollback needed.";
  }
  return [
    `-- Run-only Rollback SQL (${rows.length} compan${rows.length === 1 ? "y" : "ies"} touched in this run):`,
    "-- Note: prior versioned storage objects are retained in bucket so rollback SQL restores live URLs.",
    "BEGIN;",
    ...rows.map((r) => r.rollbackSql),
    "COMMIT;",
  ].join("\n");
}

export function buildBackfillManifest(
  cli: BackfillCliArgs,
  sqlRows: GeneratedSqlRow[],
  candidates: CandidateLogo[]
): BackfillManifest {
  const byId = new Map(candidates.map((c) => [c.company.id, c]));
  const entries: ReviewedManifestEntry[] = sqlRows.map((row) => {
    const cand = byId.get(row.companyId)!;
    return {
      companyId: row.companyId,
      companyName: row.companyName,
      source: cand.source,
      ...(cand.serviceName ? { serviceName: cand.serviceName } : {}),
      sourceImageUrl: cand.imageUrl,
      storagePath: row.storagePath,
      targetLogoUrl: row.targetLogoUrl,
      ext: cand.ext,
      domain: cand.domain ?? null,
      previousLogoUrl: cand.company.logo_url ?? null,
      previousDomain: cand.company.domain ?? null,
    };
  });

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    selection: {
      liveOnly: cli.liveOnly,
      missingOnly: cli.missingOnly,
      force: cli.force,
      limit: cli.limit ?? null,
      offset: cli.offset,
    },
    entries,
  };
}

export function writeReviewedManifest(manifestPath: string, manifest: BackfillManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function readReviewedManifest(manifestPath: string): BackfillManifest {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as BackfillManifest;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`Invalid backfill manifest file: ${manifestPath}`);
  }
  return parsed;
}

export function filterCandidatesByManifest(
  candidates: CandidateLogo[],
  manifest: BackfillManifest
): { approved: CandidateLogo[]; skippedDrift: Array<{ companyId: string; companyName: string; reason: string }> } {
  const byId = new Map(manifest.entries.map((e) => [e.companyId, e]));
  const approved: CandidateLogo[] = [];
  const skippedDrift: Array<{ companyId: string; companyName: string; reason: string }> = [];

  for (const item of candidates) {
    const entry = byId.get(item.company.id);
    if (!entry) {
      skippedDrift.push({
        companyId: item.company.id,
        companyName: item.company.name,
        reason: "Not listed in reviewed manifest",
      });
      continue;
    }
    const resolvedStoragePath = buildLogoStoragePath(item.company.id, item.buffer, item.ext);
    if (entry.sourceImageUrl !== item.imageUrl || entry.storagePath !== resolvedStoragePath) {
      skippedDrift.push({
        companyId: item.company.id,
        companyName: item.company.name,
        reason: `Resolved asset changed since manifest (${entry.storagePath} -> ${resolvedStoragePath})`,
      });
      continue;
    }
    approved.push(item);
  }

  return { approved, skippedDrift };
}

/**
 * Uploads `<company_id>-<hash>.<ext>` without deleting or overwriting any previous object before
 * DB commit, updates `companies.logo_url` (+ `companies.domain` when missing/known), and:
 * - On DB failure: removes only the newly uploaded versioned object, leaving prior storage object and `logo_url` intact.
 * - On DB success: retains prior versioned storage objects so run-only rollback SQL stays live and functional.
 */
export async function uploadAndPersistCompanyLogo(
  supabase: SupabaseClient,
  supabaseUrl: string,
  item: CandidateLogo
): Promise<{ publicUrl: string | null; storagePath?: string | null; error?: string }> {
  const storagePath = buildLogoStoragePath(item.company.id, item.buffer, item.ext);
  const oldStoragePath = extractStoragePathFromLogoUrl(item.company.logo_url);
  const isSameKey = oldStoragePath === storagePath;

  const removeNewObjectSafely = async () => {
    if (isSameKey) return;
    try {
      await supabase.storage.from(COMPANY_LOGOS_BUCKET).remove([storagePath]);
    } catch {}
  };

  const { error: uploadError } = await supabase.storage
    .from(COMPANY_LOGOS_BUCKET)
    .upload(storagePath, item.buffer, {
      contentType: item.contentType,
      upsert: true,
    });

  if (uploadError) {
    return { publicUrl: null, storagePath: null, error: uploadError.message };
  }

  const { data: publicUrlData } = supabase.storage
    .from(COMPANY_LOGOS_BUCKET)
    .getPublicUrl(storagePath);

  const publicUrl = publicUrlData?.publicUrl;
  if (!isSelfHostedLogoUrl(publicUrl, supabaseUrl)) {
    await removeNewObjectSafely();
    return {
      publicUrl: null,
      storagePath: null,
      error: `Refused external or invalid storage public URL: ${String(publicUrl)}`,
    };
  }

  const updatePayload: { logo_url: string; domain?: string } = {
    logo_url: publicUrl!,
  };
  if (item.domain && !item.company.domain?.trim()) {
    updatePayload.domain = item.domain;
  }

  const { error: dbError } = await supabase
    .from("companies")
    .update(updatePayload)
    .eq("id", item.company.id);

  if (dbError) {
    await removeNewObjectSafely();
    return { publicUrl: null, storagePath: null, error: dbError.message };
  }

  return { publicUrl: publicUrl!, storagePath };
}

async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  pageSize: number = 1000
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await fetchPage(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(error.message || "Paged query failed");
    }
    if (!data || data.length === 0) break;
    results.push(...data);
    if (data.length < pageSize) break;
    offset += data.length;
  }
  return results;
}

async function runWorkerPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, completedCount: number, totalCount: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.min(Math.max(1, concurrency), MAX_CONCURRENCY, items.length);
  let nextIdx = 0;
  let completed = 0;

  async function runOneWorker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      const item = items[idx];
      await worker(item, completed + 1, items.length);
      completed++;
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runOneWorker()));
}

export async function runBackfill() {
  const cli = parseBackfillCliArgs(process.argv);
  const loadedManifest =
    cli.isWrite && cli.manifestPath ? readReviewedManifest(cli.manifestPath) : undefined;

  console.log("=========================================================================");
  console.log("CAREERMONKE COMPANY LOGOS BACKFILL & RE-CHECK ENGINE");
  console.log(`Mode:         ${cli.isWrite ? "LIVE WRITE (--write)" : "DRY RUN (default, safe)"}`);
  console.log(`Live Only:    ${cli.liveOnly ? "YES (--live-only)" : "NO"}`);
  console.log(`Missing Only: ${cli.missingOnly ? "YES (--missing-only / --schedule)" : "NO"}`);
  console.log(`Force:        ${cli.force ? "YES (--force)" : "NO (skip self-hosted rows)"}`);
  if (cli.offset > 0) console.log(`Offset:       ${cli.offset}`);
  if (cli.limit !== undefined) console.log(`Limit:        ${cli.limit} companies`);
  if (loadedManifest) console.log(`Manifest:     ${cli.manifestPath} (${loadedManifest.entries.length} reviewed entries)`);
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

  // 1. Fetch jobs for live candidate matching, prioritization, and domain derivation
  let topRecentJobs: JobInfo[] = [];
  if (!cli.liveOnly) {
    console.log("Fetching recent active jobs for prioritization and domain derivation...");
    const { data } = await supabase
      .from("jobs")
      .select("company, company_id, apply_url, source_url, posted_at")
      .eq("status", "active")
      .eq("is_active", true)
      .order("posted_at", { ascending: false })
      .limit(200);
    topRecentJobs = (data || []) as JobInfo[];
  }

  console.log(
    cli.liveOnly
      ? "Fetching all live jobs (status = 'active' AND is_active = true)..."
      : "Fetching jobs to index job URLs for domain derivation..."
  );

  const liveJobs = await fetchAllPages<JobInfo>((from, to) => {
    const query = supabase
      .from("jobs")
      .select("company, company_id, apply_url, source_url, status, is_active");
    return cli.liveOnly
      ? query.eq("status", "active").eq("is_active", true).range(from, to)
      : query.range(from, to);
  });

  // 2. Fetch companies
  console.log("Fetching companies from database...");
  const allCompanies = await fetchAllPages<CompanyRow>((from, to) =>
    supabase
      .from("companies")
      .select("id, name, slug, domain, careers_url, ats_type, logo_url")
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
  );

  const totalCompaniesCount = allCompanies.length;
  const withLogoBefore = allCompanies.filter((c) => c.logo_url !== null).length;
  const selfHostedBefore = allCompanies.filter((c) =>
    isSelfHostedLogoUrl(c.logo_url, supabaseUrl)
  ).length;
  const withoutLogoBefore = totalCompaniesCount - withLogoBefore;
  const pct = (n: number) =>
    totalCompaniesCount > 0 ? ((n / totalCompaniesCount) * 100).toFixed(1) : "0.0";

  console.log(`Database Baseline:`);
  console.log(`  Total Companies:       ${totalCompaniesCount}`);
  console.log(`  With Logo Before:      ${withLogoBefore} (${pct(withLogoBefore)}%)`);
  console.log(`  Self-Hosted Before:    ${selfHostedBefore} (${pct(selfHostedBefore)}%)`);
  console.log(`  Without Logo Before:   ${withoutLogoBefore} (${pct(withoutLogoBefore)}%)\n`);

  const selection = selectCandidateCompanies({
    allCompanies,
    liveJobs,
    topRecentJobs,
    liveOnly: cli.liveOnly,
    missingOnly: cli.missingOnly,
    force: cli.force,
    supabaseUrl,
    limit: cli.limit,
    offset: cli.offset,
    manifest: loadedManifest,
  });

  if (cli.liveOnly) {
    console.log(`Live-only candidate summary:`);
    console.log(`  Matched companies with active jobs: ${selection.totalMatchedLiveCompanies}`);
    console.log(`  Skipped (already in bucket):        ${selection.skippedAlreadyHosted}`);
    if (selection.unmatchedNames.length > 0) {
      console.log(`  Unmatched live job company names (${selection.unmatchedNames.length}):`);
      for (const u of selection.unmatchedNames) {
        console.log(`    - "${u.name}" (${u.count} active job${u.count === 1 ? "" : "s"})`);
      }
    }
    console.log();
  } else if (selection.skippedAlreadyHosted > 0) {
    console.log(`Skipped ${selection.skippedAlreadyHosted} companies already hosted in bucket (pass --force to re-process).\n`);
  }

  const { companiesToEvaluate, activeJobCounts, jobsByCompanyId, jobsByCompanyName } = selection;

  console.log(
    `Evaluating ${companiesToEvaluate.length} companies (concurrency max ${CONCURRENCY}, >= ${MIN_HOST_INTERVAL_MS}ms per host)...\n`
  );

  // Shared polite fetcher coordinates per-host rate limiting, 5xx single retry, and no 404 retry across workers
  const politeFetch = createPoliteFetcher();

  // Phase 1: Inspect companies on ATS boards
  console.log("Phase 1: Scanning board pages, icons, and og:image candidates...");
  const inspections: CompanyInspection[] = [];

  await runWorkerPool(companiesToEvaluate, CONCURRENCY, async (company, done, total) => {
    try {
      const result = await inspectCompany(company, {
        force: cli.force,
        supabaseUrl,
        fetcher: politeFetch,
      });
      inspections.push(result);
    } catch (err: any) {
      inspections.push({
        company,
        ats: company.ats_type || "unknown",
        boardUrl: "",
        iconCandidate: null,
        ogCandidate: null,
        status: "failed",
        reason: err?.message || "Inspection failed",
      });
    }

    if (done % 25 === 0 || done === total) {
      process.stdout.write(`Progress: ${done}/${total} companies inspected...\r`);
    }
  });
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

  const getCompanyJobs = (company: CompanyRow): JobInfo[] => [
    ...(jobsByCompanyName.get(normalizeCompanyKey(company.name)) || []),
    ...(jobsByCompanyId.get(company.id) || []),
  ];

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
      if (!chosen.domain) {
        const derived = deriveCompanyDomain(
          chosen.company,
          getCompanyJobs(chosen.company),
          insp.ashbyPublicWebsite,
          insp.extractedDomain
        );
        if (derived) chosen.domain = derived;
      }
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

  await runWorkerPool(
    companiesNeedingFallback,
    CONCURRENCY,
    async ({ company, inspection }, done, total) => {
      const compJobs = getCompanyJobs(company);
      const domain = deriveCompanyDomain(
        company,
        compJobs,
        inspection.ashbyPublicWebsite,
        inspection.extractedDomain
      );

      if (domain) {
        let resolved = false;
        try {
          const homeLogo = await inspectCompanyHomepage(company, domain, 32, politeFetch);
          if (homeLogo) {
            fallbackCandidates.push({ candidate: homeLogo, company });
            resolved = true;
          }
        } catch {}

        if (!resolved) {
          try {
            const freeService = await fetchFreeLogoService(domain, 32, politeFetch);
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
            }
          } catch {}
        }
      }

      if (done % 10 === 0 || done === total) {
        process.stdout.write(`Fallback progress: ${done}/${total} inspected...\r`);
      }
    }
  );
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
    const tag =
      item.source === "homepage-icon"
        ? "homepage"
        : item.source === "free-service"
        ? item.serviceName || "free-svc"
        : item.ats;
    const jobCount = activeJobCounts.get(item.company.id);
    const jobsCol = jobCount !== undefined ? ` | jobs: ${String(jobCount).padStart(3)}` : "";
    console.log(
      `[${tag.padEnd(10)}] ${item.company.name.padEnd(28)}${jobsCol} | source: ${item.source.padEnd(13)} | domain: ${(item.domain || "n/a").padEnd(22)} | ${item.width}x${item.height} | ${item.imageUrl}`
    );
  }
  console.log("================================\n");

  let candidatesForRun = validCandidates;
  if (loadedManifest) {
    const manifestFilter = filterCandidatesByManifest(validCandidates, loadedManifest);
    for (const skipped of manifestFilter.skippedDrift) {
      console.warn(
        `Skipping ${skipped.companyName} (${skipped.companyId}): ${skipped.reason}`
      );
    }
    candidatesForRun = manifestFilter.approved;
  }

  const getPublicStorageUrl = (storagePath: string) => {
    const { data } = supabase.storage.from(COMPANY_LOGOS_BUCKET).getPublicUrl(storagePath);
    return data.publicUrl;
  };

  const sqlRows = buildCompanyLogoSql(candidatesForRun, supabaseUrl, getPublicStorageUrl);

  // Exact SQL generation for review before any DB write
  console.log("=========================================================================");
  console.log("EXACT SQL QUERIES (DRY RUN / PRE-FLIGHT AUDIT)");
  console.log("=========================================================================");
  console.log("-- Target table: public.companies");
  console.log(`-- Total rows to update: ${sqlRows.length}\n`);

  for (const row of sqlRows) {
    console.log(row.updateSql);
  }
  console.log("");
  console.log(buildRunRollbackSql(sqlRows));
  console.log("=========================================================================\n");

  const succeededCandidates: CandidateLogo[] = [];

  // In write mode: upload and update
  if (cli.isWrite) {
    console.log(`Uploading ${candidatesForRun.length} company logos to Supabase Storage...`);
    let uploadCount = 0;
    let failedCount = 0;
    const sampleUploaded: Array<{ name: string; url: string }> = [];

    for (const item of candidatesForRun) {
      try {
        const res = await uploadAndPersistCompanyLogo(supabase, supabaseUrl, item);
        if (!res.publicUrl) {
          console.error(`Write/upload error for ${item.company.name}:`, res.error);
          failedCount++;
          continue;
        }
        uploadCount++;
        succeededCandidates.push(item);
        if (sampleUploaded.length < 5) {
          sampleUploaded.push({ name: item.company.name, url: res.publicUrl });
        }
      } catch (err: any) {
        console.error(`Write error for ${item.company.name}:`, err?.message || err);
        failedCount++;
      }
    }
    console.log(`Successfully uploaded and updated ${uploadCount} companies in database.\n`);
    const candidateSkipped = candidatesForRun.length - uploadCount - failedCount;
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

  const newlyPopulatedCount = candidatesForRun.filter((c) => c.company.logo_url === null).length;
  const projectedTotalWithLogo = Math.min(totalCompaniesCount, withLogoBefore + newlyPopulatedCount);
  console.log("=========================================================================");
  console.log("BEFORE VS AFTER COMPANY LOGO AUDIT REPORT");
  console.log("=========================================================================");
  console.log(`Total Companies in Database:       ${totalCompaniesCount}`);
  console.log(`Companies With Logo BEFORE:        ${withLogoBefore} (${pct(withLogoBefore)}%)`);
  console.log(`Companies Without Logo BEFORE:     ${withoutLogoBefore} (${pct(withoutLogoBefore)}%)`);
  console.log(`Newly Resolved in this run:        +${candidatesForRun.length}`);
  console.log(`Companies With Logo AFTER:         ${projectedTotalWithLogo} (${pct(projectedTotalWithLogo)}%)`);
  console.log(`Remaining With Letter Placeholder: ${totalCompaniesCount - projectedTotalWithLogo} (${pct(totalCompaniesCount - projectedTotalWithLogo)}%)`);
  console.log("=========================================================================\n");

  const finalRollbackRows = cli.isWrite
    ? buildCompanyLogoSql(succeededCandidates, supabaseUrl, getPublicStorageUrl)
    : sqlRows;
  console.log(buildRunRollbackSql(finalRollbackRows));
  console.log();

  if (!cli.isWrite) {
    const manifestOutPath = cli.manifestPath || getDefaultManifestPath();
    const manifest = buildBackfillManifest(cli, sqlRows, candidatesForRun);
    writeReviewedManifest(manifestOutPath, manifest);
    const applyCmd = buildWriteApplyCommand(cli, manifestOutPath);

    console.log("Dry-run complete. ZERO files uploaded and ZERO database rows modified.");
    console.log(`Reviewed manifest (${manifest.entries.length} entries) written to: ${manifestOutPath}`);
    console.log(`To apply these exact reviewed changes, run:\n  ${applyCmd}\n`);
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
