import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { jobHasAnySkill, skillKey } from "../skillKey";

const CASES: Array<{ input: string; key: string }> = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/skill-key-cases.json"), "utf8"));
const PG_KEY = `translate(btrim(regexp_replace($1::text, E'[ \\t\\n\\r\\f\\v]+', ' ', 'g'), ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;

let db: PGlite;
beforeAll(() => { db = new PGlite(); });
afterAll(async () => { await db.close(); });

describe("skill key: JS and real Postgres agree on the shared fixture", () => {
  for (const c of CASES) {
    it(JSON.stringify(c.input), async () => {
      expect(skillKey(c.input)).toBe(c.key);
      const r = await db.query<{ k: string }>(`select ${PG_KEY} as k`, [c.input]);
      expect(r.rows[0].k).toBe(c.key);
    });
  }
  it("matching: exact key only, unknown skills are kept", () => {
    expect(jobHasAnySkill(["React", "SQL"], ["react"])).toBe(true);
    expect(jobHasAnySkill(["React Native"], ["react"])).toBe(false); // not a substring match
    expect(jobHasAnySkill([], ["react"])).toBe(false);
    expect(jobHasAnySkill(null, ["react"])).toBe(false);
    expect(jobHasAnySkill(["React"], [])).toBe(false);
  });
});

import { normalizeSkillList } from "../skillKey";
describe("saved skill lists use the same key as matching (end to end: save -> match)", () => {
  it("dedupes by key; accents, NBSP and Turkish I stay distinct, exactly as they will match", () => {
    const saved = normalizeSkillList(["React", " react ", "REACT", "Réact", "RÉACT", "React\u00a0Native", "React Native", "İstanbul", "istanbul"]);
    expect(saved).toEqual(["React", "Réact", "RÉACT", "React\u00a0Native", "React Native", "İstanbul", "istanbul"]);
    expect(jobHasAnySkill(["react"], saved)).toBe(true);
    expect(jobHasAnySkill(["REACT NATIVE"], saved)).toBe(true);
    expect(jobHasAnySkill(["réact"], saved)).toBe(true); // key("Réact") = "réact"
    expect(jobHasAnySkill(["RÉACT"], ["Réact"])).toBe(false); // non-ASCII is case-sensitive by contract
  });
  it("100-character and 50-item boundaries", () => {
    const hundred = "a".repeat(100);
    expect(normalizeSkillList([hundred + "b"])).toEqual([hundred]);
    expect(normalizeSkillList(["x".repeat(99) + "😀"])[0].length).toBe(99); // no lone surrogate
    expect(normalizeSkillList(Array.from({ length: 80 }, (_, i) => `s${i}`)).length).toBe(50);
    expect(normalizeSkillList(["", "   ", 5, null, "ok"] as unknown[])).toEqual(["ok"]);
  });
});
