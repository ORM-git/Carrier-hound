import { beforeEach, describe, expect, it, vi } from "vitest";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";

// Mock PostgREST that really applies order()/range(), so ordering assertions are meaningful.
let jobs: any[] = [];
let companies: any[] = [];
let calls: any[][] = [];

const ms = (v: unknown) => {
  const t = typeof v === "string" ? new Date(v).getTime() : NaN;
  return isNaN(t) ? null : t;
};

function jobsQuery() {
  const orders: Array<[string, { ascending: boolean; nullsFirst?: boolean }]> = [];
  const q: any = {
    select: () => q,
    or: (f: string) => (calls.push(["or", f]), q),
    eq: (c: string, v: unknown) => (calls.push(["eq", c, v]), q),
    order: (c: string, o: any) => (orders.push([c, o]), calls.push(["order", c, o]), q),
    range: (from: number, to: number) => {
      calls.push(["range", from, to]);
      const sorted = [...jobs].sort((a, b) => {
        for (const [col, o] of orders) {
          const va = col === "id" ? a.id : ms(a[col]);
          const vb = col === "id" ? b.id : ms(b[col]);
          if (va === vb) continue;
          if (va === null) return o.nullsFirst ? -1 : 1;
          if (vb === null) return o.nullsFirst ? 1 : -1;
          return (va < vb ? -1 : 1) * (o.ascending ? 1 : -1);
        }
        return 0;
      });
      return Promise.resolve({ data: sorted.slice(from, to + 1), error: null });
    },
  };
  return q;
}

