/** Weak ETag support for public, cacheable JSON GET responses (RFC 9110).
 * Applied only where the body is identical for every anonymous caller. */

export async function computeWeakEtag(body: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(body));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `W/"${hex.slice(0, 32)}"`;
}

/** Parses If-None-Match (list form and "*") per RFC 9110 8.8.3. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((candidate) => candidate.trim() === etag || candidate.trim() === "*");
}

/**
 * Returns a 304 response when the request's If-None-Match matches the body
 * ETag, preserving the caller's cache headers; otherwise null.
 */
export function notModifiedResponse(req: Request, etag: string, headers: Record<string, string>): Response | null {
  if (!etagMatches(req.headers.get("if-none-match"), etag)) return null;
  return new Response(null, {
    status: 304,
    headers: { ...headers, ETag: etag },
  });
}
