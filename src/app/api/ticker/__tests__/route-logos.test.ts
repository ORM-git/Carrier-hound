import { beforeEach, describe, expect, it, vi } from "vitest";

const H = "https://mock.supabase.co/storage/v1/object/public/company-logos/";
let jobs: any[] = [];
let companies: any[] = [];

function chain(rows: () => any[]) {
  const q: any = {
    select: () => q, or: () => q, eq: () => q, order: () => q, in: () => q,
    range: (from: number) => Promise.resolve({ data: from === 0 ? rows() : [], error: null }),
    then: (res: any) => Promise.resolve({ data: rows(), error: null }).then(res),
  };
  return q;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chain(() => (t === "jobs" ? jobs : companies)) }),
}));
vi.mock("@/lib/api/sharedRateLimit", () => ({
  checkSharedRateLimit: async () => ({ allowed: true }),
  TICKER_RATE_LIMIT: { maxRequests: 100, windowSeconds: 60 },
  tickerRateLimitStore: new Map(),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-key";

async function run() {
  const { GET } = await import("../route");
  const res = await GET(new Request("http://localhost/api/ticker"));
  expect(res.status).toBe(200);
  const body: any = await res.json();
  const list = Array.isArray(body) ? body : body.jobs;
  return Object.fromEntries(list.map((r: any) => [r.company, r.logo_url]));
}

function job(company: string, i: number, extra: any = {}) {
  return { id: `j${i}`, company, company_id: extra.company_id ?? null, title: `T${i}`, posted_at: new Date(Date.now() - i * 1000).toISOString(), created_at: null, logo_url: extra.logo_url ?? null };
}

describe("ticker route logo resolution", () => {
  beforeEach(() => { jobs = []; companies = []; });

  it("hosted > bundled official > null; malformed/foreign/unmapped never leak", async () => {
    jobs = [
      job("Reddit", 1),
      job("Okta", 2),
      job("Asana", 3, { company_id: "c-asana" }),
      job("Netlify", 4),
      job("Wolt", 5),
      job("Warp", 6),
      job("Reddit Analytics Co", 7),
      job("MongoDB", 8),
    ];
    companies = [
      { id: "c-asana", name: "Asana", logo_url: H + "asana-hosted.png" },        // hosted wins over bundled
      { id: "c-okta", name: "Okta", logo_url: "" },                               // empty -> bundled
      { id: "c-netlify", name: "Netlify", logo_url: "https://evil.example/company-logos/n.png" }, // foreign -> bundled
      { id: "c-wolt", name: "Wolt", logo_url: "javascript:alert(1)" },            // malformed -> bundled
      { id: "c-warp", name: "Warp", logo_url: "not a url" },                      // malformed, unmapped -> null
      { id: "c-mongo", name: "MongoDB", logo_url: "https://mock.supabase.co/storage/v1/object/public/other-bucket/m.png" }, // wrong bucket -> bundled
    ];
    const out = await run();
    expect(out["Reddit"]).toBe("/company-logos-static/reddit.png");
    expect(out["Okta"]).toBe("/company-logos-static/okta.png");
    expect(out["Asana"]).toBe(H + "asana-hosted.png");
    expect(out["Netlify"]).toBe("/company-logos-static/netlify.png");
    expect(out["Wolt"]).toBe("/company-logos-static/wolt.png");
    expect(out["MongoDB"]).toBe("/company-logos-static/mongodb.png");
    expect(out["Warp"]).toBeNull();
    expect(out["Reddit Analytics Co"]).toBeNull();
  });
});
