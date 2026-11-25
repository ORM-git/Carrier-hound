import { strict as assert } from "node:assert";
import { datePostedCutoff } from "../../src/lib/preferences/feedConstraints";

// Validate the actual call chain, not merely the presence of a helper import or comment.
export function verifyDateGuard(source: string, input: string): boolean {
  return new RegExp(`const\\s+postedCutoff\\s*=\\s*datePostedCutoff\\(${input}\\);\\s*if\\s*\\(postedCutoff\\)\\s*query\\s*=\\s*query\\.gte\\("posted_at",\\s*postedCutoff\\)`).test(source);
}

export function testDateGuardContract(): void {
  const now = Date.UTC(2026, 10, 25, 18);
  for (const value of [undefined, null, "", "all", "any", "invalid"]) {
    assert.equal(datePostedCutoff(value, now), null, `ordinary/invalid browse ${value} must not filter undated rows`);
  }
  for (const [window, days] of [["24h", 1], ["3d", 3], ["7d", 7], ["30d", 30]] as const) {
    assert.equal(datePostedCutoff(window, now), new Date(now - days * 86400000).toISOString());
  }
  const good = 'const postedCutoff = datePostedCutoff(dateParam); if (postedCutoff) query = query.gte("posted_at", postedCutoff);';
  assert(verifyDateGuard(good, "dateParam"));
  for (const bad of [
    good.replace('if (postedCutoff)', ''),
    good.replace('datePostedCutoff(dateParam)', 'datePostedCutoff("24h")'),
    good.replace('"posted_at"', '"created_at"'),
    good.replace('query = query.gte', 'other = other.gte'),
    good.replace('query.gte("posted_at", postedCutoff)', 'query'),
  ]) assert(!verifyDateGuard(bad, "dateParam"), `date guard mutation went undetected: ${bad}`);
}
