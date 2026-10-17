/**
 * Single source of truth for the site base URL across all environments.
 * Priority: NEXT_PUBLIC_SITE_URL -> fallback to "https://careermonke.com"
 * Trailing slashes are strictly stripped.
 */
export function getSiteUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, "");
  }
  return "https://careermonke.com";
}
