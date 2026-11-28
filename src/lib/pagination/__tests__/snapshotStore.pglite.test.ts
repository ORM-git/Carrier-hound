// ROW 69 feed snapshot store: local tests of the PROPOSED, NOT APPLIED SQL in docs/proposed/row69-snapshot-store/.
// In-memory PGlite only (one connection). Fixture proof, never canonical: no real Postgres, PostgREST or Supabase.
import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "docs/proposed/row69-snapshot-store");
const APPLY = fs.readFileSync(path.join(DIR, "02_apply.PROPOSED-NOT-APPLIED.sql"), "utf8").replace(/\r\n/g, "\n"); // checkouts may be CRLF
const ROLLBACK = fs.readFileSync(path.join(DIR, "04_rollback.PROPOSED-NOT-APPLIED.sql"), "utf8");
const PROPOSED_EXCLUDED = fs.readFileSync(path.join(process.cwd(), "docs/proposed/executable/20261126c_advanced_skill_filter_rpc.sql"), "utf8");
const H1 = "a".repeat(64), H2 = "b".repeat(64);
const U1 = "00000000-0000-4000-8000-000000000001", U2 = "00000000-0000-4000-8000-000000000002";
const job = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const FUNCS = ["feed_snapshot_limits()", "feed_snapshot_admit(uuid)", "feed_snapshot_check_args(text,text,text,text,integer)",
  "feed_capture_snapshot(text,uuid,text,text,text,uuid[],integer)", "feed_snapshot_filter_sql(jsonb,integer)",
  "feed_capture_search_snapshot(jsonb,boolean,uuid,text,text,text,integer,integer,text[])",
  "feed_read_snapshot_window(text,uuid,text,text,integer,integer)", "feed_purge_expired_snapshots(integer)"];

let seed = 5;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const JOBS = Array.from({ length: 300 }, (_, i) => ({
  id: job(i + 1), title: ["Data Engineer", "Engineer", "Analyst", "Designer"][rnd(4)], verified: [true, false, null][rnd(3)],
  posted_at: rnd(7) ? new Date(Date.UTC(2026, 10, 1 + rnd(25))).toISOString() : null, is_active: rnd(9) > 0,
  status: rnd(12) ? "active" : "expired", source_type: [null, "ats", "jobspy", "direct"][rnd(4)], skills: [["react"], ["python"], [], ["React "]][rnd(4)],
}));

const opened: PGlite[] = [];
afterEach(async () => { while (opened.length) await opened.pop()!.close(); });

/** Fresh database shaped like Supabase for these purposes: API roles, service_role BYPASSRLS, default privileges that
 *  grant new public objects to anon/authenticated (as Supabase does), a jobs table, an excluded-skills relation. */
