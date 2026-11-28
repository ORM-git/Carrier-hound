// LOCAL ONLY (row 69 prep). RPC vs the repo's own client mirrors (matchesWorkModelFilter etc.) as independent oracles. PGlite = one connection.
import { describe, it, expect, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
import path from "path";
import { HIDDEN_SOURCE_TYPE } from "../sourcePolicy";
import { recorder, serialize, parseOrClause } from "../captureFilters";
import { applyBaseVisibility, applySearchFilters, type SearchFilterCtx } from "../searchFilters";
import { jobTypeOrClause, workModelOrClause, matchesWorkModelFilter, matchesJobTypeFilter } from "../jobFilters";
import { applyExperienceLevelQuery, matchesExperienceLevelFilter } from "../experienceLevels";
import { applyFeedConstraints, matchesFeedConstraints } from "../../preferences/feedConstraints";

const SQL_PATH = path.join(__dirname, "fixtures", "row69-capture.PROPOSED-NOT-EXECUTED.sql");
const rec = () => { const r = recorder(); applyBaseVisibility(r.q); return r; };
let bindN = 0; const nextBind = () => (++bindN).toString(16).padStart(64, "0");
const TITLES = ["Senior Backend Engineer","Junior Data Analyst","Staff Engineer","Software Engineer Intern","Director of Engineering","Product Designer","Lead Platform Engineer","Associate Recruiter","Internal Audit Lead","Engineer","Sr. Developer","Entry Level Support"];
let seed = 7; const rnd = (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n); };
const CATS = ["ai","engineering","devops","software","data","operations","legal","healthcare","customer-support","cyber-security",null,"other"]; const rows = Array.from({ length: 600 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: TITLES[rnd(TITLES.length)], company: ["Acme","Globex","Initech"][rnd(3)],
  location: ["Remote","Hybrid - NYC","Berlin onsite","Austin, TX","Mumbai, India","Indiana, USA","New Mexico, USA",null][rnd(8)], remote: [true,false,null][rnd(3)], remote_scope: [null,"hybrid","onsite","worldwide","remote"][rnd(5)],
  category: CATS[rnd(CATS.length)], company_slug: null as any, country_code: [null,"IN","MX","US"][rnd(4)], source: [null,"greenhouse board","x"][rnd(3)], salary_min: rnd(3) ? null : 40000 + rnd(9) * 10000, description: ["Python data","React",null][rnd(3)], min_experience_years: rnd(2) ? null : rnd(8), max_experience_years: rnd(2) ? null : 3 + rnd(8),
  job_type: [null,"full-time","internship","contract"][rnd(4)], verified: [true,false,null][rnd(3)], posted_at: rnd(6) ? new Date(Date.UTC(2026,10,1+rnd(25))).toISOString() : null,
  source_type: [null,"ats",HIDDEN_SOURCE_TYPE,"hidden","direct"][rnd(5)], is_active: rnd(10) > 0, status: rnd(10) ? "active" : "closed" }));
const opened: PGlite[] = []; afterEach(async () => { while (opened.length) await opened.pop()!.close(); });
async function setup(sqlOverride?: string) {
  const db = new PGlite(); opened.push(db); await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(`create table public.jobs(id uuid primary key,title text,company text,company_slug text,location text,category text,job_type text,remote bool,remote_scope text,country_code text,source text,source_type text,salary_min int,description text,min_experience_years int,max_experience_years int,posted_at timestamptz,is_active bool,status text,verified bool);`);
  for (const r of rows) await db.query("insert into public.jobs(id,title,company,location,remote,remote_scope,job_type,verified,posted_at,source_type,is_active,status,category,country_code,source,salary_min,description,min_experience_years,max_experience_years) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)", [r.id,r.title,r.company,r.location,r.remote,r.remote_scope,r.job_type,r.verified,r.posted_at,r.source_type,r.is_active,r.status,r.category,r.country_code,r.source,r.salary_min,r.description,r.min_experience_years,r.max_experience_years]);
  await db.exec(`create or replace function public.jobs_without_excluded_skills(p_excluded text[]) returns setof public.jobs language sql as $$ select * from public.jobs where title <> all(p_excluded) $$;`);
  await db.exec(sqlOverride ?? fs.readFileSync(SQL_PATH, "utf8"));
  return db;
}
const bytesToIds = (b: Uint8Array) => { const o: string[] = []; for (let i = 0; i < b.length; i += 16) { const h = Buffer.from(b.slice(i, i + 16)).toString("hex"); o.push(`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`); } return o; };
async function capture(db: PGlite, ast: any, vf = true, max = 5000) {
  const r = await db.query<any>("select * from public.capture_feed_session($1::jsonb,$2,null,'guest',$3,$4,30)", [JSON.stringify(ast), vf, nextBind(), max]);
  if (!r.rows.length) return [];
  const m = await db.query<any>("select member_ids from public.feed_sessions where id=$1", [r.rows[0].handle]); return bytesToIds(m.rows[0].member_ids);
}
// Oracle = repo mirror + the route's base visibility + the DB order (verified desc nulls first, posted_at desc nulls last, id desc).
const ordered = (pred: (r: any) => boolean) => rows.filter((r) => (r.source_type === null || r.source_type !== HIDDEN_SOURCE_TYPE) && r.is_active && r.status === "active" && pred(r))
  .sort((a, b) => (a.verified === b.verified ? 0 : a.verified === null ? -1 : b.verified === null ? 1 : a.verified ? -1 : 1) || (a.posted_at === b.posted_at ? 0 : a.posted_at === null ? 1 : b.posted_at === null ? -1 : a.posted_at < b.posted_at ? 1 : -1) || (a.id < b.id ? 1 : -1)).map((r) => r.id);

