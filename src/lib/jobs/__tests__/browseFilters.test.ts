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
    expect(parse("jobFunction=sde&jobFunction=AI_ML&jobFunction=Sde")).toEqual({ jobFunctions: ["SDE", "AI_ML"], minAnnualSalary: null, minAnnualSalaryCurrency: null, fxRates: null });
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
  it("salary thresholds: converted per currency, annualized per period, exact decimal strings", () => {
    const t = annualSalaryThresholds(100000, "USD", RATES);
    expect(t).toContainEqual({ currency: "USD", period: "yearly", minSalary: "100000" });
    expect(t).toContainEqual({ currency: "INR", period: "yearly", minSalary: "8400000" });
    expect(t).toContainEqual({ currency: "INR", period: "monthly", minSalary: "700000" });
    expect(t).toContainEqual({ currency: "USD", period: "hourly", minSalary: "48.076923077" }); // exact, rounded up at 1e-10 (was 49)
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
    expect(p.get("minAnnualSalary")).toBe("90000.7"); // verbatim: the server 400s a fraction
    expect(p.get("minAnnualSalaryCurrency")).toBe("EUR");
  });
  it("browse title/company lists merge with saved ones (union, case-insensitive)", () => {
    const saved = normalizeFeedConstraints({ excludedTitles: ["Sales"], excludedCompanies: ["Acme"] });
    const m = mergeBrowseConstraints(saved, { excludedTitles: ["sales", "Intern"], includedCompanies: ["Globex"] });
    expect(m).toMatchObject({ excludedTitles: ["Sales", "Intern"], includedCompanies: ["Globex"], excludedCompanies: ["Acme"] });
  });
  it("hasBrowseFilters: empty lists and blanks are a no-op (zero is not blank: it is a 400)", () => {
    expect(hasBrowseFilters(null)).toBe(false);
    expect(hasBrowseFilters({ jobFunctions: [], excludedTitles: [" "], minAnnualSalary: null, minAnnualSalaryCurrency: "" })).toBe(false);
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

// --- Repair (2026-11-26): never drop/floor salary input; exact decimal thresholds; pinned FX -------------
describe("salary input is never dropped or altered on the client", () => {
  it("negative, zero, fractional and non-finite values are serialized verbatim (the server 400s them)", () => {
    for (const [v, s] of [[-5, "-5"], [0, "0"], [100000.9, "100000.9"], [NaN, "NaN"], [Infinity, "Infinity"]] as const) {
      const p = new URLSearchParams();
      appendBrowseFilterParams(p, { minAnnualSalary: v, minAnnualSalaryCurrency: "usd" });
      expect(p.get("minAnnualSalary")).toBe(s);
      expect(hasBrowseFilters({ minAnnualSalary: v, minAnnualSalaryCurrency: "usd" })).toBe(true); // routes to the server
    }
  });
  it("lone currency is sent (server 400: sent without minAnnualSalary); blank/absent stays a no-op", () => {
    const p = new URLSearchParams();
    appendBrowseFilterParams(p, { minAnnualSalaryCurrency: "usd" });
    expect(p.get("minAnnualSalaryCurrency")).toBe("USD");
    expect(hasBrowseFilters({ minAnnualSalaryCurrency: "usd" })).toBe(true);
    expect(hasBrowseFilters({ minAnnualSalary: null, minAnnualSalaryCurrency: " " })).toBe(false);
  });
  it("identity keeps full precision (no floor)", () => {
    expect(browseFilterIdentity({ minAnnualSalary: 100000.9, minAnnualSalaryCurrency: "USD" })).not.toBe(
      browseFilterIdentity({ minAnnualSalary: 100000, minAnnualSalaryCurrency: "USD" })
    );
  });
  it("server: integer-only contract, every invalid form is an explicit 400", () => {
    for (const v of ["-5", "0", "100000.9", "NaN", "Infinity", "1e5"]) {
      expect(parse(`minAnnualSalary=${encodeURIComponent(v)}&minAnnualSalaryCurrency=USD`)).toMatchObject({ error: "invalid_filter", field: "minAnnualSalary" });
    }
  });
});

describe("decimal-safe thresholds", () => {
  it("hourly/monthly thresholds are exact decimals, never rounded up to whole units", () => {
    const t = annualSalaryThresholds(100000, "USD", RATES);
    const at = (currency: string, period: string) => t.find((x) => x.currency === currency && x.period === period)!.minSalary;
    expect(at("USD", "yearly")).toBe("100000");
    expect(at("USD", "hourly")).toBe("48.076923077"); // 100000/2080 rounded up at 1e-10, not 49
    expect(at("USD", "monthly")).toBe("8333.3333333334");
    expect(at("INR", "yearly")).toBe("8400000");
    expect(at("EUR", "monthly")).toBe("7666.6666666667");
  });
});

describe("FX pinned within a continuation", () => {
  it("fxRates round-trips through the transport and the parser", () => {
    const p = new URLSearchParams("minAnnualSalary=100000&minAnnualSalaryCurrency=USD");
    appendBrowseFilterParams(p, { fxRates: RATES });
    expect(parseBrowseFilters(p)).toMatchObject({ fxRates: RATES });
  });
  it("malformed or incomplete fxRates is a 400, never ignored", () => {
    for (const v of ["USD:1", "USD:1,EUR:0.92,GBP:0.79,INR:-84,CAD:1.38,AUD:1.52", "USD:1,EUR:x,GBP:0.79,INR:84,CAD:1.38,AUD:1.52", "garbage"]) {
      expect(parse(`minAnnualSalary=100000&minAnnualSalaryCurrency=USD&fxRates=${encodeURIComponent(v)}`)).toMatchObject({ error: "invalid_filter", field: "fxRates" });
    }
  });
});
