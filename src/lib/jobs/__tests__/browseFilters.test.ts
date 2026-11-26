import { describe, expect, it } from "vitest";
import {
  annualSalaryThresholds,
  appendBrowseFilterParams,
  applyBrowseFilters,
  browseFilterIdentity,
  browseFiltersActive,
  hasBrowseFilters,
  isBrowseFilterError,
  mergeBrowseConstraints,
  parseBrowseFilters,
} from "../browseFilters";
import { normalizeFeedConstraints } from "@/lib/preferences/feedConstraints";

const RATES = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 84, CAD: 1.38, AUD: 1.52 };
const parse = (qs: string) => parseBrowseFilters(new URLSearchParams(qs));

describe("parseBrowseFilters: validation (never silent dropping)", () => {
  it("empty = no-op", () => {
    const f = parse("");
    expect(isBrowseFilterError(f)).toBe(false);
    expect(browseFiltersActive(f as any)).toBe(false);
    expect(browseFiltersActive(parse("jobFunction=&minAnnualSalary=") as any)).toBe(false);
  });
  it("jobFunction: canonical role categories, case-insensitive, deduplicated", () => {
    expect(parse("jobFunction=sde&jobFunction=AI_ML&jobFunction=Sde")).toEqual({ jobFunctions: ["SDE", "AI_ML"], minAnnualSalary: null, minAnnualSalaryCurrency: null });
  });
  it("unknown jobFunction is a 400 body naming the field", () => {
    expect(parse("jobFunction=SDE&jobFunction=marketing")).toEqual({ error: "invalid_filter", field: "jobFunctions", reason: 'unknown value "marketing"' });
    expect(isBrowseFilterError(parse("jobFunction=engineering"))).toBe(true); // a broad category is not a role category
  });
  it("salary: positive integer with a supported currency", () => {
    expect(parse("minAnnualSalary=120000&minAnnualSalaryCurrency=usd")).toMatchObject({ minAnnualSalary: 120000, minAnnualSalaryCurrency: "USD" });
    for (const [qs, field] of [
      ["minAnnualSalary=120000", "minAnnualSalaryCurrency"],
      ["minAnnualSalaryCurrency=USD", "minAnnualSalaryCurrency"],
      ["minAnnualSalary=12.5&minAnnualSalaryCurrency=USD", "minAnnualSalary"],
      ["minAnnualSalary=-5&minAnnualSalaryCurrency=USD", "minAnnualSalary"],
      ["minAnnualSalary=0&minAnnualSalaryCurrency=USD", "minAnnualSalary"],
      ["minAnnualSalary=999999999&minAnnualSalaryCurrency=USD", "minAnnualSalary"],
      ["minAnnualSalary=100000&minAnnualSalaryCurrency=JPY", "minAnnualSalaryCurrency"],
    ]) {
      expect(parse(qs)).toMatchObject({ error: "invalid_filter", field });
    }
  });
});

describe("predicates", () => {
  const recorder = () => {
    const calls: unknown[][] = [];
    const q: any = { in: (...a: unknown[]) => (calls.push(["in", ...a]), q), or: (...a: unknown[]) => (calls.push(["or", ...a]), q) };
    return { q, calls };
  };
  it("jobFunctions: one IN over role_category (OR inside, never broad category)", () => {
    const { q, calls } = recorder();
    applyBrowseFilters(q, parse("jobFunction=SDE&jobFunction=DATA") as any, RATES);
    expect(calls).toEqual([["in", "role_category", ["SDE", "DATA"]]]);
  });
  it("salary thresholds: converted per currency, annualized per period, rounded up", () => {
    const t = annualSalaryThresholds(100000, "USD", RATES);
    expect(t).toContainEqual({ currency: "USD", period: "yearly", minSalary: 100000 });
    expect(t).toContainEqual({ currency: "INR", period: "yearly", minSalary: 8400000 });
    expect(t).toContainEqual({ currency: "INR", period: "monthly", minSalary: 700000 });
    expect(t).toContainEqual({ currency: "USD", period: "hourly", minSalary: 49 }); // 48.07.. rounds up
    expect(t).toHaveLength(18);
  });
  it("salary clause: one or() of currency+period groups; nothing for absent salary", () => {
    const { q, calls } = recorder();
    applyBrowseFilters(q, parse("minAnnualSalary=100000&minAnnualSalaryCurrency=USD") as any, RATES);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][1])).toContain("and(currency.eq.INR,salary_period.eq.yearly,salary_min.gte.8400000)");
    const none = recorder();
    applyBrowseFilters(none.q, parse("") as any, RATES);
    expect(none.calls).toEqual([]);
  });
});

describe("client transport", () => {
  it("serializes jobFunction as repeated params and salary as a pair", () => {
    const p = new URLSearchParams();
    appendBrowseFilterParams(p, { jobFunctions: ["sde", " DATA ", "SDE", ""], minAnnualSalary: 90000.7, minAnnualSalaryCurrency: "eur" });
    expect(p.getAll("jobFunction")).toEqual(["SDE", "DATA"]);
    expect(p.get("minAnnualSalary")).toBe("90000");
    expect(p.get("minAnnualSalaryCurrency")).toBe("EUR");
  });
  it("browse title/company lists merge with saved ones (union, case-insensitive)", () => {
    const saved = normalizeFeedConstraints({ excludedTitles: ["Sales"], excludedCompanies: ["Acme"] });
    const m = mergeBrowseConstraints(saved, { excludedTitles: ["sales", "Intern"], includedCompanies: ["Globex"] });
    expect(m).toMatchObject({ excludedTitles: ["Sales", "Intern"], includedCompanies: ["Globex"], excludedCompanies: ["Acme"] });
  });
  it("hasBrowseFilters: empty lists and blanks are a no-op", () => {
    expect(hasBrowseFilters(null)).toBe(false);
    expect(hasBrowseFilters({ jobFunctions: [], excludedTitles: [" "], minAnnualSalary: 0 })).toBe(false);
    expect(hasBrowseFilters({ excludedCompanies: ["Acme"] })).toBe(true);
  });
  it("query identity: order/case-insensitive, empty = '', any predicate change resets", () => {
    expect(browseFilterIdentity({})).toBe("");
    const a = browseFilterIdentity({ jobFunctions: ["SDE", "DATA"], excludedTitles: ["Sales"] });
    expect(browseFilterIdentity({ jobFunctions: ["data", "sde"], excludedTitles: ["sales "] })).toBe(a);
    const variants = [
      { jobFunctions: ["SDE"], excludedTitles: ["Sales"] },
      { jobFunctions: ["SDE", "DATA"], excludedTitles: ["Sales", "Intern"] },
      { jobFunctions: ["SDE", "DATA"], excludedTitles: ["Sales"], includedCompanies: ["Acme"] },
      { jobFunctions: ["SDE", "DATA"], excludedTitles: ["Sales"], excludedCompanies: ["Acme"] },
      { jobFunctions: ["SDE", "DATA"], excludedTitles: ["Sales"], minAnnualSalary: 1, minAnnualSalaryCurrency: "USD" },
      { jobFunctions: ["SDE", "DATA"], excludedTitles: ["Sales"], minAnnualSalary: 1, minAnnualSalaryCurrency: "INR" },
    ];
    for (const v of variants) expect(browseFilterIdentity(v)).not.toBe(a);
  });
});