async function setup(opts: { apply?: string; excluded?: "stub" | "proposed" } = {}) {
  const db = new PGlite(); opened.push(db);
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE public.jobs (id uuid PRIMARY KEY, title text, company text, company_slug text, location text, category text, job_type text,
      remote boolean, remote_scope text, country_code text, source text, source_type text, salary_min int, description text,
      min_experience_years int, max_experience_years int, posted_at timestamptz, is_active boolean, status text, verified boolean, skills text[]);`);
  for (const j of JOBS) await db.query("INSERT INTO public.jobs (id,title,verified,posted_at,is_active,status,source_type,skills) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [j.id, j.title, j.verified, j.posted_at, j.is_active, j.status, j.source_type, j.skills]);
  if ((opts.excluded ?? "stub") === "stub") {
    // STUB: the real definition is not in the repo. Only the name and (text[]) signature are relied on.
    await db.exec(`CREATE FUNCTION public.jobs_without_excluded_skills(p_excluded text[]) RETURNS SETOF public.jobs LANGUAGE sql STABLE AS
      $$ SELECT * FROM public.jobs j WHERE NOT (coalesce(j.skills, '{}') && coalesce(p_excluded, '{}')) $$;
      REVOKE ALL ON FUNCTION public.jobs_without_excluded_skills(text[]) FROM PUBLIC, anon, authenticated;`);
  } else {
    await db.exec(PROPOSED_EXCLUDED);   // the repo's PROPOSED (not known to be applied) definition, 20261126c
  }
  await db.exec(opts.apply ?? APPLY);
  return db;
}
const as = async <T = any>(db: PGlite, role: string, sql: string, params: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try { return (await db.query<T>(sql, params)).rows; } finally { await db.exec("RESET ROLE"); }
};
const svc = <T = any>(db: PGlite, sql: string, params: unknown[] = []) => as<T>(db, "service_role", sql, params);
const capture = async (db: PGlite, ids: string[], o: Partial<{ kind: string; owner: string; tier: string; hash: string; ttl: number }> = {}) =>
  (await svc<{ id: string }>(db, "SELECT public.feed_capture_snapshot($1,$2,$3,$4,'rev-1',$5::uuid[],$6) AS id",
    [o.kind ?? "recommended", o.owner ?? U1, o.tier ?? "free", o.hash ?? H1, ids, o.ttl ?? 30]))[0].id;
const read = async (db: PGlite, id: string, o: Partial<{ owner: string; tier: string; hash: string; pos: number; count: number }> = {}) =>
  (await svc<{ ids: string[]; total: number; kind: string }>(db, "SELECT * FROM public.feed_read_snapshot_window($1,$2,$3,$4,$5,$6)",
    [id, o.owner ?? U1, o.tier ?? "free", o.hash ?? H1, o.pos ?? 0, o.count ?? 25]))[0];
const errOf = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e: any) { return String(e.message); } };
const expire = (db: PGlite, id: string) => db.query("UPDATE public.feed_snapshots SET created_at = now() - interval '2 hours', expires_at = now() - interval '61 minutes' WHERE id = $1", [id]);
const ordered = (pred: (j: (typeof JOBS)[number]) => boolean, verifiedFirst = true) => JOBS.filter(pred).sort((a, b) =>
  (verifiedFirst ? (a.verified === b.verified ? 0 : a.verified === null ? -1 : b.verified === null ? 1 : a.verified ? -1 : 1) : 0)
  || (a.posted_at === b.posted_at ? 0 : a.posted_at === null ? 1 : b.posted_at === null ? -1 : a.posted_at < b.posted_at ? 1 : -1)
  || (a.id < b.id ? 1 : -1)).map((j) => j.id);
const VISIBLE = { and: [{ or: [{ col: "source_type", op: "is_null" }, { col: "source_type", op: "neq", val: "jobspy" }] },
  { col: "is_active", op: "eq", val: "true" }, { col: "status", op: "eq", val: "active" }] };
const visible = (j: (typeof JOBS)[number]) => (j.source_type === null || j.source_type !== "jobspy") && j.is_active && j.status === "active";

describe("capture and read", () => {
  it("captures a ranked list and serves exact windows in order; position/count bounds", async () => {
    const db = await setup();
    const ids = Array.from({ length: 60 }, (_, i) => job(300 - i));
    const id = await capture(db, ids);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await read(db, id, { pos: 0, count: 25 })).toMatchObject({ ids: ids.slice(0, 25), total: 60, kind: "recommended" });
    expect((await read(db, id, { pos: 50, count: 25 })).ids).toEqual(ids.slice(50));
    expect((await read(db, id, { pos: 60, count: 25 })).ids).toEqual([]);
    expect(await errOf(read(db, id, { pos: 61 }))).toMatch(/bad_position/);
    expect(await errOf(read(db, id, { pos: -1 }))).toMatch(/bad_position/);
    expect(await errOf(read(db, id, { count: 0 }))).toMatch(/bad_count/);
    expect(await errOf(read(db, id, { count: 101 }))).toMatch(/bad_count/);
  });

  it("ids are 64-hex, unique and not sequential", async () => {
    const db = await setup();
    const got: string[] = [];
    for (let i = 0; i < 10; i++) got.push(await capture(db, [job(i + 1)], { owner: job(1000 + i) }));
    expect(new Set(got).size).toBe(10);
    expect(got.every((x) => /^[0-9a-f]{64}$/.test(x))).toBe(true);
    expect([...got].sort()).not.toEqual(got);                                   // not in creation order
    expect(new Set(got.map((x) => x.slice(0, 8))).size).toBe(10);               // no shared prefix pattern
  });
});

describe("binding: every use re-checks owner, tier, query hash and expiry; one safe error", () => {
  it("rejects cross-user, cross-tier, cross-query, client-claimed owner/tier, guessed, forged and expired ids alike", async () => {
    const db = await setup();
    const id = await capture(db, [job(1), job(2)]);
    const unavailable = /snapshot_unavailable/;
    expect(await errOf(read(db, id, { owner: U2 }))).toMatch(unavailable);           // another user (or a client-claimed owner)
    expect(await errOf(read(db, id, { tier: "pro" }))).toMatch(unavailable);         // a client-claimed higher tier
    expect(await errOf(read(db, id, { hash: H2 }))).toMatch(unavailable);            // another query
    expect(await errOf(read(db, "f".repeat(64)))).toMatch(unavailable);              // guessed id
    expect(await errOf(read(db, "not-a-real-id"))).toMatch(unavailable);             // forged id
    const old = await capture(db, [job(3)]);
    await expire(db, old);
    expect(await errOf(read(db, old))).toMatch(unavailable);                         // expired (not yet purged)
    expect((await read(db, id)).ids).toEqual([job(1), job(2)]);                      // the real binding still works
  });

  it("no shared guest owner can exist: owner is a uuid, 'guest' is refused at capture and read", async () => {
    const db = await setup();
    expect(await errOf(capture(db, [job(1)], { owner: "guest" }))).toMatch(/invalid input syntax for type uuid/);
    expect(await errOf(capture(db, [job(1)], { tier: "guest" }))).toMatch(/bad_tier/);
    const id = await capture(db, [job(1)]);
    expect(await errOf(read(db, id, { owner: "guest" }))).toMatch(/invalid input syntax for type uuid/);
  });
});

describe("roles: anon and authenticated get nothing; service_role only", () => {
  it("table and every function are denied to anon/authenticated, allowed to service_role", async () => {
    const db = await setup();
    const id = await capture(db, [job(1)]);
    for (const role of ["anon", "authenticated"]) {
      expect(await errOf(as(db, role, "SELECT * FROM public.feed_snapshots"))).toMatch(/permission denied/);
      expect(await errOf(as(db, role, `INSERT INTO public.feed_snapshots (kind,owner_id,tier,query_hash,scoring_rev,ids,member_count,expires_at)
        VALUES ('search','${U1}','free','${H1}','r',ARRAY['${job(1)}']::uuid[],1,now()+interval '5 min')`))).toMatch(/permission denied/);
      for (const sql of [`SELECT public.feed_capture_snapshot('recommended','${U1}','free','${H1}','r',ARRAY['${job(1)}']::uuid[],5)`,
        `SELECT * FROM public.feed_read_snapshot_window('${id}','${U1}','free','${H1}',0,5)`, "SELECT public.feed_purge_expired_snapshots(5)",
        `SELECT * FROM public.feed_capture_search_snapshot('{"and":[]}'::jsonb,true,'${U1}','free','${H1}','r',10,5)`]) {
        expect(await errOf(as(db, role, sql)), `${role}: ${sql.slice(0, 40)}`).toMatch(/permission denied/);
      }
    }
    expect((await read(db, id)).total).toBe(1);
  });

  it("metadata: RLS on with zero policies; every function SECURITY INVOKER with search_path pinned to ''", async () => {
    const db = await setup();
    const t = (await db.query<any>("SELECT relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policies WHERE tablename='feed_snapshots') AS pol FROM pg_class WHERE relname='feed_snapshots'")).rows[0];
    expect(t).toEqual({ rls: true, pol: 0 });
    const fns = (await db.query<any>("SELECT p.oid::regprocedure::text AS fn, prosecdef, proconfig FROM pg_proc p WHERE proname LIKE 'feed\\_%snapshot%' ESCAPE '\\'")).rows;
    expect(fns.map((f) => f.fn.replace(/ /g, "")).sort()).toEqual(FUNCS.map((f) => f.replace(/ /g, "")).sort());
    for (const f of fns) { expect(f.prosecdef, f.fn).toBe(false); expect(String(f.proconfig), f.fn).toBe('search_path=""'); }
  });
});

describe("bounds", () => {
  it("size per kind, duplicates, nulls, empty, ttl, tier, hash", async () => {
    const db = await setup();
    const many = (n: number) => Array.from({ length: n }, (_, i) => job(5000 + i));
    expect(await errOf(capture(db, many(201), { kind: "multiword" }))).toMatch(/capture_too_large/);
    expect(await capture(db, many(200), { kind: "multiword" })).toMatch(/^[0-9a-f]{64}$/);
    expect(await errOf(capture(db, many(1001), { kind: "recommended" }))).toMatch(/capture_too_large/);
    expect(await errOf(capture(db, [job(1), job(1)]))).toMatch(/bad_ids/);
    expect(await errOf(svc(db, `SELECT public.feed_capture_snapshot('recommended','${U1}','free','${H1}','r',ARRAY['${job(1)}',NULL]::uuid[],5)`))).toMatch(/bad_ids/);
    expect(await errOf(capture(db, []))).toMatch(/empty_snapshot/);
    expect(await errOf(capture(db, [job(1)], { ttl: 0 }))).toMatch(/bad_ttl/);
    expect(await errOf(capture(db, [job(1)], { ttl: 61 }))).toMatch(/bad_ttl/);
    expect(await errOf(capture(db, [job(1)], { hash: "xyz" }))).toMatch(/bad_query_hash/);
    expect(await errOf(capture(db, [job(1)], { kind: "other" }))).toMatch(/bad_kind/);
  });

  it("per-owner rate (10/min) and active (20) limits; other owners unaffected", async () => {
    const db = await setup();
    for (let i = 0; i < 10; i++) await capture(db, [job(i + 1)]);
    expect(await errOf(capture(db, [job(99)]))).toMatch(/snapshot_rate/);
    expect(await capture(db, [job(99)], { owner: U2 })).toMatch(/^[0-9a-f]{64}$/);
    await db.query("UPDATE public.feed_snapshots SET created_at = now() - interval '2 minutes' WHERE owner_id = $1", [U1]);
    for (let i = 0; i < 10; i++) await capture(db, [job(i + 20)]);                  // now 20 active for U1
    await db.query("UPDATE public.feed_snapshots SET created_at = now() - interval '2 minutes' WHERE owner_id = $1", [U1]);
    expect(await errOf(capture(db, [job(98)]))).toMatch(/snapshot_rate/);           // active cap, not the per-minute one
  });

  it("global active capacity (50000)", async () => {
    const db = await setup();
    await db.exec(`INSERT INTO public.feed_snapshots (kind, owner_id, tier, query_hash, scoring_rev, ids, member_count, expires_at)
      SELECT 'recommended', ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, 'free', repeat('c', 64), 'r', ARRAY['${job(1)}']::uuid[], 1, now() + interval '30 min'
        FROM generate_series(1, 49999) g`);
    expect(await capture(db, [job(1)])).toMatch(/^[0-9a-f]{64}$/);                  // 50000th active row
    expect(await errOf(capture(db, [job(2)], { owner: U2 }))).toMatch(/snapshot_capacity/);
    await db.exec("UPDATE public.feed_snapshots SET created_at = now() - interval '2 hours', expires_at = now() - interval '61 minutes' WHERE tier = 'free' AND query_hash = repeat('c', 64) AND owner_id::text LIKE '00000000-0000-4000-9000-00000000000%'");
    expect(await capture(db, [job(2)], { owner: U2 })).toMatch(/^[0-9a-f]{64}$/);   // expired rows free capacity
  }, 60000);
});

describe("search capture (single CTE)", () => {
  const cap = async (db: PGlite, filters: unknown, o: Partial<{ vf: boolean; max: number; excluded: string[] | null }> = {}) => {
    const r = await svc<{ snapshot_id: string; n: number }>(db, "SELECT * FROM public.feed_capture_search_snapshot($1::jsonb,$2,$3,'free',$4,'rev-1',$5,30,$6::text[])",
      [JSON.stringify(filters), o.vf ?? true, U1, H1, o.max ?? 20000, o.excluded ?? null]);
    return r[0] ? { id: r[0].snapshot_id, n: r[0].n } : null;
  };
  const all = async (db: PGlite, id: string) => { const out: string[] = []; for (let p = 0; ; p += 100) { const w = await read(db, id, { pos: p, count: 100 }); out.push(...w.ids); if (p + 100 >= w.total) return out; } };

  it("order = the route's (verified NULLS FIRST, posted_at DESC NULLS LAST, id DESC); sort off drops verified", async () => {
    const db = await setup();
    const a = await cap(db, VISIBLE);
    expect(await all(db, a!.id)).toEqual(ordered(visible));
    const b = await cap(db, VISIBLE, { vf: false });
    expect(await all(db, b!.id)).toEqual(ordered(visible, false));
  });

  it("over the bound raises and stores nothing; no match stores nothing", async () => {
    const db = await setup();
    const before = (await db.query<any>("SELECT count(*)::int c FROM public.feed_snapshots")).rows[0].c;
    expect(await errOf(cap(db, VISIBLE, { max: 5 }))).toMatch(/capture_too_large/);
    expect(await cap(db, { and: [{ col: "title", op: "eq", val: "zzz-none" }] })).toBeNull();
    expect((await db.query<any>("SELECT count(*)::int c FROM public.feed_snapshots")).rows[0].c).toBe(before);
    expect(await errOf(cap(db, { and: [{ col: "password", op: "eq", val: "x" }] }))).toMatch(/filter_column/);
    expect(await errOf(cap(db, VISIBLE, { max: 20001 }))).toMatch(/bad_max/);
  });

  for (const excluded of ["stub", "proposed"] as const) {
    it(`excluded skills through public.jobs_without_excluded_skills(text[]) (${excluded} definition)`, async () => {
      const db = await setup({ excluded });
      const r = await cap(db, VISIBLE, { excluded: ["react"] });
      const got = await all(db, r!.id);
      const hasReact = (j: (typeof JOBS)[number]) => excluded === "stub" ? j.skills.includes("react") : j.skills.some((s) => s.trim().toLowerCase() === "react");
      expect(got).toEqual(ordered((j) => visible(j) && !hasReact(j)));
      expect(got.length).toBeLessThan(ordered(visible).length);
    });
  }
});

describe("concurrency, as far as one PGlite connection allows", () => {
  it("interleaved captures for two owners keep independent counts and windows", async () => {
    const db = await setup();
    const mine: Record<string, string[]> = { [U1]: [], [U2]: [] };
    for (let i = 0; i < 8; i++) for (const o of [U1, U2]) mine[o].push(await capture(db, [job(i + 1), job(i + 50)], { owner: o }));
    for (const o of [U1, U2]) for (const id of mine[o]) expect((await read(db, id, { owner: o })).total).toBe(2);
    for (const id of mine[U1]) expect(await errOf(read(db, id, { owner: U2 }))).toMatch(/snapshot_unavailable/);
  });

  it("purge between reads removes only expired rows, is bounded, and a live snapshot keeps serving", async () => {
    const db = await setup();
    const live = await capture(db, [job(1), job(2), job(3)]);
    const dead: string[] = [];
    for (let i = 0; i < 6; i++) { const d = await capture(db, [job(10 + i)], { owner: job(2000 + i) }); await expire(db, d); dead.push(d); }
    expect((await read(db, live, { pos: 0, count: 2 })).ids).toEqual([job(1), job(2)]);
    expect((await svc<any>(db, "SELECT public.feed_purge_expired_snapshots(4) AS n"))[0].n).toBe(4);      // bounded
    expect((await read(db, live, { pos: 2, count: 2 })).ids).toEqual([job(3)]);                           // read continues
    expect((await svc<any>(db, "SELECT public.feed_purge_expired_snapshots(500) AS n"))[0].n).toBe(2);
    expect((await db.query<any>("SELECT count(*)::int c FROM public.feed_snapshots")).rows[0].c).toBe(1);
  });

  it("rollback removes every object", async () => {
    const db = await setup();
    await db.exec(ROLLBACK);
    expect((await db.query<any>("SELECT count(*)::int c FROM pg_proc WHERE proname LIKE 'feed\\_%snapshot%' ESCAPE '\\'")).rows[0].c).toBe(0);
    expect((await db.query<any>("SELECT to_regclass('public.feed_snapshots') AS t")).rows[0].t).toBeNull();
  });
});

// Real SQL mutants: each edits the proposed SQL text, applies it to a fresh database, and the named security check
// must FAIL on it (the probe returns true only for the secure behaviour).
type Probe = (db: PGlite) => Promise<boolean>;
const probes: Record<string, Probe> = {
  crossUser: async (db) => /snapshot_unavailable/.test(await errOf(read(db, await capture(db, [job(1)]), { owner: U2 }))),
  crossTier: async (db) => /snapshot_unavailable/.test(await errOf(read(db, await capture(db, [job(1)]), { tier: "pro" }))),
  crossQuery: async (db) => /snapshot_unavailable/.test(await errOf(read(db, await capture(db, [job(1)]), { hash: H2 }))),
  expired: async (db) => { const id = await capture(db, [job(1)]); await expire(db, id); return /snapshot_unavailable/.test(await errOf(read(db, id))); },
  oneError: async (db) => { const id = await capture(db, [job(1)]); return (await errOf(read(db, id, { owner: U2 }))) === (await errOf(read(db, "f".repeat(64)))); },
  authTable: async (db) => /permission denied/.test(await errOf(as(db, "authenticated", "SELECT * FROM public.feed_snapshots"))),
  anonExec: async (db) => (await db.query<any>("SELECT has_function_privilege('anon', 'public.feed_capture_snapshot(text,uuid,text,text,text,uuid[],integer)', 'EXECUTE') AS x")).rows[0].x === false
    && /permission denied/.test(await errOf(as(db, "anon", `SELECT public.feed_capture_snapshot('recommended','${U1}','free','${H1}','r',ARRAY['${job(1)}']::uuid[],5)`))),
  rls: async (db) => (await db.query<any>("SELECT relrowsecurity r FROM pg_class WHERE relname='feed_snapshots'")).rows[0].r === true,
  invoker: async (db) => (await db.query<any>("SELECT bool_and(NOT prosecdef) ok FROM pg_proc WHERE proname LIKE 'feed\\_%snapshot%' ESCAPE '\\'")).rows[0].ok === true,
  rate: async (db) => { for (let i = 0; i < 10; i++) await capture(db, [job(i + 1)]); return /snapshot_rate/.test(await errOf(capture(db, [job(99)]))); },
  randomId: async (db) => { const a = await capture(db, [job(1)], { owner: job(3001) }); const b = await capture(db, [job(1)], { owner: job(3002) });
    return /^[0-9a-f]{64}$/.test(a) && a.slice(0, 16) !== b.slice(0, 16); },
  sizeBound: async (db) => /capture_too_large|feed_snapshots_size/.test(await errOf(capture(db, Array.from({ length: 201 }, (_, i) => job(9000 + i)), { kind: "multiword" }))),
  searchOrder: async (db) => { const r = await svc<any>(db, "SELECT * FROM public.feed_capture_search_snapshot($1::jsonb,true,$2,'free',$3,'r',20000,30)", [JSON.stringify(VISIBLE), U1, H1]);
    const w = await read(db, r[0].snapshot_id, { count: 100 }); return JSON.stringify(w.ids) === JSON.stringify(ordered(visible).slice(0, 100)); },
};
const MUTANTS: Array<[string, string, string, keyof typeof probes]> = [
  ["read without owner check", "AND s.owner_id = p_owner AND", "AND", "crossUser"],
  ["read without tier check", "AND s.tier = p_tier AND", "AND", "crossTier"],
  ["read without query-hash check", "AND s.query_hash = p_query_hash;", ";", "crossQuery"],
  ["read without expiry check", "WHERE s.id = p_id AND s.expires_at > pg_catalog.now()", "WHERE s.id = p_id", "expired"],
  ["mismatch gets its own error", "AND s.owner_id = p_owner AND s.tier = p_tier AND s.query_hash = p_query_hash;\n  IF NOT FOUND THEN",
    ";\n  IF FOUND AND (r.owner_id <> p_owner OR r.tier <> p_tier OR r.query_hash <> p_query_hash) THEN RAISE EXCEPTION 'snapshot_forbidden'; END IF;\n  IF NOT FOUND THEN", "oneError"],
  ["table revoke dropped", "REVOKE ALL ON TABLE public.feed_snapshots FROM PUBLIC, anon, authenticated;", "", "authTable"],
  ["function revoke dropped", "REVOKE ALL ON FUNCTION public.feed_capture_snapshot(text, uuid, text, text, text, uuid[], integer) FROM PUBLIC, anon, authenticated;", "", "anonExec"],
  ["RLS not enabled", "ALTER TABLE public.feed_snapshots ENABLE ROW LEVEL SECURITY;", "", "rls"],
  ["a function made SECURITY DEFINER", "RETURNS integer\nLANGUAGE plpgsql VOLATILE SECURITY INVOKER", "RETURNS integer\nLANGUAGE plpgsql VOLATILE SECURITY DEFINER", "invoker"],
  ["rate limit removed", "IF recent >= lim.per_owner_per_minute OR active >= lim.per_owner_active THEN", "IF false THEN", "rate"],
  ["sequential ids", `DEFAULT (pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
                                    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''))`,
    `DEFAULT pg_catalog.lpad(pg_catalog.to_hex((pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()) * 1000000)::bigint), 64, '0')`, "randomId"],
  ["size bound removed (function and constraint)", "WHEN 'multiword' THEN 200 WHEN", "WHEN 'multiword' THEN 20000 WHEN", "sizeBound"],
  ["search aggregate order reversed", "pg_catalog.array_agg(id ORDER BY rn)", "pg_catalog.array_agg(id ORDER BY rn DESC)", "searchOrder"],
];

describe("SQL mutants: each security check fails on a weakened copy", () => {
  it("every probe passes on the proposed SQL", async () => {
    for (const [name, probe] of Object.entries(probes)) { const db = await setup(); expect(await probe(db), name).toBe(true); await db.close(); opened.pop(); }
  }, 120000);
  it.each(MUTANTS)("%s", async (_name, from, to, probe) => {
    expect(APPLY.split(from).length - 1, "mutant anchor must match exactly once").toBe(1);
    let sql = APPLY.replace(from, to);
    if (probe === "sizeBound") sql = sql.replace("(kind = 'multiword' AND member_count <= 200)", "(kind = 'multiword' AND member_count <= 20000)");
    const db = await setup({ apply: sql });
    expect(await probes[probe](db)).toBe(false);
  }, 60000);
});

describe("staging guards: proposed SQL stays proposed, read-only scripts stay read-only", () => {
  const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n");
  // SQL keywords only: comments and quoted string literals (e.g. privilege names in has_table_privilege) are stripped.
  const code = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''");
  it("nothing lives in supabase/migrations; apply/rollback say NOT APPLIED; the staging script refuses production", () => {
    const applied = fs.existsSync("supabase/migrations") ? fs.readdirSync("supabase/migrations") : [];
    expect(applied.filter((f) => /feed_snapshot|row69/i.test(f))).toEqual([]);
    for (const f of ["02_apply.PROPOSED-NOT-APPLIED.sql", "04_rollback.PROPOSED-NOT-APPLIED.sql"]) expect(read(f)).toMatch(/PROPOSED, NOT APPLIED/);
    expect(read("05_concurrency-check.STAGING-ONLY.sh")).toMatch(/refusing: URL looks like production/);
  });
  it("01_precheck and 03_verify contain no write or DDL statement outside comments", () => {
    for (const f of ["01_precheck.READONLY.sql", "03_verify.READONLY.sql"]) {
      expect(code(read(f)), f).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COPY|BEGIN|COMMIT)\b/i);
    }
  });
  it("01_precheck runs on the fixture before apply (no collisions); 03_verify runs after apply with the expected results", async () => {
    const db = new PGlite(); opened.push(db);
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.jobs (id uuid PRIMARY KEY, title text, company text, company_slug text, location text, category text, job_type text,
        remote boolean, remote_scope text, country_code text, source text, source_type text, salary_min int, description text,
        min_experience_years int, max_experience_years int, posted_at timestamptz, is_active boolean, status text, verified boolean, skills text[]);`);
    const pre = await db.exec(read("01_precheck.READONLY.sql"));
    expect(pre[0].rows).toEqual([]);                                                       // A: nothing to collide with
    expect(pre[2].rows[0]).toMatchObject({ has_gen_random_uuid: true, has_hashtextextended: true });
    expect(pre[3].rows).toHaveLength(20);                                                  // C: every column the capture reads
    await db.exec(APPLY);
    const v = await db.exec(read("03_verify.READONLY.sql"));
    expect(v[0].rows).toHaveLength(1 + FUNCS.length);
    expect(v[1].rows[0]).toEqual({ rls: true, policies: 0 });
    expect(v[2].rows.find((r: any) => r.rolname === "service_role")).toMatchObject({ sel: true, ins: true, upd: false, del: true });
    expect(v[2].rows.filter((r: any) => r.rolname !== "service_role").every((r: any) => !r.sel && !r.ins && !r.upd && !r.del)).toBe(true);
    expect(v[3].rows.every((r: any) => r.prosecdef === false && !r.anon_exec && !r.auth_exec && r.service_exec)).toBe(true);
    expect(v[5].rows.map((r: any) => r.indexname).sort()).toEqual(["feed_snapshots_expires_idx", "feed_snapshots_owner_created_idx", "feed_snapshots_pkey"]);
  });
});
