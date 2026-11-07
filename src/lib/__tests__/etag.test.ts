import { describe, expect, it } from "vitest";
import { computeWeakEtag, etagMatches, notModifiedResponse } from "@/lib/api/etag";
import { makeRequest } from "./fixtures";

describe("conditional request support", () => {
  it("computes stable weak etags for equal bodies and different tags for different bodies", async () => {
    const a = await computeWeakEtag({ jobsToday: 12, updatedAt: "2026-11-06T00:00:00Z" });
    const b = await computeWeakEtag({ jobsToday: 12, updatedAt: "2026-11-06T00:00:00Z" });
    const c = await computeWeakEtag({ jobsToday: 13, updatedAt: "2026-11-06T00:00:00Z" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^W\/"[0-9a-f]{32}"$/);
  });

  it("parses single, list, and star If-None-Match values", () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"x", W/"abc" , "y"', 'W/"abc"')).toBe(true);
    expect(etagMatches("*", 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"other"', 'W/"abc"')).toBe(false);
    expect(etagMatches(null, 'W/"abc"')).toBe(false);
  });

  it("returns 304 with etag and cache headers on match, null on mismatch", async () => {
    const headers = { "Cache-Control": "public, max-age=60" };
    const etag = await computeWeakEtag([1, 2, 3]);
    const hit = notModifiedResponse(
      makeRequest("https://x.test/api/ticker", { headers: { "if-none-match": etag } }),
      etag,
      headers
    );
    expect(hit?.status).toBe(304);
    expect(hit?.headers.get("ETag")).toBe(etag);
    expect(hit?.headers.get("Cache-Control")).toBe("public, max-age=60");
    const miss = notModifiedResponse(makeRequest("https://x.test/api/ticker"), etag, headers);
    expect(miss).toBeNull();
  });
});
