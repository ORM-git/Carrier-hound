// Step D: Wikidata source, pacing/cooldown/cache, allowlist preflight, canary integration, idempotency and null handling. Offline only:
// every Wikidata response and official page is a fixture; the database is a disposable PGlite with the real migrations.
import fs from "node:fs";
import path from "node:path";
import { PGlite, types } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import * as canary from "../canary";
import type { CanaryJournal, CanaryRow, CanaryStore, CanaryTable, FetchedPage, JournalIO } from "../canary";
import { companySourceLabel } from "../industryTags";
import { bareHost, employeeBand, extractWikidataProfile, fetchWikidataProfile, parseRetryAfter, WIKIDATA_API, wikidataClient, WikidataHttpError } from "../wikidata";

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
    if (overrides.status) throw new WikidataHttpError(overrides.status, null);
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
    async factAllowlists() { return (await pg.query<any>("SELECT * FROM public.company_profile_fact_allowlists()")).rows; },
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
function officialPages(home = "<html><body><a href='/careers'>Careers</a></body></html>", about?: string) {
  const pages: Record<string, FetchedPage> = {
    "https://acme-robotics.example/robots.txt": { url: "https://acme-robotics.example/robots.txt", text: "User-agent: *\nAllow: /\n", status: 200, contentType: "text/plain" },
    "https://acme-robotics.example/": { url: "https://acme-robotics.example/", text: home, status: 200, contentType: "text/html" },
    ...(about ? { "https://acme-robotics.example/about": { url: "https://acme-robotics.example/about", text: about, status: 200, contentType: "text/html" } } : {}),
  };
  return async (url: string): Promise<FetchedPage> => {
    if (url.startsWith(`${WIKIDATA_API}?`)) return wd.fetchJson(url);
    const hit = pages[url];
    if (!hit) throw new Error("Company source returned HTTP 404");
    return { ...hit };
  };
}
const OFFICIAL_HOME = `<html><head><meta name="description" content="Official overview"></head><body><a href="https://boards.greenhouse.io/acmerobotics">Careers</a><a href="/about">About</a><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@graph": [
    { "@type": "Organization", "@id": "https://acme-robotics.example/#org", name: "Acme Robotics", url: "https://acme-robotics.example", description: "Official overview" },
  ] })}</script></body></html>`;
const OFFICIAL_ABOUT = OFFICIAL_HOME.replace('<a href="/about">About</a>', "").replace(`"@graph":[`, `"@graph":[${JSON.stringify({ "@type": "Person", name: "Jane Official", jobTitle: "CEO", roleAsOf: "2026-01-01", worksFor: { "@id": "https://acme-robotics.example/#org", name: "Acme Robotics" } })},`);
const ROLLBACK_20261124A = MIGRATIONS[1].split("-- ROLLBACK")[1].split("\n").filter((l) => l.startsWith("-- ALTER TABLE")).map((l) => l.slice(3)).join("\n");
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

