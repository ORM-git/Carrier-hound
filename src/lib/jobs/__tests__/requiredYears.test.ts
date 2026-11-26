import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseYearsOfExperience, matchesRequiredYears, buildRequiredYearsClause, normalizeRequiredYearsRange, rangeFromSliderHandles, isRequiredYearsRangeActive } from "../requiredYears";
import { matchesPostgrestOr } from "./postgrestLogicTree";

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/required-years-cases.json"), "utf8"));

describe("extractor matches the shared fixture (the Python normalizer reads the same file)", () => {
  for (const c of CASES) {
    it(JSON.stringify(c.text).slice(0, 60), () => {
      const b = parseYearsOfExperience(c.text);
      expect([b?.min_experience_years ?? null, b?.max_experience_years ?? null]).toEqual([c.min_experience_years, c.max_experience_years]);
    });
  }
});

const J = (min: number | null, max: number | null) => ({ min_experience_years: min, max_experience_years: max });
describe("range selection", () => {
  const sel = { min: 0, max: 2 };
  it("inclusive overlap, unknown kept", () => {
    expect(matchesRequiredYears(J(2, 4), sel)).toBe(true);
    expect(matchesRequiredYears(J(3, null), sel)).toBe(false);
    expect(matchesRequiredYears(J(null, 1), sel)).toBe(true);
    expect(matchesRequiredYears(J(null, null), sel)).toBe(true);
  });
  it("0..top is inactive; upper at top is unbounded without forcing lower to 11", () => {
    expect(isRequiredYearsRangeActive(rangeFromSliderHandles(0, 11))).toBe(false);
    expect(rangeFromSliderHandles(3, 11)).toEqual({ min: 3, max: null });
    expect(rangeFromSliderHandles(11, 11)).toEqual({ min: 11, max: null });
    expect(matchesRequiredYears(J(1, 2), { min: 3, max: null })).toBe(false);
    expect(matchesRequiredYears(J(8, null), { min: 3, max: null })).toBe(true);
  });
  it("rejects non-finite, negative and inverted input", () => {
    expect(normalizeRequiredYearsRange({ min: NaN, max: Infinity })).toEqual({ min: null, max: null });
    expect(normalizeRequiredYearsRange({ min: -1, max: 3 })).toEqual({ min: null, max: 3 });
    expect(normalizeRequiredYearsRange({ min: 5, max: 2 })).toEqual({ min: null, max: null });
    expect(buildRequiredYearsClause({ min: NaN, max: null })).toBeNull();
  });
  it("server clause selects the same jobs as the client predicate", () => {
    const jobs = [J(2, 4), J(3, null), J(null, 1), J(null, null), J(0, 0), J(5, 8), J(null, 6), J(1, null)];
    for (const s of [{ min: 0, max: 2 }, { min: 3, max: null }, { min: 2, max: 5 }, { min: 11, max: null }, { min: null, max: 1 }]) {
      const clause = buildRequiredYearsClause(s)!;
      for (const j of jobs) expect(matchesPostgrestOr(clause, j), JSON.stringify([s, j])).toBe(matchesRequiredYears(j, s));
    }
  });
});