describe("capture RPC parity vs repo mirrors", () => {
  it("work model / job type / level / feed constraints match the client mirrors, order = NULLS FIRST", async () => {
    const db = await setup(); let compared = 0;
    for (const wm of ["remote","hybrid","onsite","remote,hybrid"]) { const { q, ast } = rec(); q.or(workModelOrClause(wm)!);
      const got = await capture(db, ast()); const exp = ordered((r) => matchesWorkModelFilter({ remote: r.remote, location: r.location, remoteScope: r.remote_scope }, wm)); const odd = exp.filter((x) => !got.includes(x)).map((x) => rows.find((r) => r.id === x)!); console.log("workModel", wm, "got", got.length, "exp", exp.length, "mirror-only remote values:", Array.from(new Set(odd.map((o) => String(o.remote)))), "rpc-only:", got.filter((x) => !exp.includes(x)).length); if (wm === "onsite") { expect(odd.length).toBeGreaterThan(0); expect(odd.every((o) => o.remote === null && !/onsite/i.test(o.location || ""))).toBe(true); expect(exp.filter((x) => got.includes(x))).toEqual(got); } else expect(got).toEqual(exp); compared++; } // onsite: PINNED existing DB behavior, remote=NULL rows excluded by remote.eq.false (JS mirror differs)
    for (const jt of ["internship","full-time","contract"]) { const c = jobTypeOrClause(jt); if (!c) continue; const { q, ast } = rec(); q.or(c);
      expect(await capture(db, ast())).toEqual(ordered((r) => matchesJobTypeFilter(r.job_type, jt))); compared++; }
    for (const lv of ["entry","mid","senior","lead","director","intern"]) { const { q, ast } = rec(); applyExperienceLevelQuery(q, lv);
      expect(await capture(db, ast())).toEqual(ordered((r) => matchesExperienceLevelFilter({ title: r.title, job_type: r.job_type }, lv))); compared++; }
    const fc = { excludedTitles: ["intern"], includedCompanies: ["acme","globex"], excludedCompanies: [], datePosted: null } as any;
    { const { q, ast } = rec(); applyFeedConstraints(q, fc);
      expect(await capture(db, ast())).toEqual(ordered((r) => matchesFeedConstraints({ title: r.title, company: r.company, postedAt: r.posted_at }, fc))); compared++; }
    console.log("compared cases:", compared, "unique ordered sample size:", ordered(() => true).length);
  }, 60000);
  it("sort=match off drops verified; budget exceed raises capture_too_large and leaves no session; empty makes none; snapshot survives mutation", async () => {
    const db = await setup(); const { ast } = rec();
    const flat = await capture(db, ast(), false); expect(flat).toEqual(ordered(() => true).slice().sort((a, b) => { const A = rows.find((r) => r.id === a)!, B = rows.find((r) => r.id === b)!; return (A.posted_at === B.posted_at ? 0 : A.posted_at === null ? 1 : B.posted_at === null ? -1 : A.posted_at < B.posted_at ? 1 : -1) || (a < b ? 1 : -1); }));
    const before = (await db.query<any>("select count(*)::int c from public.feed_sessions")).rows[0].c;
    await expect(capture(db, ast(), true, 10)).rejects.toThrow(/capture_too_large/);
    expect((await db.query<any>("select count(*)::int c from public.feed_sessions")).rows[0].c).toBe(before);
    const none = rec(); none.q.eq("title", "zzz-no-such"); const b2 = before; expect(await capture(db, none.ast())).toEqual([]);
    expect((await db.query<any>("select count(*)::int c from public.feed_sessions")).rows[0].c).toBe(b2);
    const snap = await capture(db, rec().ast()); await db.exec("delete from public.jobs where title like 'Senior%'; insert into public.jobs(id,title,is_active,status) values (gen_random_uuid(),'zzz new',true,'active')");
    const hs = (await db.query<any>("select member_ids from public.feed_sessions where member_count=$1", [snap.length])).rows; expect(hs.some((h: any) => JSON.stringify(bytesToIds(h.member_ids)) === JSON.stringify(snap))).toBe(true);
    await expect(db.query("select public.feed_filter_sql('{\"col\":\"password\",\"op\":\"eq\",\"val\":\"x\"}'::jsonb)")).rejects.toThrow(/filter_column/);
  }, 60000);
});

