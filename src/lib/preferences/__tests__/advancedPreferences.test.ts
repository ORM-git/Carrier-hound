import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserPreferences, saveUserPreferences } from "@/lib/auth/session";
import { emptyUserPreferences } from "@/lib/auth/types";
import { draftFromPreferences, preferencesFromDraft, validateDraft, groupCounts, activeCount } from "../model";
import { getLiveJobs } from "@/lib/jobs/service";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => { throw new Error("no client in test"); } }));

/** Fake client: the base select works, a select/upsert naming advanced columns fails when `advanced` is false. */
function fakeClient(opts: { advanced: boolean; row?: Record<string, unknown> }) {
  const upserts: any[] = [];
  const missing = { code: "42703", message: 'column "required_years_min" does not exist' };
  const client = {
    upserts,
    from: () => {
      let cols = "";
      const b: any = {
        select: (c: string) => { cols = c; return b; },
        eq: () => b, is: () => b,
        maybeSingle: async () => {
          if (/required_years_min/.test(cols)) return opts.advanced ? { data: opts.row ?? {}, error: null } : { data: null, error: missing };
          if (/work_models/.test(cols)) return { data: {}, error: null };
          return { data: { roles: ["Engineer"], categories: [], remote_preference: "any", updated_at: "2026-11-26T00:00:00Z" }, error: null };
        },
        upsert: async (payload: any) => { upserts.push(payload); return { error: !opts.advanced && "required_years_min" in payload ? missing : null }; },
      };
      return b;
    },
  };
  return client;
}

describe("advanced preference storage degrades without breaking other preferences", () => {
  it("columns present: range and skills are read, normalized and saved", async () => {
    const c = fakeClient({ advanced: true, row: { required_years_min: "2", required_years_max: null, preferred_skills: ["React", " react ", "SQL"], excluded_skills: ["PHP"] } });
    const prefs = await getUserPreferences("u1", c);
    expect(prefs.advancedPreferencesAvailable).toBe(true);
    expect([prefs.requiredYearsMin, prefs.requiredYearsMax]).toEqual([2, null]);
    expect(prefs.preferredSkills).toEqual(["React", "SQL"]);
    await saveUserPreferences({ ...prefs, requiredYearsMin: 3, requiredYearsMax: 6, excludedSkills: ["PHP", "php"] }, "u1", c);
    expect(c.upserts[0]).toMatchObject({ required_years_min: 3, required_years_max: 6, excluded_skills: ["PHP"] });
  });
  it("columns missing: read reports unavailable, other preferences load, save writes none of them", async () => {
    const c = fakeClient({ advanced: false });
    const prefs = await getUserPreferences("u1", c);
    expect(prefs.advancedPreferencesAvailable).toBe(false);
    expect(prefs.roles).toEqual(["Engineer"]);
    await saveUserPreferences({ ...prefs, requiredYearsMin: 3 }, "u1", c);
    expect("required_years_min" in c.upserts[0]).toBe(false);
  });
  it("a caller that never set the fields never erases them", async () => {
    const c = fakeClient({ advanced: true });
    await saveUserPreferences({ ...emptyUserPreferences(), roles: ["A"] }, "u1", c);
    expect("required_years_min" in c.upserts[0]).toBe(false);
    expect("excluded_skills" in c.upserts[0]).toBe(false);
  });
  it("non-finite years are stored as unset, never as numbers", async () => {
    const c = fakeClient({ advanced: true });
    await saveUserPreferences({ ...emptyUserPreferences(), requiredYearsMin: Number.NaN, requiredYearsMax: Infinity }, "u1", c);
    expect(c.upserts[0]).toMatchObject({ required_years_min: null, required_years_max: null });
  });
});