function companiesQuery() {
  const q: any = {
    select: () => q,
    in: () => q,
    then: (res: any) => Promise.resolve({ data: companies, error: null }).then(res),
  };
  return q;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => (t === "jobs" ? jobsQuery() : companiesQuery()) }),
}));
vi.mock("@/lib/api/sharedRateLimit", () => ({
  checkSharedRateLimit: async () => ({ allowed: true }),
  TICKER_RATE_LIMIT: { maxRequests: 100, windowSeconds: 60 },
  tickerRateLimitStore: new Map(),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-key";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const job = (id: string, company: string, over: any = {}) => ({
  id, company, company_id: null, title: `Role ${id}`, logo_url: null,
  posted_at: ago(60), created_at: ago(60), ...over,
});

type Out = { status: number; body: any; headers: Record<string, string> };

async function nextRoute(query = "", reqHeaders: Record<string, string> = {}): Promise<Out> {
  const { GET } = await import("../route");
  const res = await GET(new Request(`http://localhost/api/ticker${query}`, { headers: reqHeaders }));
  return {
    status: res.status,
    body: res.status === 200 ? await res.json() : null,
    headers: Object.fromEntries(res.headers.entries()),
  };
}

async function netlifyFn(query = ""): Promise<Out> {
  const { handler } = await import("../../../../../netlify/functions/ticker");
  const params = Object.fromEntries(new URLSearchParams(query));
  const res: any = await handler({ httpMethod: "GET", headers: {}, queryStringParameters: params });
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
}

const handlers = [
  ["Next edge route", nextRoute],
  ["Netlify function", netlifyFn],
] as const;

describe.each(handlers)("/api/ticker modes (%s)", (_name, call) => {
  beforeEach(() => {
    jobs = [];
    companies = [];
    calls = [];
  });

  it("imported mode puts a newly imported old posting first and returns added_at separately", async () => {
    jobs = [
      job("a", "Fresh Post Co", { posted_at: ago(5), created_at: ago(600) }),
      job("b", "Old Post Co", { posted_at: "2024-03-01T00:00:00.000Z", created_at: ago(1) }),
    ];
    const imported = await call("?mode=imported");
    expect(imported.status).toBe(200);
    expect(imported.body.map((r: any) => r.company)).toEqual(["Old Post Co", "Fresh Post Co"]);
    expect(imported.body[0]).toMatchObject({ posted_at: "2024-03-01T00:00:00.000Z", added_at: ago(1) });

    const byDefault = await call("");
    expect(byDefault.body.map((r: any) => r.company)).toEqual(["Fresh Post Co", "Old Post Co"]);
  });

  it("orders by created_at DESC with an id DESC tie-break, ignoring later re-sightings", async () => {
    const same = ago(10);
    jobs = [
      job("id-1", "One", { created_at: same }),
      job("id-3", "Three", { created_at: same }),
      job("id-2", "Two", { created_at: same }),
      // Re-upserted/retried old import: fresh last_seen_at, created_at untouched -> stays behind.
      job("id-9", "Old Import", { created_at: ago(900), last_seen_at: ago(0) }),
    ];
    const res = await call("?mode=imported");
    expect(res.body.map((r: any) => r.company)).toEqual(["Three", "Two", "One", "Old Import"]);
    const orders = calls.filter((c) => c[0] === "order").slice(0, 2);
    expect(orders).toEqual([
      ["order", "created_at", { ascending: false, nullsFirst: false }],
      ["order", "id", { ascending: false }],
    ]);
  });

  it("drops rows with missing/invalid/far-future created_at; nulls invalid or future posted_at", async () => {
    jobs = [
      job("1", "No Created", { created_at: null }),
      job("2", "Bad Created", { created_at: "not-a-date" }),
      job("3", "Future Created", { created_at: new Date(NOW + 60 * 60_000).toISOString() }),
      job("4", "Skew Created", { created_at: new Date(NOW + 60_000).toISOString() }), // within 5 min: kept
      job("5", "Bad Posted", { posted_at: "garbage", created_at: ago(2) }),
      job("6", "Future Posted", { posted_at: new Date(NOW + 60 * 60_000).toISOString(), created_at: ago(3) }),
      job("7", "No Posted", { posted_at: null, created_at: ago(4) }),
    ];
    const res = await call("?mode=imported");
    const byCompany = Object.fromEntries(res.body.map((r: any) => [r.company, r]));
    expect(Object.keys(byCompany).sort()).toEqual(["Bad Posted", "Future Posted", "No Posted", "Skew Created"]);
    expect(byCompany["Bad Posted"].posted_at).toBeNull();
    expect(byCompany["Future Posted"].posted_at).toBeNull();
    expect(byCompany["No Posted"].posted_at).toBeNull();
    expect(byCompany["Bad Posted"].added_at).toBe(ago(2));
  });

  it("keeps source exclusion, active filters, 20 items, max 2 per company and the 500-row scan cap", async () => {
    jobs = Array.from({ length: 700 }, (_, i) => job(`f-${String(i).padStart(3, "0")}`, "Flood", { created_at: ago(i) }));
    jobs.push(...Array.from({ length: 30 }, (_, i) => job(`d-${i}`, `Diverse ${i}`, { created_at: ago(1000 + i) })));
    const res = await call("?mode=imported");
    expect(res.body).toHaveLength(2); // diverse rows sit past the 500-row cap
    expect(res.body.every((r: any) => r.company === "Flood")).toBe(true);
    expect(calls).toContainEqual(["or", VISIBLE_SOURCE_FILTER]);
    expect(calls).toContainEqual(["eq", "status", "active"]);
    expect(calls).toContainEqual(["eq", "is_active", true]);
    expect(Math.max(...calls.filter((c) => c[0] === "range").map((c) => c[2]))).toBe(499);

    calls = [];
    jobs = Array.from({ length: 40 }, (_, i) => job(`x-${i}`, `Co ${i % 15}`, { created_at: ago(i) }));
    const capped = await call("?mode=imported");
    expect(capped.body).toHaveLength(20);
    const counts = capped.body.reduce((m: any, r: any) => ((m[r.company] = (m[r.company] || 0) + 1), m), {});
    expect(Math.max(...(Object.values(counts) as number[]))).toBeLessThanOrEqual(2);
  });

  it("default and unknown modes keep the exact previous shape and posted_at ordering", async () => {
    jobs = [job("a", "Alpha", { posted_at: ago(1), created_at: ago(500) }), job("b", "Beta", { posted_at: null, created_at: ago(2) })];
    const res = await call("");
    expect(res.body.map((r: any) => Object.keys(r))).toEqual([
      ["company", "title", "posted_at", "logo_url"],
      ["company", "title", "posted_at", "logo_url"],
    ]);
    expect(res.body[1].posted_at).toBe(ago(2)); // created_at fallback, as before
    expect(calls.filter((c) => c[0] === "order")[0]).toEqual(["order", "posted_at", { ascending: false, nullsFirst: false }]);
    expect(calls.filter((c) => c[0] === "order" && c[1] !== "posted_at")).toEqual([]);

    const unknown = await call("?mode=bogus");
    expect(unknown.body).toEqual(res.body);
  });

  it("separates modes for caching: same public policy, different bodies", async () => {
    jobs = [job("a", "Alpha", { posted_at: ago(1), created_at: ago(9) }), job("b", "Beta", { posted_at: ago(9), created_at: ago(1) })];
    const def = await call("");
    const imp = await call("?mode=imported");
    expect(imp.headers["Cache-Control"] ?? imp.headers["cache-control"]).toBe(def.headers["Cache-Control"] ?? def.headers["cache-control"]);
    expect(imp.body).not.toEqual(def.body);
  });
});

describe("/api/ticker Next route: mode-specific ETag and logo fallback", () => {
  beforeEach(() => {
    jobs = [];
    companies = [];
    calls = [];
  });

  it("issues different ETags per mode and never 304s one mode with the other's tag", async () => {
    jobs = [job("a", "Alpha", { posted_at: ago(1), created_at: ago(9) }), job("b", "Beta", { posted_at: ago(9), created_at: ago(1) })];
    const def = await nextRoute("");
    const imp = await nextRoute("?mode=imported");
    expect(def.headers.etag).toBeTruthy();
    expect(imp.headers.etag).not.toBe(def.headers.etag);
    expect((await nextRoute("?mode=imported", { "If-None-Match": def.headers.etag })).status).toBe(200);
    expect((await nextRoute("?mode=imported", { "If-None-Match": imp.headers.etag })).status).toBe(304);
  });

  it("imported mode reuses the safe hosted logo and the bundled official fallback", async () => {
    const H = "https://mock.supabase.co/storage/v1/object/public/company-logos/";
    jobs = [
      job("r", "Reddit", { created_at: ago(1) }),
      job("a", "Asana", { company_id: "c-asana", created_at: ago(2) }),
      job("e", "Evil", { company_id: "c-evil", created_at: ago(3) }),
    ];
    companies = [
      { id: "c-asana", name: "Asana", logo_url: H + "asana.png" },
      { id: "c-evil", name: "Evil", logo_url: "https://evil.example/company-logos/e.png" },
    ];
    const res = await nextRoute("?mode=imported");
    const logos = Object.fromEntries(res.body.map((r: any) => [r.company, r.logo_url]));
    expect(logos).toEqual({ Reddit: "/company-logos-static/reddit.png", Asana: H + "asana.png", Evil: null });
  });
});
