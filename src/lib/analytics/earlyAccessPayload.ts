import { readCookieConsent } from "@/lib/analytics/cookieConsent";
import { getAttribution } from "@/lib/analytics/utm";

/**
 * Builds the POST body for /api/early-access. First-touch campaign
 * attribution is attached ONLY when cookie consent is granted (parsed to
 * exactly true by the shared versioned reader) and a captured attribution
 * record exists for this session; otherwise the field is omitted entirely.
 * The route sanitizes it via sanitizeAttribution.
 */
export function buildEarlyAccessPayload(
  email: string,
  website: string
): Record<string, unknown> {
  const body: Record<string, unknown> = { email, website };
  if (readCookieConsent()) {
    const attribution = getAttribution();
    if (attribution) {
      body.attribution = attribution;
    }
  }
  return body;
}