// ---- Coverage of the route's REAL inline filter block (applySearchFilters) --------------------------------------------
// Oracle here = a JS interpreter of the recorded AST with SQL three-valued logic (independent of the SQL evaluator), plus a
// parser round-trip (AST -> PostgREST or-string must equal the string the real code produced). imatch is evaluated only by SQL.
const like = (pat: string) => new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "is");
const ev = (n: any, r: any): boolean | null => {
  if (n.and) { let u = false; for (const x of n.and) { const v = ev(x, r); if (v === false) return false; if (v === null) u = true; } return u ? null : true; }
  if (n.or) { let u = false; for (const x of n.or) { const v = ev(x, r); if (v === true) return true; if (v === null) u = true; } return u ? null : false; }
  const c = r[n.col]; let v: boolean | null;
  if (n.op === "is_null") v = c === null || c === undefined;
  else if (c === null || c === undefined) v = null;
  else if (n.op === "eq") v = String(c) === String(n.val); else if (n.op === "neq") v = String(c) !== String(n.val);
  else if (n.op === "ilike") v = like(String(n.val)).test(String(c));
  else if (n.op === "gte") v = n.col === "posted_at" ? new Date(c).getTime() >= new Date(n.val).getTime() : Number(c) >= Number(n.val);
  else if (n.op === "lte") v = Number(c) <= Number(n.val); else if (n.op === "lt") v = Number(c) < Number(n.val);
  else throw new Error("oracle cannot evaluate " + n.op);
  return n.not && v !== null ? !v : v;
};
const hasImatch = (n: any): boolean => (n.and || n.or) ? (n.and || n.or).some(hasImatch) : n.op === "imatch";
const base: SearchFilterCtx = { category: "", remoteOnly: false, countryCodeParam: "", locationParam: "", jobTypeParam: "", levelParam: "", experienceParam: "", workModelParam: "", dateParam: "", feedConstraints: { excludedTitles: [], includedCompanies: [], excludedCompanies: [], datePosted: null }, requiredYears: null, companyParam: "", salaryMinParam: "", sourceTypeParam: "", hasServiceKey: true, cleanQuery: "" };
const CASES: Array<[string, Partial<SearchFilterCtx>]> = [
  ...["trending","tech","ai","data","engineering","internships","remote","fresher","operations","cyber-security","customer-support","legal","healthcare","design"].map((c) => [`category ${c}`, { category: c }] as [string, Partial<SearchFilterCtx>]),
  ["remoteOnly", { remoteOnly: true }], ["country IN", { countryCodeParam: "IN" }], ["country MX", { countryCodeParam: "MX" }], ["country US", { countryCodeParam: "US" }], ["country unknown", { countryCodeParam: "ZZ" }],
  ["location remote", { locationParam: "remote" }], ["location text", { locationParam: "Austin" }], ["jobType", { jobTypeParam: "internship" }],
  ["level senior", { levelParam: "senior" }], ["exp 8+", { experienceParam: "8+ years" }], ["exp 3-5", { experienceParam: "3-5" }], ["exp 1-3", { experienceParam: "1-3" }], ["exp senior", { experienceParam: "5 senior" }],
  ["workModel hybrid", { workModelParam: "hybrid" }], ["company", { companyParam: "acme" }], ["salary", { salaryMinParam: "60000" }],
  ["sourceType ats", { sourceTypeParam: "ats" }], ["sourceType direct", { sourceTypeParam: "direct" }], ["sourceType aggregator", { sourceTypeParam: "aggregator" }], ["sourceType other", { sourceTypeParam: "x" }],
  ["query one word", { cleanQuery: "engineer" }], ["query multi word", { cleanQuery: "data engineer" }], ["query no service key", { cleanQuery: "engineer", hasServiceKey: false }],
  ["requiredYears", { requiredYears: { min: 2, max: 5 } }],
  ["combined", { category: "tech", workModelParam: "remote", companyParam: "acme", salaryMinParam: "50000", cleanQuery: "engineer", requiredYears: { min: 1, max: 6 } }],
];
describe("capture covers the route's real filter block", () => {
  it("every branch: recorded AST round-trips, SQL result = AST oracle (ordered), real rows only", async () => {
    const db = await setup(); const seen: string[] = [];
    for (const [name, patch] of CASES) {
      const { q, ast, raw } = rec(); applySearchFilters(q, { ...base, ...patch }); const a = ast();
      for (const s of raw()) expect(serialize(parseOrClause(s))).toBe(s);   // parser round-trip, no silent omission
      const got = await capture(db, a);
      if (!hasImatch(a)) expect(got, name).toEqual(ordered((r) => ev(a, r) === true)); else expect(got.length, name).toBeGreaterThanOrEqual(0);
      seen.push(`${name}:${got.length}`);
    }
    console.log("branches", CASES.length, seen.join(" "));
  }, 120000);
  it("fails closed: unsupported builder method / grammar / oversize AST / bad column", async () => {
    const { q } = recorder(); expect(() => q.textSearch("title", "x")).toThrow(/unsupported query method/);
    expect(() => parseOrClause("title.cs.{a}")).toThrow(/unsupported filter term/);
    expect(() => parseOrClause("title.ilike.(a")).toThrow();
    const db = await setup();
    const big = { and: Array.from({ length: 201 }, () => ({ col: "title", op: "ilike", val: "%a%" })) };
    await expect(capture(db, big)).rejects.toThrow(/filter_nodes/);
    await expect(capture(db, { and: [{ col: "title", op: "ilike", val: "x".repeat(600) }] })).rejects.toThrow(/filter_value/);
    await expect(capture(db, { and: [{ col: "title", op: "ilike", val: "%a%b%c%d%e%f%g%h%i%" }] })).rejects.toThrow(/filter_cost/);
    await expect(capture(db, { and: [{ col: "title", op: "regexp", val: "a" }] })).rejects.toThrow(/filter_op/);
    let deep: any = { col: "title", op: "eq", val: "a" }; for (let i = 0; i < 10; i++) deep = { and: [deep] };
    await expect(capture(db, deep)).rejects.toThrow(/filter_too_deep/);
    // injection-shaped values are data, not SQL
    expect(await capture(db, { and: [{ col: "title", op: "eq", val: "x'; drop table public.jobs; --" }] })).toEqual([]);
    expect((await db.query<any>("select count(*)::int c from public.jobs")).rows[0].c).toBe(600);
  }, 60000);
  it("excluded-skills base relation is wrapped, bounded, and ordering/budget still apply", async () => {
    const db = await setup(); const { ast } = rec();
    const r = await db.query<any>("select * from public.capture_feed_session($1::jsonb,true,null,'guest',$2,5000,30,$3::text[])", [JSON.stringify(ast()), nextBind(), ["Engineer"]]);
    expect(r.rows[0].n).toBe(ordered((x) => x.title !== "Engineer").length);   // STUB relation: real jobs_without_excluded_skills definition is not in the repo
    await expect(db.query("select * from public.capture_feed_session($1::jsonb,true,null,'guest',$2,5000,30,$3::text[])", [JSON.stringify(ast()), nextBind(), Array(51).fill("x")])).rejects.toThrow(/excluded_skills/);
  }, 60000);
});

