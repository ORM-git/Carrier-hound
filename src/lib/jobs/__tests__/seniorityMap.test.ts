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
      level: "senior", years_min: null, years_max: null, source: "source_field", confidence: "high", years_evidence: [],
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
      years_evidence: [{ text: "You have 5+ years of experience with Go", match: "5+ years", status: "requirement" }],
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
    expect(mapJobSeniority({})).toEqual({ level: "unknown", years_min: null, years_max: null, source: "none", confidence: "low", years_evidence: [] });
    expect(mapJobSeniority({ seniority: "unknown", title: "  ", description: null }).source).toBe("source_field");
  });

  it("unparseable source value: unknown with source recorded, never a guess", () => {
    expect(mapJobSeniority({ seniority: "Mid-Senior level" })).toEqual({
      level: "unknown", years_min: null, years_max: null, source: "source_field", confidence: "low", years_evidence: [],
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
    ["5+ years experience", { years_min: 5, years_max: null }],
    ["3-5 years of experience", { years_min: 3, years_max: 5 }],
    ["3 to 5 yrs of experience", { years_min: 3, years_max: 5 }],
    ["2–4+ years of experience", { years_min: 2, years_max: 4 }],
    ["at least 7 years of experience", { years_min: 7, years_max: null }],
    ["minimum of 2 years experience", { years_min: 2, years_max: null }],
    ["4 or more years of experience", { years_min: 4, years_max: null }],
    ["5+ years of experience; ideally 5+ years of experience in Go", { years_min: 5, years_max: null }],
  ])("%s", (text, expected) => {
    expect(parseYearsOfExperience(text)).toEqual(expected);
  });

  it.each([
    ["no number here", null],
    ["", null],
    ["3+ years of experience in Python and 5+ years of experience overall", null], // disagreeing statements are ambiguous
    ["5-3 years of experience", null], // inverted range
    ["99+ years of experience", null], // out of range
    ["founded 20 years ago", null], // not an experience phrase
    ["5+ years", null], // bare years: no work-experience cue
    ["at least 7 years", null],
    ["3 to 5 yrs", null],
  ])("%s -> null", (text, expected) => {
    expect(parseYearsOfExperience(text)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// #787 repair: bounds need positive, scoped work-experience evidence; source precedence holds.
// ---------------------------------------------------------------------------------------------
import { extractYearsEvidence } from "../seniorityMap";

describe("years bounds require scoped work-experience evidence", () => {
  it.each([
    ["company age", "We have been serving customers for 5+ years."],
    ["candidate age", "Applicants must be at least 18 years old."],
    ["candidate age, of age", "Must be 21 years of age or older."],
    ["negated requirement", "No 3+ years experience required."],
    ["negated requirement, not", "3+ years of experience is not required."],
    ["negated requirement, without", "Apply even without 2+ years of experience."],
    ["bare years, no experience cue", "5+ years"],
    ["company history", "Founded 20 years ago, we have 10+ years in the industry."],
  ])("false positive (%s) -> no bounds: %s", (_label, text) => {
    expect(parseYearsOfExperience(text)).toBeNull();
    const r = mapJobSeniority({ description: text });
    expect(r.years_min).toBeNull();
    expect(r.years_max).toBeNull();
  });

  it("age clause next to a real requirement does not leak: only the experience clause counts", () => {
    expect(parseYearsOfExperience("Must be at least 18 years old. 3+ years of experience in sales.")).toEqual({ years_min: 3, years_max: null });
    expect(parseYearsOfExperience("Serving customers for 25 years; you bring 2-4 years of experience.")).toEqual({ years_min: 2, years_max: 4 });
  });

  it.each([
    ["5+ years of experience", { years_min: 5, years_max: null }],
    ["3-5 years of professional experience", { years_min: 3, years_max: 5 }],
    ["3 to 5 yrs experience", { years_min: 3, years_max: 5 }],
    ["Experience: 2–4+ years", { years_min: 2, years_max: 4 }],
    ["At least 7 years of hands-on experience", { years_min: 7, years_max: null }],
    ["Minimum of 2 years experience required", { years_min: 2, years_max: null }],
    ["4 or more years of relevant experience", { years_min: 4, years_max: null }],
    ["You are experienced, with 6+ years building APIs", { years_min: 6, years_max: null }],
    ["0-2 years of experience", { years_min: 0, years_max: 2 }],
    ["We are looking for someone with 5+ years of experience", { years_min: 5, years_max: null }],
    ["Join our team if you have 3+ years of experience", { years_min: 3, years_max: null }],
  ])("real requirement still parses: %s", (text, expected) => {
    expect(parseYearsOfExperience(text)).toEqual(expected);
    expect(mapJobSeniority({ description: text })).toMatchObject({ ...expected, source: "description" });
  });

  it.each([
    "3+ years of experience with Python and 5+ years of experience overall",
    "2-4 years of experience. Must have 6+ years of experience.",
    "No 3+ years experience required. 1+ years of experience preferred.",
    "We have 20 years of experience serving clients",
  ])("conflicting / ambiguous statements stay null and keep evidence: %s", (text) => {
    expect(parseYearsOfExperience(text)).toBeNull();
    const ev = extractYearsEvidence(text);
    expect(ev.bounds).toBeNull();
    expect(ev.evidence.length).toBeGreaterThanOrEqual(1);
    const r = mapJobSeniority({ description: text });
    expect(r.years_min).toBeNull();
    expect(r.years_max).toBeNull();
    expect(r.years_evidence).toEqual(ev.evidence);
  });

  it("evidence records why a mention was not used", () => {
    const ev = extractYearsEvidence("Must be at least 18 years old. No 3+ years experience required.");
    expect(ev.bounds).toBeNull();
    expect(ev.evidence.map((e) => e.status)).toEqual(["not_experience", "negated"]);
  });

  it("produced bounds are always nonnegative and ordered", () => {
    for (const t of ["5-3 years of experience", "-2 years of experience", "99+ years of experience"]) {
      const b = parseYearsOfExperience(t);
      if (b) {
        expect(b.years_min).toBeGreaterThanOrEqual(0);
        if (b.years_max !== null) expect(b.years_min).toBeLessThanOrEqual(b.years_max);
      }
    }
    expect(parseYearsOfExperience("5-3 years of experience")).toBeNull();
  });
});

describe("source precedence keeps every canonical source value, unknown included", () => {
  it("source unknown + 'Senior Engineer' title stays unknown from the source field", () => {
    expect(mapJobSeniority({ seniority: "unknown", title: "Senior Engineer" })).toMatchObject({
      level: "unknown", source: "source_field",
    });
    expect(mapJobSeniority({ seniority: " Unknown ", title: "Junior Developer" })).toMatchObject({
      level: "unknown", source: "source_field",
    });
  });

  it("canonical staff/director unchanged; ambiguous title inference stays unknown", () => {
    expect(mapJobSeniority({ seniority: "staff", title: "Senior Engineer" }).level).toBe("staff");
    expect(mapJobSeniority({ seniority: "director", title: "Junior Developer" }).level).toBe("director");
    expect(mapJobSeniority({ title: "Staff Engineer" })).toMatchObject({ level: "unknown", confidence: "low" });
  });
});

describe("migration 20261126a (static, NOT APPLIED)", () => {
  const sql = fs.readFileSync("supabase/migrations/20261126a_jobs_years_and_seniority_provenance.sql", "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("stays marked NOT APPLIED, nullable, no backfill, seniority enum untouched", () => {
    expect(sql).toMatch(/STATUS: NOT APPLIED/);
    expect(code).not.toMatch(/NOT NULL/i);
    expect(code).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
    expect(code).not.toMatch(/jobs_seniority_check/);
  });

  it("constraint-existence checks are scoped to public.jobs", () => {
    const checks = Array.from(code.matchAll(/IF NOT EXISTS \(([^)]*\([^)]*\)[^)]*|[^)]*)\)/g)).map((m) => m[1]);
    expect(checks.length).toBeGreaterThanOrEqual(2);
    for (const c of checks) {
      expect(c).toMatch(/pg_constraint/);
      expect(c).toMatch(/conrelid\s*=\s*'public\.jobs'::regclass/);
    }
  });

  it("validates years bounds: nonnegative and min <= max, NULL allowed", () => {
    const m = code.match(/ADD CONSTRAINT jobs_years_bounds_check\s+CHECK\s*\(([\s\S]*?)\);/);
    expect(m).not.toBeNull();
    const body = m![1].replace(/\s+/g, " ");
    expect(body).toMatch(/years_min IS NULL OR years_min >= 0/);
    expect(body).toMatch(/years_max IS NULL OR years_max >= 0/);
    expect(body).toMatch(/years_min IS NULL OR years_max IS NULL OR years_min <= years_max/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS jobs_years_bounds_check/);
  });
});

