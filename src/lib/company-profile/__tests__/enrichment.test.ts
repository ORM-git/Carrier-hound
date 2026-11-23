import fs from "node:fs";
import path from "node:path";
import { PGlite, types } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import * as canary from "../canary";
import type { CanaryJournal, CanaryPlan, CanaryRow, CanaryStore, CanaryTable, FetchedPage, JournalIO } from "../canary";
import { extractOfficialCompanyPage, isAllowedCompanyProfileWriteTarget, parseEnrichmentOptions, reconcileCompanyFacts } from "../enrichment";
import fixture from "@/../scripts/fixtures/company-profile/official-pages.json";

describe("official company enrichment", () => {
  it("defaults to dry-run and requires an explicit positive bounded cap", () => {
    expect(parseEnrichmentOptions(["--max-rows", "8"])).toEqual({ write: false, cap: 8 });
    expect(parseEnrichmentOptions(["--write", "--max-rows", "10"]).write).toBe(true);
    for (const cap of [undefined, "0", "-1", "1.5", "101"]) {
      expect(() => parseEnrichmentOptions(cap === undefined ? [] : ["--max-rows", cap])).toThrow("--max-rows");
    }
    expect(isAllowedCompanyProfileWriteTarget("https://staging-ref.supabase.co", "staging", "staging-ref")).toBe(true);
    expect(isAllowedCompanyProfileWriteTarget("https://Staging-Ref.Supabase.Co.", "staging", "staging-ref")).toBe(true);
    expect(isAllowedCompanyProfileWriteTarget("http://127.0.0.1:54321", "local", "local")).toBe(true);
    expect(isAllowedCompanyProfileWriteTarget("http://[::1]:54321", "local", "local")).toBe(true);
    expect(isAllowedCompanyProfileWriteTarget("https://remote.example", "local", "local")).toBe(false);
    expect(isAllowedCompanyProfileWriteTarget("https://szakevhxhwpeskidvtfs.supabase.co.", "local", "local")).toBe(false);
    expect(isAllowedCompanyProfileWriteTarget("https://SZakevhxhwpeskidvtfs.SUPABASE.CO.", "staging", "szakevhxhwpeskidvtfs")).toBe(false);
    expect(isAllowedCompanyProfileWriteTarget("https://staging-ref.supabase.co", "production", "staging-ref")).toBe(false);
  });
  it("extracts only verified first-party structured facts, leaders, and dated news", () => {
    const result = extractOfficialCompanyPage({ ...fixture.affirm, retrievedAt: "2026-11-22T10:00:00Z", atsBoards: [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }] });
    expect(result.verified).toBe(true);
    expect(result.facts.headquarters?.value).toBe("San Francisco, California, US");
    expect(result.facts.founded_year?.value).toBe("2012");
    expect(result.leadership[0]?.role).toBe("CEO");
    expect(result.facts.linkedin_url?.value).toBe("https://www.linkedin.com/company/affirm");
    expect(result.facts.twitter_url?.value).toBe("https://x.com/affirm");
    expect(result.news[0]?.publishedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("extracts affiliated leaders and dated news from an ATS-linked about subpage", async () => {
    const loaded = await import("../enrichment");
    const extractSubpage = (loaded as typeof loaded & { extractOfficialCompanySubpage?: (input: any) => ReturnType<typeof extractOfficialCompanyPage> }).extractOfficialCompanySubpage;
    expect(typeof extractSubpage).toBe("function");
    if (!extractSubpage) return;
    const atsBoards = [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }];
    const verifiedHomepage = extractOfficialCompanyPage({ ...fixture.affirm, atsBoards });
    const result = extractSubpage({ ...fixture.affirmSubpage, atsBoards, homepageContext: { verified: verifiedHomepage.verified, canonicalDomain: fixture.affirm.canonicalDomain, homepageUrl: fixture.affirm.pageUrl, homepageHtml: fixture.affirm.html }, retrievedAt: "2026-11-22T10:00:00Z" });
    expect(result.verified).toBe(true);
    expect(result.leadership).toEqual([expect.objectContaining({ name: "Max Levchin", role: "CEO" })]);
    expect(result.news).toEqual([expect.objectContaining({ headline: "Company update" })]);
    expect(extractSubpage({ ...fixture.affirmSubpage, pageUrl: "https://attacker.example/about/leadership-news", atsBoards, homepageContext: { verified: true, canonicalDomain: fixture.affirm.canonicalDomain, homepageUrl: fixture.affirm.pageUrl, homepageHtml: fixture.affirm.html } }).verified).toBe(false);
  });

  it("routes repeated observations through timestamp-only conflict handlers", async () => {
    const loaded = await import("../enrichment");
    const handlers = (loaded as typeof loaded & { companyProfileObservationRpc?: any }).companyProfileObservationRpc;
    expect(handlers).toEqual({
      leadership: "record_company_profile_leadership_observation",
      news: "record_company_profile_news_observation",
    });
  });

  it("deduplicates the same leader and news item found on two pages", async () => {
    const loaded = await import("../enrichment");
    const dedupeLeaders = (loaded as typeof loaded & { dedupeLeadershipObservations?: (rows: any[]) => any[] }).dedupeLeadershipObservations;
    const dedupeNews = (loaded as typeof loaded & { dedupeCompanyNewsObservations?: (rows: any[]) => any[] }).dedupeCompanyNewsObservations;
    expect(typeof dedupeLeaders).toBe("function");
    expect(typeof dedupeNews).toBe("function");
    if (!dedupeLeaders || !dedupeNews) return;

    const atsBoards = [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }];
    const homepage = extractOfficialCompanyPage({ ...fixture.affirm, atsBoards, retrievedAt: "2026-11-21T10:00:00.000Z" });
    const subpage = loaded.extractOfficialCompanySubpage({
      ...fixture.affirmSubpage,
      atsBoards,
      homepageContext: { verified: homepage.verified, homepageUrl: fixture.affirm.pageUrl, homepageHtml: fixture.affirm.html },
      retrievedAt: "2026-11-22T10:00:00.000Z",
    });
    expect(homepage.leadership).toHaveLength(1);
    expect(subpage.leadership).toHaveLength(1);
    expect(homepage.news).toHaveLength(1);
    expect(subpage.news).toHaveLength(1);

    const leaders = dedupeLeaders([homepage, subpage].flatMap((page) => page.leadership.map((person) => ({
      company_id: "company-1", name: person.name, role: person.role, role_as_of: person.roleAsOf,
      source_url: person.sourceUrl, retrieved_at: person.retrievedAt,
    }))));
    const news = dedupeNews([homepage, subpage].flatMap((page, index) => page.news.map((item) => ({
      company_id: "company-1", headline: item.headline, published_at: item.publishedAt,
      source_url: item.sourceUrl, excerpt: item.excerpt, retrieved_at: index === 0 ? "2026-11-21T10:00:00.000Z" : "2026-11-22T10:00:00.000Z",
    }))));
    expect(leaders).toHaveLength(1);
    expect(leaders[0]).toMatchObject({ source_url: homepage.leadership[0].sourceUrl, retrieved_at: "2026-11-22T10:00:00.000Z" });
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ headline: homepage.news[0].headline, published_at: homepage.news[0].publishedAt, source_url: homepage.news[0].sourceUrl, excerpt: homepage.news[0].excerpt, retrieved_at: "2026-11-22T10:00:00.000Z" });
  });

  it("rejects unlinked ATS boards, leaders affiliated with another company, and personal profile links", () => {
    const unrelatedBoard = { ...fixture.affirm, atsBoards: [{ ats_type: "greenhouse", slug: "unrelated", careers_url: "https://boards.greenhouse.io/unrelated" }] };
    expect(extractOfficialCompanyPage(unrelatedBoard).verified).toBe(false);

    const wrongAffiliation = {
      ...fixture.affirm,
      atsBoards: [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }],
      html: fixture.affirm.html.replace('"@id":"https://affirm.com/#organization","name":"Affirm"}', '"@id":"https://affirm.com/#organization","name":"Affirm"}').replace('"worksFor":{"@id":"https://affirm.com/#organization","name":"Affirm"}', '"worksFor":{"@id":"https://customer.com/#organization","name":"Customer"}'),
    };
    expect(extractOfficialCompanyPage(wrongAffiliation).leadership).toEqual([]);

    const personalSocial = {
      ...fixture.affirm,
      atsBoards: [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }],
      html: fixture.affirm.html.replace('"https://www.linkedin.com/company/affirm","https://x.com/affirm"', '"https://www.linkedin.com/in/customer-person","https://x.com/employee-handle"').replace('https://www.linkedin.com/company/affirm', 'https://www.linkedin.com/in/customer-person'),
    };
    const personalResult = extractOfficialCompanyPage(personalSocial);
    expect(personalResult.facts.linkedin_url).toBeUndefined();
    expect(personalResult.facts.twitter_url).toBeUndefined();
  });

  it("rejects a namesake org and preserves existing values on empty or conflicting coverage", () => {
    expect(extractOfficialCompanyPage({ ...fixture.namesake, retrievedAt: "2026-11-22T10:00:00Z" }).verified).toBe(false);
    const current = { headquarters: { value: "Toronto", sourceUrl: "https://affirm.com/about", sourceKind: "official_site" as const, retrievedAt: "2026-01-01T00:00:00Z" } };
    expect(reconcileCompanyFacts(current, {}, true)).toEqual(current);
    const conflict = reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, value: "Vancouver", retrievedAt: "2026-11-22T10:00:00Z" } }, true);
    expect(conflict.headquarters?.value).toBe("Toronto");
    expect((conflict.headquarters as any)?.status).toBe("conflict");
    expect((conflict.headquarters as any)?.conflict?.value).toBe("Vancouver");
    expect(reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, value: "Toronto" } }, false)).toEqual(current);
    expect(reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, retrievedAt: "2025-01-01T00:00:00Z" } }, true)).toEqual(current);
    const newer = reconcileCompanyFacts({ headquarters: { ...current.headquarters, observedAt: "2020-01-01T00:00:00Z" } }, { headquarters: { ...current.headquarters, value: "Vancouver", retrievedAt: "2026-11-22T10:00:00Z", observedAt: "2026-11-20T00:00:00Z" } }, true);
    expect(newer.headquarters?.value).toBe("Vancouver");
    expect((newer.headquarters as any)?.status).toBe("fresh");
  });

  it("honors robots wildcards and every user-agent in a group", async () => {
    const loaded = await import("../enrichment");
    const robotsAllows = (loaded as typeof loaded & { robotsAllows?: (robots: string, path: string) => boolean }).robotsAllows;
    expect(typeof robotsAllows).toBe("function");
    if (!robotsAllows) return;
    expect(robotsAllows("User-agent: *\nDisallow: /news/*", "/news/private")).toBe(false);
    expect(robotsAllows("User-agent: *\nUser-agent: OtherBot\nDisallow: /", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /news/*\nAllow: /news/public$", "/news/public")).toBe(true);
  });

  it("keeps a resumable cursor before the company that stopped the batch", async () => {
    const loaded = await import("../enrichment");
    const processCompanyBatch = (loaded as typeof loaded & { processCompanyBatch?: (...args: any[]) => Promise<any> }).processCompanyBatch;
    expect(typeof processCompanyBatch).toBe("function");
    if (!processCompanyBatch) return;
    const attempted: string[] = [];
    const progress = await processCompanyBatch(
      [{ id: "company-a" }, { id: "company-b" }, { id: "company-c" }],
      null,
      async (company: { id: string }) => {
        attempted.push(company.id);
        if (company.id === "company-a") throw new Error("HTTP 403 forbidden");
      },
    );
    expect(attempted).toEqual(["company-a"]);
    expect(progress.nextAfterId).toBeNull();
    expect(progress.error?.companyId).toBe("company-a");
  });

  it("caches fresh profiles but rechecks stale facts, leaders, news, and conflict records", async () => {
    const loaded = await import("../enrichment");
    const evaluate = (loaded as typeof loaded & { evaluateCompanyProfileFreshness?: (input: any) => any }).evaluateCompanyProfileFreshness;
    expect(typeof evaluate).toBe("function");
    if (!evaluate) return;
    const now = "2026-11-22T00:00:00.000Z";
    const fresh = evaluate({
      now,
      state: { status: "fresh", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" },
      facts: { overview: { value: "Acme", retrievedAt: "2026-11-21T00:00:00.000Z" } },
      leadership: [{ retrievedAt: "2026-11-21T00:00:00.000Z" }],
    });
    expect(fresh).toMatchObject({ status: "fresh", shouldRefresh: false });
    expect(evaluate({ now, state: { status: "fresh", last_succeeded_at: "2026-11-22T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" }, facts: { overview: { value: "Partial but valid profile", retrievedAt: "2026-11-22T00:00:00.000Z" } }, leadership: [] })).toMatchObject({ status: "fresh", shouldRefresh: false });
    expect(evaluate({ now, state: { status: "fresh", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" }, facts: { overview: { value: "old", retrievedAt: "2026-01-01T00:00:00.000Z" } }, leadership: [{ retrievedAt: "2026-11-21T00:00:00.000Z" }] })).toMatchObject({ status: "stale", shouldRefresh: true });
    expect(evaluate({ now, state: { status: "fresh", last_succeeded_at: "2026-10-01T00:00:00.000Z", next_refresh_at: "2026-10-08T00:00:00.000Z" }, facts: {}, leadership: [{ retrievedAt: "2026-10-01T00:00:00.000Z" }] })).toMatchObject({ status: "stale", shouldRefresh: true });
    expect(evaluate({ now, state: { status: "fresh", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" }, facts: { overview: { retrievedAt: "2026-11-21T00:00:00.000Z" } }, leadership: [{ retrievedAt: "2026-11-21T00:00:00.000Z" }], news: [{ publishedAt: "2026-11-20T00:00:00.000Z", retrievedAt: "2026-01-01T00:00:00.000Z" }] })).toMatchObject({ status: "stale", shouldRefresh: true });
    expect(evaluate({ now, state: { status: "conflict", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" }, facts: { headquarters: { value: "Toronto", retrievedAt: "2026-11-21T00:00:00.000Z", status: "conflict" } }, leadership: [] })).toMatchObject({ status: "conflict", shouldRefresh: false });
    expect(evaluate({ now, state: { status: "stale", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-23T00:00:00.000Z", last_error: "HTTP 503" }, facts: { overview: { value: "old", retrievedAt: "2026-01-01T00:00:00.000Z" } }, leadership: [] })).toMatchObject({ status: "stale", shouldRefresh: false });
    expect(evaluate({ now: "2026-11-24T00:00:00.000Z", state: { status: "stale", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-23T00:00:00.000Z", last_error: "HTTP 503" }, facts: { overview: { value: "old", retrievedAt: "2026-01-01T00:00:00.000Z" } }, leadership: [] })).toMatchObject({ status: "stale", shouldRefresh: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Production canary: offline only (mocked official pages + a disposable in-memory Postgres).
// ---------------------------------------------------------------------------------------------
const REF = canary.COMPANY_PROFILE_PRODUCTION_PROJECT_REF;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const A = "11111111-1111-4111-8111-111111111111"; // Affirm: stale, verified, gets the writes
const B = "22222222-2222-4222-8222-222222222222"; // fresh profile: cache hit, no writes
const C = "33333333-3333-4333-8333-333333333333"; // only a disabled ATS board: no evidence, no writes
const FAKE_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXN5bnRoZXRpYw";
const NOW = new Date("2026-11-22T10:00:00.000Z");
const PLAN_FIXTURE = path.join(process.cwd(), "scripts/fixtures/company-profile/canary-plan.json");
const MIGRATION = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261122a_company_profile_data.sql"), "utf8");
const TABLES = Object.keys(canary.CANARY_TABLES) as CanaryTable[];
const LEADER_ID = "44444444-4444-4444-8444-444444444444";

async function disposableDb(options: { migrate?: boolean } = {}) {
  const db = new PGlite({ parsers: { [types.TIMESTAMPTZ]: (v: string) => v, [types.DATE]: (v: string) => v } });
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.companies(id uuid PRIMARY KEY, name text, canonical_domain text);
    CREATE TABLE public.company_boards(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, ats_type text, slug text, careers_url text, enabled boolean);
    CREATE TABLE public.jobs(id uuid PRIMARY KEY, company_id uuid, posted_at timestamptz, status text, is_active boolean);`);
  if (options.migrate === false) return db;
  await db.exec(MIGRATION);
  await db.exec(`
    INSERT INTO public.companies VALUES ('${A}','Affirm','affirm.com'), ('${B}','Fresh Co','fresh.example'), ('${C}','Quiet Co','quiet.example');
    INSERT INTO public.company_boards(id,company_id,ats_type,slug,careers_url,enabled) VALUES
      ('66666666-6666-4666-8666-666666666661','${A}','greenhouse','affirm','https://boards.greenhouse.io/affirm',true),
      ('66666666-6666-4666-8666-666666666662','${B}','greenhouse','fresh','https://boards.greenhouse.io/fresh',true),
      ('66666666-6666-4666-8666-666666666663','${C}','greenhouse','quiet','https://boards.greenhouse.io/quiet',false);
    INSERT INTO public.company_profile_facts(company_id,fact_key,fact_value,source_url,source_kind,retrieved_at) VALUES
      ('${A}','overview','Old overview','https://affirm.com/old','official_site','2025-01-01T00:00:00Z'),
      ('${B}','overview','Fresh overview','https://fresh.example/about','official_site','2026-11-20T00:00:00Z');
    INSERT INTO public.company_profile_leadership(id,company_id,name,role,role_as_of,source_url,retrieved_at) VALUES
      ('${LEADER_ID}','${A}','Max Levchin','CEO','2026-01-01','https://affirm.com/about/leadership-news','2026-09-01T00:00:00Z');
    INSERT INTO public.company_profile_refresh_state(company_id,status,last_attempted_at,last_succeeded_at,next_refresh_at,last_error) VALUES
      ('${A}','stale','2026-10-31T00:00:00Z','2025-01-01T00:00:00Z','2026-11-01T00:00:00Z','HTTP 503'),
      ('${B}','fresh','2026-11-20T00:00:00Z','2026-11-20T00:00:00Z','2026-11-27T00:00:00Z',NULL);`);
  return db;
}

function pgStore(db: PGlite): CanaryStore {
  const required: Record<string, readonly string[]> = { companies: ["id", "name", "canonical_domain"], company_boards: ["id", "company_id", "ats_type", "slug", "careers_url", "enabled"], ...Object.fromEntries(TABLES.map((t) => [t, canary.CANARY_TABLES[t].columns])) };
  const where = (match: CanaryRow, offset: number) => {
    const params: string[] = [];
    const sql = Object.entries(match).map(([column, value]) => {
      if (value === null) return `${column} IS NULL`;
      params.push(value);
      return `${column} = $${offset + params.length}`;
    }).join(" AND ");
    return { sql, params };
  };
  return {
    async missingSchema() {
      const { rows } = await db.query<{ t: string; c: string }>("SELECT table_name t, column_name c FROM information_schema.columns WHERE table_schema = 'public'");
      const have = new Set(rows.map((r) => `${r.t}.${r.c}`));
      return Object.entries(required).flatMap(([t, cs]) => cs.filter((c) => !have.has(`${t}.${c}`)).map((c) => `${t}.${c}`));
    },
    async companies(ids) { return (await db.query<any>("SELECT id::text id, name, canonical_domain FROM public.companies WHERE id = ANY($1::uuid[])", [ids])).rows; },
    async boards(companyId) { return (await db.query<any>("SELECT id::text id, ats_type, slug, careers_url FROM public.company_boards WHERE company_id = $1 AND enabled LIMIT 10", [companyId])).rows; },
    async rows(table, ids) {
      const cols = canary.CANARY_TABLES[table].columns;
      const select = cols.map((c) => (c === "id" || c === "company_id" ? `${c}::text ${c}` : c)).join(",");
      const { rows } = await db.query<any>(`SELECT ${select} FROM public.${table} WHERE company_id = ANY($1::uuid[])`, [ids]);
      return rows.map((row) => canary.normalizeCanaryRow(table, row));
    },
    async insert(table, row) {
      const cols = Object.keys(row);
      await db.query(`INSERT INTO public.${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => row[c]));
    },
    async updateWhere(table, match, set) {
      const cols = Object.keys(set);
      const w = where(match, cols.length);
      return (await db.query(`UPDATE public.${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(",")} WHERE ${w.sql} RETURNING 1`, [...cols.map((c) => set[c]), ...w.params])).rows.length;
    },
    async deleteWhere(table, match) {
      const w = where(match, 0);
      return (await db.query(`DELETE FROM public.${table} WHERE ${w.sql} RETURNING 1`, w.params)).rows.length;
    },
  };
}

/** Counts mutations; optionally fails the Nth one (before it lands, or after it lands to mimic a lost response). */
function instrumented(store: CanaryStore, failAt?: { n: number; after?: boolean }) {
  const counter = { writes: 0 };
  const wrap = <F extends (...args: any[]) => Promise<any>>(fn: F) => (async (...args: any[]) => {
    counter.writes++;
    if (failAt && counter.writes === failAt.n && !failAt.after) throw new Error(`connection reset (apikey=${FAKE_KEY})`);
    const result = await fn(...args);
    if (failAt && counter.writes === failAt.n && failAt.after) throw new Error("response lost after commit");
    return result;
  }) as F;
  return { counter, store: { ...store, insert: wrap(store.insert), updateWhere: wrap(store.updateWhere), deleteWhere: wrap(store.deleteWhere) } as CanaryStore };
}

function officialPages() {
  const home = fixture.affirm.html.replace("</body>", '<a href="/about/leadership-news">About</a><a href="/about/team">Team</a><a href="/news/update">News</a></body>');
  const page = (url: string, text: string, contentType = "text/html"): FetchedPage => ({ url, text, status: 200, contentType });
  const pages = new Map<string, FetchedPage>([
    ["https://affirm.com/robots.txt", page("https://affirm.com/robots.txt", "User-agent: *\nAllow: /\n", "text/plain")],
    ["https://affirm.com/", page("https://affirm.com/", home)],
    // The same leader and the same news item appear on two pages each: one observation must be planned.
    ["https://affirm.com/about/leadership-news", page("https://affirm.com/about/leadership-news", fixture.affirmSubpage.html)],
    ["https://affirm.com/about/team", page("https://affirm.com/about/team", fixture.affirmSubpage.html)],
    ["https://affirm.com/news/update", page("https://affirm.com/news/update", fixture.affirmSubpage.html)],
  ]);
  const fetched: string[] = [];
  const fetchPage = async (url: string) => {
    fetched.push(url);
    const hit = pages.get(url);
    if (!hit) throw new Error("Company source returned HTTP 404");
    return { ...hit };
  };
  return { pages, fetched, fetchPage };
}

function memoryJournal(): JournalIO & { value: CanaryJournal | null } {
  const io = {
    value: null as CanaryJournal | null,
    read: () => (io.value ? structuredClone(io.value) : null),
    write: (j: CanaryJournal) => { io.value = structuredClone(j); },
  };
  return io;
}

const sleep = async () => undefined;
const sequentialIds = () => { let n = 0; return () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`; };
async function makePlan(db: PGlite, fetchPage = officialPages().fetchPage) {
  return canary.buildCanaryPlan({
    store: canary.readOnlyCanaryStore(pgStore(db)), fetchPage, sleep, now: () => NOW, newId: sequentialIds(),
    targetProject: REF, companyIds: [A, B, C], maxCompanies: 3, codeSha: SHA, secrets: [FAKE_KEY],
  });
}
const bind = (plan: CanaryPlan, extra: Partial<canary.CanaryBinding> = {}): canary.CanaryBinding => ({ targetProject: REF, companyIds: plan.company_ids, maxCompanies: 3, confirmDigest: plan.plan_digest, codeSha: SHA, ...extra });
const redigest = (plan: CanaryPlan): CanaryPlan => ({ ...plan, plan_digest: canary.computePlanDigest(plan) });
const later = () => new Date(NOW.getTime() + 60_000);
async function liveRows(db: PGlite) {
  const store = pgStore(db);
  const out: Record<string, CanaryRow[]> = {};
  for (const t of TABLES) out[t] = canary.sortCanaryRows(t, await store.rows(t, [A, B, C]));
  return out;
}
async function rowFor(db: PGlite, table: CanaryTable, key: CanaryRow) {
  return (await pgStore(db).rows(table, [A, B, C])).find((r) => Object.entries(key).every(([k, v]) => r[k] === v)) || null;
}
const write = (db: PGlite, plan: CanaryPlan, journal: JournalIO, opts: { store?: CanaryStore; resume?: boolean; binding?: canary.CanaryBinding } = {}) =>
  canary.runCanaryWrite({ plan, binding: opts.binding ?? bind(plan), store: opts.store ?? pgStore(db), fetchPage: officialPages().fetchPage, sleep, journal, resume: opts.resume ?? false, now: later, secrets: [FAKE_KEY] });

describe("production company-profile canary", () => {
  it("keeps the local/staging guard and accepts only the exact production identity", () => {
    const prod = `https://${REF}.supabase.co`;
    expect(isAllowedCompanyProfileWriteTarget(prod, "staging", REF)).toBe(false);
    expect(isAllowedCompanyProfileWriteTarget(prod, "production", REF)).toBe(false);
    expect(canary.isAllowedCompanyProfileProductionTarget(prod, "production", REF, true)).toBe(true);
    expect(canary.isAllowedCompanyProfileProductionTarget(`${prod}/`, "production", REF, true)).toBe(true);
    const refused: Array<[string, string, string, boolean]> = [
      [prod, "staging", REF, true], [prod, "production", REF, false], [prod, "production", "staging-ref", true], [prod, "", REF, true],
      ["https://staging-ref.supabase.co", "production", REF, true], [`http://${REF}.supabase.co`, "production", REF, true],
      [`https://${REF}.supabase.co:8443`, "production", REF, true], [`https://user:pw@${REF}.supabase.co`, "production", REF, true],
      [`https://${REF}.supabase.co.`, "production", REF, true], [`https://${REF}.supabase.co.evil.example`, "production", REF, true],
      [`https://${REF}.supabase.co/rest/v1`, "production", REF, true], ["not a url", "production", REF, true],
    ];
    for (const [url, env, ref, flag] of refused) expect(canary.isAllowedCompanyProfileProductionTarget(url, env, ref, flag), `${url} ${env} ${ref} ${flag}`).toBe(false);
    expect(canary.CANARY_ROUTING_FLAGS.has("--production")).toBe(true);
    expect(canary.CANARY_ROUTING_FLAGS.has("--write")).toBe(false);
  });

  it("requires an explicit UUID allowlist within a cap of 3 and refuses cursor or all-company selection", () => {
    const base = ["--production", "--target-project", REF, "--max-companies", "3", "--company-ids", `${A},${B.toUpperCase()}`, "--plan-out", "plan.json"];
    expect(canary.parseCanaryOptions(base)).toMatchObject({ mode: "plan", companyIds: [A, B], maxCompanies: 3, ttlHours: 24 });
    const without = (flag: string) => { const i = base.indexOf(flag); return [...base.slice(0, i), ...base.slice(i + (flag === "--production" ? 1 : 2))]; };
    const withIds = (ids: string, max = "3") => base.map((v, i) => (base[i - 1] === "--company-ids" ? ids : base[i - 1] === "--max-companies" ? max : v));
    const writeArgs = [...without("--plan-out"), "--plan", "p.json", "--journal", "j.json", "--confirm-digest", "a".repeat(64)];
    const refused: Array<[string[], RegExp]> = [
      [without("--production"), /--production is required/],
      [without("--target-project"), /exact production project ref/],
      [base.map((v) => (v === REF ? "staging-ref" : v)), /exact production project ref/],
      [without("--company-ids"), /--company-ids is required/],
      [without("--max-companies"), /--max-companies/],
      [withIds("not-a-uuid"), /only company UUIDs/],
      [withIds(`${A},`), /only company UUIDs/],
      [withIds(`${A},${A.toUpperCase()}`), /duplicate/],
      [withIds(`${A},${B},${C},44444444-4444-4444-8444-444444444445`), /over --max-companies/],
      [withIds(`${A},${B}`, "1"), /over --max-companies 1/],
      [withIds(A, "4"), /from 1 to 3/],
      [withIds(A, "0"), /from 1 to 3/],
      [[...base, "--after-id", A], /does not accept --after-id/],
      [[...base, "--max-rows", "3"], /does not accept --max-rows/],
      [[...base, "--all"], /does not accept --all/],
      [[...base, "everything"], /positional/],
      [without("--plan-out"), /--plan-out/],
      [[...writeArgs.filter((v) => v !== "--confirm-digest" && v !== "a".repeat(64)), "--write"], /--confirm-digest/],
      [[...writeArgs.filter((v) => v !== "--journal" && v !== "j.json"), "--write"], /--journal/],
      [[...writeArgs, "--write", "--rollback"], /only one of/],
      [[...base, "--write", "--plan", "p.json", "--journal", "j.json", "--confirm-digest", "a".repeat(64)], /only for the dry-run/],
      [[...base, "--code-sha", "abc"], /40-character/],
    ];
    for (const [argv, message] of refused) expect(() => canary.parseCanaryOptions(argv), argv.join(" ")).toThrow(message);
    expect(canary.parseCanaryOptions([...writeArgs.slice(0, -1), "A".repeat(64), "--resume"])).toMatchObject({ mode: "resume", confirmDigest: "a".repeat(64) });
    // The batch path is untouched: --write with --max-rows still parses there, and its guard still refuses production.
    expect(parseEnrichmentOptions(["--write", "--max-rows", "3"])).toEqual({ write: true, cap: 3, afterId: undefined });
  });

  it("binds the code SHA to a clean git HEAD, or to --code-sha outside a git checkout", () => {
    expect(canary.resolveCodeSha({ head: SHA, dirty: false })).toBe(SHA);
    expect(canary.resolveCodeSha({ head: SHA, dirty: false }, SHA)).toBe(SHA);
    expect(() => canary.resolveCodeSha({ head: SHA, dirty: true })).toThrow(/uncommitted/);
    expect(() => canary.resolveCodeSha({ head: SHA, dirty: false }, "f".repeat(40))).toThrow(/does not match/);
    expect(canary.resolveCodeSha({ head: null, dirty: false }, SHA)).toBe(SHA);
    expect(() => canary.resolveCodeSha({ head: null, dirty: false })).toThrow(/--code-sha/);
  });

  it("dry-run produces a bound, reviewable plan with zero writes", async () => {
    const db = await disposableDb();
    try {
      const before = await liveRows(db);
      const pages = officialPages();
      const { store, counter } = instrumented(pgStore(db));
      await expect(canary.readOnlyCanaryStore(store).insert("company_profile_facts", {})).rejects.toThrow(/read-only/);
      const plan = await canary.buildCanaryPlan({ store: canary.readOnlyCanaryStore(store), fetchPage: pages.fetchPage, sleep, now: () => NOW, newId: sequentialIds(), targetProject: REF, companyIds: [A, B, C], maxCompanies: 3, codeSha: SHA, secrets: [FAKE_KEY] });
      expect(counter.writes).toBe(0);
      expect(await liveRows(db)).toEqual(before);
      expect(plan).toMatchObject({ target_project: REF, company_ids: [A, B, C], code_sha: SHA, schema_version: canary.COMPANY_PROFILE_SCHEMA_VERSION, created_at: "2026-11-22T10:00:00Z", expires_at: "2026-11-23T10:00:00Z", atomic: false });
      expect(canary.computePlanDigest(plan)).toBe(plan.plan_digest);
      expect(plan.companies.map((c) => c.outcome)).toEqual(["verified", "cache_hit", "no_ats_evidence"]);
      expect(pages.fetched.every((u) => u.startsWith("https://affirm.com/"))).toBe(true);
      expect(plan.sources).toHaveLength(5);
      expect(plan.sources.every((s) => /^[0-9a-f]{64}$/.test(s.sha256) && s.fetched_at === "2026-11-22T10:00:00Z")).toBe(true);
      expect(plan.actions.every((a) => a.company_id === A)).toBe(true);
      expect(plan.actions.map((a) => a.table).slice(-3)).toEqual(["company_profile_leadership", "company_profile_news", "company_profile_refresh_state"]);
      // Duplicate observations across pages collapse to one leader (an existing row) and one news item (new).
      expect(plan.actions.filter((a) => a.table === "company_profile_leadership").map((a) => a.op)).toEqual(["update"]);
      expect(plan.actions.filter((a) => a.table === "company_profile_news").map((a) => a.op)).toEqual(["insert"]);
      expect(plan.actions.find((a) => a.table === "company_profile_leadership")?.after).toMatchObject({ id: LEADER_ID, retrieved_at: "2026-11-22T10:00:00Z", source_url: "https://affirm.com/about/leadership-news" });
      expect(plan.actions.find((a) => a.key.fact_key === "overview")?.after).toMatchObject({ fact_value: "Old overview", fact_status: "conflict", conflict_value: "Affirm helps consumers pay over time" });
      expect(JSON.stringify(plan)).not.toContain(FAKE_KEY);
      if (process.env.WRITE_CANARY_PLAN_FIXTURE === "1") fs.writeFileSync(PLAN_FIXTURE, `${JSON.stringify(plan, null, 2)}\n`);
      expect(plan).toEqual(JSON.parse(fs.readFileSync(PLAN_FIXTURE, "utf8")));
    } finally { await db.close(); }
  }, 60_000);

  it("refuses tampered, expired, mis-bound, drifted, stale or schema-less plans before any write", async () => {
    const db = await disposableDb();
    try {
      const pages = officialPages();
      const plan = await makePlan(db, pages.fetchPage);
      const attempt = (p: CanaryPlan, binding: canary.CanaryBinding, opts: { now?: Date; fetchPage?: (u: string) => Promise<FetchedPage> } = {}) => {
        const { store, counter } = instrumented(pgStore(db));
        const journal = memoryJournal();
        const run = canary.runCanaryWrite({ plan: p, binding, store, fetchPage: opts.fetchPage ?? pages.fetchPage, sleep, journal, resume: false, now: () => opts.now ?? later() });
        return { run, counter, journal };
      };
      const tampered = structuredClone(plan);
      tampered.actions[0].after.fact_value = "Injected";
      const outsider = structuredClone(plan);
      outsider.actions[0] = { ...outsider.actions[0], company_id: "55555555-5555-4555-8555-555555555555" };
      // Re-digested plans confirm their own digest, so each case isolates the binding check it names.
      const wrongProject = redigest({ ...plan, target_project: "stagingrefxxxxxxxxxx" });
      const oldSchema = redigest({ ...plan, schema_version: "20260101_old" });
      const changedHome = async (u: string) => { const p = await pages.fetchPage(u); return u === "https://affirm.com/" ? { ...p, text: `${p.text}<!-- changed -->` } : p; };
      const cases: Array<[string, () => ReturnType<typeof attempt>, RegExp]> = [
        ["tamper", () => attempt(tampered, bind(plan)), /digest mismatch/],
        ["confirmation", () => attempt(plan, bind(plan, { confirmDigest: "0".repeat(64) })), /--confirm-digest does not match/],
        ["expiry", () => attempt(plan, bind(plan), { now: new Date(Date.parse(plan.expires_at)) }), /expired/],
        ["wrong project", () => attempt(wrongProject, bind(wrongProject)), /different target/],
        ["wrong SHA", () => attempt(plan, bind(plan, { codeSha: "f".repeat(40) })), /different code SHA/],
        ["schema version", () => attempt(oldSchema, bind(oldSchema)), /schema/i],
        ["IDs", () => attempt(plan, bind(plan, { companyIds: [A] })), /do not match the plan/],
        ["cap", () => attempt(plan, bind(plan, { maxCompanies: 2 })), /do not match the plan/],
        ["outsider action", () => attempt(redigest(outsider), bind(redigest(outsider))), /outside the allowlist/],
        ["source drift", () => attempt(plan, bind(plan), { fetchPage: changedHome }), /Source drift/],
      ];
      for (const [name, start, message] of cases) {
        const { run, counter, journal } = start();
        await expect(run, name).rejects.toThrow(message);
        expect(counter.writes, name).toBe(0);
        expect(journal.value, name).toBeNull();
      }
      await expect(write(db, plan, memoryJournal(), { binding: bind(plan, { codeSha: undefined }) })).rejects.toThrow(/code SHA is required/);
      await expect(write(db, plan, memoryJournal(), { resume: true })).rejects.toThrow(/needs an existing journal/);

      await db.exec(`UPDATE public.company_profile_facts SET fact_value = 'Edited after review' WHERE company_id = '${A}'`);
      const stale = attempt(plan, bind(plan));
      await expect(stale.run).rejects.toThrow(/Stale baseline: company_profile_facts/);
      expect(stale.counter.writes).toBe(0);
    } finally { await db.close(); }

    const bare = await disposableDb({ migrate: false });
    try {
      await expect(makePlan(bare)).rejects.toThrow(/Schema 20261122a_company_profile_data is not applied/);
    } finally { await bare.close(); }
    const drifted = await disposableDb();
    try {
      const plan = await makePlan(drifted);
      await drifted.exec("ALTER TABLE public.company_profile_facts DROP COLUMN conflict_value");
      const { store, counter } = instrumented(pgStore(drifted));
      await expect(write(drifted, plan, memoryJournal(), { store })).rejects.toThrow(/missing company_profile_facts.conflict_value/);
      expect(counter.writes).toBe(0);
    } finally { await drifted.close(); }
  }, 120_000);

  it("stops on a mid-canary write failure, journals it, and resumes from exactly that step", async () => {
    const db = await disposableDb();
    try {
      const plan = await makePlan(db);
      const journal = memoryJournal();
      const error = await write(db, plan, journal, { store: instrumented(pgStore(db), { n: 3 }).store }).catch((e) => e);
      expect(error).toBeInstanceOf(canary.CanaryStoppedError);
      expect(error.seq).toBe(3);
      expect(journal.value!.steps.map((s) => s.status)).toEqual(["applied", "applied", "failed"]);
      expect(JSON.stringify(journal.value)).not.toContain(FAKE_KEY);
      expect(journal.value!.steps[2].error).toContain("[redacted");
      for (const action of plan.actions.slice(0, 2)) expect(await rowFor(db, action.table, action.key)).toEqual(action.after);
      for (const action of plan.actions.slice(2)) expect(await rowFor(db, action.table, action.key)).toEqual(action.before);

      await expect(write(db, plan, journal)).rejects.toThrow(/Journal already exists/);
      const resumed = await write(db, plan, journal, { resume: true });
      expect(resumed).toMatchObject({ mode: "resume", applied: plan.actions.length - 2, already_applied: 2, total: plan.actions.length, atomic: false });
      for (const action of plan.actions) expect(await rowFor(db, action.table, action.key)).toEqual(action.after);
      expect(await write(db, plan, journal, { resume: true })).toMatchObject({ applied: 0, already_applied: plan.actions.length });
    } finally { await db.close(); }

    // A write that landed but whose response was lost is recognised on resume, not applied twice.
    const lost = await disposableDb();
    try {
      const plan = await makePlan(lost);
      const journal = memoryJournal();
      await expect(write(lost, plan, journal, { store: instrumented(pgStore(lost), { n: 2, after: true }).store })).rejects.toThrow(/Step 2/);
      expect(journal.value!.steps[1].status).toBe("failed");
      expect(await write(lost, plan, journal, { resume: true })).toMatchObject({ applied: plan.actions.length - 2, already_applied: 2 });
    } finally { await lost.close(); }
  }, 120_000);

  it("rolls back only rows that still hold the canary's values, including after a partial run", async () => {
    const db = await disposableDb();
    try {
      const original = await liveRows(db);
      const plan = await makePlan(db);
      const journal = memoryJournal();
      await write(db, plan, journal);
      await db.exec(`UPDATE public.company_profile_facts SET fact_value = 'Edited by an operator' WHERE company_id = '${A}' AND fact_key = 'headquarters'`);
      await expect(canary.runCanaryRollback({ plan, binding: bind(plan, { confirmDigest: "1".repeat(64) }), store: pgStore(db), journal })).rejects.toThrow(/confirm-digest/);
      // Rollback does not need an unexpired plan or the same code SHA, only the digest, target and matching journal.
      const report = await canary.runCanaryRollback({ plan, binding: bind(plan, { codeSha: "f".repeat(40) }), store: pgStore(db), journal, now: () => new Date(Date.parse(plan.expires_at) + 86_400_000) });
      const inserts = plan.actions.filter((a) => a.op === "insert").length;
      const updates = plan.actions.filter((a) => a.op === "update").length;
      expect(report.results).toMatchObject({ removed: inserts - 1, restored: updates, skipped_drifted: 1, failed: 0 });
      const after = await liveRows(db);
      expect(after.company_profile_facts.find((r) => r.fact_key === "headquarters")?.fact_value).toBe("Edited by an operator");
      expect({ ...after, company_profile_facts: after.company_profile_facts.filter((r) => r.fact_key !== "headquarters") }).toEqual(original);
      expect(journal.value!.rollback!.results.find((r) => r.result === "skipped_drifted")?.key).toEqual({ company_id: A, fact_key: "headquarters" });
      if (process.env.CANARY_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.CANARY_EVIDENCE_DIR, "canary-rollback-journal.json"), `${JSON.stringify(journal.value, null, 2)}\n`);
      const rerun = await canary.runCanaryRollback({ plan, binding: bind(plan), store: pgStore(db), journal });
      expect(rerun.results).toMatchObject({ removed: 0, restored: 0, already_absent: inserts - 1, already_restored: updates, skipped_drifted: 1, failed: 0 });
      await expect(write(db, plan, journal, { resume: true })).rejects.toThrow(/rolled back/);
    } finally { await db.close(); }

    const partial = await disposableDb();
    try {
      const original = await liveRows(partial);
      const plan = await makePlan(partial);
      const journal = memoryJournal();
      await expect(write(partial, plan, journal, { store: instrumented(pgStore(partial), { n: 3 }).store })).rejects.toThrow(/Step 3/);
      const report = await canary.runCanaryRollback({ plan, binding: bind(plan), store: pgStore(partial), journal });
      expect(report.results.not_applied).toBe(1);
      expect(report.results.removed + report.results.restored).toBe(2);
      expect(await liveRows(partial)).toEqual(original);
    } finally { await partial.close(); }
  }, 120_000);

  it("redacts credentials, tokens, connection strings and URLs from printed output", () => {
    const text = canary.redactCanaryText(`failed key=${FAKE_KEY} at https://${REF}.supabase.co/rest/v1 via postgres://u:p@db.internal/x sb_secret_abc123 raw=SECRETVALUE123`, ["SECRETVALUE123"]);
    for (const leaked of [FAKE_KEY, REF, "postgres://", "sb_secret_abc123", "SECRETVALUE123", "u:p@"]) expect(text).not.toContain(leaked);
    expect(canary.redactCanaryText("x".repeat(900))).toHaveLength(500);
  });
});
