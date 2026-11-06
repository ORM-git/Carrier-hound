/**
 * Server-side attribution sanitizer (backend half of UTM capture; frontend
 * half: src/lib/analytics/utm.ts). Accepts the optional `attribution` object
 * on signup-style payloads, keeps only known keys, enforces the same length
 * caps as the frontend, and returns snake_case columns ready for insert.
 * Anything unexpected is dropped - attribution is best-effort and must never
 * break a signup.
 */

export interface AttributionInput {
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  utmTerm?: unknown;
  utmContent?: unknown;
  referrer?: unknown;
  landingPath?: unknown;
  capturedAt?: unknown;
}

export interface AttributionColumns {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  referrer?: string;
  landing_path?: string;
}

export const ATTRIBUTION_FIELD_CAPS: ReadonlyArray<
  [keyof AttributionInput, keyof AttributionColumns, number]
> = [
  ["utmSource", "utm_source", 200],
  ["utmMedium", "utm_medium", 200],
  ["utmCampaign", "utm_campaign", 200],
  ["utmTerm", "utm_term", 200],
  ["utmContent", "utm_content", 200],
  ["referrer", "referrer", 500],
  ["landingPath", "landing_path", 200],
];

export function sanitizeAttribution(raw: unknown): AttributionColumns {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const input = raw as AttributionInput;
  const columns: AttributionColumns = {};
  for (const [fromKey, toKey, cap] of ATTRIBUTION_FIELD_CAPS) {
    const value = input[fromKey];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    columns[toKey] = trimmed.slice(0, cap);
  }
  return columns;
}

/** True when at least one attribution column survived sanitization. */
export function hasAttribution(columns: AttributionColumns): boolean {
  return Object.keys(columns).length > 0;
}

/**
 * True when an insert failed because an attribution column does not exist yet
 * (migration 20261106b pending): Postgres undefined_column (42703) or
 * PostgREST schema-cache miss (PGRST204).
 */
export function isMissingAttributionColumnError(err: any): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("does not exist") && msg.includes("column")
  ) || msg.includes("could not find") && msg.includes("column");
}
