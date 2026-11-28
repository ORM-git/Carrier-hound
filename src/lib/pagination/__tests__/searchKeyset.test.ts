import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  afterCursorFilter,
  compareSortKeys,
  decodeSearchCursor,
  encodeSearchCursor,
  searchOrder,
  type SearchSort,
  type SortKey,
} from "../searchKeyset";
import type { SessionBinding } from "../feedSession";

// Row 69: search keyset over the full sort key, evaluated by real Postgres (PGlite). Synthetic data only.
const SECRET = "test-only-feed-session-secret-0123456789abcdef";
const binding: SessionBinding = { user: "u-1", tier: "free", sort: "match", pageSize: 7, filters: ["q:engineer"] };
const T0 = Date.UTC(2026, 10, 28, 9, 0, 0);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
let db: PGlite;

/** Decodes the PostgREST logic-tree subset afterCursorFilter emits (eq / lt / is.null, nested and/or) into SQL. */
function toSql(expr: string, args: unknown[]): string {
  const split = (s: string) => {
    const out: string[] = [];
    let depth = 0, quoted = false, cur = "";
    for (const ch of s) {
      if (ch === '"') quoted = !quoted;
      if (!quoted && ch === "(") depth++;
      if (!quoted && ch === ")") depth--;
      if (!quoted && depth === 0 && ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const term = (t: string): string => {
    const group = t.match(/^(and|or)\((.*)\)$/);
    if (group) return `(${split(group[2]).map(term).join(group[1] === "and" ? " AND " : " OR ")})`;
    const m = t.match(/^(verified|posted_at|id)\.(eq|lt|is)\.(.+)$/);
    if (!m) throw new Error(`unsupported term ${t}`);
    const [, col, op, raw] = m;
    if (op === "is") { if (raw !== "null") throw new Error(raw); return `${col} IS NULL`; }
    const value = raw.startsWith('"') ? raw.slice(1, -1) : raw === "true" ? true : raw === "false" ? false : raw;
    args.push(value);
    const cast = col === "posted_at" ? "::timestamptz" : col === "id" ? "::uuid" : "::boolean";
    return `${col} ${op === "eq" ? "=" : "<"} $${args.length}${cast}`;
  };
  return `(${split(expr).map(term).join(" OR ")})`;
}

const orderSql = (sort: SearchSort) => searchOrder(sort).map((o) => `${o.column} DESC NULLS LAST`).join(", ");

async function page(sort: SearchSort, after: SortKey | null, arrivalAt: number, size: number) {
  const args: unknown[] = [new Date(arrivalAt).toISOString()];
  const where = [`is_active`, `first_seen_at <= $1::timestamptz`];
  if (after) where.push(toSql(afterCursorFilter(after, sort), args));
  const r = await db.query<{ id: string; verified: boolean | null; posted_at: string | null }>(
    `SELECT id::text, verified, to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS posted_at
       FROM jobs WHERE ${where.join(" AND ")} ORDER BY ${orderSql(sort)} LIMIT ${size}`, args);
  return r.rows;
}
async function browse(sort: SearchSort, size: number, between: (n: number) => Promise<void> = async () => {}) {
  const seen: string[] = [];
  let after: SortKey | null = null;
  for (let n = 1; n < 100; n++) {
    if (n > 1) await between(n);
    const rows = await page(sort, after, T0, size);
    seen.push(...rows.map((r) => r.id));
    if (rows.length < size) break;
    after = rows[rows.length - 1];
  }
  return seen;
}
async function all(sort: SearchSort) {
  return (await db.query<{ id: string }>(`SELECT id::text FROM jobs WHERE is_active AND first_seen_at <= $1::timestamptz ORDER BY ${orderSql(sort)}`,
    [new Date(T0).toISOString()])).rows.map((r) => r.id);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE jobs (id uuid PRIMARY KEY, verified boolean, posted_at timestamptz, first_seen_at timestamptz NOT NULL, is_active boolean NOT NULL DEFAULT true)`);
  const rows: string[] = [];
  for (let n = 1; n <= 60; n++) {
    const verified = n % 3 === 0 ? "true" : n % 3 === 1 ? "false" : "NULL";              // all three tiers
    const posted = n % 7 === 0 ? "NULL" : `'2026-11-${String((n % 5) + 1).padStart(2, "0")}T00:00:00Z'`; // ties + nulls
    rows.push(`('${uuid(n)}', ${verified}, ${posted}, '2026-11-20T00:00:00Z')`);
  }
  await db.exec(`INSERT INTO jobs (id, verified, posted_at, first_seen_at) VALUES ${rows.join(",")}`);
});
afterAll(async () => { await db.close(); });

describe("search keyset over the full sort key (real Postgres)", () => {
  for (const sort of ["match", "newest"] as const) {
    for (const size of [1, 7, 60]) {
      it(`${sort}, page size ${size}: pages concatenate to the full ordered result, no repeat, no skip`, async () => {
        const expected = await all(sort);
        expect(expected).toHaveLength(60);
        expect(await browse(sort, size)).toEqual(expected);
      });
    }
  }

  it("match with an empty middle tier: a page may cross straight from verified=true into verified=null", async () => {
    await db.exec("BEGIN");
    try {
      await db.exec("UPDATE jobs SET verified = NULL WHERE verified = false");
      for (const size of [3, 7]) expect(await browse("match", size)).toEqual(await all("match"));
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("the JS reference comparator agrees with Postgres ordering (ties, nulls, all verified tiers)", async () => {
    const rows = (await db.query<SortKey>(`SELECT id::text, verified, to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS posted_at FROM jobs`)).rows;
    for (const sort of ["match", "newest"] as const) {
      expect([...rows].sort((a, b) => compareSortKeys(a, b, sort)).map((r) => r.id)).toEqual(await all(sort));
    }
  });

  it("jobs inserted after the session's arrival time stay out; deactivated ones drop; the rest stay complete and ordered", async () => {
    const expected = await all("match");
    const dropped = new Set<string>();
    const seen = await browse("match", 7, async (n) => {
      await db.query(`INSERT INTO jobs (id, verified, posted_at, first_seen_at) VALUES ($1, true, '2026-11-30T00:00:00Z', $2)`,
        [uuid(1000 + n), new Date(T0 + n * 1000).toISOString()]);                        // newest + verified: would sort first
      const victim = expected[expected.length - n];                                       // an unserved member
      await db.query(`UPDATE jobs SET is_active = false WHERE id = $1`, [victim]);
      dropped.add(victim);
    });
    expect(seen).toEqual(expected.filter((id) => !dropped.has(id)));
    await db.query(`DELETE FROM jobs WHERE id::text LIKE '00000000-0000-4000-8000-0000000003%'`);
    await db.query(`UPDATE jobs SET is_active = true`);
  });

  it("negative control: the old (posted_at, id) cursor under verified-first ordering skips jobs", async () => {
    const expected = await all("match");
    const seen: string[] = [];
    let after: SortKey | null = null;
    for (let n = 0; n < 20; n++) {
      const args: unknown[] = [new Date(T0).toISOString()];
      const where = [`is_active`, `first_seen_at <= $1::timestamptz`];
      if (after) where.push(toSql(afterCursorFilter(after, "newest"), args));          // old cursor: posted_at/id only
      const rows = (await db.query<SortKey>(`SELECT id::text, verified, to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS posted_at
        FROM jobs WHERE ${where.join(" AND ")} ORDER BY ${orderSql("match")} LIMIT 7`, args)).rows;
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 7) break;
      after = rows[rows.length - 1];
    }
    expect(seen).not.toEqual(expected);
    expect(expected.filter((id) => !seen.includes(id)).length).toBeGreaterThan(0);        // skipped jobs
  });
});

describe("search cursor tokens", () => {
  const key: SortKey = { verified: null, posted_at: "2026-11-03T00:00:00.000Z", id: uuid(5) };
  it("round-trips every verified tier and null posted_at", async () => {
    for (const k of [key, { ...key, verified: true }, { ...key, verified: false }, { ...key, posted_at: null }]) {
      const t = await encodeSearchCursor(k, T0, binding, SECRET);
      expect(await decodeSearchCursor({ token: t, binding, secret: SECRET, now: T0 + 1000 })).toEqual({ ok: true, cursor: { ...k, arrivalAt: T0 } });
    }
  });
  it("rejects other bindings, tampering, expiry and junk", async () => {
    const t = await encodeSearchCursor(key, T0, binding, SECRET);
    const read = (token: unknown, b = binding, now = T0 + 1000) => decodeSearchCursor({ token, binding: b, secret: SECRET, now });
    expect(await read(t, { ...binding, tier: "pro" })).toEqual({ ok: false, reason: "invalid" });
    expect(await read(t, { ...binding, filters: ["q:designer"] })).toEqual({ ok: false, reason: "invalid" });
    const p = t.split(".");
    expect(await read([p[0], p[1], "t", p[3], p[4], p[5]].join("."))).toEqual({ ok: false, reason: "invalid" });
    expect(await read(t, binding, T0 + 31 * 60_000)).toEqual({ ok: false, reason: "expired" });
    for (const bad of [null, "", "ks1.a.b", "x".repeat(500), "ks1.zz.q.AA.not-uuid.AA"]) expect((await read(bad)).ok).toBe(false);
  });
});
