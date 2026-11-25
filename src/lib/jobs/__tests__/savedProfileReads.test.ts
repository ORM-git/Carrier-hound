import { describe, expect, it, vi } from "vitest";
import { createSavedProfileReads, loadDisplayScoreAnswers, MAX_READ_ATTEMPTS } from "../displayScore";

const PREFS = { roles: ["Frontend Engineer"], experience_level: "mid", remote_preference: "remote", locations: ["United States"], employment_types: ["full-time"] };
const PATH = "u/onboarding/r.pdf";
const PROFILE = { jobTitles: ["Data Analyst"], skills: ["SQL"], preferredRoles: [], education: [], yearsOfExperience: 2, location: null };
type Outcome = { data?: any; error?: any; throws?: boolean };

/** Fake db: each table answers from its queue of outcomes (last one repeats) and logs every read with its user id. */
function fakeDb(queues: Record<string, Outcome[]>) {
  const log: Array<{ table: string; userId: unknown }> = [];
  const from = vi.fn((table: string) => ({
    select: () => ({
      eq: (_c: string, userId: unknown) => ({
        maybeSingle: async () => {
          log.push({ table, userId });
          const q = queues[table] ?? [{ data: null }];
          const o = q.length > 1 ? q.shift()! : q[0];
          if (o.throws) throw new Error("boom");
          return { data: o.data ?? null, error: o.error ?? null };
        },
      }),
    }),
  }));
  const count = (t: string) => log.filter((l) => l.table === t).length;
  return { from, log, count };
}
const resumeOk = { onboarding_resume_profiles: [{ data: { parse_status: "parsed", source_storage_path: PATH, profile: PROFILE } }], onboarding_resume_uploads: [{ data: { storage_path: PATH } }] };

describe("createSavedProfileReads (request-local)", () => {
  it("found and missing results are read once, including concurrent callers", async () => {
    for (const data of [PREFS, null]) {
      const db = fakeDb({ user_preferences: [{ data }] });
      const r = createSavedProfileReads(db, "u");
      const all = await Promise.all([r.preferences(), r.preferences()]);
      await r.preferences();
      expect(db.count("user_preferences")).toBe(1);
      expect(all[0]).toEqual(data ? { status: "found", row: data } : { status: "missing" });
    }
  });

  it("an error is not cached as an empty profile: the next caller retries, bounded by MAX_READ_ATTEMPTS", async () => {
    const db = fakeDb({ user_preferences: [{ error: { message: "offline" } }] });
    const r = createSavedProfileReads(db, "u");
    for (let i = 0; i < 5; i++) expect((await r.preferences()).status).toBe("error");
    expect(db.count("user_preferences")).toBe(MAX_READ_ATTEMPTS);
    expect(MAX_READ_ATTEMPTS).toBe(2);
  });

  it("error then success: the recovered result is reused, never read again", async () => {
    const db = fakeDb({ user_preferences: [{ error: { message: "blip" } }, { data: PREFS }] });
    const r = createSavedProfileReads(db, "u");
    expect((await r.preferences()).status).toBe("error");
    expect(await r.preferences()).toEqual({ status: "found", row: PREFS });
    await r.preferences();
    expect(db.count("user_preferences")).toBe(2);
  });

  it("a throw becomes an error carrying the thrown value, and is retried like an error", async () => {
    const db = fakeDb({ user_preferences: [{ throws: true }, { data: PREFS }] });
    const r = createSavedProfileReads(db, "u");
    const first = await r.preferences();
    expect(first.status).toBe("error");
    expect((first as any).thrown).toBeInstanceOf(Error);
    expect((await r.preferences()).status).toBe("found");
  });

  it("resume: found once; missing and error tracked apart, error retried once", async () => {
    const ok = fakeDb(resumeOk);
    const r = createSavedProfileReads(ok, "u");
    expect((await r.resumeProfile()).status).toBe("found");
    await r.resumeProfile();
    expect(ok.count("onboarding_resume_profiles")).toBe(1);

    const none = fakeDb({});
    const rn = createSavedProfileReads(none, "u");
    expect(await rn.resumeProfile()).toEqual({ status: "missing" });
    await rn.resumeProfile();
    expect(none.count("onboarding_resume_profiles")).toBe(1);

    const bad = fakeDb({ ...resumeOk, onboarding_resume_uploads: [{ error: { message: "x" } }] });
    const rb = createSavedProfileReads(bad, "u");
    for (let i = 0; i < 4; i++) expect((await rb.resumeProfile()).status).toBe("error");
    expect(bad.count("onboarding_resume_profiles")).toBe(2);
  });

  it("separate users never share reads", async () => {
    const db = fakeDb({ user_preferences: [{ data: PREFS }] });
    const a = createSavedProfileReads(db, "user-a");
    const b = createSavedProfileReads(db, "user-b");
    await Promise.all([a.preferences(), b.preferences(), a.preferences()]);
    expect(db.log.map((l) => l.userId).sort()).toEqual(["user-a", "user-b"]);
  });
});

describe("loadDisplayScoreAnswers with shared reads", () => {
  it("flag on: display answers plus the caller's own reads cost one preference and one resume read", async () => {
    vi.stubEnv("NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED", "true");
    try {
      const db = fakeDb({ user_preferences: [{ data: PREFS }], ...resumeOk });
      const r = createSavedProfileReads(db, "u");
      const answers = await loadDisplayScoreAnswers(db, "u", undefined, r);
      await r.preferences();
      await r.resumeProfile();
      expect(answers?.roles).toEqual(PREFS.roles);
      expect(answers?.resumeProfile?.jobTitles).toEqual(["Data Analyst"]);
      expect({ prefs: db.count("user_preferences"), resume: db.count("onboarding_resume_profiles") }).toEqual({ prefs: 1, resume: 1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("without shared reads it still reads on its own (public helper unchanged); preference error still means null", async () => {
    const db = fakeDb({ user_preferences: [{ data: PREFS }] });
    expect((await loadDisplayScoreAnswers(db, "u"))?.roles).toEqual(PREFS.roles);
    expect(await loadDisplayScoreAnswers(fakeDb({ user_preferences: [{ error: { message: "x" } }] }), "u")).toBeNull();
  });
});
