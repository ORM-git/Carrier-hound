import { NextResponse } from "next/server";
import { computeWeakEtag, notModifiedResponse } from "@/lib/api/etag";

/**
 * Success response for GET /api/radar (Backend sheet row 97, conditional requests).
 *
 * The body, status and the headers passed in (Cache-Control, X-Cache, set by the route)
 * are exactly what the route returned before. The only additions are an ETag header and a 304 answer when the
 * caller sends a matching If-None-Match. The payload is the same for every anonymous
 * caller, which is the condition etag.ts requires.
 */
export async function radarJsonResponse(
  req: Request | undefined,
  payload: unknown,
  headers: Record<string, string>
): Promise<Response> {
  const etag = await computeWeakEtag(payload);
  if (req) {
    const notModified = notModifiedResponse(req, etag, headers);
    if (notModified) return notModified;
  }
  return NextResponse.json(payload, { headers: { ...headers, ETag: etag } });
}
