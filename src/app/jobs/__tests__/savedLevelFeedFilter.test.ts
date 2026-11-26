import { afterEach, describe, expect, it, vi } from "vitest";
import { getLiveJobs } from "@/lib/jobs/service";
import { resolveEffectiveLevel } from "@/lib/jobs/experienceLevels";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => { throw new Error("no client in test"); } }));

const G = { enforced: true, personalized: true };
describe("resolveEffectiveLevel", () => {
  it("gate off or not the personalized feed: saved level never filters", () => {
    expect(resolveEffectiveLevel(undefined, "senior", { enforced: false, personalized: true })).toBeUndefined();
    expect(resolveEffectiveLevel(undefined, "senior", { enforced: true, personalized: false })).toBeUndefined();
  });
  it("gate on: singles and multi-select apply uniformly; none/all six/unknown do not", () => {
    expect(resolveEffectiveLevel(undefined, "senior", G)).toBe("senior");
    expect(resolveEffectiveLevel("", "entry level,mid", G)).toBe("entry level,mid");
    expect(resolveEffectiveLevel("all", "junior", G)).toBe("junior");
    expect(resolveEffectiveLevel(undefined, "intern,entry,mid,senior,lead,director", G)).toBeUndefined();
    expect(resolveEffectiveLevel(undefined, "", G)).toBeUndefined();
    expect(resolveEffectiveLevel(undefined, "wizard", G)).toBeUndefined();
    expect(resolveEffectiveLevel(undefined, undefined, G)).toBeUndefined();
  });
  it("an explicit browse level overrides the saved one, never intersects", () => {
    expect(resolveEffectiveLevel("director", "senior", G)).toBe("director");
    expect(resolveEffectiveLevel("intern,entry,mid,senior,lead,director", "senior", G)).toBe("intern,entry,mid,senior,lead,director");
  });
});

describe("getLiveJobs level param follows the owner gate (recommended route request)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const run = async (level: string | undefined, saved: string | undefined) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobs: [], totalCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getLiveJobs({ baseUrl: "http://t", sortBy: "match", level, preferences: { experienceLevel: saved } as any });
    return new URL(String((fetchMock.mock.calls as unknown as Array<[string]>)[0][0])).searchParams;
  };
  it("gate off: saved level only ranks (experienceLevel), no level filter", async () => {
    const p = await run(undefined, "senior,lead");
    expect(p.get("level")).toBeNull();
    expect(p.get("experienceLevel")).toBe("senior,lead");
  });
  it("gate on: saved level is also sent as the level filter, ranking param unchanged", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    const p = await run(undefined, "Senior Level,junior");
    expect(p.get("level")).toBe("entry,senior");
    expect(p.get("experienceLevel")).toBe("Senior Level,junior");
  });
  it("gate on: a single saved level filters too", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    expect((await run(undefined, "mid")).get("level")).toBe("mid");
  });
  it("gate on: explicit browse level overrides (not intersected); reset to none falls back to saved; all six saved = no filter", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    expect((await run("director", "senior")).get("level")).toBe("director");
    expect((await run("", "senior")).get("level")).toBe("senior");
    expect((await run(undefined, "intern,entry,mid,senior,lead,director")).get("level")).toBeNull();
  });
});
