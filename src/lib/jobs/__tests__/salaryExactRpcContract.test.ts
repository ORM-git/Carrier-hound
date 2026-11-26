// Contract fixture (PGlite, NOT live): validate-once typed thresholds + a single-statement join over a relation.
// Proves SQL semantics and equality with the BigInt rational verdict; says nothing about PostgREST, roles or cost.
import { afterEach, describe, expect, it } from "vitest";
import { annualSalaryRationals } from "../browseFilters";
// PGlite is a full WASM Postgres (~250 MB each): every instance a test opens is closed after it.
const opened: Array<{ close(): Promise<void> }> = [];
const track = <T extends { close(): Promise<void> }>(pg: T): T => (opened.push(pg), pg);
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close()));
});

const read = (f: string) => (require("fs").readFileSync(`docs/proposed/${f}`, "utf8") as string);
// Only the privilege DDL (no roles in PGlite) is dropped; schema qualification and search_path stay as canonical.
const exec = (sql: string) => sql.split("\n").filter((l) => !/^(revoke|grant)/.test(l) && !l.startsWith("--")).join("\n");
const R = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 84, CAD: 1.38, AUD: 1.52 };
const passesJs = (v: string, r: { num: string; den: string }) => {
  const [i, f = ""] = v.split(".");
  return BigInt(i + f) * BigInt(r.den) >= BigInt(r.num) * BigInt("1" + "0".repeat(f.length));
};

describe("salary exact RPC contract: validate once, join in the same statement", () => {
  const FILE = read("salary_exact_thresholds_typed.NOT_APPLIED.sql");
  it("access metadata in the tracked file (text only, not live proof)", () => {
    expect(FILE).toMatch(/set search_path = pg_catalog/);
    expect(FILE).toMatch(/revoke all on function public\.salary_thresholds_typed\(jsonb\) from public, anon, authenticated;/);
    expect(FILE).toMatch(/grant execute on function public\.salary_thresholds_typed\(jsonb\) to service_role;/);
    expect(FILE).not.toMatch(/security definer/i);
  });
  it("single statement over a relation equals the exact BigInt verdict for every row, incl. 11+ digit scales", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = track(new PGlite());
    await pg.exec(exec(FILE));
    await pg.exec("create table frozen (id serial primary key, epoch int, salary_min numeric, currency text, salary_period text)");
    const th = annualSalaryRationals(100000, "USD", R) as any[];
    const vals: Array<[string, string, string]> = [
      ["48.07692307695", "USD", "hourly"], ["48.0769230769", "USD", "hourly"], ["48.50", "USD", "hourly"], ["48.00", "USD", "hourly"],
      ["8333.33333333333333", "USD", "monthly"], ["7666.67", "EUR", "monthly"], ["7666.66", "EUR", "monthly"], ["4038.47", "INR", "hourly"],
      ["4038.46", "INR", "hourly"], ["100000", "USD", "yearly"], ["99999.99999999999999", "USD", "yearly"],
    ];
    for (const [v, c, p] of vals) await pg.query("insert into frozen(epoch,salary_min,currency,salary_period) values (1,$1,$2,$3)", [v, c, p]);
    await pg.query("insert into frozen(epoch,salary_min,currency,salary_period) values (1,null,'USD','yearly'),(1,'NaN','USD','yearly'),(1,'50','USD','weekly'),(2,'1000000','USD','yearly')");
    const q = `select f.id from frozen f join salary_thresholds_typed($1::jsonb) t on t.currency = f.currency and t.period = f.salary_period
      where f.epoch = 1 and f.salary_min is not null and f.salary_min::text not in ('NaN','Infinity','-Infinity') and f.salary_min * t.den >= t.num order by f.id`;
    const got = (await pg.query(q, [JSON.stringify(th)])).rows.map((r: any) => r.id);
    const want = vals.map(([v, c, p], i) => (passesJs(v, th.find((x) => x.currency === c && x.period === p)) ? i + 1 : 0)).filter(Boolean);
    expect(got).toEqual(want);
    expect(got).toContain(1); // 48.07692307695 (the reviewer's counterexample)
    expect(got).not.toContain(2); // 48.0769230769
  });
  it("explicit-validation RPC shape: malformed payload raises 22023 for empty relation, no-match epoch, zero limit and normal relation; validator runs once per call", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = track(new PGlite());
    // test-only instrumentation: count validator invocations by injecting a sequence bump into the canonical body
    const instrumented = exec(FILE).replace("begin\n  if p_thresholds is null", "begin\n  perform nextval('public.validator_calls');\n  if p_thresholds is null");
    expect(instrumented).not.toBe(exec(FILE));
    await pg.exec("create sequence validator_calls");
    await pg.exec(instrumented);
    await pg.exec("create table frozen (id serial primary key, epoch int, salary_min numeric, currency text, salary_period text)");
    await pg.exec(exec(read("salary_exact_rpc_contract_example.NOT_APPLIED.sql")));
    const e = (o: Record<string, unknown> = {}) => ({ currency: "USD", period: "yearly", num: "100", den: "1", ...o });
    const calls = async () => Number(((await pg.query("select last_value::int as n, is_called from validator_calls")).rows[0] as any).is_called ? ((await pg.query("select last_value::int as n from validator_calls")).rows[0] as any).n : 0);
    const run = (epoch: number, th: unknown, limit: number) => pg.query("select * from example_salary_candidates($1,$2::jsonb,$3)", [epoch, JSON.stringify(th), limit]);
    const malformed: unknown[] = [[e({ den: "NaN" })], [e({ den: "0" })], [e(), e({ num: "1", den: "9" })], [], "x", [e({ num: "1" + "0".repeat(80) })]];
    const raises = async (epoch: number, limit: number, label: string) => {
      for (const th of malformed) {
        let err: any = null;
        try { await run(epoch, th, limit); } catch (x) { err = x; }
        expect(err, `${label} ${JSON.stringify(th).slice(0, 40)}`).not.toBeNull();
        expect(err.code).toBe("22023");
      }
    };
    await raises(1, 10, "empty relation");
    await pg.query("insert into frozen(epoch,salary_min,currency,salary_period) values (1,'150','USD','yearly'),(1,'50','USD','yearly'),(2,'999','USD','yearly')");
    await raises(1, 10, "normal relation");
    await raises(99, 10, "no-match epoch");
    await raises(1, 0, "zero limit");
    // valid payloads: normal, no-match epoch, zero limit
    expect((await run(1, [e()], 10)).rows.map((r: any) => r.id)).toEqual([1]);
    expect((await run(99, [e()], 10)).rows).toEqual([]);
    expect((await run(1, [e()], 0)).rows).toEqual([]);
    // once per call: before this block the counter had value c0; three valid calls add exactly three
    const c0 = await calls();
    await run(1, [e()], 10); await run(99, [e()], 10); await run(1, [e()], 0);
    expect((await calls()) - c0).toBe(3);
    // 150 rows: validator still runs once, not once per row
    for (let i = 0; i < 150; i++) await pg.query("insert into frozen(epoch,salary_min,currency,salary_period) values (3,'150','USD','yearly')");
    const c1 = await calls();
    expect((await run(3, [e()], 1000)).rows).toHaveLength(150);
    expect((await calls()) - c1).toBe(1);
    // a negative limit is rejected, never an unbounded query
    await expect(run(1, [e()], -1)).rejects.toThrow();
  });
});
