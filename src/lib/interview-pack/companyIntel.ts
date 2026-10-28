/**
 * Company Intel Service & 30-Day Caching
 *
 * Strict verification rules:
 * 1. Only claims that have a valid https:// source URL are accepted. Reject http://.
 * 2. Reject localhost, private IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1), and internal hosts (.local, .internal, .lan, .corp).
 * 3. Never invent funding, news, salaries, interviewer names or culture.
 * 4. Cache per company for 30 days in public.company_intel_cache keyed by normalized company name.
 * 5. Do NOT cache empty results.
 * 6. No fetcher configured yet -> return empty claims + isThin: true.
 */

export interface CompanyClaim {
  text: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface CompanyIntel {
  normalizedCompany: string;
  companyName: string;
  claims: CompanyClaim[];
  fetchedAt: string;
  expiresAt: string;
  isThin: boolean;
}

export interface CompanyIntelDeps {
  fetchClaims?: (companyName: string) => Promise<any[]>;
  now?: () => number;
}

/**
 * Checks if a hostname belongs to a private network, internal domain, or loopback.
 */
export function isPrivateOrInternalHost(hostname: string): boolean {
  if (!hostname || typeof hostname !== "string") return true;
  const host = hostname.toLowerCase().trim();

  // Strip brackets from IPv6 if present
  const unbracketed = host.replace(/^\[|\]$/g, "");

  // Localhost / Loopback / Any
  if (
    unbracketed === "localhost" ||
    unbracketed === "127.0.0.1" ||
    unbracketed === "0.0.0.0" ||
    unbracketed === "::1" ||
    unbracketed === "::"
  ) {
    return true;
  }

  // Internal domain extensions
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".corp") ||
    host.endsWith(".home") ||
    host.endsWith(".arpa")
  ) {
    return true;
  }

  // Reject single-word hostnames (e.g. "intranet", "corp")
  if (!host.includes(".")) {
    return true;
  }

  // Check IPv4 private and link-local ranges
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const o1 = parseInt(ipv4Match[1], 10);
    const o2 = parseInt(ipv4Match[2], 10);

    if (o1 === 0) return true; // 0.0.0.0/8
    if (o1 === 10) return true; // 10.0.0.0/8
    if (o1 === 127) return true; // 127.0.0.0/8
    if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
    if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
  }

  return false;
}

/**
 * Normalizes company name for deterministic cache keys.
 * e.g. "Stripe, Inc." -> "stripeinc"
 */
export function normalizeCompanyName(name: string): string {
  if (!name || typeof name !== "string") return "unknowncompany";
  const cleaned = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, "");
  return cleaned || "unknowncompany";
}

/**
 * Sanitizes company claims:
 * - Requires https:// protocol only.
 * - Rejects localhost, private IPs, and internal hosts.
 * - Drops any claim missing text or valid URL.
 */
export function sanitizeCompanyClaims(rawClaims: any[]): CompanyClaim[] {
  if (!Array.isArray(rawClaims)) return [];

  const valid: CompanyClaim[] = [];

  for (const item of rawClaims) {
    if (!item || typeof item !== "object") continue;

    const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";

    // Hard requirement 1: https:// only
    if (!sourceUrl.startsWith("https://")) {
      continue;
    }

    // Hard requirement 2: Valid URL and reject private/internal hostnames
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== "https:") continue;
      if (isPrivateOrInternalHost(parsed.hostname)) {
        continue;
      }
    } catch {
      continue;
    }

    if (!text) continue;

    valid.push({
      text,
      sourceUrl,
      fetchedAt:
        typeof item.fetchedAt === "string" && item.fetchedAt
          ? item.fetchedAt
          : new Date().toISOString(),
    });
  }

  return valid;
}

/**
 * Retrieves company intel utilizing 30-day cache in Supabase table `company_intel_cache`.
 * A cache hit within 30 days returns cached intel immediately without calling upstream fetchers.
 * Expired or missing entries trigger fetchClaims (if provided).
 * Empty claim sets are NEVER cached.
 */
export async function getCompanyIntel(
  companyName: string,
  supabaseAdmin: any,
  deps: CompanyIntelDeps = {}
): Promise<CompanyIntel> {
  const normalized = normalizeCompanyName(companyName);
  const nowMs = deps.now ? deps.now() : Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // 1. Check 30-Day Cache in Supabase
  if (supabaseAdmin?.from) {
    try {
      const { data: cached, error } = await supabaseAdmin
        .from("company_intel_cache")
        .select("*")
        .eq("normalized_company", normalized)
        .maybeSingle();

      if (!error && cached && cached.expires_at) {
        const expiresAtMs = new Date(cached.expires_at).getTime();
        // Cache hit within 30 days: Return cached intel WITHOUT calling fetcher
        if (expiresAtMs > nowMs) {
          const rawClaims = cached.intel_json?.claims || [];
          const sanitized = sanitizeCompanyClaims(rawClaims);
          return {
            normalizedCompany: cached.normalized_company,
            companyName: cached.company_name || companyName,
            claims: sanitized,
            fetchedAt: cached.fetched_at || new Date(nowMs).toISOString(),
            expiresAt: cached.expires_at,
            isThin: sanitized.length < 2,
          };
        }
      }
    } catch (cacheErr) {
      console.warn("[CompanyIntel] Cache lookup error:", cacheErr);
    }
  }

  // 2. Fetch fresh claims (Cache Miss or Expired)
  let rawFetchedClaims: any[] = [];
  if (deps.fetchClaims) {
    try {
      rawFetchedClaims = await deps.fetchClaims(companyName);
    } catch (fetchErr) {
      console.warn("[CompanyIntel] Error in fetchClaims:", fetchErr);
    }
  }

  // Strictly filter: https only, reject private IPs, drop unsourced
  const sanitizedClaims = sanitizeCompanyClaims(rawFetchedClaims);
  const fetchedAtIso = new Date(nowMs).toISOString();
  const expiresAtIso = new Date(nowMs + THIRTY_DAYS_MS).toISOString();

  const intel: CompanyIntel = {
    normalizedCompany: normalized,
    companyName,
    claims: sanitizedClaims,
    fetchedAt: fetchedAtIso,
    expiresAt: expiresAtIso,
    isThin: sanitizedClaims.length < 2,
  };

  // 3. Persist to 30-day cache in Supabase ONLY IF claims are not empty
  // "Do not cache empty results."
  if (sanitizedClaims.length > 0 && supabaseAdmin?.from) {
    try {
      const table = supabaseAdmin.from("company_intel_cache");
      if (typeof table?.upsert === "function") {
        await table.upsert(
          {
            normalized_company: normalized,
            company_name: companyName,
            intel_json: { claims: sanitizedClaims },
            claims_count: sanitizedClaims.length,
            fetched_at: fetchedAtIso,
            expires_at: expiresAtIso,
            updated_at: fetchedAtIso,
          },
          { onConflict: "normalized_company" }
        );
      }
    } catch (upsertErr) {
      console.warn("[CompanyIntel] Cache upsert error:", upsertErr);
    }
  }

  return intel;
}
