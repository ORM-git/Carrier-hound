/**
 * Company Intel Service & 30-Day Caching
 *
 * Strict verification rules:
 * 1. Only claims that have a source URL are accepted. Any claim without a valid sourceUrl is dropped.
 * 2. Never invent funding, news, salaries, interviewer names or culture.
 * 3. Cache per company for 30 days in public.company_intel_cache keyed by normalized company name.
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
 * Sanitizes company claims: strictly drops any claim missing a valid HTTP(S) source URL.
 */
export function sanitizeCompanyClaims(rawClaims: any[]): CompanyClaim[] {
  if (!Array.isArray(rawClaims)) return [];

  const valid: CompanyClaim[] = [];

  for (const item of rawClaims) {
    if (!item || typeof item !== "object") continue;

    const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";

    // Hard requirement: Drop claims without non-empty HTTP(S) sourceUrl
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
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
 * Retrieves company intel, utilizing 30-day cache in Supabase table `company_intel_cache`.
 * A cache hit within 30 days returns cached intel immediately without calling upstream fetchers.
 * Expired or missing entries trigger fetchClaims and update the cache.
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
      // Graceful fallback to fetch if cache lookup fails
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

  // Strictly filter: Claim without sourceUrl is dropped
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

  // 3. Persist to 30-day cache in Supabase
  if (supabaseAdmin?.from) {
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
