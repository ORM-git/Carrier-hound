import { describe, expect, it } from "vitest";
import {
  annualSalaryThresholds,
  annualSalaryRationals,
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

describe("annualSalaryRationals (exact, no rounding)", () => {
  const R = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 84, CAD: 1.38, AUD: 1.52 };
  const find = (cur: string, period: string) => (annualSalaryRationals(100000, "USD", R) as any[]).find((x) => x.currency === cur && x.period === period)!;
  // exact test: stored decimal string v passes iff v * den >= num (BigInt, any scale)
  const passes = (v: string, r: { num: string; den: string }) => {
    const [i, f = ""] = v.split(".");
    return BigInt(i + f) * BigInt(r.den) >= BigInt(r.num) * BigInt("1" + "0".repeat(f.length));
  };
  it("terminating and non-terminating thresholds are exact", () => {
    expect(find("USD", "yearly")).toEqual({ currency: "USD", period: "yearly", num: "100000", den: "1" });
    expect(BigInt(find("USD", "hourly").num) * BigInt(2080)).toBe(BigInt(100000) * BigInt(find("USD", "hourly").den));
  });
  it("the reviewer's 48.07692307695 counterexample passes; rounded-down 48.0769230769 fails; 48.50 passes, 48.00 fails", () => {
    const h = find("USD", "hourly");
    expect(passes("48.07692307695", h)).toBe(true);
    expect(passes("48.0769230769", h)).toBe(false);
    expect(passes("48.50", h)).toBe(true);
    expect(passes("48.00", h)).toBe(false);
    expect(passes("48.076923076923076923", h)).toBe(false); // 100000/2080 = 48.07692307692307..., this is below
    expect(passes("48.0769230769230770", h)).toBe(true);
  });
  it("cross-currency exact (EUR 0.92, INR 84)", () => {
    expect(passes("7666.67", find("EUR", "monthly"))).toBe(true);
    expect(passes("7666.66", find("EUR", "monthly"))).toBe(false);
    expect(passes("4038.47", find("INR", "hourly"))).toBe(true);
    expect(passes("4038.46", find("INR", "hourly"))).toBe(false);
  });
});

