// Step D: Wikidata source, canary integration, idempotency, null handling and industry tags. Offline only:
// every Wikidata response and official page is a fixture; the database is a disposable PGlite with the real migrations.
import fs from "node:fs";
import path from "node:path";
import { PGlite, types } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import * as canary from "../canary";
import type { CanaryJournal, CanaryRow, CanaryStore, CanaryTable, FetchedPage, JournalIO } from "../canary";
import { companySourceLabel, deriveIndustryTags } from "../industryTags";
import { bareHost, employeeBand, extractWikidataProfile, fetchWikidataProfile, WIKIDATA_API } from "../wikidata";

const MIGRATIONS = ["20261122a_company_profile_data.sql", "20261124a_company_profile_wikidata.sql"]
  .map((f) => fs.readFileSync(path.join(process.cwd(), "supabase/migrations", f), "utf8"));
const REF = canary.COMPANY_PROFILE_PRODUCTION_PROJECT_REF;
const SHA = "a".repeat(40);
const NOW = new Date("2026-11-24T10:00:00.000Z");
const CO = "c0000000-0000-4000-8000-000000000001";
const TABLES = Object.keys(canary.CANARY_TABLES) as CanaryTable[];
const sleep = async () => undefined;

// --- fixtures ---------------------------------------------------------------------------------
const item = (id: string, extra: Record<string, unknown> = {}) => ({ mainsnak: { snaktype: "value", datavalue: { value: { id } } }, rank: "normal", ...extra });
const str = (value: string, rank = "normal") => ({ mainsnak: { snaktype: "value", datavalue: { value } }, rank });
const time = (t: string, precision: number) => ({ snaktype: "value", datavalue: { value: { time: t, precision } } });
const ENTITY = {
  id: "Q100",
  descriptions: { en: { value: "American robotics and machine learning company" } },
  claims: {
    P856: [str("https://www.acme-robotics.example/")],
    P571: [{ mainsnak: time("+2015-12-11T00:00:00Z", 11), rank: "normal" }],
    P159: [item("Q1")],
    P1128: [
      { mainsnak: { snaktype: "value", datavalue: { value: { amount: "+900" } } }, rank: "normal", qualifiers: { P585: [time("+2022-01-01T00:00:00Z", 9)] } },
      { mainsnak: { snaktype: "value", datavalue: { value: { amount: "+1500" } } }, rank: "normal", qualifiers: { P585: [time("+2024-06-30T00:00:00Z", 11)] } },
      { mainsnak: { snaktype: "value", datavalue: { value: { amount: "+99999" } } }, rank: "normal" }, // undated: not comparable, ignored
    ],
    P2002: [str("acmerobotics")],
    P4264: [str("acme-robotics")],
    P414: [item("Q2", { qualifiers: { P249: [{ snaktype: "value", datavalue: { value: "ACME" } }] } })],
    P169: [item("Q3", { qualifiers: { P580: [time("+2021-03-01T00:00:00Z", 11)] } }), item("Q6", { qualifiers: { P582: [time("+2020-01-01T00:00:00Z", 11)] } })],
    P112: [item("Q4"), item("Q5")],
  },
};
const LABELS: Record<string, string> = { Q1: "San Francisco", Q2: "NASDAQ", Q3: "Jane Doe", Q4: "John Roe", Q5: "Some Holding Org", Q6: "Old Chief" };

