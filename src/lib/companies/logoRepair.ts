/**
 * src/lib/companies/logoRepair.ts
 *
 * Repairs ONE claimed company against the shared logo contract (see logoEligibility.ts):
 *   resolve (verified ATS image -> verified homepage icon -> free resolver on the verified domain,
 *   all via logoResolver.ts with its SSRF/redirect/raster/size/dimension checks)
 *   -> reject vendor/default branding (known default fingerprints, image shared by other companies)
 *   -> upload validated bytes to company-logos/<company_id>/<sha256>.<ext> (content-hashed,
 *      versioned, idempotent: identical bytes reuse the existing object)
 *   -> commit hosted URL + verified domain with a conditional update (claim token + expected old
 *      logo_url). Objects are never deleted here: an uncertain commit (lost response, reclaimed lease,
 *      same-content key) could otherwise remove a live logo; an unreferenced content-hashed object is
 *      harmless and is reused by the next attempt for the same bytes.
 * A "pending" row is always repaired for real, even when its URL is well-formed (the sweep marks
 * verified-broken hosted logos pending), so URL shape never stands in for asset health.
 * If every source fails the company keeps logo_url null (an ineligible external URL is cleared),
 * gets a reason and a bounded backoff, and the UI shows initials. Never throws for branding issues.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
import { eligibleLogoUrl, hostedLogoPublicUrl, logoObjectKey } from "./logoEligibility";
import { fetchWithTimeout, getCleanImageMeta, type CompanyRecord, type FetchWithTimeoutOptions, type JobUrlInfo, type ResolveLogoOptions, type ResolvedLogoResult } from "./logoResolver";

/**
 * Vendor/default marks observed in production that must never become a company logo. The worker also
 * probes favicon services for their "unknown domain" image and rejects any image that resolves for two
 * or more companies in one run, so new vendor defaults are caught without being listed here.
 */
export const KNOWN_VENDOR_DEFAULT_SHA256: readonly string[] = [
  "d3b538025d8270a6514e8243278afe7f8ad1e1e19faa3d094ff2b76c2ccd2f54", // Ashby job-board default mark (19 Ashby boards, 2026-11-22)
];

export const sha256Hex = (buf: Buffer) => crypto.hash("sha256", buf, "hex");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * True only when the bytes decode as a PNG image (header sniffing is not enough: a bare header
 * would otherwise be hosted as a "logo"). PNG: every chunk parsed and the IDAT stream inflated to the exact
 * size its IHDR implies.
 * shortcut: JPEG/WebP/GIF/interlaced PNG are not decoded (no declared decoder), so they are rejected and the
 * chain falls through to the next source (favicon services serve PNG); add a decoder if that becomes a gap.
 */
