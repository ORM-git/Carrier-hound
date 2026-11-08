import { describe, expect, it } from "vitest";
import { etagMatches, notModifiedResponse } from "../api/etag";
describe("If-None-Match weak comparison", () => {
  it.each([['"same"', 'W/"same"'], ['W/"same"', '"same"'], ['W/"same"', 'W/"same"'], ['"same"', '"same"']])("matches %s with %s", (header, target) => {
    expect(etagMatches(header, target)).toBe(true);
  });
  it("handles list whitespace and commas inside opaque tags", () => {
    expect(etagMatches(' "different", W/"a,b", "last" ', '"a,b"')).toBe(true);
    expect(etagMatches('"a,b"', 'W/"a"')).toBe(false);
    expect(etagMatches(' , , W/"same", ', '"same"')).toBe(true);
  });
  it.each(['same', 'w/"same"', 'junk"same"', '"same" trailing', '"same";"other"', '*, "same"', '"same" "other"'])("does not match malformed header %s", (header) => {
    expect(etagMatches(header, 'W/"same"')).toBe(false);
  });
  it("matches only equal case-sensitive opaque tags and preserves wildcard", () => {
    expect(etagMatches('"Same"', 'W/"same"')).toBe(false);
    expect(etagMatches(' * ', 'W/"same"')).toBe(true);
    expect(etagMatches(null, 'W/"same"')).toBe(false);
    expect(etagMatches('""', 'W/""')).toBe(true);
  });
  it("returns a bodyless 304 with existing cache headers and server tag", async () => {
    const response = notModifiedResponse(new Request("https://example.invalid", { headers: { "If-None-Match": '"same"' } }), 'W/"same"', { "Cache-Control": "public,max-age=60" });
    expect(response?.status).toBe(304);
    expect(await response?.text()).toBe("");
    expect(response?.headers.get("etag")).toBe('W/"same"');
    expect(response?.headers.get("cache-control")).toBe("public,max-age=60");
  });
});
