/**
 * Versioned localStorage persistence with migration.
 *
 * Values are stored as an envelope `{ v: number, data: T }`. Reads accept the
 * current version, run a registered migration chain for older versions
 * (including legacy un-enveloped values, treated as version 0), and fall back
 * to the default when the payload is corrupt or written by a newer version of
 * the app (forward-incompatible).
 */

export interface VersionedReadOptions<T> {
  /** Current schema version written by this build. */
  version: number;
  /** Default when nothing readable is stored. */
  fallback: T;
  /**
   * Migrate a stored payload from `fromVersion` to `fromVersion + 1`.
   * Version 0 is the legacy raw (un-enveloped) value.
   */
  migrate?: (fromVersion: number, raw: unknown) => unknown;
  /** Optional shape check on the migrated/current payload. */
  validate?: (data: unknown) => data is T;
}

interface Envelope<T> {
  v: number;
  data: T;
}

export function readVersioned<T>(
  key: string,
  { version, fallback, migrate, validate }: VersionedReadOptions<T>
): T {
  if (typeof window === "undefined") return fallback;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;

  let v = 0;
  let data: unknown = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as Envelope<T>).v === "number" && "data" in (parsed as object)) {
      v = (parsed as Envelope<T>).v;
      data = (parsed as Envelope<T>).data;
    } else {
      // Legacy: raw JSON value without an envelope.
      data = parsed;
    }
  } catch {
    // Legacy: raw non-JSON string (e.g. "true").
    data = raw;
  }

  // Written by a newer build: do not guess, fall back.
  if (v > version) return fallback;

  while (v < version) {
    if (!migrate) return fallback;
    try {
      data = migrate(v, data);
    } catch {
      return fallback;
    }
    v++;
  }

  if (validate && !validate(data)) return fallback;
  return data as T;
}

export function writeVersioned<T>(key: string, version: number, data: T): void {
  if (typeof window === "undefined") return;
  try {
    const envelope: Envelope<T> = { v: version, data };
    window.localStorage.setItem(key, JSON.stringify(envelope));
  } catch {}
}
