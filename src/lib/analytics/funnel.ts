/**
 * Funnel event emitter (frontend half of funnel tracking).
 *
 * Fires the signup -> onboard -> apply funnel events to /api/track as
 * fire-and-forget POSTs. STRICTLY consent-gated: without an analytics
 * consent record in localStorage (cm_cookie_notice, same gate as
 * PageViewTracker and the UTM capture) every call is a silent no-op and
 * nothing leaves the device.
 *
 * The stage allowlist MUST stay identical to ALLOWED_FUNNEL_EVENTS in
 * src/app/api/track/route.ts and the CHECK constraint in
 * supabase/migrations/20261106e_funnel_events.sql -
 * scripts/test-funnel-frontend.ts asserts the parity.
 *
 * Fail-open: network errors, aborted beacons and non-JSON responses are
 * swallowed. Analytics must never break a user flow.
 */

import { readCookieConsent } from "@/lib/analytics/cookieConsent";

export const FUNNEL_EVENTS = [
  "signup_started",
  "signup_completed",
  "onboarding_started",
  "onboarding_completed",
  "apply_started",
  "apply_completed",
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENTS)[number];

const ALLOWED: ReadonlySet<string> = new Set(FUNNEL_EVENTS);
const MAX_METADATA_BYTES = 2048;

function hasAnalyticsConsent(): boolean {
  return readCookieConsent();
}

export interface FunnelTrackOptions {
  /** Current in-app path (must start with "/", no query/hash - the route enforces this). */
  path?: string;
  /** Small flat metadata object; oversized or unserializable values are dropped. */
  metadata?: Record<string, unknown>;
}

/**
 * Emit one funnel event. No-op without consent, on the server, for an
 * unknown stage, or when metadata cannot be serialized within the budget.
 */
export function trackFunnelEvent(event: FunnelEventName, opts: FunnelTrackOptions = {}): void {
  try {
    if (!ALLOWED.has(event)) return;
    if (!hasAnalyticsConsent()) return;

    const payload: Record<string, unknown> = { eventType: "funnel", event };
    if (opts.path && opts.path.startsWith("/") && !opts.path.includes("?") && !opts.path.includes("#")) {
      payload.path = opts.path;
    }
    if (opts.metadata) {
      const json = JSON.stringify(opts.metadata);
      if (json && json.length <= MAX_METADATA_BYTES) {
        payload.metadata = opts.metadata;
      }
    }

    void fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {
      // fail-open: never surface analytics failures to the user flow
    });
  } catch {
    // fail-open
  }
}