describe("sheet model", () => {
  const base = { ...emptyUserPreferences(), advancedPreferencesAvailable: true as const };
  it("round trips and validates", () => {
    const d = draftFromPreferences({ ...base, requiredYearsMin: 2, requiredYearsMax: null, preferredSkills: ["React"], excludedSkills: ["PHP"] });
    expect([d.requiredYearsMin, d.requiredYearsMax, d.preferredSkills, d.excludedSkills]).toEqual([2, null, ["React"], ["PHP"]]);
    const out = preferencesFromDraft(base, { ...d, requiredYearsMin: 1, requiredYearsMax: 4 });
    expect([out.requiredYearsMin, out.requiredYearsMax]).toEqual([1, 4]);
    expect(validateDraft({ ...d, requiredYearsMin: 5, requiredYearsMax: 2 }).errors.requiredYears).toBeTruthy();
    expect(validateDraft({ ...d, requiredYearsMin: NaN }).errors.requiredYears).toBeTruthy();
    expect(validateDraft({ ...d, preferredSkills: ["react"], excludedSkills: ["React"] }).errors.skills).toBeTruthy();
  });
  it("unavailable storage leaves the saved advanced fields alone", () => {
    const committed = { ...emptyUserPreferences(), advancedPreferencesAvailable: false as const };
    const out = preferencesFromDraft(committed, { ...draftFromPreferences(committed), requiredYearsMin: 3, preferredSkills: ["x"] });
    expect(out.requiredYearsMin).toBeUndefined();
    expect(out.preferredSkills).toBeUndefined();
  });
  it("counts: advanced items only when available; filters also need the owner gate; 0..top does not count", () => {
    const d = draftFromPreferences({ ...base, requiredYearsMin: 2, requiredYearsMax: 4, preferredSkills: ["React"], excludedSkills: ["PHP"] });
    expect(activeCount(d, true)).toBe(0);
    expect(activeCount(d, true, true)).toBe(3);
    expect(activeCount(d, false, true)).toBe(1); // only preferred skills (ranking) while the gate is off
    expect(groupCounts({ ...d, requiredYearsMin: 0, requiredYearsMax: null }, true, true).basic).toBe(0);
  });
});

describe("getLiveJobs sends the saved range only under the owner gate, for the personalized feed", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const run = async (prefs: any, sortBy = "match") => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobs: [], totalCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getLiveJobs({ baseUrl: "http://t", sortBy: sortBy as any, preferences: prefs });
    return new URL(String((fetchMock.mock.calls as unknown as Array<[string]>)[0][0])).searchParams;
  };
  const saved = { requiredYearsMin: 2, requiredYearsMax: null, advancedPreferencesAvailable: true };
  it("gate off: nothing is sent", async () => {
    const p = await run(saved);
    expect(p.get("yearsMin")).toBeNull();
  });
  it("gate on: min only (upper handle at top) is sent; 0..top and unavailable storage send nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    const p = await run(saved);
    expect(p.get("yearsMin")).toBe("2");
    expect(p.get("yearsMax")).toBeNull();
    expect((await run({ ...saved, requiredYearsMin: 0 })).get("yearsMin")).toBeNull();
    expect((await run({ ...saved, advancedPreferencesAvailable: false })).get("yearsMin")).toBeNull();
    const q = await run({ ...saved, requiredYearsMin: 1, requiredYearsMax: 4 });
    expect([q.get("yearsMin"), q.get("yearsMax")]).toEqual(["1", "4"]);
  });
});

describe("getLiveJobs explicit drawer required-years choice (inherit | any | range)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const run = async (opts: any, sortBy = "newest") => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ jobs: [], totalCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getLiveJobs({ baseUrl: "http://t", sortBy: sortBy as any, ...opts });
    return new URL(String((fetchMock.mock.calls as unknown as Array<[string]>)[0][0])).searchParams;
  };
  const saved = { requiredYearsMin: 2, requiredYearsMax: 6, advancedPreferencesAvailable: true };
  const pair = (p: URLSearchParams) => [p.get("yearsMin"), p.get("yearsMax")];
  it("gate off: nothing is sent", async () => {
    expect(pair(await run({ requiredYears: { mode: "range", min: 1, max: 3 } }))).toEqual([null, null]);
  });
  it("gate on: range is sent on any sort and overrides (never intersects) the saved range", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    expect(pair(await run({ requiredYears: { mode: "range", min: 1, max: 3 } }))).toEqual(["1", "3"]);
    expect(pair(await run({ requiredYears: { mode: "range", min: 1, max: 3 }, preferences: saved }, "match"))).toEqual(["1", "3"]);
    expect(pair(await run({ requiredYears: { mode: "range", min: 5, max: null }, preferences: saved }, "match"))).toEqual(["5", null]);
  });
  it("inherit keeps the saved range; explicit any clears it; a no-op range is any", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    expect(pair(await run({ preferences: saved }, "match"))).toEqual(["2", "6"]);
    expect(pair(await run({ requiredYears: { mode: "inherit" }, preferences: saved }, "match"))).toEqual(["2", "6"]);
    expect(pair(await run({ requiredYears: { mode: "any" }, preferences: saved }, "match"))).toEqual([null, null]);
    expect(pair(await run({ requiredYears: { mode: "range", min: 0, max: null }, preferences: saved }, "match"))).toEqual([null, null]);
  });
  it("junk modes normalize to inherit, never to a silent filter", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    expect(pair(await run({ requiredYears: { mode: "range", min: -3, max: "x" } as any, preferences: saved }, "match"))).toEqual(["2", "6"]);
    expect(pair(await run({ requiredYears: { mode: "wat" } as any }))).toEqual([null, null]);
  });
});
