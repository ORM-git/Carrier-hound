// Actual retained-row metric against local Postgres, not the old visible-listing model.
// No network or production database. Uses the REAL count helper and its generated query.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { countRetainedJobsToday, __resetRetainedCountForTests } from "@/lib/api/retainedJobsToday";

const now = new Date("2026-11-27T12:00:00Z");
let db: PGlite;
const calls: string[] = [];
const client = {
  from(table: string) {
    calls.push(table);
    const conditions: string[] = [];
    const values: string[] = [];
    const builder: any = {
      select(_columns: string, opts: any) {
        expect(opts).toEqual({ count: "exact", head: true });
        return builder;
      },
      gte(column: string, value: string) {
        expect(column).toBe("created_at");
        values.push(value); conditions.push(`created_at >= $${values.length}::timestamptz`); return builder;
      },
      lt(column: string, value: string) {
        expect(column).toBe("created_at");
        values.push(value); conditions.push(`created_at < $${values.length}::timestamptz`); return builder;
      },
      abortSignal(_signal: AbortSignal) { return builder; },
      then(resolve: any, reject: any) {
        // Table name is restricted before SQL construction, and values are bound parameters.
        expect(table).toBe("jobs");
        return db.query<{ n: number }>(`select count(*)::int as n from public.jobs where ${conditions.join(" and ")}`, values)
          .then(result => ({ count: result.rows[0].n, error: null })).then(resolve, reject);
      },
    };
    return builder;
  },
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create table public.jobs (
    id text primary key, created_at timestamptz not null, last_seen_at timestamptz,
    status text, is_active boolean, source_type text, dedupe_hash text
  )`);
}, 30000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { __resetRetainedCountForTests(); calls.length = 0; await db.exec("delete from public.jobs"); });
const add = async (id: string, created: string, extra: { status?: string; active?: boolean; source?: string; hash?: string } = {}) => {
  await db.query("insert into public.jobs values ($1,$2,$3,$4,$5,$6,$7)", [id, created, now.toISOString(), extra.status ?? "active", extra.active ?? true, extra.source ?? "greenhouse", extra.hash ?? null]);
};
const count = async () => {
  const result = await countRetainedJobsToday(client, now);
  expect(result.ok).toBe(true); expect(result.asOf).toBe(now.toISOString());
  expect(calls.every(t => t === "jobs")).toBe(true);
  return result.count;
};

describe("retained-row metric uses the actual helper, not visible-listing semantics", () => {
  it("includes retained inactive and hidden rows; excludes physically removed rows", async () => {
    await add("active", "2026-11-27T01:00:00Z");
    await add("inactive", "2026-11-27T01:00:00Z", { status: "expired", active: false });
    await add("hidden", "2026-11-27T01:00:00Z", { source: "jobspy_hidden" });
    await add("deleted", "2026-11-27T01:00:00Z");
    await db.exec("delete from public.jobs where id='deleted'");
    expect(await count()).toBe(3);
  });
  it("refreshing yesterday's row does not recount it, new retained identities do", async () => {
    await add("old", "2026-11-25T12:00:00Z", { hash: "same-role" });
    await add("repost-new-id", "2026-11-27T01:00:00Z", { hash: "same-role" });
    await add("other-board", "2026-11-27T02:00:00Z", { hash: "same-role" });
    expect(await count()).toBe(2);
  });
  it("uses inclusive IST midnight and exclusive query start, not the whole future day", async () => {
    await add("before", "2026-11-26T18:29:59.999Z");
    await add("midnight", "2026-11-26T18:30:00Z");
    await add("start", now.toISOString());
    await add("future", "2026-11-27T14:00:00Z");
    expect(await count()).toBe(1);
  });
});
