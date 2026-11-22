/**
 * src/lib/companies/logoEligibility.ts
 *
 * The single company-logo contract shared by every reader and writer (browser-safe, no Node imports).
 *
 * A logo is ELIGIBLE only when it is an object we host in this project's public `company-logos`
 * bucket, addressed by company id: legacy `<company_id>.<ext>` keys or versioned content-hashed
 * `<company_id>/<sha256>.<ext>` keys, raster extensions only. Everything else (ATS/vendor CDNs,
 * Google/DuckDuckGo favicon services, unavatar, company homepages, other buckets or projects) is
 * ineligible: writers must never persist it and readers must never render it.
 */

export const COMPANY_LOGO_BUCKET = "company-logos";
const PUBLIC_PATH = `/storage/v1/object/public/${COMPANY_LOGO_BUCKET}/`;
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.(?:png|jpe?g|webp|gif)|\/[0-9a-f]{64}\.(?:png|jpe?g|webp|gif))$/i;

export type LogoUrlClass = "hosted" | "null" | "external" | "invalid";

function supabaseOrigin(supabaseUrl?: string | null): string | null {
  const raw = (supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Returns the normalised hosted URL when `url` is an eligible company logo, otherwise null. */
export function eligibleLogoUrl(url: unknown, supabaseUrl?: string | null): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const origin = supabaseOrigin(supabaseUrl);
  if (!origin) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) return null;
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (!parsed.pathname.startsWith(PUBLIC_PATH)) return null;
  const key = decodeURIComponent(parsed.pathname.slice(PUBLIC_PATH.length));
  if (!KEY_RE.test(key)) return null;
  return `${origin}${PUBLIC_PATH}${key}`;
}

export function classifyLogoUrl(url: unknown, supabaseUrl?: string | null): LogoUrlClass {
  if (url == null || (typeof url === "string" && !url.trim())) return "null";
  if (eligibleLogoUrl(url, supabaseUrl)) return "hosted";
  if (typeof url !== "string") return "invalid";
  try {
    new URL(url.trim());
    return "external";
  } catch {
    return "invalid";
  }
}

/** Deterministic, content-hashed, versioned object key: identical bytes always map to the same key. */
export function logoObjectKey(companyId: string, sha256Hex: string, ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "").replace("jpeg", "jpg");
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw new Error(`invalid company id for logo key: ${companyId}`);
  if (!/^[0-9a-f]{64}$/i.test(sha256Hex)) throw new Error("logo key needs a sha256 hex digest");
  if (!/^(png|jpg|webp|gif)$/.test(e)) throw new Error(`logo key extension not allowed: ${ext}`);
  return `${companyId.toLowerCase()}/${sha256Hex.toLowerCase()}.${e}`;
}

export function hostedLogoPublicUrl(key: string, supabaseUrl?: string | null): string {
  const origin = supabaseOrigin(supabaseUrl);
  if (!origin) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured");
  return `${origin}${PUBLIC_PATH}${key}`;
}

/** First non-empty eligible logo among the candidates (job row, nested company record, ...). */
export function firstEligibleLogo(candidates: unknown[], supabaseUrl?: string | null): string | null {
  for (const c of candidates) {
    const ok = eligibleLogoUrl(c, supabaseUrl);
    if (ok) return ok;
  }
  return null;
}
