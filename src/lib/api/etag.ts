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

/** Compare valid entity tags weakly for If-None-Match (RFC 9110 13.1.2).
 * Parse quoted tags rather than splitting commas, which are valid opaque data.
 */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const header = ifNoneMatch.trim();
  if (header === "*") return true;
  const tagPattern = /^(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")$/;
  const target = tagPattern.exec(etag)?.[1];
  if (target === undefined) return false;
  // Full list grammar prevents accepting a matching substring from malformed
  // headers, including adjacent tags with no comma. Empty members are allowed.
  const tagSource = String.raw`(?:W/)?"[\x21\x23-\x7e\x80-\xff]*"`;
  const listPattern = new RegExp(`^[\\t ]*(?:${tagSource})?(?:[\\t ]*,[\\t ]*(?:${tagSource})?)*[\\t ]*$`);
  if (!listPattern.test(header)) return false;
  const candidates = header.match(new RegExp(tagSource, "g")) ?? [];
  return candidates.some((candidate) => tagPattern.exec(candidate)?.[1] === target);
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
