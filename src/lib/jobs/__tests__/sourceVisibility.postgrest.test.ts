// Source visibility against REAL PostgREST semantics, combined with category / location / work-model OR filters.
//
// The route handlers run unmodified with the real supabase-js client; only `fetch` is shimmed:
//  - LIVE   (POSTGREST_URL set): /rest/v1/* is forwarded to a local PostgREST (fixtures/.../schema.sql loaded into a
//            local Postgres). With RECORD=1 every exchange is written to fixtures/.../recorded.json.
//  - REPLAY (default, CI): each request must match a recorded exchange byte for byte (method, path + query string,
//            Prefer, Accept, role) and gets the real server's recorded response. A request the server never
//            verified fails the test, so a changed filter cannot pass on the old evidence.
// Never touches production: the Supabase URL is a dummy host and live mode only talks to 127.0.0.1.
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { matchesPostgrestOr } from "@/lib/jobs/__tests__/postgrestLogicTree";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";

vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));
vi.mock("@/lib/billing/serverEntitlement", () => ({ getServerEntitlement: async (id: string) => ({ isPro: id.startsWith("aaaaaaaa") }) }));
vi.mock("@/lib/admin/auth", () => ({ verifyUserNotBanned: async () => ({ isBlocked: false }) }));

const DIR = path.join(__dirname, "fixtures", "postgrest-source-visibility");
const RECORDED = path.join(DIR, "recorded.json");
const LIVE = process.env.POSTGREST_URL?.replace(/\/$/, "");
const RECORD = Boolean(LIVE && process.env.RECORD === "1");
const SUPABASE_URL = "http://supabase.test";
const SECRET = "0".repeat(48); // matches the local postgrest.conf: zero-entropy, local-only, not a real key

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (role: string) => {
  const body = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify({ role }))}`;
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
};
const ANON = jwt("anon");
const SERVICE = jwt("service_role");
const PRO_TOKEN = "pro-session-token";
const PRO_USER = { id: "aaaaaaaa-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", user_metadata: {} };

type Exchange = { status: number; contentRange: string | null; body: string };
const recorded: Record<string, Exchange> = RECORD ? {} : JSON.parse(readFileSync(RECORDED, "utf8"));
const used = new Set<string>();
const realFetch = globalThis.fetch;

const roleOf = (auth: string | null) => (auth === `Bearer ${SERVICE}` ? "service_role" : auth === `Bearer ${ANON}` ? "anon" : `other`);

async function shim(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== SUPABASE_URL) throw new Error(`unexpected fetch to ${url.origin}`);
  if (url.pathname === "/auth/v1/user") {
    const ok = req.headers.get("authorization") === `Bearer ${PRO_TOKEN}`;
    return new Response(JSON.stringify(ok ? PRO_USER : { message: "invalid" }), { status: ok ? 200 : 401, headers: { "content-type": "application/json" } });
  }
  if (url.pathname.startsWith("/rest/v1/rpc/")) return new Response('{"message":"no rpc in fixture"}', { status: 404 });
  if (!url.pathname.startsWith("/rest/v1/")) throw new Error(`unexpected path ${url.pathname}`);
  const rest = url.pathname.slice("/rest/v1".length) + url.search;
  const key = `${req.method} ${rest} | prefer=${req.headers.get("prefer") ?? ""} | accept=${req.headers.get("accept") ?? ""} | role=${roleOf(req.headers.get("authorization"))}`;
  let ex: Exchange | undefined;
  if (LIVE) {
    const headers: Record<string, string> = {};
    for (const h of ["authorization", "prefer", "accept", "content-type"]) { const v = req.headers.get(h); if (v) headers[h] = v; }
    const res = await realFetch(`${LIVE}${rest}`, { method: req.method, headers });
    ex = { status: res.status, contentRange: res.headers.get("content-range"), body: await res.text() };
    if (RECORD) recorded[key] = ex;
  } else {
    ex = recorded[key];
    if (!ex) throw new Error(`request not verified against real PostgREST (re-record): ${key}`);
  }
  used.add(key);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ex.contentRange) headers["content-range"] = ex.contentRange;
  return new Response(req.method === "HEAD" ? null : ex.body, { status: ex.status, headers });
}

const env = {
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON,
  COMPANY_GROUP_ID_SECRET: "test-hmac-secret-012345678901234567890", NEXT_PUBLIC_BILLING_ENABLED: "true",
  __CAREERMONKE_LEGACY_RATE_LIMIT: "true",
};
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T00:00:00Z"));
  for (const k of [...Object.keys(env), "SUPABASE_SERVICE_ROLE_KEY"]) saved[k] = process.env[k];
  Object.assign(process.env, env);
  (globalThis as any).fetch = shim;
});
afterEach(() => { vi.resetModules(); delete process.env.SUPABASE_SERVICE_ROLE_KEY; });
afterAll(() => {
  vi.useRealTimers();
  (globalThis as any).fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (RECORD) writeFileSync(RECORDED, JSON.stringify(Object.fromEntries(Object.entries(recorded).sort()), null, 2) + "\n");
});

// Seed (schema.sql): 1xx provider rows, 2xx jobspy, 3xx NULL source_type; 109 is expired.
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JOBSPY = [201, 202, 203, 204, 205].map(ID);
const sorted = (ids: string[]) => [...ids].sort();
const idsOf = (body: any): string[] => (body.jobs || []).map((j: any) => j.id);
const call = async (route: string, url: string, token?: string) => {
  const { GET } = await import(route);
  const res: Response = await GET(new Request(`http://localhost${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  return { status: res.status, body: await res.json() };
};
const expectVisibility = (ids: string[], expected: number[]) => {
  expect(sorted(ids)).toEqual(sorted(expected.map(ID)));
  expect(ids.filter((id) => JOBSPY.includes(id))).toEqual([]);
};

