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
 *     Skip when width / height > 1.6 (prefer square-ish images).
 * - Generic default filter:
 *     Skip any image URL shared by 3 or more companies.
 * - Allowed formats: raster images only (png, jpeg/jpg, webp, gif). SVG is strictly excluded.
 * - In --write mode:
 *     Uploads to 'company-logos' bucket at <company_id>.<ext> (upsert: true).
 *     Deletes old file(s) when extension changes.
 *     Sets companies.logo_url to the public storage URL.
 * - In dry-run mode:
 *     Prints company, ATS and candidate image URL per row.
 * - Prints found/missing/failed per ats_type summary table and rollback SQL:
 *     UPDATE companies SET logo_url = null WHERE logo_url LIKE '%company-logos%';
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createClient } from "@supabase/supabase-js";

interface CompanyRow {
  id: string;
  name: string;
  slug: string | null;
  ats_type: string | null;
  logo_url: string | null;
}

interface AtsStats {
  found: number;
  missing: number;
  failed: number;
  already_set: number;
  total: number;
}

interface CandidateLogo {
  company: CompanyRow;
  ats: string;
  boardUrl: string;
  imageUrl: string;
  source: "icon" | "og:image";
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
}

interface CompanyInspection {
  company: CompanyRow;
  ats: string;
  boardUrl: string;
  iconCandidate: CandidateLogo | null;
  ogCandidate: CandidateLogo | null;
  status: "inspected" | "already_set" | "missing" | "failed";
  reason?: string;
}

const MAX_IMAGE_BYTES = 2097152; // 2MB
const REQUEST_TIMEOUT_MS = 10000; // 10s
const CONCURRENCY = 8;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 CareerMonkeBot/1.0";

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function getImageDimensions(buffer: Buffer): { width: number; height: number; type: string } | null {
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

  // 4. WebP: RIFF .... WEBP
  if (
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunkHeader = buffer.toString("ascii", 12, 16);
    if (chunkHeader === "VP8 " && buffer.length >= 30) {
      const width = (buffer[26] | (buffer[27] << 8)) & 0x3fff;
      const height = (buffer[28] | (buffer[29] << 8)) & 0x3fff;
      return { width, height, type: "webp" };
    }
    if (chunkHeader === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const b0 = buffer[21],
        b1 = buffer[22],
        b2 = buffer[23],
        b3 = buffer[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height, type: "webp" };
    }
    if (chunkHeader === "VP8X" && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height, type: "webp" };
    }
  }

  return null;
}

export function getCleanImageMeta(
  rawContentType: string,
  buffer: Buffer,
  url: string
): { contentType: string; ext: string } | null {
  const dims = getImageDimensions(buffer);
  if (!dims) {
    // Explicitly reject SVGs and non-raster formats
    return null;
  }

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

async function fetchWithTimeout(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/png,image/jpeg,image/webp,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadAndValidateImage(url: string): Promise<{
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

async function inspectCompany(company: CompanyRow): Promise<CompanyInspection> {
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

  // 2. Inspect og:image candidate (aspect ratio <= 1.6)
  if (ogImageUrl) {
    const imgData = await downloadAndValidateImage(ogImageUrl);
    if (imgData) {
      const ratio = imgData.width / imgData.height;
      if (ratio <= 1.6 && ratio >= 0.5) {
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
    status: iconCandidate || ogCandidate ? "inspected" : "missing",
    reason: iconCandidate || ogCandidate ? undefined : "No square-ish icon or og:image found",
  };
}

async function runBackfill() {
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

  console.log("Fetching companies from database...");
  let query = supabase
    .from("companies")
    .select("id, name, slug, ats_type, logo_url")
    .order("name", { ascending: true });

  if (limitVal) {
    query = query.limit(limitVal);
  }

  const { data: companies, error } = await query;
  if (error || !companies) {
    console.error("Failed to query companies:", error);
    process.exit(1);
  }

  console.log(`Found ${companies.length} companies to evaluate.\n`);

  // Phase 1: Inspect all companies and gather candidates
  console.log("Scanning board pages, icons, and og:image candidates...");
  const inspections: CompanyInspection[] = [];

  let completed = 0;
  const total = companies.length;

  async function worker(items: CompanyRow[]) {
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
  companies.forEach((item, index) => {
    chunks[index % CONCURRENCY].push(item);
  });

  await Promise.all(chunks.map((chunk) => worker(chunk)));
  console.log(`\n\nPhase 1 complete. Inspected ${inspections.length} companies.`);

  // Phase 2: Frequency analysis to detect generic default images shared across 3+ companies
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

    // Rule: Prefer favicon / apple-touch-icon >= 128px unless it is a shared generic default (count >= 3)
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
    }
  }

  console.log(`Filtered out ${genericDefaultsSkipped} generic default images shared by 3+ companies.\n`);

  // (1) Print company, ATS and the og:image/icon URL per row in dry-run mode
  console.log("=== CANDIDATE LOGOS PER ROW (DRY RUN) ===");
  for (const item of validCandidates) {
    console.log(`[${item.ats.padEnd(10)}] ${item.company.name.padEnd(28)} | ${item.width}x${item.height} (${item.source}) | ${item.imageUrl}`);
  }
  console.log("=========================================\n");

  // In write mode: upload and update
  if (isWrite) {
    console.log(`Uploading ${validCandidates.length} company logos to Supabase Storage...`);
    let uploadCount = 0;

    for (const item of validCandidates) {
      const storagePath = `${item.company.id}.${item.ext}`;

      try {
        // (8) Delete the old file when the extension changes
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
        }
      } catch (err: any) {
        console.error(`Write error for ${item.company.name}:`, err.message);
      }
    }
    console.log(`Successfully uploaded and updated ${uploadCount} companies in database.\n`);
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

if (process.argv[1]?.endsWith("backfill-company-logos.ts")) {
  runBackfill().catch((err) => {
    console.error("Unexpected error in backfill script:", err);
    process.exit(1);
  });
}
