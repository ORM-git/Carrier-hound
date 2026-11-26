import { describe, it, expect } from "vitest";
import { ANNUALIZATION_FACTORS, detectNormalizedPeriod, normalizeSalary } from "../normalize";
import { detectPayPeriod } from "../parser";
import { scoreJobRecommendation } from "@/lib/jobs/recommendations";

describe("normalizeSalary strict mode (default)", () => {
  it.each([
    ["yearly", "per year", 1, false],
    ["monthly", "monthly", 12, false],
    ["weekly", "per week", 52, true],
    ["daily", "/day", 260, true],
    ["hourly", "hourly", 2080, true],
  ] as const)("%s: factor and conversionAssumed per path", (period, text, factor, assumed) => {
    expect(normalizeSalary({ min: 10, max: 20, period: text, currency: "USD" })).toEqual({
      annualMin: 10 * factor, annualMax: 20 * factor, period, periodInferred: false, conversionAssumed: assumed, currency: "USD",
    });
    expect(ANNUALIZATION_FACTORS[period].factor).toBe(factor);
  });

  it.each(["per day", "/day", "daily", "a day"])("daily alias %s", (t) => expect(detectNormalizedPeriod(t)).toBe("daily"));
  it.each(["per week", "/week", "weekly", "a week"])("weekly alias %s", (t) => expect(detectNormalizedPeriod(t)).toBe("weekly"));
  it("does not change detectPayPeriod (still no daily/weekly)", () => {
    expect(detectPayPeriod("weekly")).toBeNull();
    expect(detectPayPeriod("per day")).toBeNull();
    expect(detectNormalizedPeriod("per month")).toBe("monthly");
  });

  it.each(["stipend", "per project", "per shift"])("unrecognized explicit period %s -> null + reason, never monthly/yearly", (p) => {
    const r = normalizeSalary({ min: 3000, max: 3000, period: p });
    expect(r).toMatchObject({ annualMin: null, annualMax: null, period: null, periodInferred: false, conversionAssumed: false });
    expect(r.reason).toContain("unrecognized period");
  });

  it.each([undefined, null, "", "   "])("absent period %s -> null by default", (p) => {
    const r = normalizeSalary({ min: 100000, max: 120000, period: p as any });
    expect(r).toMatchObject({ annualMin: null, annualMax: null, period: null, periodInferred: false });
    expect(r.reason).toContain("not stated");
  });

  it.each([
    [null, null], [0, 0], [-5, -1], [NaN, NaN], [Infinity, Infinity], [0, -10],
  ])("invalid amounts min=%s max=%s stay missing, never repaired", (min, max) => {
    const r = normalizeSalary({ min, max, period: "yearly" });
    expect(r.annualMin).toBeNull();
    expect(r.annualMax).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it("one invalid side is dropped, not zero-filled or copied from the other", () => {
    const r = normalizeSalary({ min: -1, max: 50000, period: "yearly" });
    expect(r).toMatchObject({ annualMin: null, annualMax: 50000 });
    expect(r.reason).toContain("invalid min");
  });

  it("min > max is rejected, never swapped", () => {
    const r = normalizeSalary({ min: 200, max: 100, period: "yearly" });
    expect(r).toMatchObject({ annualMin: null, annualMax: null });
    expect(r.reason).toContain("min greater than max");
  });
});

describe("normalizeSalary strict ambiguity guards (review of #789)", () => {
  const nulled = { annualMin: null, annualMax: null, period: null, periodInferred: false, conversionAssumed: false };

  it.each(["not hourly", "non-hourly", "no weekly", "not paid monthly"])("negated period %s -> null, reason negated", (p) => {
    const r = normalizeSalary({ min: 20, max: 30, period: p });
    expect(r).toMatchObject(nulled);
    expect(r.reason).toContain("negated");
  });

  it.each(["twice monthly", "bi-weekly", "biweekly", "semi-monthly", "semimonthly", "every two weeks", "every 2 weeks", "twice a week", "fortnightly"])(
    "qualified/unsupported frequency %s -> null, never x12/x52",
    (p) => {
      const r = normalizeSalary({ min: 2000, max: 3000, period: p });
      expect(r).toMatchObject(nulled);
      expect(r.reason).toMatch(/qualified|unsupported/);
    },
  );

  it.each(["per hour or per year", "hourly/yearly", "monthly or annual", "per week, per day"])("conflicting periods %s -> null, reason names conflict", (p) => {
    const r = normalizeSalary({ min: 50, max: 60, period: p });
    expect(r).toMatchObject(nulled);
    expect(r.reason).toContain("conflicting");
  });

  it("names both conflicting periods", () => {
    expect(normalizeSalary({ max: 50, period: "per hour or per year" }).reason).toMatch(/hourly.*yearly|yearly.*hourly/);
  });

  it.each([
    [{ min: 1, max: 1e308, period: "monthly" }],
    [{ min: 1e306, period: "hourly" }],
  ])("finite input that overflows on annualization -> null, never Infinity (%o)", (input) => {
    const r = normalizeSalary(input);
    expect(r.annualMin).toBeNull();
    expect(r.annualMax).toBeNull();
    expect(r.reason).toContain("overflow");
  });

  it.each([
    ["per month", "monthly", 12], ["$50/hr", "hourly", 2080], ["per annum", "yearly", 1], ["a week", "weekly", 52], ["Monthly", "monthly", 12],
  ] as const)("clean single period %s still annualizes", (p, period, factor) => {
    expect(normalizeSalary({ min: 10, max: 20, period: p })).toMatchObject({ annualMin: 10 * factor, annualMax: 20 * factor, period });
  });

  it("guards are strict-only: compatibility mode is unchanged", () => {
    expect(normalizeSalary({ max: 3000, period: "twice monthly" }, { compatibility: true })).toMatchObject({ annualMax: 36000, period: "monthly", periodInferred: false });
    expect(normalizeSalary({ max: 20, period: "not hourly" }, { compatibility: true })).toMatchObject({ annualMax: 41600, period: "hourly" });
  });
});

describe("normalizeSalary compatibility mode (opt-in parity with recommendations.ts)", () => {
  const compat = (max: number, period?: string) => normalizeSalary({ max, period, currency: "USD" }, { compatibility: true });

  it.each([
    [499, undefined, 499 * 2080, "hourly"],
    [500, undefined, 500 * 12, "monthly"],
    [24999, undefined, 24999 * 12, "monthly"],
    [25000, undefined, 25000, "yearly"],
  ])("absent period, amount %s -> %s (guessed %s), flagged inferred + assumed", (max, period, annual, guessed) => {
    expect(compat(max, period)).toMatchObject({ annualMax: annual, period: guessed, periodInferred: true, conversionAssumed: true });
  });

  it("explicit period is never guessed: 'stipend' 3000 stays 3000 (as today), flagged assumed", () => {
    expect(compat(3000, "stipend")).toMatchObject({ annualMax: 3000, period: null, periodInferred: true, conversionAssumed: true });
    expect(compat(3000, "weekly")).toMatchObject({ annualMax: 3000, periodInferred: true }); // today ignores weekly
  });

  it("recognized explicit periods match strict values and flags", () => {
    expect(compat(20, "hourly")).toMatchObject({ annualMax: 41600, periodInferred: false, conversionAssumed: true });
    expect(compat(3000, "monthly")).toMatchObject({ annualMax: 36000, periodInferred: false, conversionAssumed: false });
  });

  // Parity against the REAL disqualifier: it rejects iff annualMax < minSalary (USD both sides).
  const disqualified = (salary_max: number, salary_period: string | undefined, minSalary: number) =>
    scoreJobRecommendation(
      { title: "Engineer", remote: true, salary_max, salary_period, currency: "USD" } as any,
      { minSalary, salaryCurrency: "USD" },
    ).reasons.some((r) => r.startsWith("Salary mismatch"));

  it.each([
    [499, undefined], [500, undefined], [24999, undefined], [25000, undefined],
    [20, "hourly"], [3000, "monthly"], [90000, "yearly"], [3000, "stipend"], [3000, "weekly"],
  ])("parity at %s %s: disqualifier threshold equals compat annualMax", (max, period) => {
    const annual = compat(max, period).annualMax as number;
    expect(disqualified(max, period, annual)).toBe(false);
    expect(disqualified(max, period, annual + 1)).toBe(true);
  });
});
