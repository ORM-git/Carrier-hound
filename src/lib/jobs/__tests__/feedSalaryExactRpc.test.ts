// Contract fixture (PGlite, NOT live) for docs/proposed/feed_salary_exact_rpc.NOT_APPLIED.sql on top of the #796
// typed-threshold validator. Proves SQL semantics only; says nothing about PostgREST, roles, live data or cost.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { annualSalaryRationals } from "../browseFilters";
// PGlite is a full WASM Postgres (~250 MB each): every instance a test opens is closed after it.
const opened: Array<{ close(): Promise<void> }> = [];
const track = <T extends { close(): Promise<void> }>(pg: T): T => (opened.push(pg), pg);
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close()));
});

const read = (f: string) => fs.readFileSync(`docs/proposed/${f}`, "utf8");
// PGlite has no roles: only the privilege DDL and comment lines are dropped; everything else runs as written.
const exec = (sql: string) => sql.split("\n").filter((l) => !/^(revoke|grant)/.test(l) && !l.startsWith("--")).join("\n");
const TYPED = read("salary_exact_thresholds_typed.NOT_APPLIED.sql");
const RPC = read("feed_salary_exact_rpc.NOT_APPLIED.sql");
const R = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 84, CAD: 1.38, AUD: 1.52 };
const TH = annualSalaryRationals(100000, "USD", R) as any[];
const E1 = "00000000-0000-4000-8000-000000000001";
const E2 = "00000000-0000-4000-8000-000000000002";
const uuid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const passesJs = (v: string, r: { num: string; den: string }) => {
  const [i, f = ""] = v.split(".");
  return BigInt(i + f) * BigInt(r.den) >= BigInt(r.num) * BigInt("1" + "0".repeat(f.length));
};
// The six malformed payload shapes of the #796 contract fixture.
const e = (o: Record<string, unknown> = {}) => ({ currency: "USD", period: "yearly", num: "100", den: "1", ...o });
const MALFORMED: unknown[] = [[e({ den: "NaN" })], [e({ den: "0" })], [e(), e({ num: "1", den: "9" })], [], "x", [e({ num: "1" + "0".repeat(80) })]];

async function db(instrument = false) {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = track(new PGlite());
  await pg.exec(`
    create table public.jobs (id uuid primary key, title text, currency text, salary_period text, salary_min numeric);
    create table public.feed_corpus_frozen (id uuid, title text, currency text, salary_period text, salary_min numeric, epoch uuid);`);
  let typed = exec(TYPED);
  if (instrument) {
    await pg.exec("create sequence public.validator_calls");
    const bumped = typed.replace("begin\n  if p_thresholds is null", "begin\n  perform nextval('public.validator_calls');\n  if p_thresholds is null");
    expect(bumped).not.toBe(typed); // the instrumentation really landed in the canonical body
    typed = bumped;
  }
  await pg.exec(typed);
  await pg.exec(exec(RPC));
  return pg;
}
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (x: any) { return x.code ?? String(x); } };
const counter = async (pg: any) => {
  const r = (await pg.query("select last_value::int as n, is_called from public.validator_calls")).rows[0] as any;
  return r.is_called ? r.n : 0;
};