// ---------------------------------------------------------------------------------------------
// #787 repair 2: upper-bound phrases are never minimums; negative amounts are rejected, not stripped.
// ---------------------------------------------------------------------------------------------
describe("upper-bound phrases and negative amounts", () => {
  it.each([
    ["Up to 3 years of experience", 3],
    ["At most 4 years of experience", 4],
    ["Maximum 5 years experience", 5],
    ["Maximum of 2 years of experience", 2],
    ["Max 6 years experience", 6],
    ["No more than 3 years of experience", 3],
  ])("inclusive upper bound is kept as a max only: %s", (text, max) => {
    expect(parseYearsOfExperience(text)).toEqual({ years_min: null, years_max: max });
    expect(mapJobSeniority({ description: text })).toMatchObject({ years_min: null, years_max: max, source: "description" });
    expect(extractYearsEvidence(text).evidence.map((e) => e.status)).toEqual(["requirement"]);
  });

  it.each([
    "Less than 2 years of experience",
    "Fewer than 3 years of experience",
    "Under 2 years of experience",
    "Below 4 years of experience",
  ])("strict upper bound is not approximated: %s -> null with ambiguous evidence", (text) => {
    expect(parseYearsOfExperience(text)).toBeNull();
    const ev = extractYearsEvidence(text);
    expect(ev.evidence.map((e) => e.status)).toEqual(["ambiguous"]);
    const r = mapJobSeniority({ description: text });
    expect(r.years_min).toBeNull();
    expect(r.years_max).toBeNull();
  });

  it.each([
    "Up to 3+ years of experience", // contradictory upper + open-ended minimum
  ])("contradictory upper phrase -> null with evidence: %s", (text) => {
    expect(parseYearsOfExperience(text)).toBeNull();
    expect(extractYearsEvidence(text).evidence.length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    "-2 years of experience",
    "Experience: -3+ years",
    "−1 years of experience", // unicode minus
  ])("negative amount is rejected as invalid, never stripped to positive: %s", (text) => {
    expect(parseYearsOfExperience(text)).toBeNull();
    const ev = extractYearsEvidence(text);
    expect(ev.bounds).toBeNull();
    expect(ev.evidence.map((e) => e.status)).toEqual(["invalid"]);
  });

  it("upper-bound phrases never become minimum requirements anywhere", () => {
    for (const t of [
      "Up to 3 years of experience", "Less than 2 years of experience", "At most 4 years of experience",
      "Maximum 5 years experience", "Under 2 years of experience", "No more than 3 years of experience",
    ]) {
      const b = parseYearsOfExperience(t);
      expect(b?.years_min ?? null, t).toBeNull();
    }
  });

  it("an upper bound alongside a different minimum statement is a conflict -> null", () => {
    expect(parseYearsOfExperience("5+ years of experience. Up to 3 years of experience.")).toBeNull();
  });

  it.each([
    ["2 years experience", { years_min: 2, years_max: null }],
    ["3-5 years of experience", { years_min: 3, years_max: 5 }],
    ["5+ years of experience", { years_min: 5, years_max: null }],
  ])("valid forms still parse: %s", (text, expected) => {
    expect(parseYearsOfExperience(text)).toEqual(expected);
  });

  it("source unknown still wins over the title", () => {
    expect(mapJobSeniority({ seniority: "unknown", title: "Senior Engineer", description: "Up to 3 years of experience" }))
      .toMatchObject({ level: "unknown", source: "source_field", years_min: null, years_max: 3 });
  });
});