describe("exact numeric predicate fixture (PGlite, unconstrained numeric; SQL is a NOT APPLIED proposal)", () => {
  const SQL_FILE = require("fs").readFileSync("docs/proposed/salary_exact_predicate.NOT_APPLIED.sql", "utf8") as string;
  // PGlite has no roles: the grant/revoke lines are asserted on the file text, then stripped for execution.
  const SQL = SQL_FILE.split("\n").filter((l) => !/^(revoke|grant)/.test(l) && !l.startsWith("--")).join("\n").replace(/public\./g, "").replace(/set search_path = pg_catalog\n/, "");
  const R = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 84, CAD: 1.38, AUD: 1.52 };
  const passesJs = (v: string, r: { num: string; den: string }) => {
    const [i, f = ""] = v.split(".");
    return BigInt(i + f) * BigInt(r.den) >= BigInt(r.num) * BigInt("1" + "0".repeat(f.length));
  };
  it("Postgres numeric verdict equals the exact BigInt verdict on boundary and random values of any scale", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    await pg.exec(SQL);
    await pg.exec("create table jobs (id serial primary key, salary_min numeric, currency text, salary_period text)");
    const th = annualSalaryRationals(100000, "USD", R) as any[];
    const thJson = JSON.stringify(th);
    const cases: Array<[string, string, string]> = [
      ["48.07692307695", "USD", "hourly"], ["48.0769230769", "USD", "hourly"], ["48.076923077", "USD", "hourly"],
      ["48.0769230769230769230769", "USD", "hourly"], ["48.50", "USD", "hourly"], ["48.00", "USD", "hourly"],
      ["8333.33333333333333", "USD", "monthly"], ["8333.333333333333333", "USD", "monthly"], ["7666.67", "EUR", "monthly"], ["7666.66", "EUR", "monthly"],
    ];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 200; i++) {
      const scale = Math.floor(rnd() * 16);
      const v = (48.0769 + (rnd() - 0.5) * 1e-4).toFixed(Math.max(scale, 4));
      cases.push([v, "USD", "hourly"]);
    }
    let boundaryFlips = 0;
    for (const [v, cur, per] of cases) {
      const r = th.find((x) => x.currency === cur && x.period === per)!;
      const row = await pg.query("select salary_meets_threshold($1::numeric, $2, $3, $4::jsonb) as ok", [v, cur, per, thJson]);
      expect((row.rows[0] as any).ok).toBe(passesJs(v, r));
      // the old 1e-10 ceil comparison, for contrast
      const ceil = annualSalaryThresholds(100000, "USD", R).find((x) => x.currency === cur && x.period === per)!.minSalary;
      const old = await pg.query("select $1::numeric >= $2::numeric as ok", [v, ceil]);
      if ((old.rows[0] as any).ok !== passesJs(v, r)) boundaryFlips++;
    }
    expect(boundaryFlips).toBeGreaterThan(0); // the ceil comparison really had false exclusions the exact predicate fixes
    // pinned reviewer cases
    for (const [v, want] of [["48.07692307695", true], ["48.0769230769", false]] as const) {
      const r = (await pg.query("select salary_meets_threshold($1::numeric,'USD','hourly',$2::jsonb) as ok", [v, thJson])).rows[0] as any;
      expect(r.ok).toBe(want);
    }
    // set-returning use over a relation, with null salary and unmatched period never passing
    await pg.query("insert into jobs(salary_min,currency,salary_period) values (48.07692307695,'USD','hourly'),(48.0769230769,'USD','hourly'),(null,'USD','hourly'),(48.5,'USD','weekly')");
    const ids = (await pg.query("select id from jobs j where salary_meets_threshold(j.salary_min, j.currency, j.salary_period, $1::jsonb) order by id", [thJson])).rows.map((x: any) => x.id);
    expect(ids).toEqual([1]);
  });
  it("tracked file carries the access metadata: pg_catalog search_path, revoked from public/anon/authenticated, service_role only", () => {
    expect(SQL_FILE).toMatch(/set search_path = pg_catalog/);
    expect(SQL_FILE).toMatch(/revoke all on function public\.salary_meets_threshold\(numeric, text, text, jsonb\) from public, anon, authenticated;/);
    expect(SQL_FILE).toMatch(/grant execute on function public\.salary_meets_threshold\(numeric, text, text, jsonb\) to service_role;/);
    expect(SQL_FILE).not.toMatch(/security definer/i);
  });
  it("SQL lists equal the TypeScript constants (currencies, periods, 18 entries, 80 digits)", () => {
    const cur = /e ->> 'currency'\) in \(([^)]*)\)/.exec(SQL_FILE)![1].match(/'([A-Z]+)'/g)!.map((x) => x.replace(/'/g, ""));
    const per = /e ->> 'period'\) in \(([^)]*)\)/.exec(SQL_FILE)![1].match(/'([a-z]+)'/g)!.map((x) => x.replace(/'/g, ""));
    const ts = annualSalaryRationals(100000, "USD", R) as any[];
    expect(Array.from(new Set(ts.map((x) => x.currency))).sort()).toEqual([...cur].sort());
    expect(Array.from(new Set(ts.map((x) => x.period))).sort()).toEqual([...per].sort());
    expect(ts.length).toBe(cur.length * per.length);
    expect(SQL_FILE).toContain("n > 18");
    expect(SQL_FILE).toContain("{0,79}");
  });
  it("salary: NULL, NaN, +/-Infinity are false; unknown currency/period are false", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    await pg.exec(SQL);
    const call = async (sal: string | null, cur: string, per: string, th: unknown) =>
      ((await pg.query("select salary_meets_threshold($1::numeric,$2,$3,$4::jsonb) as ok", [sal, cur, per, JSON.stringify(th)])).rows[0] as any).ok;
    const good = [{ currency: "USD", period: "yearly", num: "100", den: "1" }];
    expect(await call("100", "USD", "yearly", good)).toBe(true);
    expect(await call("99.99999999999999999999", "USD", "yearly", good)).toBe(false);
    for (const s of ["NaN", "Infinity", "-Infinity", null]) expect(await call(s, "USD", "yearly", good)).toBe(false);
    expect(await call("1e9", "XXX", "yearly", good)).toBe(false);
    expect(await call("1e9", "USD", "hourly", good)).toBe(false);
  });
  it("whole payload is validated before evaluation: every malformed shape raises 22023, never passes", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    await pg.exec(SQL);
    const e = (o: Record<string, unknown> = {}) => ({ currency: "USD", period: "yearly", num: "100", den: "1", ...o });
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ currency: ["USD", "EUR", "GBP", "INR", "CAD", "AUD"][i % 6], period: ["hourly", "monthly", "yearly"][Math.floor(i / 6) % 3], num: "100", den: "1" }));
    const bad: Array<[string, unknown]> = [
      ["nonarray object", e()], ["string", "x"], ["null json", null], ["empty array", []], ["19 entries", [...entries(18), e({ currency: "USD", period: "hourly" })]],
      ["den NaN", [e({ den: "NaN" })]], ["den Infinity", [e({ den: "Infinity" })]], ["num Infinity", [e({ num: "Infinity" })]],
      ["den zero", [e({ den: "0" })]], ["num zero", [e({ num: "0" })]], ["negative", [e({ num: "-5" })]], ["plus sign", [e({ num: "+5" })]],
      ["decimal", [e({ num: "1.5" })]], ["exponent", [e({ num: "1e5" })]], ["leading zero", [e({ num: "0100" })]], ["empty", [e({ num: "" })]],
      ["81 digits", [e({ num: "1" + "0".repeat(80) })]], ["number not string", [e({ num: 100 })]], ["den number", [e({ den: 1 })]],
      ["unknown currency", [e({ currency: "XXX" })]], ["unknown period", [e({ period: "weekly" })]], ["currency number", [e({ currency: 1 })]],
      ["missing num", [{ currency: "USD", period: "yearly", den: "1" }]], ["entry not object", ["x"]], ["entry null", [null]],
      ["identical duplicate", [e(), e()]], ["conflicting duplicate", [e(), e({ num: "1", den: "1000" })]],
    ];
    for (const [name, th] of bad) {
      let err: any = null;
      try { await pg.query("select salary_meets_threshold(100000::numeric,'USD','yearly',$1::jsonb)", [JSON.stringify(th)]); } catch (x) { err = x; }
      expect(err, name).not.toBeNull();
      expect(String(err.code ?? err.message), name).toMatch(/22023|must be|malformed|duplicate/);
    }
    // 80 digits and 18 entries are accepted
    expect(((await pg.query("select salary_meets_threshold(1::numeric,'USD','yearly',$1::jsonb) as ok", [JSON.stringify([e({ num: "1" + "0".repeat(79), den: "1" + "0".repeat(79) })])])).rows[0] as any).ok).toBe(true);
    expect(((await pg.query("select salary_meets_threshold(1000::numeric,'USD','yearly',$1::jsonb) as ok", [JSON.stringify(entries(18))])).rows[0] as any).ok).toBe(true);
  });
});