describe("feed_frozen_salary_rows / jobs_salary_rows (exact salary join over the frozen corpus)", () => {
  it("tracked file: NOT APPLIED, service_role only, no security definer, empty search_path", () => {
    expect(RPC).toMatch(/^-- PROPOSED, NOT APPLIED/);
    expect(RPC).not.toMatch(/security definer/i);
    expect(RPC.match(/set search_path = ''/g)).toHaveLength(2);
    expect(RPC).toMatch(/revoke all on function public\.feed_frozen_salary_rows\(uuid, jsonb\) from public, anon, authenticated;/);
    expect(RPC).toMatch(/grant execute on function public\.jobs_salary_rows\(uuid\[\], jsonb\) to service_role;/);
  });

  it("one call returns exactly the epoch's rows that meet the exact threshold (BigInt verdict), never another epoch", async () => {
    const pg = await db();
    const vals: Array<[string | null, string, string]> = [
      ["48.07692307695", "USD", "hourly"], ["48.0769230769", "USD", "hourly"], ["48.50", "USD", "hourly"], ["8333.33333333333333", "USD", "monthly"],
      ["7666.67", "EUR", "monthly"], ["7666.66", "EUR", "monthly"], ["100000", "USD", "yearly"], ["99999.99999999999999", "USD", "yearly"],
      [null, "USD", "yearly"], ["NaN", "USD", "yearly"], ["500000", "USD", "weekly"],
    ];
    for (let i = 0; i < vals.length; i++) await pg.query("insert into public.feed_corpus_frozen values ($1,'x',$2,$3,$4,$5)", [uuid(i + 1), vals[i][1], vals[i][2], vals[i][0], E1]);
    await pg.query("insert into public.feed_corpus_frozen values ($1,'x','USD','yearly',1000000,$2)", [uuid(99), E2]);
    const got = (await pg.query("select id from public.feed_frozen_salary_rows($1, $2::jsonb) order by id", [E1, JSON.stringify(TH)])).rows.map((r: any) => r.id);
    const want = vals.flatMap(([v, c, p], i) => (v && v !== "NaN" && TH.some((t) => t.currency === c && t.period === p && passesJs(v, t)) ? [uuid(i + 1)] : []));
    expect(got).toEqual(want);
    expect(got).toContain(uuid(1)); // 48.07692307695: the reviewer's counterexample passes
    expect(got).not.toContain(uuid(2)); // 48.0769230769 fails
    expect(got).not.toContain(uuid(99)); // other epoch
  });

  it("malformed payload raises 22023 for an empty relation, a no-match epoch, a normal relation and a filter matching nothing", async () => {
    const pg = await db();
    const run = (epoch: string, th: unknown, tail = "") => pg.query(`select id from public.feed_frozen_salary_rows($1, $2::jsonb) ${tail}`, [epoch, JSON.stringify(th)]);
    for (const th of MALFORMED) expect(await code(run(E1, th)), "empty relation").toBe("22023");
    await pg.query("insert into public.feed_corpus_frozen values ($1,'x','USD','yearly',150,$2)", [uuid(1), E1]);
    for (const th of MALFORMED) {
      expect(await code(run(E1, th)), "normal relation").toBe("22023");
      expect(await code(run(E2, th)), "no-match epoch").toBe("22023");
      expect(await code(run(E1, th, "where title = 'none' limit 1000")), "chained filter matching nothing").toBe("22023");
    }
    expect(await code(pg.query("select * from public.feed_frozen_salary_rows(null, $1::jsonb)", [JSON.stringify(TH)]))).toBe("22023");
    // the same payloads on the serve-time function, with ids that match nothing
    for (const th of MALFORMED) expect(await code(pg.query("select * from public.jobs_salary_rows($1::uuid[], $2::jsonb)", [[uuid(7)], JSON.stringify(th)]))).toBe("22023");
  });

  it("zero limit: an OUTER `limit 0` never runs the body (why the app refuses limit < 1); `limit 1` on an empty result still raises", async () => {
    const pg = await db();
    const bad = JSON.stringify(MALFORMED[0]);
    expect(await code(pg.query("select id from public.feed_frozen_salary_rows($1, $2::jsonb) limit 0", [E1, bad]))).toBeNull();
    expect(await code(pg.query("select id from public.feed_frozen_salary_rows($1, $2::jsonb) limit 1", [E1, bad]))).toBe("22023");
  });

  it("validator runs once per call, not once per row, even with chained filters, order and limit", async () => {
    const pg = await db(true);
    for (let i = 0; i < 150; i++) await pg.query("insert into public.feed_corpus_frozen values ($1,'Frontend','USD','yearly',150000,$2)", [uuid(i + 1), E1]);
    const c0 = await counter(pg);
    const rows = (await pg.query("select id from public.feed_frozen_salary_rows($1, $2::jsonb) where title = 'Frontend' and id < $3 order by id desc limit 1000", [E1, JSON.stringify(TH), uuid(999)])).rows;
    expect(rows).toHaveLength(150);
    expect((await counter(pg)) - c0).toBe(1);
    await pg.query("select * from public.feed_frozen_salary_rows($1, $2::jsonb)", [E2, JSON.stringify(TH)]); // empty: still exactly once
    expect((await counter(pg)) - c0).toBe(2);
  });

  it("multiplication overflow raises 22003 (the app maps it to 503 fail-closed), never a pass", async () => {
    const pg = await db();
    await pg.query("insert into public.feed_corpus_frozen values ($1,'x','USD','yearly','9e131071'::numeric,$2)", [uuid(1), E1]);
    const huge = [{ currency: "USD", period: "yearly", num: "1", den: "9".repeat(80) }];
    expect(await code(pg.query("select id from public.feed_frozen_salary_rows($1, $2::jsonb)", [E1, JSON.stringify(huge)]))).toBe("22003");
  });

  it("serve-time function: only the given live ids that meet the HELD threshold; id list is bounded 1..1000", async () => {
    const pg = await db();
    await pg.query("insert into public.jobs values ($1,'x','USD','hourly',48.07692307695),($2,'x','USD','hourly',48.0769230769),($3,'x','USD','yearly',200000)", [uuid(1), uuid(2), uuid(3)]);
    const got = (await pg.query("select id from public.jobs_salary_rows($1::uuid[], $2::jsonb) order by id", [[uuid(1), uuid(2)], JSON.stringify(TH)])).rows.map((r: any) => r.id);
    expect(got).toEqual([uuid(1)]); // uuid(3) passes the threshold but was not asked for
    expect(await code(pg.query("select * from public.jobs_salary_rows($1::uuid[], $2::jsonb)", [[], JSON.stringify(TH)]))).toBe("22023");
    const many = Array.from({ length: 1001 }, (_, i) => uuid(i + 1));
    expect(await code(pg.query("select * from public.jobs_salary_rows($1::uuid[], $2::jsonb)", [many, JSON.stringify(TH)]))).toBe("22023");
  });
});
