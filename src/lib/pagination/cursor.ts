/**
 * src/lib/pagination/cursor.ts
 *
 * Keyset (Cursor-Based) Pagination Utilities.
 *
 * Encodes and decodes opaque, URL-safe cursors composed of [posted_at, id].
 * Provides strict determinism on 100k+ row tables without OFFSET degradation.
 */

export interface KeysetCursorPayload {
  posted_at: string | null;
  id: string;
}

export interface KeysetPageResult<T> {
  jobs: T[];
  totalCount: number;
  nextCursor?: string | null;
  hasNextPage: boolean;
}

// Strict UUID regex: standard 8-4-4-4-12 hexadecimal UUID format
export const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Strict ISO 8601 timestamp regex (requires YYYY-MM-DDTHH:MM:SS with optional subseconds and timezone offset/Z)
export const POSTED_AT_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * Encodes a (posted_at, id) tuple into an opaque URL-safe base64 string.
 * Keeps exact PostgREST posted_at string format to preserve microsecond database precision.
 * Never re-serializes via new Date().toISOString().
 */
export function encodeCursor(postedAt: string | null | undefined, id: string): string {
  let exactPostedAt: string | null = null;
  if (typeof postedAt === "string" && POSTED_AT_REGEX.test(postedAt.trim())) {
    exactPostedAt = postedAt.trim();
  }
  const payload = JSON.stringify([exactPostedAt, id]);

  if (typeof Buffer !== "undefined") {
    return Buffer.from(payload, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // Browser / Edge fallback
  const b64 = btoa(payload);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes an opaque URL-safe base64 cursor into { posted_at, id }.
 * Enforces strict ISO timestamp and UUID validation; returns null on any malformed or injection payload.
 */
export function decodeCursor(cursorStr?: string | null): KeysetCursorPayload | null {
  if (!cursorStr || typeof cursorStr !== "string" || !cursorStr.trim()) return null;

  try {
    let base64 = cursorStr.trim().replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) {
      base64 += "=";
    }

    let jsonStr = "";
    if (typeof Buffer !== "undefined") {
      jsonStr = Buffer.from(base64, "base64").toString("utf-8");
    } else {
      jsonStr = atob(base64);
    }

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed) || parsed.length < 2) {
      return null;
    }

    const [postedAtRaw, idRaw] = parsed;

    // 1. Strict UUID validation on id
    if (typeof idRaw !== "string" || !UUID_REGEX.test(idRaw)) {
      return null;
    }

    // 2. Strict timestamp validation on posted_at (if present)
    let posted_at: string | null = null;
    if (postedAtRaw !== null && postedAtRaw !== undefined) {
      if (typeof postedAtRaw !== "string" || !POSTED_AT_REGEX.test(postedAtRaw)) {
        return null;
      }
      const parsedTime = Date.parse(postedAtRaw);
      if (isNaN(parsedTime)) {
        return null;
      }
      const parsedYear = new Date(parsedTime).getUTCFullYear();
      if (parsedYear < 1970 || parsedYear > 2100) {
        return null;
      }
      posted_at = postedAtRaw;
    }

    return {
      posted_at,
      id: idRaw,
    };
  } catch {
    return null;
  }
}
