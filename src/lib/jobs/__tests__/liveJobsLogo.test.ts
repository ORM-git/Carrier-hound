import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => {
  const chain: any = new Proxy({}, { get: (_target, key) => key === "then"
    ? (resolve: any) => Promise.resolve({ data: state.rows, count: state.rows.length, error: null }).then(resolve)
    : () => chain });
  return { from: () => chain, auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } };
} }));
import { getLiveJobs } from "../service";
const originalFetch = globalThis.fetch;
beforeEach(() => { state.rows = [{ id: "logo-fixture", title: "Fixture role", location: "Remote", remote: true }]; });
afterEach(() => { globalThis.fetch = originalFetch; });
const unlocked = (extra: Record<string, unknown>) => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: [{ id: "logo-fixture", company: "Fixture employer", ...extra }] }), { status: 200 })) as any;
};
describe("Pro listing fallback logo mapping", () => {
  it("keeps the related company logo/domain supplied by the authorized batch unlock", async () => {
    unlocked({ companies: { logo_url: "https://cdn.fixture.invalid/logo.png", domain: "fixture.invalid" } });
    const { jobs } = await getLiveJobs({ isPro: true });
    expect([jobs[0].logoUrl, jobs[0].logo_url, jobs[0].companyDomain]).toEqual(["https://cdn.fixture.invalid/logo.png", "https://cdn.fixture.invalid/logo.png", "fixture.invalid"]);
  });
  it("uses job logo before company logo, and never guesses a missing domain", async () => {
    unlocked({ logo_url: "https://row.fixture.invalid/logo.png", companies: { logo_url: "https://company.fixture.invalid/logo.png" } });
    const { jobs } = await getLiveJobs({ isPro: true });
    expect([jobs[0].logoUrl, jobs[0].companyDomain]).toEqual(["https://row.fixture.invalid/logo.png", null]);
  });
  it("does not inherit another job's unlock or expose company metadata on Free", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: [{ id: "other-job", company: "Other employer", companies: { logo_url: "https://other.invalid/logo.png", domain: "other.invalid" } }] }), { status: 200 })) as any;
    const pro = await getLiveJobs({ isPro: true });
    expect([pro.jobs[0].logoUrl, pro.jobs[0].companyDomain ?? null]).toEqual([null, null]);
    const free = await getLiveJobs({ isPro: false });
    expect([free.jobs[0].logoUrl, free.jobs[0].companyDomain ?? null]).toEqual([null, null]);
  });
});
