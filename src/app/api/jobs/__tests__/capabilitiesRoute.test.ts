import { afterEach, describe, expect, it, vi } from "vitest";

const cf = vi.hoisted(() => ({ env: undefined as Record<string, any> | undefined }));
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => ({ env: cf.env }) }));

const KEYS = ["NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "CM_EXCLUDED_SKILLS_RPC", "CM_PREFERRED_SKILLS_RANKING"];
afterEach(() => { for (const k of KEYS) delete process.env[k]; cf.env = undefined; });

describe("GET /api/jobs/capabilities", () => {
  it("is an edge, force-dynamic, uncached route (no build-time capture of server flags)", async () => {
    const m = await import("../capabilities/route");
    expect(m.runtime).toBe("edge");
    expect(m.dynamic).toBe("force-dynamic");
  });
  it("reads the server flags on every request: off by default, on only with gate + service key + RPC flag", async () => {
    const { GET } = await import("../capabilities/route");
    let r = await GET();
    expect(await r.json()).toEqual({ savedConstraintsApplied: false, excludedSkillsFilter: false, preferredSkillsRanking: false });
    expect(r.headers.get("cache-control")).toBe("no-store");
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
    r = await GET();
    expect((await r.json()).excludedSkillsFilter).toBe(false);
    process.env.CM_EXCLUDED_SKILLS_RPC = "1";
    process.env.CM_PREFERRED_SKILLS_RANKING = "1";
    expect(await (await GET()).json()).toEqual({ savedConstraintsApplied: true, excludedSkillsFilter: true, preferredSkillsRanking: true });
    delete process.env.CM_EXCLUDED_SKILLS_RPC;
    expect((await (await GET()).json()).excludedSkillsFilter).toBe(false);
  });

  it("Cloudflare bindings alone drive the answer; a binding wins over process.env in both directions", async () => {
    const { GET } = await import("../capabilities/route");
    cf.env = { NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS: "true", SUPABASE_SERVICE_ROLE_KEY: "x", CM_EXCLUDED_SKILLS_RPC: "1", CM_PREFERRED_SKILLS_RANKING: "1" };
    expect(await (await GET()).json()).toEqual({ savedConstraintsApplied: true, excludedSkillsFilter: true, preferredSkillsRanking: true });
    // binding gate OFF, process gate ON: the binding wins, everything off
    cf.env = { ...cf.env, NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS: "false" };
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    expect(await (await GET()).json()).toEqual({ savedConstraintsApplied: false, excludedSkillsFilter: false, preferredSkillsRanking: false });
    // binding gate ON, process gate OFF
    cf.env = { ...cf.env, NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS: "true" };
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "false";
    expect((await (await GET()).json()).savedConstraintsApplied).toBe(true);
    // process gate only ON, no binding flags: gate true, features still off
    cf.env = undefined;
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    expect(await (await GET()).json()).toEqual({ savedConstraintsApplied: true, excludedSkillsFilter: false, preferredSkillsRanking: false });
  });
});
