import { afterEach, describe, expect, it } from "vitest";
import { loadDisplayScoreAnswers, loadPreferredSkills, sharedDisplayScore } from "../displayScore";

const fakeDb = (opts: { prefs?: Record<string, unknown>; failPreferred?: boolean }) => {
  const queries: string[] = [];
  return {
    queries,
    from: (_t: string) => ({
      select: (cols: string) => {
        queries.push(cols);
        return { eq: () => ({ maybeSingle: async () => {
          if (cols === "preferred_skills") return opts.failPreferred ? { data: null, error: { code: "42703", message: "column does not exist" } } : { data: { preferred_skills: (opts.prefs as any)?.preferred_skills }, error: null };
          return { data: { roles: ["Frontend Engineer"], experience_level: "mid", remote_preference: "any", locations: [], employment_types: [], categories: [] }, error: null };
        } }) };
      },
    }),
  } as any;
};
afterEach(() => { delete process.env.CM_PREFERRED_SKILLS_RANKING; delete process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS; });

describe("preferred skills loader", () => {
  it("flag off: no preferred-skills query at all and answers carry none", async () => {
    const db = fakeDb({ prefs: { preferred_skills: ["react"] } });
    const a = await loadDisplayScoreAnswers(db, "u1");
    expect(a?.preferredSkills).toBeUndefined();
    expect(db.queries).not.toContain("preferred_skills");
  });
  it("flag on but owner gate off: no query, no preferred skills", async () => {
    process.env.CM_PREFERRED_SKILLS_RANKING = "1";
    const db = fakeDb({ prefs: { preferred_skills: ["react"] } });
    expect(await loadPreferredSkills(db, "u1")).toEqual([]);
    expect(db.queries).not.toContain("preferred_skills");
  });
  it("flag on: normalized by the shared skill key rules; missing column or error means none, never an error", async () => {
    process.env.CM_PREFERRED_SKILLS_RANKING = "1";
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    expect(await loadPreferredSkills(fakeDb({ prefs: { preferred_skills: [" React ", "react", "Réact"] } }), "u1")).toEqual(["React", "Réact"]);
    expect(await loadPreferredSkills(fakeDb({ failPreferred: true }), "u1")).toEqual([]);
    const a = await loadDisplayScoreAnswers(fakeDb({ failPreferred: true }), "u1");
    expect(a).not.toBeNull();
    expect(a?.preferredSkills).toBeUndefined();
    expect(await loadPreferredSkills(fakeDb({}), null)).toEqual([]);
  });
  it("one answers source: card, detail and unlock compute the same score; Free (paid inputs stripped) gets no boost", async () => {
    process.env.CM_PREFERRED_SKILLS_RANKING = "1";
    process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS = "true";
    const answers = await loadDisplayScoreAnswers(fakeDb({ prefs: { preferred_skills: ["react"] } }), "u1");
    const row = { id: "j", title: "Frontend Engineer", company: "A", location: "Remote", remote: true, remote_scope: "worldwide", job_type: "full-time", category: "engineering", skills: ["React"], posted_at: "2026-11-25T00:00:00Z" };
    const now = Date.parse("2026-11-26T00:00:00Z");
    expect(sharedDisplayScore(row, answers, true, now)).toBe(sharedDisplayScore({ ...row }, answers, true, now));
    const noPref = { ...answers!, preferredSkills: undefined };
    expect(sharedDisplayScore(row, answers, false, now)).toBe(sharedDisplayScore(row, noPref, false, now));
  });
});
