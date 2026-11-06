/**
 * First-touch campaign attribution capture (frontend half).
 *
 * Reads utm_source / utm_medium / utm_campaign / utm_term / utm_content plus
 * the referrer once per browser session and stores them in sessionStorage
 * under `cm_attribution`. Nothing leaves the device here: the stored object
 * is exposed via getAttribution() for signup / early-access payloads once the
 * backend accepts attribution fields.
 *
 * Called only after cookie consent (the caller gates it), and storage is
 * session-scoped so attribution never persists across sessions.
 */

export interface Attribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  referrer?: string;
  landingPath?: string;
  capturedAt: string;
}

export const ATTRIBUTION_STORAGE_KEY = "cm_attribution";

const UTM_KEYS: ReadonlyArray<[keyof Attribution, string]> = [
  ["utmSource", "utm_source"],
  ["utmMedium", "utm_medium"],
  ["utmCampaign", "utm_campaign"],
  ["utmTerm", "utm_term"],
  ["utmContent", "utm_content"],
];

/** Returns the stored attribution for this session, if any. */
export function getAttribution(): Attribution | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Attribution) : null;
  } catch {
    return null;
  }
}

/**
 * Captures attribution from the current URL once per session. Subsequent
 * calls in the same session are no-ops (first-touch wins).
 */
export function captureAttribution(pathname: string): void {
  try {
    if (typeof window === "undefined") return;
    if (window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)) return;

    const params = new URLSearchParams(window.location.search);
    const attribution: Attribution = { capturedAt: new Date().toISOString() };
    let hasUtm = false;
    for (const [field, key] of UTM_KEYS) {
      const value = params.get(key);
      if (value) {
        attribution[field] = value.slice(0, 200);
        hasUtm = true;
      }
    }
    if (document.referrer) {
      attribution.referrer = document.referrer.slice(0, 500);
    }
    if (pathname) {
      attribution.landingPath = pathname.slice(0, 200);
    }
    // Store only when there is something worth keeping.
    if (!hasUtm && !attribution.referrer) return;

    window.sessionStorage.setItem(
      ATTRIBUTION_STORAGE_KEY,
      JSON.stringify(attribution)
    );
  } catch {
    // Attribution capture is best-effort and must never break the app.
  }
}
