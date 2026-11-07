/**
 * Shared test fixtures (Testing row "Test Data / Fixtures").
 *
 * Before this module every suite hand-rolled its own Request builders and
 * rate-limit stubs, and the shapes drifted between suites. These builders
 * are the single source for the common shapes; a suite adds a local helper
 * only when it needs a shape this module does not cover. Builders mirror
 * the real production interfaces (docs/test-fixtures.md).
 */

/** Mirrors the shared rate-limit result shape consumed across src/lib. */
export interface RateLimitResultFixture {
  allowed: boolean;
  retryAfter: number;
  currentCount: number;
  source: "shared" | "memory" | "unavailable";
}

/** Defaults to an allowed shared-store result; pass overrides for a case. */
export function makeRateLimitResult(
  overrides: Partial<RateLimitResultFixture> = {}
): RateLimitResultFixture {
  return { allowed: true, retryAfter: 0, currentCount: 1, source: "shared", ...overrides };
}

/** Async check stub variants matching how the handlers consume them. */
export const rateLimitAllow = async () => makeRateLimitResult();
export const rateLimitDeny = async (retryAfter = 60) =>
  makeRateLimitResult({ allowed: false, retryAfter, currentCount: 99 });
export const rateLimitDown = async (retryAfter = 30) =>
  makeRateLimitResult({ allowed: false, retryAfter, currentCount: 0, source: "unavailable" });

/** Plain HTTP request fixture with optional headers and Bearer token. */
export function makeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; token?: string } = {}
): Request {
  const headers = new Headers(init.headers ?? {});
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  return new Request(url, { method: init.method ?? "GET", headers });
}

/** Request carrying an x-forwarded-for client IP (rate-limit/ATO tests). */
export function makeRequestFromIp(url: string, ip?: string): Request {
  return makeRequest(url, ip ? { headers: { "x-forwarded-for": ip } } : {});
}

/** Mirrors PageViewPayload in src/lib/admin/analytics.ts. */
export interface PageViewPayloadFixture {
  path: string;
  userId?: string | null;
  referrer?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  createdAt?: string;
}

export function makePageViewPayload(
  overrides: Partial<PageViewPayloadFixture> = {}
): PageViewPayloadFixture {
  return {
    path: "/jobs",
    userId: null,
    referrer: null,
    ipHash: "hash-fixture",
    userAgent: "vitest-fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Mirrors JobEligibilityRecord in src/lib/jobs/eligibility.ts. */
export interface JobEligibilityFixture {
  country?: string | null;
  country_code?: string | null;
  location?: string | null;
  remote?: boolean | null;
  remote_scope?: string | null;
  remote_eligibility?: string | null;
}

export function makeJobEligibilityRecord(
  overrides: Partial<JobEligibilityFixture> = {}
): JobEligibilityFixture {
  return {
    country: "India",
    country_code: "IN",
    location: "Bengaluru, India",
    remote: false,
    remote_scope: null,
    remote_eligibility: null,
    ...overrides,
  };
}
