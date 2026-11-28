import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { openFeedSession, orderSurvivors, readFeedPage, type SessionBinding } from "../feedSession";
import { compareSortKeys, searchOrder, timestampKey, type SearchSort, type SortKey } from "../searchSession";

// Row 69: search gets the same stable-membership guarantee as the recommended feed, checked against real Postgres
// (PGlite) while verified flags and timestamps change between pages. Synthetic data only; test-only secret.
const SECRET = "test-only-feed-session-secret-0123456789abcdef";
const T0 = Date.UTC(2026, 10, 28, 9, 0, 0);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const bindingFor = (sort: SearchSort): SessionBinding => ({ surface: "search", user: "u-1", tier: "free", sort, pageSize: 7, filters: ["q:engineer"] });
const SIZE = 7;
let db: PGlite;

const ORDER = (sort: SearchSort) => searchOrder(sort).map((o) => `${o.column} DESC NULLS LAST`).join(", ");
// Microsecond output (.US), as PostgreSQL stores timestamptz: never truncated to milliseconds.
const KEY_COLS = `id::text, verified, to_char(posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS posted_at`;
// Rows that differ only below the millisecond (and one written with a +05:30 offset, equal to another instant).
const SUB_MS = ["2026-11-04T00:00:00.000001Z", "2026-11-04T00:00:00.000002Z", "2026-11-04T00:00:00.000999Z",
  "2026-11-04T05:30:00.0005+05:30", "2026-11-04T00:00:00.0005Z", "2026-11-04T00:00:00.000501Z"];
// Search filter + eligibility, the same on page 1 and on every later page.
const MATCHES = `is_active AND title ILIKE '%engineer%'`;

async function membership(sort: SearchSort, limit: number) {
  return (await db.query<SortKey>(`SELECT ${KEY_COLS} FROM jobs WHERE ${MATCHES} ORDER BY ${ORDER(sort)} LIMIT ${limit + 1}`)).rows;
}
/** Later page: only the page's ids, current eligibility, no ORDER BY (order must come from the session). */
async function eligible(ids: string[]) {
  return (await db.query<{ id: string }>(`SELECT id::text FROM jobs WHERE ${MATCHES} AND id::text = ANY($1::text[])`, [ids])).rows;
}
async function browseSession(sort: SearchSort, limit: number, between: (page: number, snapshot: string[]) => Promise<void>) {
  const rows = await membership(sort, limit);
  const ids = rows.slice(0, limit).map((r) => r.id);
  const s = await openFeedSession({ orderedIds: ids, binding: bindingFor(sort), secret: SECRET, pageSize: SIZE, now: T0, moreBeyondCap: rows.length > limit });
  const seen = [...s.firstPage];
  for (let i = 0; i < s.continuation.length; i++) {
    await between(i + 2, ids);
    const r = await readFeedPage({ token: s.continuation[i], binding: bindingFor(sort), secret: SECRET, pageSize: SIZE, now: T0 + (i + 1) * 1000 });
    if (!r.ok) throw new Error(`page ${i + 2}: ${r.reason}`);
    seen.push(...orderSurvivors(r.ids, await eligible(r.ids)).map((x) => x.id));
  }
  return { s, ids, seen };
}
/** Mutations between pages, always aimed at members of pages not yet served (plus one already-shown member). */
function mutator() {
  const dropped = new Set<string>();
  const run = async (page: number, ids: string[]) => {
    const unserved = ids.slice((page - 1) * SIZE);
    const [a, b, c] = unserved;
    await db.query(`UPDATE jobs SET verified = NOT coalesce(verified, false) WHERE id = $1`, [a]);          // verified flips
    await db.query(`UPDATE jobs SET posted_at = $2 WHERE id = $1`, [b, `2026-12-${String(page).padStart(2, "0")}T00:00:00Z`]); // newest date
    if (c) await db.query(`UPDATE jobs SET posted_at = NULL, verified = NULL WHERE id = $1`, [c]);         // both keys to NULL
    await db.query(`UPDATE jobs SET verified = false, posted_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [ids[0]]); // already shown
    await db.query(`INSERT INTO jobs (id, title, verified, posted_at, first_seen_at) VALUES ($1, 'Engineer new', true, '2026-12-31T00:00:00Z', now())`,
      [uuid(5000 + page)]);                                                                                   // arrival that would sort first
    const gone = [...unserved].reverse().find((id) => !dropped.has(id) && ![a, b, c].includes(id));
    if (gone) {
      await db.query(`UPDATE jobs SET is_active = false WHERE id = $1`, [gone]);                            // unserved member goes inactive
      dropped.add(gone);
    }
    if (page === 3) {
      const notMatching = unserved.find((id) => !dropped.has(id) && ![a, b, c].includes(id))!;
      await db.query(`UPDATE jobs SET title = 'Designer' WHERE id = $1`, [notMatching]);                 // no longer matches the query
      dropped.add(notMatching);
    }
  };
  return { run, dropped };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE jobs (id uuid PRIMARY KEY, title text NOT NULL, verified boolean, posted_at timestamptz,
    first_seen_at timestamptz NOT NULL, is_active boolean NOT NULL DEFAULT true)`);
});
beforeEach(async () => {
  await db.exec("TRUNCATE jobs");
  const rows: string[] = [];
  for (let n = 1; n <= 60; n++) {
    const verified = n % 3 === 0 ? "true" : n % 3 === 1 ? "false" : "NULL";                      // all three tiers
    const posted = n % 7 === 0 ? "NULL" : `'2026-11-${String((n % 5) + 1).padStart(2, "0")}T00:00:00Z'`; // ties + nulls
    const title = n % 10 === 0 ? "Designer" : "Engineer";                                       // some never match
    rows.push(`('${uuid(n)}', '${title}', ${verified}, ${posted}, '2026-11-20T00:00:00Z')`);
  }
  SUB_MS.forEach((ts, i) => rows.push(`('${uuid(61 + i)}', 'Engineer', ${i % 2 ? "true" : "false"}, '${ts}', '2026-11-20T00:00:00Z')`));
  await db.exec(`INSERT INTO jobs (id, title, verified, posted_at, first_seen_at) VALUES ${rows.join(",")}`);
});
afterAll(async () => { await db.close(); });

