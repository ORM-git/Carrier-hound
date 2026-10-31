/**
 * scripts/backfill-company-logos.ts
 *
 * Backfill script for self-hosted company logos in Supabase Storage.
 *
 * Requirements:
 * - Service role client (reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).
 * - Dry-run by default. Pass `--write` to apply uploads and database updates.
 * - Fully idempotent (skips rows whose logo_url already points to 'company-logos').
 * - For each company row:
 *     greenhouse: https://job-boards.greenhouse.io/<slug> (fallback: https://boards.greenhouse.io/<slug>)
 *     ashby:      https://jobs.ashbyhq.com/<slug>
 *     lever:      https://jobs.lever.co/<slug>
 * - Parse og:image meta tag from HTML.
 * - Download image validating content-type image/* and size <= 2MB (2,097,152 bytes).
 * - In --write mode:
 *     Upload to 'company-logos' bucket at <company_id>.<ext> (upsert: true).
 *     Set companies.logo_url to the public storage URL.
 * - Print counts (found / missing / failed / already_set) per ats_type.
 * - Never throw on a single company error.
 * - No placeholders (no logo found means logo_url stays null).
 * - Prints rollback SQL at the end:
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

function getExtension(contentType: string, url: string): string {
  const cleanType = (contentType || "").toLowerCase().split(";")[0].trim();
  switch (cleanType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
  }

  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(png|jpe?g|webp|gif|svg)$/i);
    if (match) {
      const ext = match[1].toLowerCase();
      return ext === "jpeg" ? "jpg" : ext;
    }
  } catch {
    // ignore
  }

  return "png";
}

function parseOgImage(html: string, baseUrl: string): string | null {
  const match =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

  if (!match || !match[1]) return null;

  const rawUrl = decodeHtmlEntities(match[1].trim());
  if (!rawUrl) return null;

  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function processCompany(
  company: CompanyRow,
  supabase: any,
  isWrite: boolean
): Promise<{ status: "found" | "missing" | "failed" | "already_set"; reason?: string }> {
  // 1. Skip rows already pointing at our bucket
  if (company.logo_url && company.logo_url.includes("company-logos")) {
    return { status: "already_set", reason: "Already backfilled" };
  }

  const ats = (company.ats_type || "unknown").toLowerCase().trim();
  const slug = (company.slug || "").trim();

  if (!slug) {
    return { status: "missing", reason: "No slug" };
  }

  // 2. Derive candidate board URLs based on ATS type
  const candidateUrls: string[] = [];
  if (ats === "greenhouse") {
    candidateUrls.push(`https://job-boards.greenhouse.io/${slug}`);
    candidateUrls.push(`https://boards.greenhouse.io/${slug}`);
  } else if (ats === "ashby") {
    candidateUrls.push(`https://jobs.ashbyhq.com/${slug}`);
  } else if (ats === "lever") {
    candidateUrls.push(`https://jobs.lever.co/${slug}`);
  } else {
    // Unsupported or unknown ATS for direct board derivation
    return { status: "missing", reason: `Unsupported ats_type: ${ats}` };
  }

  // 3. Fetch board page and extract og:image
  let ogImageUrl: string | null = null;
  let activeBoardUrl: string | null = null;
  let lastError = "";

  for (const url of candidateUrls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const html = await res.text();
      const parsed = parseOgImage(html, url);
      if (parsed) {
        ogImageUrl = parsed;
        activeBoardUrl = url;
        break;
      } else {
        lastError = "No og:image tag in HTML";
      }
    } catch (err: any) {
      lastError = err?.message || "Fetch failed";
    }
  }

  if (!ogImageUrl || !activeBoardUrl) {
    return { status: "missing", reason: lastError || "No logo found" };
  }

  // 4. Download the image and validate Content-Type & size
  let imageBuffer: Buffer;
  let contentType: string;
  try {
    const imgRes = await fetchWithTimeout(ogImageUrl);
    if (!imgRes.ok) {
      return { status: "failed", reason: `Image download failed: HTTP ${imgRes.status}` };
    }

    const arrayBuf = await imgRes.arrayBuffer();
    imageBuffer = Buffer.from(arrayBuf);

    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      return {
        status: "failed",
        reason: `Image exceeds 2MB limit: ${imageBuffer.length} bytes`,
      };
    }
    if (imageBuffer.length === 0) {
      return { status: "failed", reason: "Empty image buffer (0 bytes)" };
    }

    const rawType = imgRes.headers.get("content-type") || "";
    let cleanType = rawType.split(";")[0].trim().toLowerCase();

    // If content-type is generic octet-stream (e.g. S3 sends application/octet-stream for Lever),
    // sniff image magic bytes to validate image type:
    if (!cleanType.startsWith("image/")) {
      if (
        imageBuffer.length >= 8 &&
        imageBuffer[0] === 0x89 &&
        imageBuffer[1] === 0x50 &&
        imageBuffer[2] === 0x4e &&
        imageBuffer[3] === 0x47
      ) {
        cleanType = "image/png";
      } else if (
        imageBuffer.length >= 3 &&
        imageBuffer[0] === 0xff &&
        imageBuffer[1] === 0xd8 &&
        imageBuffer[2] === 0xff
      ) {
        cleanType = "image/jpeg";
      } else if (
        imageBuffer.length >= 4 &&
        imageBuffer[0] === 0x47 &&
        imageBuffer[1] === 0x49 &&
        imageBuffer[2] === 0x46
      ) {
        cleanType = "image/gif";
      } else if (
        imageBuffer.length >= 12 &&
        imageBuffer.toString("ascii", 0, 4) === "RIFF" &&
        imageBuffer.toString("ascii", 8, 12) === "WEBP"
      ) {
        cleanType = "image/webp";
      } else if (
        imageBuffer.slice(0, 100).toString("utf8").toLowerCase().includes("<svg")
      ) {
        cleanType = "image/svg+xml";
      }
    }

    if (!cleanType.startsWith("image/")) {
      return { status: "failed", reason: `Invalid content-type: ${rawType}` };
    }
    contentType = cleanType;
  } catch (err: any) {
    return { status: "failed", reason: `Image fetch error: ${err?.message}` };
  }

  const ext = getExtension(contentType, ogImageUrl);
  const storagePath = `${company.id}.${ext}`;

  // 5. In write mode: upload to Supabase Storage and update companies.logo_url
  if (isWrite) {
    try {
      const { error: uploadError } = await supabase.storage
        .from("company-logos")
        .upload(storagePath, imageBuffer, {
          contentType,
          upsert: true,
        });

      if (uploadError) {
        return { status: "failed", reason: `Storage upload error: ${uploadError.message}` };
      }

      const { data: publicUrlData } = supabase.storage
        .from("company-logos")
        .getPublicUrl(storagePath);

      const publicUrl = publicUrlData?.publicUrl;
      if (!publicUrl) {
        return { status: "failed", reason: "Failed to generate public URL" };
      }

      const { error: updateError } = await supabase
        .from("companies")
        .update({ logo_url: publicUrl })
        .eq("id", company.id);

      if (updateError) {
        return { status: "failed", reason: `DB update error: ${updateError.message}` };
      }
    } catch (err: any) {
      return { status: "failed", reason: `Write operation error: ${err?.message}` };
    }
  }

  return { status: "found" };
}

async function runBackfill() {
  const isWrite = process.argv.includes("--write");
  const limitIdx = process.argv.indexOf("--limit");
  const limitVal = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : undefined;

  console.log("=================================================");
  console.log(`CAREERMONKE COMPANY LOGOS BACKFILL`);
  console.log(`Mode: ${isWrite ? "LIVE WRITE (--write)" : "DRY RUN (default)"}`);
  if (limitVal) console.log(`Limit: ${limitVal} companies`);
  console.log("=================================================\n");

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

  // Query all companies
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

  const statsByAts: Record<string, AtsStats> = {};

  const getStats = (ats: string): AtsStats => {
    const key = ats || "unknown";
    if (!statsByAts[key]) {
      statsByAts[key] = { found: 0, missing: 0, failed: 0, already_set: 0, total: 0 };
    }
    return statsByAts[key];
  };

  // Run with concurrency control
  let completed = 0;
  const total = companies.length;

  async function worker(items: CompanyRow[]) {
    for (const company of items) {
      const ats = (company.ats_type || "unknown").toLowerCase().trim();
      const stats = getStats(ats);
      stats.total++;

      try {
        const result = await processCompany(company, supabase, isWrite);
        if (result.status === "found") {
          stats.found++;
        } else if (result.status === "already_set") {
          stats.already_set++;
        } else if (result.status === "missing") {
          stats.missing++;
        } else if (result.status === "failed") {
          stats.failed++;
        }
      } catch (err: any) {
        stats.failed++;
      }

      completed++;
      if (completed % 25 === 0 || completed === total) {
        process.stdout.write(`Progress: ${completed}/${total} companies processed...\r`);
      }
    }
  }

  // Partition items into CONCURRENCY chunks
  const chunks: CompanyRow[][] = Array.from({ length: CONCURRENCY }, () => []);
  companies.forEach((item, index) => {
    chunks[index % CONCURRENCY].push(item);
  });

  await Promise.all(chunks.map((chunk) => worker(chunk)));
  console.log("\n");

  // Summary Table
  console.log("-------------------------------------------------------------------------");
  console.log("ATS Type        | Found | Missing | Failed | Already Set | Total Scanned");
  console.log("-------------------------------------------------------------------------");

  let grandFound = 0;
  let grandMissing = 0;
  let grandFailed = 0;
  let grandAlreadySet = 0;
  let grandTotal = 0;

  const sortedAts = Object.keys(statsByAts).sort();
  for (const ats of sortedAts) {
    const s = statsByAts[ats];
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
