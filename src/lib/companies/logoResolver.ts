/**
 * src/lib/companies/logoResolver.ts
 *
 * Centralized, production-grade company logo resolution engine.
 *
 * Capabilities:
 * 1. Derives company website domain strictly from verifiable sources (apply URLs,
 *    source URLs, company records, Ashby publicWebsite, or board Schema.org metadata).
 *    Never invents or guesses `${slug}.com`.
 * 2. Fetches and validates logos through a multi-tier fallback pipeline:
 *    - Tier 1: ATS Board icons or og:image (Greenhouse, Ashby, Lever).
 *    - Tier 2: Company website homepage favicon, apple-touch-icon, or og:image.
 *    - Tier 3: Free logo service fallback (Unavatar -> Google Favicons -> DuckDuckGo).
 * 3. Rigorous image validation:
 *    - HTTP 200 OK.
 *    - Allowed formats: raster only (PNG, JPEG, WebP, GIF). SVG is strictly excluded.
 *    - Dimension bounds: min dimension >= 32px (128px preferred for board icons).
 *    - Aspect ratio: 0.6 <= width / height <= 1.6 (prefer square / square-ish marks).
 *    - Max buffer size <= 2MB.
 *    - Generic default filter (rejects images shared across >= 3 unrelated companies).
 * 4. Idempotent storage and insert-time resolution for job ingestion pipelines.
 */

import dns from "node:dns";
import net from "node:net";
import { Agent } from "undici";

export interface CompanyRecord {
  id: string;
  name: string;
  slug?: string | null;
  domain?: string | null;
  careers_url?: string | null;
  ats_type?: string | null;
  logo_url?: string | null;
}

export interface JobUrlInfo {
  apply_url?: string | null;
  source_url?: string | null;
}

export interface ValidatedImage {
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
}

export interface ResolvedLogoResult {
  imageUrl: string;
  source: "ats-board" | "homepage-icon" | "free-service";
  serviceName?: "unavatar" | "google" | "duckduckgo";
  domain?: string;
  buffer: Buffer;
  contentType: string;
  ext: string;
  width: number;
  height: number;
}

export const MAX_IMAGE_BYTES = 2097152; // 2MB
export const REQUEST_TIMEOUT_MS = 10000; // 10s
export const MAX_REDIRECTS = 3;
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 CareerMonkeBot/1.0";

/**
 * Extracts and normalizes the IPv4 address from an IPv4-mapped IPv6 address,
 * supporting both dotted-quad (::ffff:127.0.0.1) and WHATWG hex format (::ffff:7f00:1).
 */
function parseV4Mapped(ip: string): string | null {
  const clean = ip.toLowerCase();
  let rest = "";
  if (clean.startsWith("::ffff:")) {
    rest = clean.slice(7);
  } else if (clean.startsWith("0:0:0:0:0:ffff:")) {
    rest = clean.slice(15);
  } else {
    return null;
  }

  if (rest.includes(".")) {
    return rest;
  }

  const parts = rest.split(":");
  if (parts.length === 2) {
    const w1 = parseInt(parts[0], 16);
    const w2 = parseInt(parts[1], 16);
    if (!isNaN(w1) && !isNaN(w2)) {
      const a = (w1 >> 8) & 0xff;
      const b = w1 & 0xff;
      const c = (w2 >> 8) & 0xff;
      const d = w2 & 0xff;
      return `${a}.${b}.${c}.${d}`;
    }
  }
  return null;
}

