import { afterEach, describe, expect, it, vi } from "vitest";

// createClient is also used for the auth session on the server path; only a table query counts as the public fallback.
const from = vi.hoisted(() => vi.fn(() => { throw new Error("direct public query must not run"); }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from, auth: { getSession: async () => ({ data: { session: null } }) } }) }));
import { getLiveJobs } from "../service";

const prefs = { roles: ["Frontend Engineer"], requiredYearsMin: 3, requiredYearsMax: null, advancedPreferencesAvailable: true } as any;

describe("an active required-years range never falls back to an unfiltered public query", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); from.mockClear(); });
  const run = (extra: Record<string, unknown> = {}) =>
    getLiveJobs({ sortBy: "match", preferences: prefs, candidate: { skills: ["react"], jobTitles: ["Frontend Engineer"] }, ...extra } as any);

  const cases: Array<[string, () => Promise<Response>]> = [
    ["fetch rejects", async () => { throw new Error("network"); }],
    ["server 500", async () => new Response("{}", { status: 500 })],
    ["server 429", async () => new Response("{}", { status: 429 })],
    ["server 502", async () => new Response("{}", { status: 502 })],
  ];
  for (const [name, impl] of cases) {
    it(`${name}: degraded result, no jobs_public query`, async () => {
      vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
      vi.stubGlobal("fetch", vi.fn(impl));
      const r = await run({ baseUrl: "http://t" });
      expect(r.isDegraded).toBe(true);
      expect(r.jobs).toEqual([]);
      expect(from).not.toHaveBeenCalled();
    });
  }
  it("no server available at all: degraded, never the public query", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    const r = await run();
    expect(r.isDegraded).toBe(true);
    expect(from).not.toHaveBeenCalled();
  });
});