function wikidata(overrides: { search?: unknown; candidates?: Record<string, unknown>; status?: number; malformed?: string } = {}) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    if (overrides.status) throw new Error(`Wikidata returned HTTP ${overrides.status}`);
    const params = new URL(url).searchParams;
    const body = (() => {
      if (overrides.malformed && params.get("action") === overrides.malformed) return "{not json";
      if (params.get("action") === "wbsearchentities") return JSON.stringify(overrides.search ?? { search: [{ id: "Q100" }, { id: "Q200" }] });
      if (params.get("action") === "wbgetclaims") return JSON.stringify({ claims: { P31: [item(params.get("entity") === "Q4" ? "Q5" : "Q43229")] } });
      const ids = String(params.get("ids")).split("|");
      if (params.get("props") === "claims") return JSON.stringify({ entities: overrides.candidates ?? { Q100: { id: "Q100", claims: { P856: ENTITY.claims.P856 } }, Q200: { id: "Q200", claims: { P856: [str("https://other.example/")] } } } });
      if (params.get("props") === "labels") return JSON.stringify({ entities: Object.fromEntries(ids.map((id) => [id, { id, labels: { en: { value: LABELS[id] } } }])) });
      return JSON.stringify({ entities: { Q100: ENTITY } });
    })();
    return { url, text: body, status: 200, contentType: "application/json" };
  };
  return { calls, fetchJson };
}

// --- database ---------------------------------------------------------------------------------
async function db(options: { stepD?: boolean } = {}) {
  const pg = new PGlite({ parsers: { [types.TIMESTAMPTZ]: (v: string) => v, [types.DATE]: (v: string) => v } });
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.companies(id uuid PRIMARY KEY, name text, canonical_domain text);
    CREATE TABLE public.company_boards(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, ats_type text, slug text, careers_url text, enabled boolean);
    CREATE TABLE public.jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, posted_at timestamptz, status text, is_active boolean);`);
  await pg.exec(MIGRATIONS[0]);
  if (options.stepD !== false) await pg.exec(MIGRATIONS[1]);
  await pg.query("INSERT INTO public.companies VALUES ($1,'Acme Robotics','acme-robotics.example')", [CO]);
  await pg.query("INSERT INTO public.company_boards(company_id,ats_type,slug,careers_url,enabled) VALUES ($1,'greenhouse','acmerobotics','https://boards.greenhouse.io/acmerobotics',true)", [CO]);
  return pg;
}

function pgStore(pg: PGlite): CanaryStore {
  const where = (match: CanaryRow, offset: number) => {
    const params: string[] = [];
    const sql = Object.entries(match).map(([c, v]) => (v === null ? `${c} IS NULL` : (params.push(v), `${c} = $${offset + params.length}`))).join(" AND ");
    return { sql, params };
  };
  return {
    async missingSchema() { return []; },
    async companies(ids) { return (await pg.query<any>("SELECT id::text id, name, canonical_domain FROM public.companies WHERE id = ANY($1::uuid[])", [ids])).rows; },
    async boards(companyId) { return (await pg.query<any>("SELECT id::text id, ats_type, slug, careers_url FROM public.company_boards WHERE company_id = $1 AND enabled", [companyId])).rows; },
    async rows(table, ids) {
      const select = canary.CANARY_TABLES[table].columns.map((c) => (c === "id" || c === "company_id" ? `${c}::text ${c}` : c)).join(",");
      return (await pg.query<any>(`SELECT ${select} FROM public.${table} WHERE company_id = ANY($1::uuid[])`, [ids])).rows.map((r) => canary.normalizeCanaryRow(table, r));
    },
    async insert(table, row) {
      const cols = Object.keys(row);
      await pg.query(`INSERT INTO public.${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => row[c]));
    },
    async updateWhere(table, match, set) {
      const cols = Object.keys(set);
      const w = where(match, cols.length);
      return (await pg.query(`UPDATE public.${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(",")} WHERE ${w.sql} RETURNING 1`, [...cols.map((c) => set[c]), ...w.params])).rows.length;
    },
    async deleteWhere(table, match) {
      const w = where(match, 0);
      return (await pg.query(`DELETE FROM public.${table} WHERE ${w.sql} RETURNING 1`, w.params)).rows.length;
    },
  };
}