describe("Wikidata funding_stage: listings valid at retrievedAt", () => {
  // NOW is the file's reference clock; retrievedAt below is NOW.toISOString().
  const day = (offsetDays: number, precision = 11) => {
    const d = new Date(NOW.getTime() + offsetDays * 86_400_000);
    const p = (n: number) => String(n).padStart(2, "0");
    return time(`+${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T00:00:00Z`, precision);
  };
  const listed = (qualifiers: Record<string, unknown>) => ({ id: "Q9", claims: { P414: [item("Q2", { qualifiers: { P249: [{ snaktype: "value", datavalue: { value: "ACME" } }], ...qualifiers } })] } });
  const run = (entity: ReturnType<typeof listed>) => extractWikidataProfile({ entity, companyDomain: "x.example", labels: LABELS, humans: new Set(), retrievedAt: NOW.toISOString() }).facts.funding_stage;

  it("a past end date means the listing is over: nothing stated", () => {
    expect(run(listed({ P582: [day(-30)] }))).toBeUndefined();
    expect(run(listed({ P582: [day(-1)] }))).toBeUndefined();
  });
  it("a future end date keeps the listing valid (not unknown)", () => {
    expect(run(listed({ P582: [day(30)] }))).toMatchObject({ value: "Public (NASDAQ: ACME)" });
  });
  it("an end date given to the day is valid through that whole day, so today's end date still counts", () => {
    expect(run(listed({ P582: [day(0)] }))).toMatchObject({ value: "Public (NASDAQ: ACME)" });
  });
  it("month and year precision are valid through the end of that month or year", () => {
    const y = NOW.getUTCFullYear(), m = String(NOW.getUTCMonth() + 1).padStart(2, "0");
    expect(run(listed({ P582: [time(`+${y}-${m}-00T00:00:00Z`.replace("-00T", "-01T"), 10)] }))).toMatchObject({ value: "Public (NASDAQ: ACME)" }); // this month: still valid
    expect(run(listed({ P582: [time(`+${y}-01-01T00:00:00Z`, 9)] }))).toMatchObject({ value: "Public (NASDAQ: ACME)" }); // this year: still valid
    expect(run(listed({ P582: [time(`+${y - 1}-06-01T00:00:00Z`, 9)] }))).toBeUndefined(); // last year: over
    expect(run(listed({ P582: [time(`+${y - 1}-12-01T00:00:00Z`, 10)] }))).toBeUndefined(); // an earlier month: over
  });
  it("an end time that cannot be placed (unknown value, decade precision, no time) is treated as ended: unknown, not Public", () => {
    expect(run(listed({ P582: [{ snaktype: "somevalue" }] }))).toBeUndefined();
    expect(run(listed({ P582: [time("+2020-00-00T00:00:00Z", 8)] }))).toBeUndefined();
    expect(run(listed({ P582: [{ snaktype: "value", datavalue: { value: {} } }] }))).toBeUndefined();
  });
  it("a 'no value' end time is not an end", () => {
    expect(run(listed({ P582: [{ snaktype: "novalue" }] }))).toMatchObject({ value: "Public (NASDAQ: ACME)" });
  });
  it("a start time in the future has not begun: nothing stated", () => {
    expect(run(listed({ P580: [day(10)] }))).toBeUndefined();
  });
  it("observedAt is the start (P580) only when stated to the day, else null", () => {
    expect(run(listed({ P580: [day(-9)] }))?.observedAt).toBe(new Date(NOW.getTime() - 9 * 86_400_000).toISOString().slice(0, 10) + "T00:00:00.000Z");
    expect(run(listed({ P580: [time("+2026-00-00T00:00:00Z", 9)] }))?.observedAt).toBeNull();
    expect(run(listed({}))?.observedAt).toBeNull();
  });
});

