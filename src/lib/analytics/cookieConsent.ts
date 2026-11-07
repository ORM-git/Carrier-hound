import { COOKIE_CONSENT_KEY, COOKIE_CONSENT_VERSION } from "@/components/CookieNotice";
import { readVersioned } from "@/lib/storage/versioned";

/**
 * Single consent gate for all telemetry. Consent exists only when the stored
 * record parses through the versioned reader to exactly `true`: a corrupt
 * payload, a `false` value, an envelope written by a newer build, or legacy
 * junk all read as no-consent - identical to how CookieNotice itself decides.
 */
export function readCookieConsent(): boolean {
  try {
    return (
      readVersioned<boolean>(COOKIE_CONSENT_KEY, {
        version: COOKIE_CONSENT_VERSION,
        fallback: false,
        migrate: (from, raw) => (from === 0 ? raw === true || raw === "true" : raw),
        validate: (d): d is boolean => typeof d === "boolean",
      }) === true
    );
  } catch {
    return false;
  }
}
