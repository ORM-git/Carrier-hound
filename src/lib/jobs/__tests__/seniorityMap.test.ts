import { describe, it, expect } from "vitest";
import { JOB_SENIORITY_LEVELS, mapJobSeniority, parseYearsOfExperience } from "../seniorityMap";
import * as fs from "fs";

describe("JOB_SENIORITY_LEVELS", () => {
  it("is exactly the existing jobs_seniority_check enum", () => {
    const sql = fs.readFileSync("supabase/migrations/20261001_filter_upgrades.sql", "utf8");
    const m = sql.match(/jobs_seniority_check\s+CHECK \(seniority IN \(([^)]*)\)\)/);
    const dbValues = m![1].split(",").map((v) => v.trim().replace(/'/g, ""));
    expect([...JOB_SENIORITY_LEVELS]).toEqual(dbValues);
  });
});

describe("mapJobSeniority", () => {
  it("explicit canonical source field passes through at high confidence", () => {
    expect(mapJobSeniority({ seniority: "senior", title: "Backend Engineer" })).toEqual({
      level: "senior", years_min: null, years_max: null, source: "source_field", confidence: "high",
    });
  });

  it.each(["staff", "director", "lead", "entry", "mid"])("fidelity: source %s in = out, never remapped", (lvl) => {
    expect(mapJobSeniority({ seniority: lvl }).level).toBe(lvl);
    expect(mapJobSeniority({ seniority: ` ${lvl.toUpperCase()} `, title: "Engineer" }).level).toBe(lvl);
  });

  it("title-only: unambiguous existing detector outputs at medium confidence", () => {
    expect(mapJobSeniority({ title: "Senior Data Analyst" })).toMatchObject({ level: "senior", source: "title", confidence: "medium" });
    expect(mapJobSeniority({ title: "Junior Developer" })).toMatchObject({ level: "entry", source: "title", confidence: "medium" });
  });

  it("description-only: years parsed, level stays unknown at low confidence", () => {
    expect(mapJobSeniority({ description: "You have 5+ years of experience with Go." })).toEqual({
      level: "unknown", years_min: 5, years_max: null, source: "description", confidence: "low",
    });
  });

  it("years come from the description alongside an explicit level", () => {
    expect(mapJobSeniority({ seniority: "senior", description: "3-5 years of experience" })).toMatchObject({
      level: "senior", years_min: 3, years_max: 5, source: "source_field",
    });
  });

  it("conflicting signals: explicit source wins, confidence drops to medium", () => {
    expect(mapJobSeniority({ seniority: "senior", title: "Junior Developer" })).toMatchObject({
      level: "senior", source: "source_field", confidence: "medium",
    });
  });

  it("absent input: unknown, source none, low", () => {
    expect(mapJobSeniority({})).toEqual({ level: "unknown", years_min: null, years_max: null, source: "none", confidence: "low" });
    expect(mapJobSeniority({ seniority: "unknown", title: "  ", description: null }).source).toBe("source_field");
  });

  it("unparseable source value: unknown with source recorded, never a guess", () => {
    expect(mapJobSeniority({ seniority: "Mid-Senior level" })).toEqual({
      level: "unknown", years_min: null, years_max: null, source: "source_field", confidence: "low",
    });
  });

  it.each(["Staff Accountant", "Nurse", "Principal", "Account Executive", "Head of Housekeeping", "Intern"])(
    "negative fixture %s: no staff/lead/senior inference",
    (title) => {
      const r = mapJobSeniority({ title, description: title === "Principal" ? "Principal of a K-12 public school district." : "" });
      expect(r.level).toBe("unknown");
      expect(r.confidence).toBe("low");
    },
  );

  it("Staff Engineer / Engineering Director: existing detector says 'lead' (ambiguous), so unknown, never staff/director by guess", () => {
    expect(mapJobSeniority({ title: "Staff Engineer" }).level).toBe("unknown");
    expect(mapJobSeniority({ title: "Engineering Director" }).level).toBe("unknown");
    // The source field is the only way to staff/director.
    expect(mapJobSeniority({ seniority: "staff", title: "Staff Engineer" })).toMatchObject({ level: "staff", confidence: "high" });
    expect(mapJobSeniority({ seniority: "director", title: "Engineering Director" })).toMatchObject({ level: "director", confidence: "high" });
  });

  it("negative control: no guessed input (title/description/non-canonical source) can reach high confidence", () => {
    const guessed = [
      { title: "Senior Engineer" },
      { title: "Junior Engineer", description: "1-2 years" },
      { description: "10+ years of experience" },
      { seniority: "Senior Level", title: "Senior Engineer" },
      { seniority: "SR", title: "Engineer" },
    ];
    for (const input of guessed) expect(mapJobSeniority(input).confidence, JSON.stringify(input)).not.toBe("high");
  });
});

describe("parseYearsOfExperience", () => {
  it.each([
    ["5+ years", { years_min: 5, years_max: null }],
    ["3-5 years of experience", { years_min: 3, years_max: 5 }],
    ["3 to 5 yrs", { years_min: 3, years_max: 5 }],
    ["2–4+ years", { years_min: 2, years_max: 4 }],
    ["at least 7 years", { years_min: 7, years_max: null }],
    ["minimum of 2 years", { years_min: 2, years_max: null }],
    ["4 or more years", { years_min: 4, years_max: null }],
    ["5+ years; we want 5+ years of Go", { years_min: 5, years_max: null }],
  ])("%s", (text, expected) => {
    expect(parseYearsOfExperience(text)).toEqual(expected);
  });

  it.each([
    ["no number here", null],
    ["", null],
    ["3+ years Python and 5+ years overall", null], // disagreeing statements are ambiguous
    ["5-3 years", null], // inverted range
    ["99+ years", null], // out of range
    ["founded 20 years ago", null], // not an experience phrase
  ])("%s -> null", (text, expected) => {
    expect(parseYearsOfExperience(text)).toBe(expected);
  });
});
