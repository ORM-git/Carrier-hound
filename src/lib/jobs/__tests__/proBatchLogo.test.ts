// For You with a resume: getLiveJobs takes the direct jobs_public query, then the authorized Pro batch unlock
// (POST /api/jobs/pro). Exact-shape rows from the 25 Nov 2026 owner evidence (Qonto, both ElevenLabs duplicates)
// go through the REAL POST handler and the REAL client merge. The fake DB projects each select string, so a
// column the route does not select is absent, as in PostgREST. Controlled fixtures, not live captures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  entitlement: { isPro: true } as { isPro: boolean },
}));

// Top-level columns plus nested `rel(a, b)`; everything else is dropped.
function project(row: any, select: string) {
  const out: any = {};
  for (const part of select.match(/\w+\([^)]*\)|\w+/g) || []) {
    const nested = part.match(/^(\w+)\(([^)]*)\)$/);
    if (nested) {
      const rel = row[nested[1]];
      out[nested[1]] = rel ? Object.fromEntries(nested[2].split(",").map((c) => c.trim()).map((c) => [c, rel[c] ?? null])) : null;
    } else if (part in row) out[part] = row[part];
  }
  return out;
}
function table(rows: () => any[]) {
  let select = "*";
  const preds: Array<(r: any) => boolean> = [];
  const run = () => {
    const data = rows().filter((r) => preds.every((p) => p(r)));
    return { data: select === "*" ? data : data.map((r) => project(r, select)), count: data.length, error: null };
  };
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
      if (prop === "select") return (s: string) => ((select = s), b);
      if (prop === "in") return (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), b);
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: run().data[0] ?? null, error: null });
      return () => b; // or / eq / order / range: filtering is not under test here
    },
  });
  return b;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async (t: string) => (t === "fixture-token" ? { data: { user: { id: "pro-fixture", user_metadata: {} } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) },
    from: (name: string) => table(() => (name === "jobs" ? db.jobs : [])),
  }),
}));
vi.mock("@/lib/billing/serverEntitlement", () => ({ getServerEntitlement: async () => db.entitlement }));
vi.mock("@/lib/admin/auth", () => ({ verifyUserNotBanned: async () => ({ isBlocked: false }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) },
    from: () => table(() => db.jobs.map(({ id, title, location, category, remote, country_code, job_type, verified, posted_at }) => ({ id, title, location, category, remote, country_code, job_type, verified, posted_at, is_active: true, status: "active" }))),
  }),
}));
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: undefined }) }));

import { getLiveJobs, type LiveJob } from "@/lib/jobs/service";
import { POST } from "@/app/api/jobs/pro/route";

const SUPA = "https://szakevhxhwpeskidvtfs.supabase.co/storage/v1/object/public/company-logos";
const ELEVEN = { name: "ElevenLabs", logo_url: `${SUPA}/bfda93c7-772e-4fb7-b8a2-49c867d8310b.png`, domain: "elevenlabs.io", canonical_domain: "elevenlabs.io", category: null };
const QONTO = { name: "Qonto", logo_url: `${SUPA}/844776b3-3f03-4d78-b0af-fc35b98d32a2.png`, domain: null, canonical_domain: null, category: null };
const GOOGLE_FAVICON = "https://www.google.com/s2/favicons?domain=elevenlabs.io&sz=128";
const row = (id: string, title: string, company: string, companyId: string, companies: any, logo_url: string | null, apply_url: string) => ({
  id, title, company, company_id: companyId, companies, logo_url, apply_url, source_type: null,
  location: "Remote", category: "engineering", remote: true, country_code: "IN", job_type: "full-time", verified: true,
  posted_at: "2026-11-24T00:00:00.000Z", is_active: true, status: "active", skills: ["kotlin", "android", "mobile"], description: "Kotlin Android mobile engineering",
});
const QONTO_JOB = row("7f3c3834-bfde-4a5d-8975-55b332e0ce27", "Senior Product Engineer - Android/Kotlin", "Qonto", "844776b3-3f03-4d78-b0af-fc35b98d32a2", QONTO, null, "https://jobs.lever.co/qonto/1");
const ELEVEN_NULL = row("00eb359b-f651-48f4-a4b4-b2ba81f9bd9c", "Mobile Engineer - ElevenMusic", "ElevenLabs", "bfda93c7-772e-4fb7-b8a2-49c867d8310b", ELEVEN, null, "https://jobs.ashbyhq.com/elevenlabs/1");
const ELEVEN_FAV = row("4f2ee6d7-6571-4576-9963-fd98657a7f45", "Mobile Engineer - ElevenMusic", "ElevenLabs", "bfda93c7-772e-4fb7-b8a2-49c867d8310b", ELEVEN, GOOGLE_FAVICON, "https://jobs.ashbyhq.com/elevenlabs/2");

