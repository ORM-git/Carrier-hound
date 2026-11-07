/**
 * Cache Invalidation row (Performance): the documented strategy in
 * docs/cache-invalidation.md must stay truthful against the real cache
 * implementations it names, so the strategy cannot rot away from the
 * code.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";

const doc = fs.readFileSync("docs/cache-invalidation.md", "utf8");
const swr = fs.readFileSync("src/lib/cache/swr.ts", "utf8");
const tailor = fs.readFileSync("src/lib/resume/tailor.ts", "utf8");
const idem = fs.readFileSync("src/lib/ai/idempotency.ts", "utf8");
const rl = fs.readFileSync("src/lib/api/sharedRateLimit.ts", "utf8");

describe("cache invalidation strategy doc", () => {
  it("covers explicit invalidation via the real invalidateSwr export", () => {
    expect(doc).toContain("invalidateSwr");
    expect(/export function invalidateSwr\(keyOrPrefix: string\)/.test(swr)).toBe(true);
    expect(/key\.startsWith\(keyOrPrefix\)/.test(swr)).toBe(true);
  });

  it("covers the version-keyed cover-letter cache against the real constant", () => {
    expect(doc).toContain("COVER_LETTER_CACHE_VERSION");
    expect(/export const COVER_LETTER_CACHE_VERSION = \d+/.test(tailor)).toBe(true);
    expect(/cacheVersion: COVER_LETTER_CACHE_VERSION/.test(tailor)).toBe(true);
  });

  it("covers the TTL-based idempotency cache against the real TTL", () => {
    expect(doc).toContain("24h TTL");
    expect(/IDEMPOTENCY_CACHE_TTL_MS = 24 \* 60 \* 60 \* 1000/.test(idem)).toBe(true);
  });

  it("covers time-windowed rate-limit stores against the real window state", () => {
    expect(doc).toContain("resetAt");
    expect(/RateLimitStore = new Map<string, \{ count: number; resetAt: number \}>/.test(rl)).toBe(true);
  });

  it("covers content-hashed static assets", () => {
    expect(/[Cc]ontent hash/.test(doc)).toBe(true);
  });

  it("names a strategy for every row of its own table", () => {
    const rows = doc.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| ---") && !l.startsWith("| Cache"));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      expect(cells.length).toBe(3);
      expect(cells[2].length).toBeGreaterThan(10);
    }
  });
});
