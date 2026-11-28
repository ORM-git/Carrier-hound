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

describe("row 72: the Pro batch unlock is lean on the wire (feed) and still full by default", () => {
  const LONG = "Senior role. Build Kotlin and Android apps with 5+ years of experience, working across mobile, design and backend teams every single day.";
  beforeEach(() => { db.jobs = db.jobs.map((j) => ({ ...j, description: LONG })); });

  it("the feed asks for lean and the response body carries no description (real POST handler)", async () => {
    let raw = "";
    const inner = proResponder;
    proResponder = async (req) => {
      const sent = JSON.parse(await req.clone().text());
      expect(sent.lean).toBe(true);
      const res = await inner(req);
      raw = await res.clone().text();
      return res;
    };
    const { jobs } = await forYou();
    expect(raw).not.toContain("Build Kotlin and Android apps");
    for (const j of jobs) {
      expect(j.description).toBe("");
      expect(j.lean).toBe(true);
      expect(j.experienceBuckets).toContain("5+ Years");
      expect(j.evidencedSkills).toEqual(expect.arrayContaining(["Kotlin"]));
      expect(j.skills).toEqual([]);   // the unlock merge must not put the raw skills back on a lean row
      expect(Array.isArray(j.top_keywords) && j.top_keywords.length > 0).toBe(true);
      expect(j.applyUrl).toBeTruthy();
      expect(typeof j.scoreRevision).toBe("string");
    }
  });

  it("an older server that still sends full rows (no lean flag): the client derives the evidence, drops description AND raw skills, keeps the server keywords", async () => {
    const inner = proResponder;
    proResponder = async (req) => {
      const sent = JSON.parse(await req.clone().text()); delete sent.lean;
      return inner(new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(sent) }));
    };
    const { jobs } = await forYou();
    for (const j of jobs) {
      expect(j.lean).toBe(true);
      expect(j.description).toBe("");
      expect(j.skills).toEqual([]);
      expect(j.evidencedSkills).toEqual(expect.arrayContaining(["Kotlin"]));
      expect(Array.isArray(j.top_keywords) && j.top_keywords.length > 0).toBe(true);
    }
  });

  it("the REAL previously deployed lean DTO (lean+buckets+descriptionSkills+RAW skills, no evidencedSkills): evidence derived before the raw skills are dropped", async () => {
    const { extractSkillsFromJob, extractDescriptionSkills } = await import("@/lib/matcher/scoring");
    const inner = proResponder;
    let sentDto: any[] = [];
    proResponder = async (req) => {
      const res = await inner(req);
      const body = await res.clone().json();
      body.jobs = body.jobs.map((j: any) => {
        const row = db.jobs.find((d) => d.id === j.id);
        const { evidencedSkills, ...rest } = j; void evidencedSkills;
        return { ...rest, skills: row?.skills || [], descriptionSkills: extractDescriptionSkills(LONG, row?.category) };
      });
      sentDto = body.jobs;
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    };
    const { jobs } = await forYou();
    expect(sentDto.length).toBeGreaterThan(0);
    for (const dto of sentDto) { expect(dto.lean).toBe(true); expect(dto.evidencedSkills).toBeUndefined(); expect(dto.descriptionSkills.length).toBeGreaterThan(0); }
    for (const j of jobs) {
      const row = db.jobs.find((d) => d.id === j.id);
      expect(j.lean).toBe(true);
      expect(j.skills).toEqual([]);                                  // raw skills never restored on a lean row
      expect(j.description).toBe("");
      // exact old client evidence: raw skills + description + title, same order and case
      expect(j.evidencedSkills).toEqual(extractSkillsFromJob({ title: j.title, description: LONG, skills: row?.skills || [], category: j.category } as any));
      expect(j.evidencedSkills).toEqual(expect.arrayContaining(["Kotlin"]));
    }
  });

  it("without the lean flag the same handler still returns the full description (default unchanged)", async () => {
    const res = await POST(new Request("http://localhost/api/jobs/pro", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-token" },
      body: JSON.stringify({ ids: [QONTO_JOB.id] }),
    }));
    const body = await res.json();
    expect(body.jobs[0].description).toBe(LONG);
    expect(body.jobs[0].lean).toBeUndefined();
  });
});

