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

/**
 * Encodes a (posted_at, id) tuple into an opaque URL-safe base64 string.
 */
export function encodeCursor(postedAt: string | null | undefined, id: string): string {
  const payload = JSON.stringify([postedAt ? new Date(postedAt).toISOString() : null, id]);

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
 * Returns null if the cursor is invalid, corrupted, or malformed.
 */
export function decodeCursor(cursorStr?: string | null): KeysetCursorPayload | null {
  if (!cursorStr || typeof cursorStr !== "string") return null;

  try {
    let base64 = cursorStr.replace(/-/g, "+").replace(/_/g, "/");
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
    if (Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[1] === "string" && parsed[1].length > 0) {
      return {
        posted_at: parsed[0] ? String(parsed[0]) : null,
        id: String(parsed[1]),
      };
    }
    return null;
  } catch {
    return null;
  }
}
