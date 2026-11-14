/**
 * Caps jobs per company (maxPerCompany in any visible topWindow).
 * Prevents mass postings from one employer from flooding the recommended list.
 *
 * Cap key priority: companyGroupId (opaque keyed hash sent to guests/free users instead of the real
 * company_id), then company_id/companyId (Pro responses and server-side rows), then the company name
 * when it is revealed. This identifies unrevealed companies ("Verified Employer") without leaking names or ids.
 *
 * Never drops jobs: always returns topItems plus deferredItems.
 */
export function capJobsPerCompany<
  T extends {
    company?: string | null;
    company_id?: string | null;
    companyId?: string | null;
    companyGroupId?: string | null;
  }
>(
  jobs: T[],
  maxPerCompany: number = 3,
  topWindow: number = 30
): T[] {
  if (!Array.isArray(jobs) || jobs.length === 0) return jobs;

  const topItems: T[] = [];
  const deferredItems: T[] = [];
  const companyCounts = new Map<string, number>();

  for (const job of jobs) {
    const rawCompanyId = (job.companyGroupId || job.company_id || job.companyId || "").trim();
    const rawCompanyName = (job.company || "").trim();

    // Priority 1: companyGroupId, then company_id, as the cap key
    let compKey = rawCompanyId.toLowerCase();
    // Priority 2: company name fallback only when real name is revealed
    if (
      !compKey &&
      rawCompanyName &&
      rawCompanyName.toLowerCase() !== "verified employer" &&
      rawCompanyName.toLowerCase() !== "confidential employer"
    ) {
      compKey = rawCompanyName.toLowerCase();
    }

    // If neither company_id nor a real company name is available, place directly
    if (!compKey) {
      if (topItems.length < topWindow) {
        topItems.push(job);
      } else {
        deferredItems.push(job);
      }
      continue;
    }

    const currentCount = companyCounts.get(compKey) || 0;
    if (currentCount < maxPerCompany && topItems.length < topWindow) {
      companyCounts.set(compKey, currentCount + 1);
      topItems.push(job);
    } else {
      deferredItems.push(job);
    }
  }

  // Never drop jobs: always return topItems plus deferredItems
  return [...topItems, ...deferredItems];
}

/** Server-only env var holding the HMAC key for companyGroupId. Never use a NEXT_PUBLIC_ name. */
export const COMPANY_GROUP_SECRET_ENV = "COMPANY_GROUP_ID_SECRET";

export class CompanyGroupSecretMissingError extends Error {
  constructor() {
    super(`${COMPANY_GROUP_SECRET_ENV} is not configured`);
    this.name = "CompanyGroupSecretMissingError";
  }
}

/**
 * companyGroupId = first 12 hex chars of HMAC-SHA256(company_id, secret).
 * Same company -> same id, different companies -> different ids, and the real id cannot be recovered
 * without the server-only secret. Uses Web Crypto so it works on Cloudflare edge and Node.
 */
export async function computeCompanyGroupId(companyId: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(companyId)));
  let hex = "";
  for (let i = 0; i < 6; i++) hex += sig[i].toString(16).padStart(2, "0");
  return hex;
}

/**
 * Builds company_id -> companyGroupId for every distinct id. Fails closed: throws
 * CompanyGroupSecretMissingError when there is at least one company id to convert and the secret is
 * absent, so a guest response never falls back to the raw id. With no company ids (empty list, or only
 * null ids) nothing can leak and the secret is not required.
 */
export async function buildCompanyGroupIdMap(
  companyIds: Array<string | null | undefined>,
  secret: string | null | undefined
): Promise<Map<string, string>> {
  const ids = companyIds.filter((id): id is string => Boolean(id));
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  if (!secret || !secret.trim()) throw new CompanyGroupSecretMissingError();
  for (const id of ids) {
    if (!map.has(id)) map.set(id, await computeCompanyGroupId(id, secret));
  }
  return map;
}