describe("source visibility under real PostgREST semantics", () => {
  it("raw: two or= params are ANDed by the server; list and exact count agree; the test evaluator matches", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
    const AI = "category.eq.ai,title.ilike.%machine learning%,title.ilike.%llm%,title.ilike.%nlp%";
    const list = await db.from("jobs").select("id, source_type, category, title").or(AI).or(VISIBLE_SOURCE_FILTER).eq("status", "active");
    const head = await db.from("jobs").select("id", { count: "exact", head: true }).or(AI).or(VISIBLE_SOURCE_FILTER).eq("status", "active");
    const everything = await db.from("jobs").select("id, source_type, category, title, status");
    expect(list.error).toBeNull();
    expectVisibility((list.data || []).map((r: any) => r.id), [101, 106, 301]);
    expect(head.count).toBe(list.data!.length);
    // The unit-test fakes AND successive or() predicates; here that assumption is checked against the server.
    const fake = (everything.data || []).filter((r: any) => matchesPostgrestOr(AI, r) && matchesPostgrestOr(VISIBLE_SOURCE_FILTER, r) && r.status === "active");
    expect(sorted(fake.map((r: any) => r.id))).toEqual(sorted((list.data || []).map((r: any) => r.id)));
  });

  it("/api/jobs/search anon (jobs_public) + category=ai: NULL-source and provider rows kept, jobspy hidden", async () => {
    const { status, body } = await call("@/app/api/jobs/search/route", "/api/jobs/search?category=ai&pageSize=100");
    expect(status).toBe(200);
    expectVisibility(idsOf(body), [101, 106, 301]);
  });

  it("/api/jobs/search service (jobs) + category=data + location=remote: list and totalCount agree", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const { body } = await call("@/app/api/jobs/search/route", "/api/jobs/search?category=data&location=remote&pageSize=100");
    expectVisibility(idsOf(body), [103, 108]);
    expect(body.totalCount).toBe(idsOf(body).length);
  });

  it("/api/jobs/search service + workModel=remote,hybrid (OR) keeps hybrid and NULL-source rows, hides jobspy", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const { body } = await call("@/app/api/jobs/search/route", "/api/jobs/search?workModel=remote,hybrid&pageSize=100");
    expectVisibility(idsOf(body), [102, 103, 105, 107, 108, 301, 302]);
    expect(body.totalCount).toBe(idsOf(body).length);
  });

  it("/api/jobs/search anon + remoteOnly=true", async () => {
    const { body } = await call("@/app/api/jobs/search/route", "/api/jobs/search?remoteOnly=true&pageSize=100");
    expectVisibility(idsOf(body), [103, 107, 108, 301]);
  });

  it("/api/jobs/recommended anon branch (jobs_public) + category=ai + location=remote", async () => {
    const { body } = await call("@/app/api/jobs/recommended/route", "/api/jobs/recommended?category=ai&location=remote&pageSize=100");
    expectVisibility(idsOf(body), [301]);
    expect(body.totalCount).toBe(idsOf(body).length);
  });

  it("/api/jobs/recommended service branch + Pro hydration + category=data + workModel=remote,hybrid", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const { body } = await call("@/app/api/jobs/recommended/route", "/api/jobs/recommended?category=data&workModel=remote,hybrid&pageSize=100", PRO_TOKEN);
    expect(body.isPro).toBe(true);
    expectVisibility(idsOf(body), [102, 103, 108]);
    expect(body.totalCount).toBe(idsOf(body).length);
    expect(body.jobs.every((j: any) => j.applyUrl)).toBe(true); // hydrated from the real server
  });

  it("every recorded exchange is still exercised (no stale evidence)", () => {
    if (RECORD) return;
    expect(sorted(Array.from(used))).toEqual(sorted(Object.keys(recorded)));
  });
});