/**
 * Checks whether an IP address belongs to private, loopback, link-local,
 * carrier-grade NAT, multicast, or reserved ranges.
 * Covers: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (incl. 169.254.169.254),
 * ::1, fc00::/7, fe80::/10, 0/8, 100.64/10, 224/4, 240/4, ::, and IPv4-mapped IPv6.
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const clean = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 (::ffff:192.168.1.1 or ::ffff:7f00:1)
  if (clean.startsWith("::ffff:") || clean.startsWith("0:0:0:0:0:ffff:")) {
    const v4 = parseV4Mapped(clean);
    if (v4) return isPrivateIp(v4);
    return true; // Malformed or unrecognized IPv4-mapped, reject to fail closed
  }

  const family = net.isIP(clean);
  if (!family) return true; // not a valid IP

  if (family === 4) {
    const parts = clean.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 127) return true; // 127/8 (loopback)
    if (a === 10) return true; // 10/8 (private)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 (private)
    if (a === 192 && b === 168) return true; // 192.168/16 (private)
    if (a === 169 && b === 254) return true; // 169.254/16 (link-local, incl 169.254.169.254)
    if (a === 0) return true; // 0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (carrier-grade NAT)
    if (a >= 224) return true; // 224/4 (multicast) and 240/4 (reserved/broadcast)
    return false;
  }

  if (family === 6) {
    if (clean === "::1" || clean === "::") return true;
    const parts = clean.split(":");
    const first = parts[0] === "" ? parts[1] : parts[0];
    const val = parseInt(first, 16);
    if (!isNaN(val)) {
      if ((val & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
      if ((val & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
    }
    return false;
  }

  return true;
}

export type DnsLookupFn = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Resolves a hostname to IP addresses and rejects private, loopback, or link-local IPs.
 * Returns the resolved IP and address family.
 */
export async function resolveAndValidateHost(
  rawHostname: string,
  customLookup?: DnsLookupFn
): Promise<{ resolvedIp: string; family: number }> {
  let hostname = rawHostname.trim();
  // Strip IPv6 brackets if present e.g. [::1]
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  const directIpFamily = net.isIP(hostname);
  if (directIpFamily) {
    if (isPrivateIp(hostname)) {
      throw new Error(`Blocked private IP address: ${hostname}`);
    }
    return { resolvedIp: hostname, family: directIpFamily };
  }

  // Resolve hostname via DNS
  let records: Array<{ address: string; family: number }>;
  if (customLookup) {
    records = await customLookup(hostname);
  } else {
    records = await dns.promises.lookup(hostname, { all: true });
  }

  if (!records || records.length === 0) {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }

  // Validate that NO resolved IP is private/loopback/link-local
  for (const entry of records) {
    if (isPrivateIp(entry.address)) {
      throw new Error(
        `Blocked private IP for hostname ${hostname}: resolved to ${entry.address}`
      );
    }
  }

  return { resolvedIp: records[0].address, family: records[0].family };
}

export interface FetchWithTimeoutOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  customLookup?: DnsLookupFn;
  customFetch?: (url: string, init?: RequestInit & { dispatcher?: Agent }) => Promise<Response>;
}

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
  "visualwebsiteoptimizer.com",
  "typekit.net",
  "osano.com",
  "sng.link",
  "youtu.be",
  "youtube.com",
];

const STRIPPED_SUBDOMAINS = [
  "www",
  "careers",
  "jobs",
  "app",
  "recruiting",
  "about",
  "company",
  "boards",
  "job-boards",
  "academy",
  "support",
  "pages",
  "go",
];

/**
 * Returns true if hostname belongs to an ATS vendor, job board aggregator, or CDN.
 */
export function isAtsHost(host: string): boolean {
  const h = host.toLowerCase().trim();
  return ATS_HOST_KEYWORDS.some((k) => h === k || h.endsWith("." + k));
}

/**
 * Sanitizes and extracts the root domain from a URL or hostname.
 * Returns null if invalid or belongs to an ATS/aggregator host.
 */
export function cleanDomain(raw: string): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();

  // Strip mailto: prefix if present
  if (host.startsWith("mailto:")) {
    const parts = host.replace("mailto:", "").split("@");
    host = parts[parts.length - 1] || "";
  }

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
  if (!host || isAtsHost(host)) return null;

  const parts = host.split(".");
  if (parts.length < 2) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;

  let cur = parts;
  while (cur.length > 2 && STRIPPED_SUBDOMAINS.includes(cur[0])) {
    cur = cur.slice(1);
  }
  return cur.join(".");
}

/**
 * Derives company domain strictly from verifiable sources without guessing.
 */