describe("row 72: the previously deployed lean DTO (raw skills + descriptionSkills, no evidencedSkills) through EVERY service ingress", () => {
  const DESC_ONLY = ["Kotlin", "Android"];
  const oldLean = (id: string, skills: string[]) => ({
    id, title: "Mobile Engineer", company: "Acme", category: "engineering", description: "", lean: true,
    experienceBuckets: ["3-5 Years"], skills, descriptionSkills: DESC_ONLY, role_category: "SDE", top_keywords: ["Kotlin"],
  });
  const expected = (skills: string[]) => async () => {
    const { extractSkillsFromJob } = await import("@/lib/matcher/scoring");
    return extractSkillsFromJob({ title: "Mobile Engineer", description: "", skills: [...skills, ...DESC_ONLY], category: "engineering" } as any);
  };
  const serve = (path: string, body: any) => {
    globalThis.fetch = vi.fn(async (input: any) => {
      if (String(input).startsWith(`http://localhost${path}`)) return new Response(JSON.stringify(body), { status: 200 });
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as any;
  };
  const check = async (jobs: LiveJob[], skills: string[]) => {
    const want = await expected(skills)();
    expect(want).toEqual(expect.arrayContaining(["Kotlin", "Android", ...skills]));
    for (const j of jobs) {
      expect(j.lean).toBe(true);
      expect(j.evidencedSkills).toEqual(want);        // exact old order and case: raw skills, description skills, title
      expect(j.skills).toEqual([]);                   // raw skills dropped only AFTER the evidence was derived
      expect((j as any).descriptionSkills).toBeUndefined();
      expect(j.description).toBe("");
    }
  };
  it("GET /api/jobs/recommended (no resume)", async () => {
    serve("/api/jobs/recommended", { jobs: [oldLean("r1", ["Jetpack Compose"]), oldLean("r2", [])], totalCount: 2 });
    const { jobs } = await getLiveJobs({ isPro: true, sortBy: "match", page: 1, pageSize: 25, baseUrl: "http://localhost", preferences: { roles: ["Mobile Engineer"] } as any });
    expect(jobs.length).toBe(2);
    await check(jobs.slice(0, 1), ["Jetpack Compose"]); await check(jobs.slice(1), []);
  });
  it("GET /api/jobs/search", async () => {
    serve("/api/jobs/search", { jobs: [oldLean("s1", ["Jetpack Compose"])], totalCount: 1, hasNextPage: false });
    const { jobs } = await getLiveJobs({ isPro: true, sortBy: "newest", search: "kotlin", page: 1, pageSize: 25, baseUrl: "http://localhost" });
    expect(jobs.length).toBe(1);
    await check(jobs, ["Jetpack Compose"]);
  });
  it("new-contract rows (evidencedSkills present) and non-lean rows pass through untouched; negative control: without the normalizer the old DTO loses the description evidence", async () => {
    const fresh = { ...oldLean("n1", []), skills: [], descriptionSkills: undefined, evidencedSkills: ["Zig"] };
    const full = { id: "f1", title: "Mobile Engineer", category: "engineering", description: "Full text row", skills: ["Kotlin"] };
    serve("/api/jobs/search", { jobs: [fresh, full], totalCount: 2 });
    const { jobs } = await getLiveJobs({ isPro: true, sortBy: "newest", search: "kotlin", page: 1, pageSize: 25, baseUrl: "http://localhost" });
    expect(jobs[0].evidencedSkills).toEqual(["Zig"]);
    expect(jobs[1]).toMatchObject({ skills: ["Kotlin"], description: "Full text row" });
    expect((jobs[1] as any).evidencedSkills).toBeUndefined();
    const { extractSkillsFromJob } = await import("@/lib/matcher/scoring");
    const bare = extractSkillsFromJob({ ...oldLean("x", ["Jetpack Compose"]), lean: true } as any);
    expect(bare).not.toEqual(expect.arrayContaining(["Kotlin"]));   // the extractor alone ignores descriptionSkills: the normalizer is what preserves it
  });
});