export function decodesAsRaster(buf: Buffer): boolean {
  try {
    if (buf.subarray(0, 8).equals(PNG_SIG)) {
      let off = 8, w = 0, h = 0, depth = 0, color = -1, interlace = 1;
      const idat: Buffer[] = [];
      while (off + 12 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString("ascii", off + 4, off + 8);
        if (off + 12 + len > buf.length) return false;
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
        if (type === "IDAT") idat.push(data);
        off += 12 + len;
        if (type === "IEND") break;
      }
      const ch = PNG_CHANNELS[color];
      if (!w || !h || !ch || interlace !== 0 || !idat.length) return false;
      const raw = zlib.inflateSync(Buffer.concat(idat));
      return raw.length === h * (1 + Math.ceil((w * ch * depth) / 8));
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Health check for a stored hosted logo: "ok" or a reason. Only this project's eligible URLs are fetched,
 * through the SSRF-safe fetcher (scheme + DNS/private-IP checks, timeout, size cap) with no redirects
 * followed; the bytes must be a raster image, and PNGs must fully decode.
 */
export async function verifyHostedLogo(url: string, supabaseUrl: string, opts: FetchWithTimeoutOptions = {}): Promise<string> {
  if (!eligibleLogoUrl(url, supabaseUrl)) return "ineligible-url";
  try {
    const r = await fetchWithTimeout(url, { ...opts, maxRedirects: 0 });
    if (!r.ok) return `http-${r.status}`;
    const buf = Buffer.from(await r.arrayBuffer());
    const meta = buf.length ? getCleanImageMeta(r.headers.get("content-type") || "", buf, url) : null;
    if (!meta) return "not-a-raster-image";
    if (meta.ext === "png" && !decodesAsRaster(buf)) return "does-not-decode";
    return "ok";
  } catch (e) {
    return `fetch-error: ${String((e as Error)?.message || e).slice(0, 120)}`;
  }
}

export interface ClaimedCompany {
  id: string;
  name: string;
  slug: string | null;
  domain: string | null;
  careers_url: string | null;
  ats_type: string | null;
  logo_url: string | null;
  /** "pending" = queued or a hosted logo the sweep verified broken: always repaired for real. */
  logo_status?: string | null;
  logo_attempts: number;
  claim_token: string;
}

export type RepairStatus = "repaired" | "already-eligible" | "missing" | "failed";
export interface RepairOutcome {
  id: string;
  name: string;
  status: RepairStatus;
  reason: string | null;
  source: string | null;
  logoUrl: string | null;
  previousLogoUrl: string | null;
  sha256: string | null;
  attempts: number;
  nextAttemptAt: string | null;
}

export interface LogoRepairDeps {
  supabaseUrl: string;
  resolve(company: CompanyRecord, jobs: JobUrlInfo[], options: ResolveLogoOptions): Promise<ResolvedLogoResult | null>;
  jobsFor(companyId: string): Promise<JobUrlInfo[]>;
  /** sha256 hex digests of vendor/default images (e.g. favicon-service "unknown domain" globes). */
  knownDefaultHashes: ReadonlySet<string>;
  /** Number of OTHER companies whose committed logo has this content hash. */
  companiesSharingHash(sha256: string, excludeId: string): Promise<number>;
  /** Uploads with no overwrite; "exists" when the content-hashed key is already present. */
  upload(key: string, bytes: Buffer, contentType: string): Promise<"created" | "exists">;
  /** Conditional commit: only if the row still holds our claim token and the logo we read. */
  commitHosted(args: { id: string; token: string; expectedLogoUrl: string | null; logoUrl: string; domain: string | null; sha256: string; source: string; at: Date }): Promise<boolean>;
  recordFailure(args: { id: string; token: string; expectedLogoUrl: string | null; clearLogoUrl: boolean; status: "missing" | "failed"; reason: string; attempts: number; nextAttemptAt: Date | null; at: Date }): Promise<boolean>;
  markAlreadyEligible(args: { id: string; token: string; at: Date }): Promise<void>;
  now(): Date;
}

/** shortcut: fixed backoff ladder (1h, 6h, 24h, 72h, 7d); then "missing" rechecked every 30 days. */
const BACKOFF_HOURS = [1, 6, 24, 72, 168];
export const MAX_LOGO_ATTEMPTS = BACKOFF_HOURS.length;
const MISSING_RECHECK_HOURS = 24 * 30;
/** Company marks/icons are small; larger images are banners or photos, not logos. */
export const MAX_LOGO_SIDE_PX = 1024;
/** A real company mark is never byte-identical across this many other companies. */
const SHARED_HASH_LIMIT = 1;

export function nextAttempt(attempts: number, now: Date, transient: boolean): { status: "missing" | "failed"; at: Date } {
  const h = attempts <= MAX_LOGO_ATTEMPTS ? BACKOFF_HOURS[Math.max(0, attempts - 1)] : MISSING_RECHECK_HOURS;
  return { status: transient && attempts < MAX_LOGO_ATTEMPTS ? "failed" : "missing", at: new Date(now.getTime() + h * 3600_000) };
}

export async function repairCompanyLogo(company: ClaimedCompany, deps: LogoRepairDeps): Promise<RepairOutcome> {
  const at = deps.now();
  const base = { id: company.id, name: company.name, previousLogoUrl: company.logo_url, sha256: null, source: null, logoUrl: null, attempts: company.logo_attempts, nextAttemptAt: null };

  if (company.logo_status !== "pending" && eligibleLogoUrl(company.logo_url, deps.supabaseUrl)) {
    await deps.markAlreadyEligible({ id: company.id, token: company.claim_token, at });
    return { ...base, status: "already-eligible", reason: null, logoUrl: company.logo_url };
  }

  const attempts = company.logo_attempts + 1;
  const fail = async (reason: string, transient: boolean): Promise<RepairOutcome> => {
    const nx = nextAttempt(attempts, at, transient);
    // Ineligible external URLs are never kept: the company falls back to initials until a hosted logo exists.
    await deps.recordFailure({ id: company.id, token: company.claim_token, expectedLogoUrl: company.logo_url, clearLogoUrl: company.logo_url != null, status: nx.status, reason, attempts, nextAttemptAt: nx.at, at });
    return { ...base, status: transient ? "failed" : "missing", reason, attempts, nextAttemptAt: nx.at.toISOString() };
  };

  let resolved: ResolvedLogoResult | null;
  try {
    const jobs = await deps.jobsFor(company.id);
    // logo_url is withheld so the resolver never short-circuits on a stored (possibly broken) value.
    resolved = await deps.resolve(
      { id: company.id, name: company.name, slug: company.slug, domain: company.domain, careers_url: company.careers_url, ats_type: company.ats_type, logo_url: null },
      jobs,
      // Default/vendor images are skipped inside the chain, so the next tier (homepage, free resolver) still runs.
      { isRejected: (buf) => deps.knownDefaultHashes.has(sha256Hex(buf)) || !decodesAsRaster(buf) }
    );
  } catch (e) {
    return fail(`resolver-error: ${String((e as Error)?.message || e).slice(0, 160)}`, true);
  }
  if (!resolved) return fail("no-source: no verified ATS image, homepage icon or resolver logo for a verified domain", false);

  if (resolved.width > MAX_LOGO_SIDE_PX || resolved.height > MAX_LOGO_SIDE_PX) {
    return fail(`not-a-logo: ${resolved.width}x${resolved.height} image from ${resolved.source} is a banner/photo, not an icon`, false);
  }
  if (!decodesAsRaster(resolved.buffer)) return fail(`corrupt-image: ${resolved.source} bytes do not decode as a PNG`, false);
  const sha256 = sha256Hex(resolved.buffer);
  if (deps.knownDefaultHashes.has(sha256)) return fail(`default-branding: ${resolved.serviceName || resolved.source} returned its default image`, false);
  if ((await deps.companiesSharingHash(sha256, company.id)) >= SHARED_HASH_LIMIT) return fail("shared-image: identical bytes already used by another company (vendor/default mark)", false);

  let key: string;
  try {
    key = logoObjectKey(company.id, sha256, resolved.ext);
  } catch (e) {
    return fail(`invalid-image: ${String((e as Error).message).slice(0, 120)}`, false);
  }

  try {
    await deps.upload(key, resolved.buffer, resolved.contentType);
  } catch (e) {
    return fail(`upload-failed: ${String((e as Error)?.message || e).slice(0, 160)}`, true);
  }

  const logoUrl = hostedLogoPublicUrl(key, deps.supabaseUrl);
  const source = resolved.serviceName ? `${resolved.source}:${resolved.serviceName}` : resolved.source;
  let committed = false;
  let commitError: string | null = null;
  try {
    committed = await deps.commitHosted({ id: company.id, token: company.claim_token, expectedLogoUrl: company.logo_url, logoUrl, domain: resolved.domain || company.domain || null, sha256, source, at });
  } catch (e) {
    commitError = String((e as Error)?.message || e).slice(0, 160);
  }
  if (!committed) {
    // Outcome may be uncertain (e.g. committed but the response was lost): keep the object, retry later.
    return { ...base, status: "failed", reason: commitError ? `db-update-failed: ${commitError}` : "db-update-skipped: row changed or claim expired", sha256, source, attempts };
  }
  return { ...base, status: "repaired", reason: null, source, logoUrl, sha256, attempts };
}
