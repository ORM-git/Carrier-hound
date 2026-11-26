// Fixture (PGlite, NOT live) for docs/proposed/feed_snapshots_durable.NOT_APPLIED.sql: the whole file runs as written.
// Proves re-run safety and that a pre-existing column of the WRONG type is rejected instead of silently kept by
// `add column if not exists`. Says nothing about the live database, roles beyond these three, or PostgREST.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const SQL = fs.readFileSync("docs/proposed/feed_snapshots_durable.NOT_APPLIED.sql", "utf8");
const opened: Array<{ close(): Promise<void> }> = [];
const track = <T extends { close(): Promise<void> }>(pg: T): T => (opened.push(pg), pg);
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close()));
});

async function db(preexisting?: string) {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = track(new PGlite());
  await pg.exec("create role anon; create role authenticated; create role service_role;");
  if (preexisting) await pg.exec(preexisting);
  return pg;
}
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (x: any) { return { code: x.code, message: String(x.message) }; } };
const typeOf = async (pg: any, col: string) =>
  ((await pg.query("select format_type(a.atttypid, a.atttypmod) as t from pg_attribute a where a.attrelid = 'public.feed_snapshots'::regclass and a.attname = $1 and not a.attisdropped", [col])).rows[0] as any)?.t ?? null;
// A table that already exists with the canonical columns, plus `extra` for the column under test.
const existing = (extra: string) => `create table public.feed_snapshots (
  id uuid primary key, identity text not null, job_ids uuid[] not null, corpus_mark timestamptz,
  built_at timestamptz not null, expires_at timestamptz not null, epoch_id uuid, frozen_at timestamptz${extra});`;

describe("feed_snapshots durable SQL (NOT APPLIED): re-run safety and column-type guard", () => {
  it("fresh database: applies, salary_filter is jsonb, and a second run is a no-op that still succeeds", async () => {
    const pg = await db();
    expect(await code(pg.exec(SQL))).toBeNull();
    expect(await typeOf(pg, "salary_filter")).toBe("jsonb");
    expect(await code(pg.exec(SQL))).toBeNull(); // correct-type re-run
    expect(await typeOf(pg, "salary_filter")).toBe("jsonb");
    // put_feed_snapshot stores the held filter as jsonb
    await pg.query(`select public.put_feed_snapshot($1, repeat('a', 64), $2::uuid[], null, null, null, $3::jsonb, now(), now() + interval '6 hours', 10, 1000)`,
      ["00000000-0000-4000-8000-000000000001", ["00000000-0000-4000-9000-000000000001"], JSON.stringify({ currency: "USD", thresholds: [] })]);
    const row = (await pg.query("select salary_filter->>'currency' as c, jsonb_typeof(salary_filter) as t from public.feed_snapshots")).rows[0] as any;
    expect([row.c, row.t]).toEqual(["USD", "object"]);
  });

  it("pre-existing table with salary_filter jsonb: re-run succeeds", async () => {
    const pg = await db(existing(", salary_filter jsonb"));
    expect(await code(pg.exec(SQL))).toBeNull();
    expect(await typeOf(pg, "salary_filter")).toBe("jsonb");
  });

  it.each([["text"], ["json"], ["jsonb[]"]])("pre-existing salary_filter of type %s is REJECTED (42804), not silently kept", async (wrong) => {
    const pg = await db(existing(`, salary_filter ${wrong}`));
    const err = await code(pg.exec(SQL));
    expect(err?.code).toBe("42804");
    expect(err?.message).toMatch(/salary_filter/);
    expect(await typeOf(pg, "salary_filter")).toBe(wrong); // nothing was altered
  });

  it("control: the existing guard still rejects a wrong epoch_id type", async () => {
    const pg = await db(existing("").replace("epoch_id uuid", "epoch_id bigint"));
    expect((await code(pg.exec(SQL)))?.code).toBe("42804");
  });
});