describe("search session: stable ordered membership while verified and dates change", () => {
  for (const sort of ["match", "newest"] as const) {
    it(`${sort}: complete ordered surviving membership, exactly`, async () => {
      const m = mutator();
      const { s, ids, seen } = await browseSession(sort, 1000, m.run);
      expect(s.total).toBe(60);                                                                  // 66 minus the 6 non-matching
      expect(s.capped).toBe(false);
      expect(m.dropped.size).toBeGreaterThan(5);
      expect(seen).toEqual(ids.filter((id) => !m.dropped.has(id)));                              // order, no skip, no repeat
      expect(seen.some((id) => id.startsWith("00000000-0000-4000-8000-00000000138"))).toBe(false); // no arrivals
    });
  }

  it("a capped session holds exactly the first N in order and says it is capped", async () => {
    const { s, ids, seen } = await browseSession("match", 20, async () => {});
    expect(s.capped).toBe(true);
    expect(ids).toEqual((await membership("match", 1000)).slice(0, 20).map((r) => r.id));
    expect(seen).toEqual(ids);
    const last = await readFeedPage({ token: s.continuation.at(-1), binding: bindingFor("match"), secret: SECRET, pageSize: SIZE, now: T0 + 1 });
    expect(last.ok && last.capped).toBe(true);
  });

  it("sub-millisecond ordering: the comparator matches PostgreSQL at microsecond precision", async () => {
    const rows = (await db.query<SortKey>(`SELECT ${KEY_COLS} FROM jobs WHERE id::text = ANY($1::text[])`, [SUB_MS.map((_, i) => uuid(61 + i))])).rows;
    expect(rows.map((r) => r.posted_at)).toContain("2026-11-04T00:00:00.000501Z");             // read back with microseconds
    for (const sort of ["newest", "match"] as const) {
      const pg = (await db.query<{ id: string }>(`SELECT id::text FROM jobs WHERE id::text = ANY($1::text[]) ORDER BY ${ORDER(sort)}`,
        [rows.map((r) => r.id)])).rows.map((r) => r.id);
      expect([...rows].sort((a, b) => compareSortKeys(a, b, sort)).map((r) => r.id)).toEqual(pg);
    }
  });

  it("negative control: a Date.parse (millisecond) comparator disagrees with PostgreSQL on the same rows", async () => {
    const rows = (await db.query<SortKey>(`SELECT ${KEY_COLS} FROM jobs WHERE id::text = ANY($1::text[])`, [SUB_MS.map((_, i) => uuid(61 + i))])).rows;
    const msCompare = (a: SortKey, b: SortKey) => (Date.parse(b.posted_at!) - Date.parse(a.posted_at!)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const pg = (await db.query<{ id: string }>(`SELECT id::text FROM jobs WHERE id::text = ANY($1::text[]) ORDER BY ${ORDER("newest")}`,
      [rows.map((r) => r.id)])).rows.map((r) => r.id);
    expect([...rows].sort(msCompare).map((r) => r.id)).not.toEqual(pg);
  });

  it("timestampKey: offsets in every ISO form are the same instant; more than 6 fractional digits is refused", () => {
    expect(timestampKey("2026-11-04T05:30:00.0005+05:30")).toEqual(timestampKey("2026-11-04T00:00:00.000500Z"));
    expect(timestampKey("2026-11-04T05:30:00.000500+0530")).toEqual(timestampKey("2026-11-04T00:00:00.0005Z"));
    expect(timestampKey("2026-11-04T05:00:00.5+05")).toEqual(timestampKey("2026-11-04T00:00:00.5Z"));
    expect(timestampKey("2026-11-04T00:00:00Z")[1]).toBe(0);
    expect(() => timestampKey("2026-11-04T00:00:00.0000001Z")).toThrow("6 fractional");
    expect(() => timestampKey("not a time")).toThrow();
  });

  it("the JS comparator agrees with Postgres ORDER BY (ties, nulls, all verified tiers)", async () => {
    const rows = (await db.query<SortKey>(`SELECT ${KEY_COLS} FROM jobs`)).rows;
    for (const sort of ["match", "newest"] as const) {
      const pg = (await db.query<{ id: string }>(`SELECT id::text FROM jobs ORDER BY ${ORDER(sort)}`)).rows.map((r) => r.id);
      expect([...rows].sort((a, b) => compareSortKeys(a, b, sort)).map((r) => r.id)).toEqual(pg);
    }
  });

  it("a search session token does not open on the recommended surface or another query", async () => {
    const ids = (await membership("match", 1000)).map((r) => r.id);
    const s = await openFeedSession({ orderedIds: ids, binding: bindingFor("match"), secret: SECRET, pageSize: SIZE, now: T0 });
    for (const b of [{ ...bindingFor("match"), surface: "recommended" }, { ...bindingFor("match"), filters: ["q:designer"] }, bindingFor("newest")]) {
      expect(await readFeedPage({ token: s.continuation[0], binding: b, secret: SECRET, pageSize: SIZE, now: T0 + 1 })).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

// Negative controls: the designs this replaces, run on the same data and the same mutations.
/** A keyset page: rows strictly after `after` in `cursorSort` order, listed in `listSort` order (Postgres sorts). */
async function keysetPage(listSort: SearchSort, cursorSort: SearchSort, after: SortKey | null, arrivalFence: boolean) {
  const all = (await db.query<SortKey>(`SELECT ${KEY_COLS} FROM jobs WHERE ${MATCHES}${arrivalFence ? ` AND first_seen_at <= '2026-11-20T00:00:00Z'` : ""}
    ORDER BY ${ORDER(listSort)}`)).rows;
  return all.filter((r) => !after || compareSortKeys(r, after, cursorSort) > 0).slice(0, SIZE);
}
async function browseKeyset(listSort: SearchSort, cursorSort: SearchSort, arrivalFence: boolean, between: (page: number, snapshot: string[]) => Promise<void>) {
  const snapshot = (await membership(listSort, 1000)).map((r) => r.id);
  const seen: string[] = [];
  let after: SortKey | null = null;
  for (let page = 1; page < 50; page++) {
    if (page > 1) await between(page, snapshot);
    const rows = await keysetPage(listSort, cursorSort, after, arrivalFence);
    seen.push(...rows.map((r) => r.id));
    if (rows.length < SIZE) break;
    after = rows[rows.length - 1];
  }
  return { snapshot, seen };
}

describe("negative controls: the search designs this replaces", () => {
  it("main's (posted_at, id) cursor under verified-first ordering skips jobs even with no changes", async () => {
    const { snapshot, seen } = await browseKeyset("match", "newest", false, async () => {});
    expect(snapshot.filter((id) => !seen.includes(id)).length).toBeGreaterThan(0);
  });

  it("a full-sort-key keyset with an arrival fence (this PR's earlier design) skips and repeats when keys change", async () => {
    const m = mutator();
    const { snapshot, seen } = await browseKeyset("match", "match", true, m.run);
    const expected = snapshot.filter((id) => !m.dropped.has(id));
    const skipped = expected.filter((id) => !seen.includes(id));
    const repeated = seen.filter((id, i) => seen.indexOf(id) !== i);
    expect(seen).not.toEqual(expected);
    expect(skipped.length + repeated.length).toBeGreaterThan(0);
  });
});
