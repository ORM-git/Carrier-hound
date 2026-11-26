// Fixture (PGlite, NOT live) for docs/proposed/video_facets_coverage.READONLY.sql, run as written.
// Proves: every coverage query counts only the feed's scope (active, visible sources; hidden jobspy rows never counted),
// a missing or wrong-typed facet column stops the script with a named error before any dependent query, and the
// script changes nothing. Says nothing about live coverage.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const SQL = fs.readFileSync("docs/proposed/video_facets_coverage.READONLY.sql", "utf8");
const opened: Array<{ close(): Promise<void> }> = [];
const track = <T extends { close(): Promise<void> }>(pg: T): T => (opened.push(pg), pg);
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close()));
});

const COLS: Record<string, string> = {
  id: "int primary key", status: "text", is_active: "boolean", source_type: "text", role_category: "text",
  min_experience_years: "integer", max_experience_years: "integer", skills: "text[]", seniority: "text",
};
async function db(override: Record<string, string | null> = {}) {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = track(new PGlite());
  const cols = { ...COLS, ...override };
  const defs = Object.entries(cols).filter(([, t]) => t !== null).map(([c, t]) => `${c} ${t}`).join(", ");
  await pg.exec(`create table public.jobs (${defs}); create table public.companies (id int primary key);`);
  return { pg, cols };
}
// visible active rows: 1..3; hidden: jobspy (4), inactive (5), not active status (6)
const ROWS = [
  [1, "active", true, null, "SDE", 2, 5, "{react}", "senior"],
  [2, "active", true, "ats", "DATA", null, null, "{}", "unknown"],
  [3, "active", true, "direct", null, 1, 3, null, "mid"],
  [4, "active", true, "jobspy", "SDE", 9, 9, "{x}", "senior"],
  [5, "active", false, "ats", "SDE", 9, 9, "{x}", "senior"],
  [6, "expired", true, "ats", "SDE", 9, 9, "{x}", "senior"],
];
async function seed(pg: any) {
  for (const r of ROWS) {
    await pg.query("insert into public.jobs (id,status,is_active,source_type,role_category,min_experience_years,max_experience_years,skills,seniority) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", r);
  }
}
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (x: any) { return { code: x.code, message: String(x.message) }; } };

describe("video facet coverage SQL (READ-ONLY): scope filter on every query and a safe stop on missing columns", () => {
  it("every query, including each UNION branch of the value distribution, counts only active visible rows (no jobspy)", async () => {
    const { pg } = await db();
    await seed(pg);
    const results = await pg.exec(SQL);
    const pop = results.find((r: any) => r.fields.some((f: any) => f.name === "visible_active_rows"))!.rows[0] as any;
    expect(pop.visible_active_rows).toBe(3);
    const perSource = results.find((r: any) => r.fields.some((f: any) => f.name === "source_type") && r.fields.some((f: any) => f.name === "rows"))!.rows as any[];
    expect(perSource.reduce((n, r) => n + Number(r.rows), 0)).toBe(3);
    expect(perSource.map((r) => r.source_type)).not.toContain("jobspy");
    const dist = results[results.length - 1].rows as any[];
    for (const facet of ["role_category", "seniority", "min_experience_years"]) {
      const branch = dist.filter((r) => r.facet === facet);
      expect(branch.reduce((n, r) => n + Number(r.count), 0), facet).toBe(3); // no hidden row in any branch
    }
  });

  it.each([
    ["missing min_experience_years", { min_experience_years: null }, /min_experience_years .*MISSING/],
    ["missing skills", { skills: null }, /skills .*MISSING/],
    ["skills of type text, not text[]", { skills: "text" }, /skills \(want text\[\], have text\)/],
    ["role_category of type integer", { role_category: "integer" }, /role_category \(want text, have integer\)/],
    ["missing source_type (scope filter)", { source_type: null }, /source_type .*MISSING/],
  ])("%s: stops with a named error before any dependent query", async (_label, override, why) => {
    const { pg } = await db(override);
    const e = await err(pg.exec(SQL));
    expect(e?.code).toBe("42703");
    expect(e?.message).toMatch(/video facet coverage checks stopped/);
    expect(e?.message).toMatch(why);
  });

  it("changes nothing: same tables, columns and rows after a run", async () => {
    const { pg } = await db();
    await seed(pg);
    const shape = async () => JSON.stringify((await pg.query(
      "select c.relname, count(a.attname) cols from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 where n.nspname = 'public' group by 1 order by 1")).rows)
      + JSON.stringify((await pg.query("select * from public.jobs order by id")).rows);
    const before = await shape();
    await pg.exec(SQL);
    expect(await shape()).toBe(before);
  });
});