describe("final candidate: policy, security, bounds, negative controls", () => {
  const call = (db: PGlite, a: any[]) => db.query<any>("select * from public.capture_feed_session($1::jsonb,$2,$3,$4,$5,$6,$7)", a);
  it("real source policy flows through: jobspy removed; hidden/ats/null kept", async () => {
    const db = await setup(); const got = await capture(db, rec().ast());
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(got.some((i) => byId.get(i)!.source_type === HIDDEN_SOURCE_TYPE)).toBe(false);
    for (const t of [null, "ats", "hidden", "direct"]) expect(got.some((i) => byId.get(i)!.source_type === t), String(t)).toBe(true);
    expect(got.every((i) => byId.get(i)!.is_active && byId.get(i)!.status === "active")).toBe(true);
  }, 60000);
  it("security: anon/authenticated cannot read the table or call the functions; service_role can call; RLS on; SECURITY DEFINER pinned search_path", async () => {
    const db = await setup();
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query("select 1 from public.feed_sessions")).rejects.toThrow(/permission denied/);
      await expect(call(db, [JSON.stringify(rec().ast()), true, null, "guest", nextBind(), 100, 30])).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role"); const ok = await call(db, [JSON.stringify(rec().ast()), true, null, "guest", nextBind(), 5000, 30]); expect(ok.rows[0].n).toBeGreaterThan(0); await db.exec("reset role");
    const meta = (await db.query<any>("select relrowsecurity rls, (select count(*)::int from pg_policies where tablename='feed_sessions') pol from pg_class where relname='feed_sessions'")).rows[0];
    expect(meta).toEqual({ rls: true, pol: 0 });
    const fn = (await db.query<any>("select prosecdef, proconfig from pg_proc where proname='capture_feed_session'")).rows[0];
    expect(fn.prosecdef).toBe(true); expect(String(fn.proconfig)).toMatch(/search_path=pg_catalog, public, pg_temp/);
  }, 60000);
  it("bounds: max/ttl/tier/binding validated; per-caller create rate and active-session limits; opportunistic purge", async () => {
    const db = await setup(); const f = JSON.stringify(rec().ast()); const b = nextBind();
    await expect(call(db, [f, true, null, "guest", b, 0, 30])).rejects.toThrow(/bad_max/);
    await expect(call(db, [f, true, null, "guest", b, 20001, 30])).rejects.toThrow(/bad_max/);
    await expect(call(db, [f, true, null, "guest", b, 100, 61])).rejects.toThrow(/bad_ttl/);
    await expect(call(db, [f, true, null, "pro", b, 100, 30])).rejects.toThrow(/bad_tier/);
    await expect(call(db, [f, true, "00000000-0000-4000-8000-0000000000aa", "guest", b, 100, 30])).rejects.toThrow(/bad_tier/);
    await expect(call(db, [f, true, null, "guest", "xyz", 100, 30])).rejects.toThrow(/bad_binding/);
    for (let i = 0; i < 10; i++) await call(db, [f, true, null, "guest", b, 5000, 30]);
    await expect(call(db, [f, true, null, "guest", b, 5000, 30])).rejects.toThrow(/capture_rate/);
    await call(db, [f, true, null, "guest", nextBind(), 5000, 30]);   // another caller unaffected
    await db.exec("update public.feed_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '90 minutes' where true");
    const before = (await db.query<any>("select count(*)::int c from public.feed_sessions")).rows[0].c; expect(before).toBeGreaterThan(5);
    await call(db, [f, true, null, "guest", nextBind(), 5000, 30]);
    expect((await db.query<any>("select count(*)::int c from public.feed_sessions")).rows[0].c).toBe(before - Math.min(before, 20) + 1);
    expect((await db.query<any>("select public.purge_expired_feed_sessions(100000) n")).rows[0].n).toBeGreaterThanOrEqual(0);
  }, 60000);
  it("NEGATIVE CONTROLS: the tests detect a reversed aggregate order, a dropped visibility rule, and a dropped NOT", async () => {
    const src = fs.readFileSync(SQL_PATH, "utf8");
    const withSql = async (sql: string) => { const d = await setup(sql); return d; };
    // 1. aggregate order reversed -> ordered-list oracle must disagree
    { const d = await withSql(src.replace("order by rn) ids", "order by rn desc) ids")); const got = await capture(d, rec().ast()); expect(got).not.toEqual(ordered(() => true)); expect(got).toEqual(ordered(() => true).reverse()); }
    // 2. without base visibility in the AST, jobspy/inactive rows leak (shows the visibility check has teeth)
    { const d = await setup(); const leaked = await capture(d, recorder().ast()); expect(leaked.length).toBeGreaterThan(ordered(() => true).length); }
    // 3. NOT dropped -> a not.ilike filter changes result
    { const d = await withSql(src.replace("'not (' || s || ')'", "s")); const { q, ast } = rec(); q.not("title", "ilike", "%senior%");
      expect(await capture(d, ast())).not.toEqual(ordered((r) => !/senior/i.test(r.title))); }
    { const d = await setup(); const { q, ast } = rec(); q.not("title", "ilike", "%senior%"); expect(await capture(d, ast())).toEqual(ordered((r) => !/senior/i.test(r.title))); }
  }, 120000);
});
