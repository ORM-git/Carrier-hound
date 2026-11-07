/**
 * Post-deploy smoke checks (Backend sheet rank 78). UptimeRobot pings
 * /api/health continuously, but nothing scripted runs right after a
 * deploy. These are the checks scripts/smoke-post-deploy.ts runs against
 * a base URL (production or a preview deploy) - read-only, safe to run
 * any time. Add a check here when a deploy breaks something these miss.
 */

export interface SmokeCheck {
  name: string;
  path: string;
  method?: string;
  expectStatus: number;
  /** Optional body assertion: response text must contain this. */
  expectBodyIncludes?: string;
}

export interface SmokeResult {
  name: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/** The live smoke set. Keep small and read-only. */
export const SMOKE_CHECKS: readonly SmokeCheck[] = [
  { name: "health endpoint", path: "/api/health", expectStatus: 200, expectBodyIncludes: '"status":"ok"' },
  { name: "homepage renders", path: "/", expectStatus: 200, expectBodyIncludes: "<html" },
] as const;

export type FetchLike = (url: string, init?: { method?: string }) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

export async function runSmokeChecks(
  baseUrl: string,
  fetchImpl: FetchLike,
  checks: readonly SmokeCheck[] = SMOKE_CHECKS
): Promise<{ ok: boolean; results: SmokeResult[] }> {
  const base = baseUrl.replace(/\/+$/, "");
  const results: SmokeResult[] = [];
  for (const check of checks) {
    try {
      const res = await fetchImpl(`${base}${check.path}`, { method: check.method ?? "GET" });
      if (res.status !== check.expectStatus) {
        results.push({ name: check.name, ok: false, status: res.status, error: `expected ${check.expectStatus}` });
        continue;
      }
      if (check.expectBodyIncludes !== undefined) {
        const text = await res.text();
        if (!text.includes(check.expectBodyIncludes)) {
          results.push({ name: check.name, ok: false, status: res.status, error: "body assertion failed" });
          continue;
        }
      }
      results.push({ name: check.name, ok: true, status: res.status });
    } catch (err: any) {
      results.push({ name: check.name, ok: false, error: err?.message || "request failed" });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}