// Official site: reachable, but the homepage does not link the ATS board (what OpenAI/Stripe/Datadog returned).
function officialPages(home = "<html><body><a href='/careers'>Careers</a></body></html>") {
  const pages: Record<string, FetchedPage> = {
    "https://acme-robotics.example/robots.txt": { url: "https://acme-robotics.example/robots.txt", text: "User-agent: *\nAllow: /\n", status: 200, contentType: "text/plain" },
    "https://acme-robotics.example/": { url: "https://acme-robotics.example/", text: home, status: 200, contentType: "text/html" },
  };
  return async (url: string): Promise<FetchedPage> => {
    if (url.startsWith(`${WIKIDATA_API}?`)) return wd.fetchJson(url);
    const hit = pages[url];
    if (!hit) throw new Error("Company source returned HTTP 404");
    return { ...hit };
  };
}
let wd = wikidata();
const ids = () => { let n = 0; return () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`; };
const plan = (pg: PGlite, extra: Partial<Parameters<typeof canary.buildCanaryPlan>[0]> = {}) => canary.buildCanaryPlan({
  store: canary.readOnlyCanaryStore(pgStore(pg)), fetchPage: officialPages(), sleep, now: () => NOW, newId: ids(),
  targetProject: REF, companyIds: [CO], maxCompanies: 1, codeSha: SHA, fetchWikidata: wd.fetchJson, ...extra,
});
function journal(): JournalIO & { value: CanaryJournal | null } {
  const io = { value: null as CanaryJournal | null, read: () => (io.value ? structuredClone(io.value) : null), write: (j: CanaryJournal) => { io.value = structuredClone(j); } };
  return io;
}
const bind = (p: canary.CanaryPlan) => ({ targetProject: REF, companyIds: p.company_ids, maxCompanies: 1, confirmDigest: p.plan_digest, codeSha: SHA });
const later = () => new Date(NOW.getTime() + 60_000);

// --- tests ------------------------------------------------------------------------------------
describe("Wikidata extraction (only what statements state)", () => {
  it("maps statements to sourced facts and leaders, dropping former CEOs and organisations", () => {
    const out = extractWikidataProfile({ entity: ENTITY, companyDomain: "acme-robotics.example", labels: LABELS, humans: new Set(["Q4"]), retrievedAt: NOW.toISOString() });
    const v = Object.fromEntries(Object.entries(out.facts).map(([k, f]) => [k, f!.value]));
    expect(v).toEqual({
      website: "https://www.acme-robotics.example/", overview: "American robotics and machine learning company", founded_year: "2015",
      headquarters: "San Francisco", employee_count_range: "1,001-5,000", twitter_url: "https://x.com/acmerobotics",
      linkedin_url: "https://www.linkedin.com/company/acme-robotics", funding_stage: "Public (NASDAQ: ACME)",
    });
    for (const fact of Object.values(out.facts)) expect(fact).toMatchObject({ sourceKind: "wikidata", sourceUrl: "https://www.wikidata.org/wiki/Q100", retrievedAt: NOW.toISOString() });
    expect(out.facts.employee_count_range?.observedAt).toBe("2024-06-30T00:00:00.000Z"); // P585 point in time
    expect(out.facts.founded_year?.observedAt).toBeNull(); // never an invented date
    expect(out.leadership.map((l) => `${l.name}|${l.role}|${l.roleAsOf}`)).toEqual(["Jane Doe|Chief Executive Officer|2021-03-01", "John Roe|Founder|null"]);
  });

  it("stores nothing it cannot state: no claims, ambiguous single values, deprecated values, unlisted companies", () => {
    expect(extractWikidataProfile({ entity: { id: "Q9", claims: {} }, companyDomain: "x.example", labels: {}, humans: new Set(), retrievedAt: NOW.toISOString() }))
      .toEqual({ entityId: "Q9", facts: {}, leadership: [] });
    const messy = { id: "Q9", claims: { P159: [item("Q1"), item("Q7")], P571: [{ mainsnak: time("+1990-00-00T00:00:00Z", 7), rank: "normal" }], P2002: [str("dead_handle", "deprecated")], P856: [str("https://x.example")] } };
    const out = extractWikidataProfile({ entity: messy, companyDomain: "x.example", labels: { Q1: "A", Q7: "B" }, humans: new Set(), retrievedAt: NOW.toISOString() });
    expect(Object.keys(out.facts)).toEqual(["website"]); // two HQs, a century-precision date, a deprecated handle: all dropped
    expect(out.facts.funding_stage).toBeUndefined(); // no listing is not evidence of "private"
    const preferred = { id: "Q9", claims: { P159: [item("Q1"), item("Q7", { rank: "preferred" })] } };
    expect(extractWikidataProfile({ entity: preferred, companyDomain: "x.example", labels: { Q1: "A", Q7: "B" }, humans: new Set(), retrievedAt: NOW.toISOString() }).facts.headquarters?.value).toBe("B");
    expect([employeeBand(0), employeeBand(7), employeeBand(1000), employeeBand(250000)]).toEqual([null, "1-10", "501-1,000", "10,001+"]);
    expect(bareHost("HTTPS://WWW.Acme.example/jobs")).toBe("acme.example");
  });
});

describe("Wikidata fetch: identity, 429, malformed", () => {
  const company = { name: "Acme Robotics", canonical_domain: "acme-robotics.example" };
  const run = (w: ReturnType<typeof wikidata>, sources: string[] = []) => fetchWikidataProfile({
    company, fetchJson: w.fetchJson, sleep, now: () => NOW.toISOString(), sha256: (t) => `h${t.length}`, record: (s) => sources.push(s.requested_url),
  });

  it("matches exactly one entity whose official website is the stored domain", async () => {
    const w = wikidata();
    const sources: string[] = [];
    const out = await run(w, sources);
    expect(out.outcome).toBe("matched");
    expect(out.entityId).toBe("Q100");
    expect(w.calls.length).toBeLessThanOrEqual(6);
    expect(sources.every((u) => !u.includes("wbsearchentities"))).toBe(true); // identity search is not a provenance source
    expect(sources.length).toBe(w.calls.length - 2);
  });

  it("a product entity on a subpath of the company's domain is not the company (live OpenAI/Anthropic shape)", async () => {
    const products = { Q100: { id: "Q100", claims: { P856: ENTITY.claims.P856 } }, Q300: { id: "Q300", claims: { P856: [str("https://acme-robotics.example/arm"), str("https://arm.example/")] } } };
    const out = await run(wikidata({ search: { search: [{ id: "Q100" }, { id: "Q300" }] }, candidates: products }));
    expect(out.outcome).toBe("matched");
    expect(out.entityId).toBe("Q100");
  });

  it("no match and ambiguous names store nothing", async () => {
    expect((await run(wikidata({ candidates: { Q100: { id: "Q100", claims: { P856: [str("https://acme-robotics-fans.example/")] } } } }))).outcome).toBe("no_match");
    expect((await run(wikidata({ search: { search: [] } }))).outcome).toBe("no_match");
    const twins = { Q100: { id: "Q100", claims: { P856: ENTITY.claims.P856 } }, Q200: { id: "Q200", claims: { P856: [str("https://acme-robotics.example")] } } };
    const ambiguous = await run(wikidata({ candidates: twins }));
    expect(ambiguous).toEqual({ outcome: "ambiguous", entityId: null, facts: {}, leadership: [] });
  });

  it("a 429 throws once (no retry) and malformed JSON throws", async () => {
    const limited = wikidata({ status: 429 });
    await expect(run(limited)).rejects.toThrow(/HTTP 429/);
    expect(limited.calls.length).toBe(1);
    await expect(run(wikidata({ malformed: "wbgetentities" }))).rejects.toThrow(/malformed/);
    await expect(run(wikidata({ search: { nope: true } }))).rejects.toThrow(/malformed/);
  });
});

describe("Step D canary: Wikidata through the reviewed plan, write and rollback contract", () => {
  it("plans Wikidata rows when the official site is not ATS-linked, writes them, and a re-run plans nothing", async () => {
    wd = wikidata();
    const pg = await db();
    try {
      const p = await plan(pg);
      expect(p.companies[0].outcome).toBe("not_ats_linked");
      expect(p.companies[0].wikidata).toEqual({ outcome: "matched", entity_id: "Q100", error: null });
      expect(p.summary.by_table).toEqual({ company_profile_facts: 8, company_profile_leadership: 2, company_profile_news: 0, company_profile_refresh_state: 1 });
      expect(p.actions.filter((a) => a.table === "company_profile_facts").every((a) => a.after.source_kind === "wikidata")).toBe(true);
      expect(p.sources.some((s) => s.kind === "wikidata")).toBe(true);
      expect(p.actions.at(-1)!.table).toBe("company_profile_refresh_state"); // success recorded last

      const j = journal();
      const report = await canary.runCanaryWrite({ plan: p, binding: bind(p), store: pgStore(pg), fetchPage: officialPages(), sleep, journal: j, resume: false, now: later });
      expect(report.applied).toBe(11);
      const facts = (await pg.query<any>("SELECT fact_key, source_kind, source_url FROM public.company_profile_facts ORDER BY fact_key")).rows;
      expect(facts).toHaveLength(8);
      expect(new Set(facts.map((f) => `${f.source_kind}|${f.source_url}`))).toEqual(new Set(["wikidata|https://www.wikidata.org/wiki/Q100"]));

      const again = await plan(pg, { now: () => later() });
      expect(again.actions).toEqual([]); // idempotent: fresh refresh state, nothing to write
      expect(again.companies[0].outcome).toBe("cache_hit");

      const back = await canary.runCanaryRollback({ plan: p, binding: { ...bind(p), checkExpiry: false }, store: pgStore(pg), journal: j });
      expect(back.results.removed).toBe(11);
      for (const t of TABLES) expect((await pgStore(pg).rows(t, [CO])).length).toBe(0);
    } finally { await pg.close(); }
  }, 60_000);

  it("official facts always win over Wikidata, and Wikidata never creates a conflict with them", async () => {
    wd = wikidata();
    const pg = await db();
    try {
      await pg.query(`INSERT INTO public.company_profile_facts(company_id,fact_key,fact_value,source_url,source_kind,retrieved_at) VALUES ($1,'overview','Official overview','https://acme-robotics.example/about','official_site','2026-10-01T00:00:00Z')`, [CO]);
      await pg.query(`INSERT INTO public.company_profile_refresh_state(company_id,status,last_attempted_at,last_succeeded_at,next_refresh_at) VALUES ($1,'stale','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','2026-10-08T00:00:00Z')`, [CO]);
      const p = await plan(pg);
      const overview = p.companies[0].proposed.facts.find((f) => f.fact_key === "overview")!;
      expect(overview).toMatchObject({ fact_value: "Official overview", source_kind: "official_site", fact_status: "fresh", conflict_value: null });
      expect(p.actions.some((a) => a.table === "company_profile_facts" && a.after.fact_key === "overview")).toBe(false);
    } finally { await pg.close(); }
  }, 60_000);

  it("Wikidata failures, no match and ambiguity plan zero actions; without a Wikidata fetcher the plan is unchanged", async () => {
    for (const [w, outcome] of [[wikidata({ status: 429 }), "fetch_failed"], [wikidata({ search: { search: [] } }), "no_match"],
      [wikidata({ candidates: { Q100: { id: "Q100", claims: { P856: ENTITY.claims.P856 } }, Q200: { id: "Q200", claims: { P856: ENTITY.claims.P856 } } } }), "ambiguous"]] as const) {
      wd = w;
      const pg = await db();
      try {
        const p = await plan(pg);
        expect(p.companies[0].wikidata?.outcome).toBe(outcome);
        expect(p.actions).toEqual([]);
        expect(JSON.stringify(p)).not.toMatch(/apikey|service_role/);
      } finally { await pg.close(); }
    }
    const pg = await db();
    try {
      const p = await plan(pg, { fetchWikidata: undefined });
      expect(p.companies[0]).not.toHaveProperty("wikidata");
      expect(p.actions).toEqual([]);
    } finally { await pg.close(); }
  }, 60_000);

  it("without the 20261124a migration the first Wikidata row is refused by the database and journaled, nothing applied", async () => {
    wd = wikidata();
    const pg = await db({ stepD: false });
    try {
      const p = await plan(pg);
      const j = journal();
      await expect(canary.runCanaryWrite({ plan: p, binding: bind(p), store: pgStore(pg), fetchPage: officialPages(), sleep, journal: j, resume: false, now: later })).rejects.toThrow();
      expect(j.value!.steps.filter((s) => s.status === "applied")).toHaveLength(0);
      expect((await pg.query("SELECT 1 FROM public.company_profile_facts")).rows).toHaveLength(0);
    } finally { await pg.close(); }
  }, 60_000);

  it("the write fails closed if a Wikidata source changed since the plan (source drift)", async () => {
    wd = wikidata();
    const pg = await db();
    try {
      const p = await plan(pg);
      const edited = { ...ENTITY, descriptions: { en: { value: "Edited after the plan" } } };
      const drifted = async (url: string) => (url.includes("props=claims%7Cdescriptions")
        ? { url, text: JSON.stringify({ entities: { Q100: edited } }), status: 200, contentType: "application/json" }
        : officialPages()(url));
      await expect(canary.runCanaryWrite({ plan: p, binding: bind(p), store: pgStore(pg), fetchPage: drifted, sleep, journal: journal(), resume: false, now: later })).rejects.toThrow(/Source drift/);
      expect((await pg.query("SELECT 1 FROM public.company_profile_facts")).rows).toHaveLength(0);
    } finally { await pg.close(); }
  }, 60_000);
});

describe("20261124a migration", () => {
  it("keeps every check of the SELECT-only preflight passing and still rejects unknown kinds and keys", async () => {
    const pg = await db();
    try {
      const preflight = fs.readFileSync(path.join(process.cwd(), "supabase/scripts/preflight-company-profile-20261122a.sql"), "utf8").split(/^-- 2\. Exact row counts.*$/m)[0];
      const rows = (await pg.exec(preflight)).at(-1)!.rows as Array<{ ok: boolean; check_name: string }>;
      expect(rows.length).toBe(77);
      expect(rows.filter((r) => !r.ok).map((r) => r.check_name)).toEqual([]);
      await pg.exec(MIGRATIONS[1]); // re-running is harmless
      const bad = (key: string, kind: string) => pg.query(`INSERT INTO public.company_profile_facts(company_id,fact_key,fact_value,source_url,source_kind,retrieved_at) VALUES ($1,$2,'v','https://www.wikidata.org/wiki/Q1',$3,now())`, [CO, key, kind]);
      await expect(bad("ceo", "wikidata")).rejects.toThrow();
      await expect(bad("overview", "google_news")).rejects.toThrow();
      await expect(bad("funding_stage", "wikidata")).resolves.toBeDefined();
    } finally { await pg.close(); }
  }, 60_000);
});

describe("industry tags and source labels (deterministic)", () => {
  it("tags from the description, or from at least 3 job titles, at most 3 tags", () => {
    expect(deriveIndustryTags("American robotics and machine learning company")).toEqual(["AI & machine learning"]);
    expect(deriveIndustryTags(null, ["Security Engineer"])).toEqual([]);
    expect(deriveIndustryTags(null, ["Database Engineer", "Database Administrator", "Senior Database Developer"])).toEqual(["Developer tools"]);
    expect(deriveIndustryTags("A payments, cloud computing, cybersecurity and machine learning company").length).toBe(3);
    expect(deriveIndustryTags("")).toEqual([]);
  });

  it("labels Wikidata provenance honestly", () => {
    expect(companySourceLabel("https://www.wikidata.org/wiki/Q1")).toBe("Wikidata");
    expect(companySourceLabel("https://acme.example/about", "wikidata")).toBe("Wikidata");
    expect(companySourceLabel("https://acme.example/about", "official_site")).toBe("Official source");
  });
});