const realFetch = globalThis.fetch;
let proResponder: (req: Request) => Promise<Response>;
beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-service-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-only-anon-key";
  db.jobs = [QONTO_JOB, ELEVEN_NULL, ELEVEN_FAV];
  db.entitlement = { isPro: true };
  proResponder = (req) => POST(req) as Promise<Response>;
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.startsWith("/api/jobs/pro")) return proResponder(new Request(`http://localhost${url}`, init));
    throw new Error(`unexpected fetch ${url}`);
  }) as any;
});


describe("For You resume pagination metadata", () => {
  const page = (n: number) => getLiveJobs({
    isPro: false, sortBy: "match", page: n, pageSize: 25,
    candidate: { skills: ["kotlin", "android", "mobile"], titles: ["Mobile Engineer", "Android Engineer"] } as any,
    preferences: { roles: ["Mobile Engineer", "Android Engineer"], categories: ["engineering"] } as any,
  });
  it("advertises every remaining page and stops only at the actual pool end", async () => {
    db.jobs = Array.from({ length: 60 }, (_, i) => ({ ...QONTO_JOB, id: `fixture-${i}` }));
    const first = await page(1), second = await page(2), last = await page(3);
    expect([first.jobs.length, second.jobs.length, last.jobs.length]).toEqual([25, 25, 10]);
    expect([first.totalCount, second.totalCount, last.totalCount]).toEqual([60, 60, 60]);
    expect([first.hasNextPage, second.hasNextPage, last.hasNextPage]).toEqual([true, true, false]);
    expect(new Set([...first.jobs, ...second.jobs, ...last.jobs].map(j => j.id)).size).toBe(60);
  });
  it("returns explicit exhausted metadata beyond the pool end", async () => {
    const res = await page(2);
    expect(res.jobs).toEqual([]);
    expect(res.hasNextPage).toBe(false);
    expect(res.nextCursor).toBeNull();
  });
});
afterEach(() => { globalThis.fetch = realFetch; });

const forYou = () => getLiveJobs({
  isPro: true, sortBy: "match", page: 1, pageSize: 25,
  candidate: { skills: ["kotlin", "android", "mobile"], titles: ["Mobile Engineer", "Android Engineer"] } as any,
  preferences: { roles: ["Mobile Engineer", "Android Engineer"], categories: ["engineering"] } as any,
});
const byId = (jobs: LiveJob[]) => Object.fromEntries(jobs.map((j) => [j.id, j]));
const logo = (j?: LiveJob) => j && { logoUrl: j.logoUrl ?? null, companyLogoUrl: j.companyLogoUrl ?? null, companyDomain: j.companyDomain ?? null };

describe("For You direct + Pro batch unlock keeps the employer logo metadata", () => {
  it("took the direct + batch path (no recommended/search call) and unlocked all three duplicates", async () => {
    const res = await forYou();
    const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calls).toEqual(["/api/jobs/pro"]);
    expect(res.jobs.map((j) => j.id).sort()).toEqual([QONTO_JOB.id, ELEVEN_NULL.id, ELEVEN_FAV.id].sort());
  });

  it("Qonto shape: null job logo, healthy company logo, null domain -> company logo kept", async () => {
    const j = byId((await forYou()).jobs)[QONTO_JOB.id];
    expect(logo(j)).toEqual({ logoUrl: QONTO.logo_url, companyLogoUrl: QONTO.logo_url, companyDomain: null });
  });

  it("both ElevenLabs duplicates carry the stored company logo and domain; the job favicon stays as fallback", async () => {
    const jobs = byId((await forYou()).jobs);
    expect(logo(jobs[ELEVEN_NULL.id])).toEqual({ logoUrl: ELEVEN.logo_url, companyLogoUrl: ELEVEN.logo_url, companyDomain: "elevenlabs.io" });
    expect(logo(jobs[ELEVEN_FAV.id])).toEqual({ logoUrl: GOOGLE_FAVICON, companyLogoUrl: ELEVEN.logo_url, companyDomain: "elevenlabs.io" });
  });

  it("an unmatched batch id gets nothing from another job", async () => {
    proResponder = async () => new Response(JSON.stringify({ jobs: [{ id: "someone-else", company: "Other", logo_url: "https://x.invalid/o.png", companies: QONTO }], isPro: true }), { status: 200 });
    for (const j of (await forYou()).jobs) {
      expect(j.company).toBe("Verified Employer");
      expect(logo(j)).toEqual({ logoUrl: null, companyLogoUrl: null, companyDomain: null });
    }
  });

  it("a denied (403, not Pro) or failed (500) unlock leaves no logo, domain or employer", async () => {
    db.entitlement = { isPro: false };
    for (const j of (await forYou()).jobs) {
      expect(j.proUnlockError?.status).toBe(403);
      expect([j.company, ...Object.values(logo(j)!)]).toEqual(["Verified Employer", null, null, null]);
    }
    proResponder = async () => new Response("{}", { status: 500 });
    for (const j of (await forYou()).jobs) expect(Object.values(logo(j)!)).toEqual([null, null, null]);
  });
});