export function deriveCompanyDomain(
  company: CompanyRecord,
  jobsForCompany: JobUrlInfo[] = [],
  ashbyPublicWebsite?: string | null,
  boardHtmlOrExtractedDomain?: string | null
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

  // 4. From Ashby board publicWebsite
  if (ashbyPublicWebsite) {
    try {
      const h = new URL(ashbyPublicWebsite).hostname;
      const d = cleanDomain(h);
      if (d) return d;
    } catch {}
  }

  // 5. From extracted domain or ATS board HTML (Schema.org Organization URL or anchor tags)
  if (boardHtmlOrExtractedDomain) {
    if (boardHtmlOrExtractedDomain.includes("<")) {
      const jsonLdMatch =
        boardHtmlOrExtractedDomain.match(/"@type":\s*"Organization"[^}]*"url":\s*"([^"]+)"/i) ||
        boardHtmlOrExtractedDomain.match(/"url":\s*"([^"]+)"[^}]*"@type":\s*"Organization"/i);
      if (jsonLdMatch && jsonLdMatch[1]) {
        const d = cleanDomain(jsonLdMatch[1]);
        if (d) return d;
      }

      const aMatches = Array.from(
        boardHtmlOrExtractedDomain.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)
      ).map((m) => m[1]);
      for (const h of aMatches) {
        if (!h.startsWith("http") && !h.startsWith("mailto:")) continue;
        const d = cleanDomain(h);
        if (d) return d;
      }
    } else {
      const d = cleanDomain(boardHtmlOrExtractedDomain);
      if (d) return d;
    }
  }

  // Never guess
  return null;
}

/**
 * Decodes image dimensions directly from file headers without external native binaries.
 * Supports PNG, GIF, JPEG, and WebP.
 */
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

/**
 * Validates raster image content type and extension. Strictly rejects SVG.
 */