describe("annualSalaryRationals preconditions", () => {
  const R = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 84, CAD: 1.38, AUD: 1.52 };
  it("rejects bad amount, currency and rates with a typed error, never a throw", () => {
    for (const [min, cur, rates] of [
      [NaN, "USD", R], [Infinity, "USD", R], [-5, "USD", R], [0, "USD", R], [1.5, "USD", R], [1e12, "USD", R], [100000, "XXX", R],
      [100000, "USD", { ...R, INR: Infinity }], [100000, "USD", { ...R, INR: NaN }], [100000, "USD", { ...R, INR: 0 }], [100000, "USD", { ...R, INR: -84 }],
      [100000, "USD", { ...R, INR: 1e300 }], [100000, "USD", { ...R, INR: 1e-300 }], [100000, "USD", { ...R, USD: 0 }], [100000, "USD", { USD: 1 } as any],
    ] as Array<[number, string, any]>) {
      expect(annualSalaryRationals(min, cur, rates)).toMatchObject({ error: "invalid_filter" });
    }
  });
  it("valid input: 18 reduced entries, no zero/negative, bounded digits, no duplicates", () => {
    const r = annualSalaryRationals(100000, "USD", R) as any[];
    expect(r).toHaveLength(18);
    expect(new Set(r.map((x) => x.currency + x.period)).size).toBe(18);
    for (const x of r) { expect(BigInt(x.num) > BigInt(0)).toBe(true); expect(BigInt(x.den) > BigInt(0)).toBe(true); expect(x.num.length).toBeLessThanOrEqual(80); expect(x.den.length).toBeLessThanOrEqual(80); }
  });
});