describe("Wikidata fetch: identity, 429, malformed", () => {
  const company = { name: "Acme Robotics", canonical_domain: "acme-robotics.example" };
  const run = (w: ReturnType<typeof wikidata>, sources: string[] = []) => fetchWikidataProfile({
    company, fetchJson: w.fetchJson, now: () => NOW.toISOString(), sha256: (t) => `h${t.length}`, record: (s) => sources.push(s.requested_url),
  });

  it("matches exactly one entity whose official website is the stored domain", async () => {
    const w = wikidata();
    const sources: string[] = [];
    const out = await run(w, sources);
    expect(out.outcome).toBe("matched");
    expect(out.entityId).toBe("Q100");
    expect(w.calls.length).toBeLessThanOrEqual(6);
    expect(sources).toEqual(w.calls); // identity lookups are recorded too, so the write revalidates the match
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

  it("malformed JSON throws", async () => {
    await expect(run(wikidata({ malformed: "wbgetentities" }))).rejects.toThrow(/malformed/);
    await expect(run(wikidata({ search: { nope: true } }))).rejects.toThrow(/malformed/);
  });
});

describe("Wikidata client: global 1 req/s pacer, 429 cooldown (Retry-After), cache", () => {
  const clock = () => {
    let t = 0;
    const waits: number[] = [];
    return { waits, nowMs: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; } };
  };
  const company = (name: string) => ({ name, canonical_domain: "acme-robotics.example" });

  it("paces every request 1s apart across companies (never reset per company) and caches repeated URLs", async () => {
    const w = wikidata();
    const c = clock();
    const client = wikidataClient(w.fetchJson, { ...c, cache: true });
    await fetchWikidataProfile({ company: company("Acme Robotics"), fetchJson: client, now: () => NOW.toISOString(), sha256: (t) => t });
    const firstCompanyCalls = w.calls.length;
    await fetchWikidataProfile({ company: company("Acme Robotics Inc"), fetchJson: client, now: () => NOW.toISOString(), sha256: (t) => t });
    expect(c.waits).toEqual(Array(w.calls.length - 1).fill(1_000)); // the second company's first request waits too
    expect(w.calls.length).toBe(firstCompanyCalls + 1); // only its new search URL was fetched; the rest came from the cache
    const uncached = wikidataClient(w.fetchJson, { ...clock(), cache: false });
    await uncached(w.calls[0]);
    expect(w.calls.length).toBe(firstCompanyCalls + 2); // write-time revalidation never reads the cache
  });

  it("a 429 honours Retry-After as a global cooldown, retries at most twice, and refuses an over-cap wait", async () => {
    const c = clock();
    let n = 0;
    const flaky = async (url: string) => {
      n++;
      if (n === 1) throw new WikidataHttpError(429, 7_000);
      return { url, text: "{}", status: 200, contentType: "application/json" };
    };
    const client = wikidataClient(flaky, { ...c, cache: false });
    await client(`${WIKIDATA_API}?a=1`);
    await client(`${WIKIDATA_API}?a=2`);
    expect(c.waits).toEqual([7_000, 1_000]);

    const always = wikidata({ status: 429 });
    const c2 = clock();
    await expect(wikidataClient(always.fetchJson, { ...c2, cache: false })(`${WIKIDATA_API}?a=3`)).rejects.toThrow(/HTTP 429/);
    expect(always.calls.length).toBe(3); // 1 + 2 retries
    expect(c2.waits).toEqual([5_000, 10_000]); // no Retry-After: 5s doubling

    const tooLong = async () => { throw new WikidataHttpError(429, 600_000); };
    await expect(wikidataClient(tooLong, { ...clock(), cache: false })(`${WIKIDATA_API}?a=4`)).rejects.toThrow(/over the 120s cap/);
    const forbidden = wikidata({ status: 403 });
    await expect(wikidataClient(forbidden.fetchJson, { ...clock(), cache: false })(`${WIKIDATA_API}?a=5`)).rejects.toThrow(/HTTP 403/);
    expect(forbidden.calls.length).toBe(1); // 403 is never retried

    expect(parseRetryAfter("12", 0)).toBe(12_000);
    expect(parseRetryAfter(new Date(30_000).toUTCString(), 0)).toBe(30_000);
    expect(parseRetryAfter("soon", 0)).toBeNull();
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
      const report = await canary.runCanaryWrite({ plan: p, binding: bind(p), store: pgStore(pg), fetchPage: officialPages(), sleep, journal: j, resume: false, now: later, fetchWikidata: wd.fetchJson });
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

  it("a stored Wikidata value is replaced by a later official value (no conflict), and leaders are never concatenated", async () => {
    wd = wikidata();
    const pg = await db();
    try {
      const first = await plan(pg);
      await canary.runCanaryWrite({ plan: first, binding: bind(first), store: pgStore(pg), fetchPage: officialPages(), sleep, journal: journal(), resume: false, now: later, fetchWikidata: wd.fetchJson });
      expect((await pg.query<any>("SELECT source_kind FROM public.company_profile_facts WHERE fact_key = 'overview'")).rows[0].source_kind).toBe("wikidata");
      await pg.query("UPDATE public.company_profile_refresh_state SET next_refresh_at = '2026-11-01T00:00:00Z'");

      const p = await plan(pg, { fetchPage: officialPages(OFFICIAL_HOME, OFFICIAL_ABOUT), now: () => new Date(NOW.getTime() + 120_000) });
      expect(p.companies[0].outcome).toBe("verified");
      const overview = p.companies[0].proposed.facts.find((f) => f.fact_key === "overview")!;
      expect(overview).toMatchObject({ fact_value: "Official overview", source_kind: "official_site", fact_status: "fresh", conflict_value: null, conflict_source_kind: null });
      expect(p.companies[0].proposed.facts.every((f) => f.fact_status === "fresh" && f.conflict_value === null)).toBe(true);
      expect(p.companies[0].proposed.facts.find((f) => f.fact_key === "founded_year")?.source_kind).toBe("wikidata"); // gaps stay filled
      const newLeaders = p.actions.filter((a) => a.table === "company_profile_leadership" && a.op === "insert").map((a) => a.after.source_url);
      expect(newLeaders.length).toBeGreaterThan(0);
      expect(newLeaders.every((u) => !u!.includes("wikidata.org"))).toBe(true); // official leaders only

      // Read side: once an official leader is stored, Wikidata leaders are not shown next to it.
      const profile = (await import("../types")).sanitizeCompanyProfile({ companyId: CO, facts: {}, news: [], jobs: { status: "unknown", jobs: [] }, freshness: "fresh", leadership: [
        { id: "1", name: "Jane Doe", role: "Chief Executive Officer", sourceUrl: "https://www.wikidata.org/wiki/Q100", retrievedAt: NOW.toISOString() },
        { id: "2", name: "Jane Official", role: "CEO", sourceUrl: "https://acme-robotics.example/", retrievedAt: NOW.toISOString() },
      ] }, CO);
      expect(profile?.leadership.map((l) => l.name)).toEqual(["Jane Official"]);
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

  it("without the 20261124a allowlists the read-only preflight refuses the plan, and a reviewed mixed plan writes nothing", async () => {
    wd = wikidata();
    const bare = await db({ stepD: false });
    try {
      await expect(plan(bare)).rejects.toThrow(/20261124a_company_profile_wikidata is not applied/);
    } finally { await bare.close(); }

    const pg = await db();
    try {
      const p = await plan(pg, { fetchPage: officialPages(OFFICIAL_HOME, OFFICIAL_ABOUT) });
      const kinds = new Set(p.actions.filter((a) => a.table === "company_profile_facts").map((a) => a.after.source_kind));
      expect(kinds).toEqual(new Set(["official_site", "wikidata"])); // mixed: official rows would otherwise land first
      await pg.exec(ROLLBACK_20261124A); // allowlists narrowed back; the preflight function stays and reports them
      expect(canary.missingFactAllowlists((await pgStore(pg).factAllowlists()))).toEqual([
        "company_profile_facts.fact_key allowlist 'funding_stage'", "company_profile_facts.source_kind allowlist 'wikidata'", "company_profile_facts.conflict_source_kind allowlist 'wikidata'",
      ]);
      const j = journal();
      await expect(canary.runCanaryWrite({ plan: p, binding: bind(p), store: pgStore(pg), fetchPage: officialPages(OFFICIAL_HOME, OFFICIAL_ABOUT), sleep, journal: j, resume: false, now: later, fetchWikidata: wd.fetchJson })).rejects.toThrow(/is not applied: missing/);
      expect(j.value).toBeNull(); // refused before the journal or any row
      for (const t of TABLES) expect((await pgStore(pg).rows(t, [CO])).length).toBe(0);
      expect(p.schema_version).toBe("20261124a_company_profile_wikidata");
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
        : wd.fetchJson(url));
      await expect(canary.runCanaryWrite({ plan: p, binding: bind(p), store: pgStore(pg), fetchPage: officialPages(), sleep, journal: journal(), resume: false, now: later, fetchWikidata: drifted })).rejects.toThrow(/Source drift/);
      const searchDrift = async (url: string) => (url.includes("wbsearchentities")
        ? { url, text: JSON.stringify({ search: [{ id: "Q100" }, { id: "Q999" }] }), status: 200, contentType: "application/json" }
        : wd.fetchJson(url));
      await expect(canary.runCanaryWrite({ plan: p, binding: bind(p), store: pgStore(pg), fetchPage: officialPages(), sleep, journal: journal(), resume: false, now: later, fetchWikidata: searchDrift })).rejects.toThrow(/Source drift/);
      await expect(canary.runCanaryWrite({ plan: p, binding: bind(p), store: pgStore(pg), fetchPage: officialPages(), sleep, journal: journal(), resume: false, now: later })).rejects.toThrow(/needs a Wikidata fetcher/);
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

describe("source labels", () => {
  it("labels Wikidata provenance honestly", () => {
    expect(companySourceLabel("https://www.wikidata.org/wiki/Q1")).toBe("Wikidata");
    expect(companySourceLabel("https://acme.example/about", "wikidata")).toBe("Wikidata");
    expect(companySourceLabel("https://acme.example/about", "official_site")).toBe("Official source");
  });
});