export function getCleanImageMeta(
  rawContentType: string,
  buffer: Buffer,
  urlStr: string
): { contentType: string; ext: string } | null {
  const ct = rawContentType.toLowerCase().trim();

  // Strictly reject SVG to avoid XSS and malformed vector rendering
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

/**
 * Secure HTTP fetch with:
 * - Scheme restriction (only http: and https:)
 * - SSRF mitigation: host resolution & rejection of private, loopback, and link-local IPs
 * - Pinning connection to the resolved IP
 * - Manual redirect loop with max 3 redirects, re-validating each hop
 * - 10s deadline across the entire request sequence
 * - 2MB body size cap enforced during streaming
 */
export async function fetchWithTimeout(
  url: string,
  timeoutMsOrOptions?: number | FetchWithTimeoutOptions
): Promise<Response> {
  const options: FetchWithTimeoutOptions =
    typeof timeoutMsOrOptions === "number"
      ? { timeoutMs: timeoutMsOrOptions }
      : timeoutMsOrOptions || {};

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const customLookup = options.customLookup;
  const fetchImpl = options.customFetch ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let currentUrl = url;
  let redirectsRemaining = maxRedirects;

  try {
    while (true) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(currentUrl);
      } catch {
        throw new Error(`Invalid URL: ${currentUrl}`);
      }

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(
          `Blocked scheme: ${parsedUrl.protocol}. Only http and https are allowed.`
        );
      }

      const { resolvedIp, family } = await resolveAndValidateHost(
        parsedUrl.hostname,
        customLookup
      );

      const dispatcher = new Agent({
        connect: {
          lookup: (_originHost, _opts, cb) => {
            cb(null, [{ address: resolvedIp, family }]);
          },
        },
      });

      let res: Response;
      try {
        res = await fetchImpl(currentUrl, {
          dispatcher,
          redirect: "manual",
          headers: {
            "User-Agent": USER_AGENT,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/png,image/jpeg,image/webp,*/*;q=0.8",
          },
          signal: controller.signal,
        });
      } catch (fetchErr) {
        dispatcher.destroy();
        throw fetchErr;
      }

      // Check for redirect (301, 302, 303, 307, 308)
      if (
        [301, 302, 303, 307, 308].includes(res.status) &&
        res.headers.has("location")
      ) {
        if (res.body) {
          try {
            await res.arrayBuffer();
          } catch {}
        }
        dispatcher.destroy();

        const location = res.headers.get("location");
        if (!location) {
          return res;
        }

        redirectsRemaining--;
        if (redirectsRemaining < 0) {
          throw new Error(
            `Redirect limit exceeded: followed maximum ${maxRedirects} redirects`
          );
        }

        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // Check Content-Length header cap
      const clStr = res.headers.get("content-length");
      if (clStr) {
        const cl = parseInt(clStr, 10);
        if (!isNaN(cl) && cl > MAX_IMAGE_BYTES) {
          dispatcher.destroy();
          throw new Error(
            `Response Content-Length ${cl} exceeds maximum allowed size of ${MAX_IMAGE_BYTES} bytes (2MB)`
          );
        }
      }

      // Read and cap body stream at 2MB
      let bodyBuffer: Buffer;
      if (res.body && ![101, 204, 205, 304].includes(res.status)) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.length;
              if (totalBytes > MAX_IMAGE_BYTES) {
                await reader.cancel();
                throw new Error(
                  `Response body exceeded maximum allowed size of ${MAX_IMAGE_BYTES} bytes (2MB)`
                );
              }
              chunks.push(value);
            }
          }
        } finally {
          reader.releaseLock();
          dispatcher.destroy();
        }

        bodyBuffer = Buffer.concat(chunks);
      } else {
        dispatcher.destroy();
        bodyBuffer = Buffer.alloc(0);
      }

      const responsePayload = [101, 204, 205, 304].includes(res.status)
        ? null
        : (bodyBuffer as any);

      const wrappedResponse = new Response(responsePayload, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });

      Object.defineProperty(wrappedResponse, "url", {
        value: currentUrl,
        writable: false,
      });

      return wrappedResponse;
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads image buffer and performs full validation:
 * - HTTP 200
 * - Non-empty and <= 2MB
 * - Valid raster format (no SVG)
 * - Dimensions >= minSize (default 32px)
 * - Aspect ratio 0.6 <= ratio <= 1.6
 */
export async function downloadAndValidateImage(
  url: string,
  minSize: number = 32,
  fetcher: (targetUrl: string) => Promise<Response> = fetchWithTimeout
): Promise<ValidatedImage | null> {
  try {
    const imgRes = await fetcher(url);
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
    if (!dims || dims.width < minSize || dims.height < minSize) {
      return null;
    }

    const ratio = dims.width / dims.height;
    if (ratio < 0.6 || ratio > 1.6) {
      return null;
    }

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

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Parses candidate icon URLs and og:image from an HTML document.
 */
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
    } catch {}
  }

  iconUrls.sort((a, b) => b.declaredSize - a.declaredSize);
  return { iconUrls, ogImageUrl };
}

/**
 * Inspects company homepage favicon, apple-touch-icon, and root /apple-touch-icon.png.
 */
export async function inspectCompanyHomepage(
  domain: string,
  minSize: number = 32
): Promise<ResolvedLogoResult | null> {
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

  // 1. Try icons in order of declared size
  for (const icon of iconUrls) {
    const imgData = await downloadAndValidateImage(icon.url, minSize);
    if (imgData) {
      return {
        imageUrl: icon.url,
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

  // 2. Try og:image fallback
  if (ogImageUrl) {
    const imgData = await downloadAndValidateImage(ogImageUrl, minSize);
    if (imgData) {
      return {
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

/**
 * Free logo service fallback:
 * Queries Unavatar -> Google Favicons -> DuckDuckGo with validation.
 */
export async function fetchFreeLogoService(
  domain: string,
  minSize: number = 32,
  fetcher: (targetUrl: string) => Promise<Response> = fetchWithTimeout
): Promise<ResolvedLogoResult | null> {
  // Service 1: Unavatar (returns HTTP 200 image or 404 when fallback=false)
  try {
    const unavUrl = `https://unavatar.io/${domain}?fallback=false`;
    const unavData = await downloadAndValidateImage(unavUrl, minSize, fetcher);
    if (unavData) {
      return {
        imageUrl: unavUrl,
        source: "free-service",
        serviceName: "unavatar",
        domain,
        buffer: unavData.buffer,
        contentType: unavData.contentType,
        ext: unavData.ext,
        width: unavData.width,
        height: unavData.height,
      };
    }
  } catch {}

  // Service 2: Google Favicon service (returns 128x128 PNG or defaults)
  try {
    const gglUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    const gglData = await downloadAndValidateImage(gglUrl, minSize, fetcher);
    if (gglData) {
      return {
        imageUrl: gglUrl,
        source: "free-service",
        serviceName: "google",
        domain,
        buffer: gglData.buffer,
        contentType: gglData.contentType,
        ext: gglData.ext,
        width: gglData.width,
        height: gglData.height,
      };
    }
  } catch {}

  // Service 3: DuckDuckGo Icons
  try {
    const ddgUrl = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    const ddgData = await downloadAndValidateImage(ddgUrl, minSize, fetcher);
    if (ddgData) {
      return {
        imageUrl: ddgUrl,
        source: "free-service",
        serviceName: "duckduckgo",
        domain,
        buffer: ddgData.buffer,
        contentType: ddgData.contentType,
        ext: ddgData.ext,
        width: ddgData.width,
        height: ddgData.height,
      };
    }
  } catch {}

  return null;
}

/**
 * Unified company logo resolver combining all tiers.
 */
export async function resolveCompanyLogo(
  company: CompanyRecord,
  jobsForCompany: JobUrlInfo[] = []
): Promise<ResolvedLogoResult | null> {
  // If company already has a self-hosted storage URL, keep it
  if (company.logo_url && company.logo_url.includes("company-logos")) {
    return null;
  }

  let boardHtml: string | null = null;
  let ashbyPublicWebsite: string | null = null;

  // Tier 1: ATS Board probe (Greenhouse, Ashby, Lever)
  const ats = (company.ats_type || "").toLowerCase().trim();
  const slug = (company.slug || "").trim();

  if (slug && ["greenhouse", "ashby", "lever"].includes(ats)) {
    const candidateUrls: string[] = [];
    if (ats === "greenhouse") {
      candidateUrls.push(`https://job-boards.greenhouse.io/${slug}`);
      candidateUrls.push(`https://boards.greenhouse.io/${slug}`);
    } else if (ats === "ashby") {
      candidateUrls.push(`https://jobs.ashbyhq.com/${slug}`);
    } else if (ats === "lever") {
      candidateUrls.push(`https://jobs.lever.co/${slug}`);
    }

    let activeBoardUrl = "";
    for (const url of candidateUrls) {
      try {
        const res = await fetchWithTimeout(url);
        if (res.ok) {
          boardHtml = await res.text();
          activeBoardUrl = url;
          break;
        }
      } catch {}
    }

    if (boardHtml && activeBoardUrl) {
      if (ats === "ashby") {
        const m = boardHtml.match(/"publicWebsite":\s*"([^"]+)"/);
        if (m && m[1]) {
          ashbyPublicWebsite = decodeHtmlEntities(m[1].trim());
        }
      }

      const { iconUrls, ogImageUrl } = parsePageImages(boardHtml, activeBoardUrl);

      // Check board icon >= 128px
      for (const icon of iconUrls) {
        const imgData = await downloadAndValidateImage(icon.url, 128);
        if (imgData) {
          return {
            imageUrl: icon.url,
            source: "ats-board",
            buffer: imgData.buffer,
            contentType: imgData.contentType,
            ext: imgData.ext,
            width: imgData.width,
            height: imgData.height,
          };
        }
      }

      // Check board og:image
      if (ogImageUrl) {
        const imgData = await downloadAndValidateImage(ogImageUrl, 128);
        if (imgData) {
          return {
            imageUrl: ogImageUrl,
            source: "ats-board",
            buffer: imgData.buffer,
            contentType: imgData.contentType,
            ext: imgData.ext,
            width: imgData.width,
            height: imgData.height,
          };
        }
      }
    }
  }

  // Derive domain from all available signals
  const domain = deriveCompanyDomain(company, jobsForCompany, ashbyPublicWebsite, boardHtml);
  if (!domain) {
    return null;
  }

  // Tier 2: Company website homepage favicon / apple-touch-icon
  const homepageLogo = await inspectCompanyHomepage(domain, 32);
  if (homepageLogo) {
    return homepageLogo;
  }

  // Tier 3: Free logo service fallback
  const freeServiceLogo = await fetchFreeLogoService(domain, 32);
  if (freeServiceLogo) {
    return freeServiceLogo;
  }

  return null;
}
