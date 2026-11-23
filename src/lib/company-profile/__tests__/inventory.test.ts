import fs from "node:fs";
import path from "node:path";
import { PGlite, types } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import * as canary from "../canary";
import type { CanaryPlan, CanaryTable } from "../canary";
import { extractOfficialCompanyPage, isAllowedCompanyProfileWriteTarget } from "../enrichment";
import * as inventory from "../inventory";
import type { InventoryStore } from "../inventory";
import { renderCanaryPlanSummary } from "../review";
import fixture from "@/../scripts/fixtures/company-profile/official-pages.json";

const MIGRATION = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261122a_company_profile_data.sql"), "utf8");
const PREFLIGHT = fs.readFileSync(path.join(process.cwd(), "supabase/scripts/preflight-company-profile-20261122a.sql"), "utf8");
const FIXTURES = path.join(process.cwd(), "scripts/fixtures/company-profile");
const TABLES = Object.keys(canary.CANARY_TABLES) as CanaryTable[];
const NOW = new Date("2026-11-22T10:00:00.000Z");
const FAKE_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXN5bnRoZXRpYw";
const REF = canary.COMPANY_PROFILE_PRODUCTION_PROJECT_REF;

// Fictional companies; UUID order is the cursor order.
const ID = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CO = {
  bigNever: ID(1),      // eligible: 9 active jobs, never enriched
  tieA: ID(2),          // eligible: 3 jobs, never enriched (ties with tieB, wins on UUID)
  tieB: ID(3),          // eligible: 3 jobs, never enriched
  staleConflict: ID(4), // eligible: conflict fact, refresh due, has leaders/news
  fresh: ID(5),         // hold: fresh cache hit
  cooling: ID(6),       // hold: stale but next_refresh_at in the future
  noDomain: ID(7),      // review queue: no canonical domain (has jobs, never guessed)
  badDomain: ID(8),     // review queue: not a hostname
  dupA: ID(9),          // review queue: shares a domain with dupB (www. ignored)
  dupB: ID(10),
  disabledAts: ID(11),  // hold: only a disabled board
  noAts: ID(12),        // hold: no board at all
  badRows: ID(13),      // hold: stored rows fail validation (error)
};

async function inventoryDb(options: { migrate?: boolean } = {}) {
  const db = new PGlite({ parsers: { [types.TIMESTAMPTZ]: (v: string) => v, [types.DATE]: (v: string) => v } });
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.companies(id uuid PRIMARY KEY, name text, canonical_domain text);
    CREATE TABLE public.company_boards(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, ats_type text, slug text, careers_url text, enabled boolean);
    CREATE TABLE public.jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, posted_at timestamptz, status text, is_active boolean);`);
  if (options.migrate === false) return db;
  await db.exec(MIGRATION);
  const companies: Array<[string, string, string | null]> = [
    [CO.bigNever, "Northwind Robotics", "northwind-robotics.example"], [CO.tieA, "Tie Alpha", "tie-alpha.example"], [CO.tieB, "Tie Beta", "tie-beta.example"],
    [CO.staleConflict, "Harbor Signal", "harbor-signal.example"], [CO.fresh, "Fresh Fields", "fresh-fields.example"], [CO.cooling, "Cooling Co", "cooling.example"],
    [CO.noDomain, "Nameonly Inc", null], [CO.badDomain, "Bad Domain", "https://user@bad:8080/x"], [CO.dupA, "Twin One", "twins.example"], [CO.dupB, "Twin Two", "www.twins.example"],
    [CO.disabledAts, "Disabled Board", "disabled.example"], [CO.noAts, "No Board", "noboard.example"], [CO.badRows, "Bad Rows", "badrows.example"],
  ];
  for (const [id, name, domain] of companies) await db.query("INSERT INTO public.companies VALUES ($1,$2,$3)", [id, name, domain]);
  for (const [id] of companies) {
    if (id === CO.noAts) continue;
    await db.query("INSERT INTO public.company_boards(id,company_id,ats_type,slug,careers_url,enabled) VALUES ($1,$2,'greenhouse',$3,$4,$5)", [id.replace(/^c/, "b"), id, `slug-${id.slice(-2)}`, `https://boards.greenhouse.io/slug-${id.slice(-2)}`, id !== CO.disabledAts]);
  }
  const jobs: Record<string, number> = { [CO.bigNever]: 9, [CO.tieA]: 3, [CO.tieB]: 3, [CO.staleConflict]: 2, [CO.fresh]: 5, [CO.noDomain]: 7 };
  for (const [id, n] of Object.entries(jobs)) for (let i = 0; i < n; i++) await db.query("INSERT INTO public.jobs(company_id,status,is_active) VALUES ($1,'active',true)", [id]);
  await db.query("INSERT INTO public.jobs(company_id,status,is_active) VALUES ($1,'expired',false)", [CO.tieB]);
  await db.exec(`
    INSERT INTO public.company_profile_facts(company_id,fact_key,fact_value,source_url,source_kind,retrieved_at,fact_status,conflict_value,conflict_source_url,conflict_source_kind,conflict_retrieved_at) VALUES
      ('${CO.staleConflict}','headquarters','Chicago, US','https://harbor-signal.example/about','official_site','2026-11-01T00:00:00Z','conflict','Toronto, CA','https://harbor-signal.example/locations','official_site','2026-11-01T00:00:00Z'),
      ('${CO.fresh}','overview','Fresh overview','https://fresh-fields.example/about','official_site','2026-11-20T00:00:00Z','fresh',NULL,NULL,NULL,NULL),
      ('${CO.cooling}','overview','Old overview','https://cooling.example/about','official_site','2025-01-01T00:00:00Z','fresh',NULL,NULL,NULL,NULL);
    INSERT INTO public.company_profile_leadership(company_id,name,role,role_as_of,source_url,retrieved_at) VALUES
      ('${CO.staleConflict}','Ada Example','Chief Executive Officer',NULL,'https://harbor-signal.example/about/team','2026-11-01T00:00:00Z'),
      ('${CO.fresh}','Bo Example','CEO','2025-02-01','https://fresh-fields.example/about/team','2026-11-20T00:00:00Z');
    INSERT INTO public.company_profile_news(company_id,headline,published_at,source_url,excerpt,retrieved_at) VALUES
      ('${CO.staleConflict}','Harbor opens office','2026-10-01T00:00:00Z','https://harbor-signal.example/news/office',NULL,'2026-11-01T00:00:00Z'),
      ('${CO.fresh}','Fresh launch','2026-11-10T00:00:00Z','https://fresh-fields.example/news/launch',NULL,'2026-11-20T00:00:00Z');
    INSERT INTO public.company_profile_refresh_state(company_id,status,last_attempted_at,last_succeeded_at,next_refresh_at,last_error) VALUES
      ('${CO.staleConflict}','conflict','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z','2026-11-15T00:00:00Z',NULL),
      ('${CO.fresh}','fresh','2026-11-20T00:00:00Z','2026-11-20T00:00:00Z','2026-11-27T00:00:00Z',NULL),
      ('${CO.cooling}','stale','2026-11-22T06:00:00Z','2025-01-01T00:00:00Z','2026-11-22T12:00:00Z','HTTP 503 from https://cooling.example/ apikey=${FAKE_KEY}'),
      ('${CO.badRows}','fresh','2026-11-20T00:00:00Z','2026-11-20T00:00:00Z','2026-11-27T00:00:00Z',NULL);`);
  return db;
}

function pgInventoryStore(db: PGlite, onQuery?: (method: string) => void): InventoryStore {
  const track = (m: string) => onQuery?.(m);
  return {
    async companiesAfter(afterId, limit) {
      track("companiesAfter");
      return (await db.query<any>("SELECT id::text id, name, canonical_domain FROM public.companies WHERE $1::uuid IS NULL OR id > $1::uuid ORDER BY id LIMIT $2", [afterId, limit])).rows;
    },
    async domainOwnerCounts(domains) {
      track("domainOwnerCounts");
      const { rows } = await db.query<{ d: string; n: number }>("SELECT regexp_replace(lower(canonical_domain), '^www\\.', '') d, count(*)::int n FROM public.companies WHERE regexp_replace(lower(canonical_domain), '^www\\.', '') = ANY($1::text[]) GROUP BY 1", [domains]);
      return Object.fromEntries(rows.map((r) => [r.d, r.n]));
    },
    async boards(ids) {
      track("boards");
      return (await db.query<any>("SELECT id::text id, company_id::text company_id, enabled, ats_type, slug, careers_url FROM public.company_boards WHERE company_id = ANY($1::uuid[]) ORDER BY id", [ids])).rows;
    },
    async activeJobCounts(ids) {
      track("activeJobCounts");
      const { rows } = await db.query<{ c: string; n: number }>("SELECT company_id::text c, count(*)::int n FROM public.jobs WHERE company_id = ANY($1::uuid[]) AND status = 'active' AND is_active GROUP BY 1", [ids]);
      return Object.fromEntries(rows.map((r) => [r.c, r.n]));
    },
    async rows(table, ids) {
      track(`rows:${table}`);
      const select = canary.CANARY_TABLES[table].columns.map((c) => (c === "id" || c === "company_id" ? `${c}::text ${c}` : c)).join(",");
      const rows = (await db.query<any>(`SELECT ${select} FROM public.${table} WHERE company_id = ANY($1::uuid[])`, [ids])).rows;
      // A row missing a required column (schema drift) must become one company's error, not abort the inventory.
      return rows.map((r) => (r.company_id === CO.badRows && table === "company_profile_refresh_state" ? (({ next_refresh_at: _drop, ...rest }) => rest)(r) : r));
    },
  };
}

async function snapshot(db: PGlite) {
  const out: Record<string, unknown[]> = {};
  for (const t of [...TABLES, "companies", "company_boards", "jobs"]) out[t] = (await db.query(`SELECT * FROM public.${t} ORDER BY 1`)).rows;
  return out;
}
const build = (db: PGlite, extra: Partial<Parameters<typeof inventory.buildCompanyInventory>[0]> = {}) =>
  inventory.buildCompanyInventory({ store: pgInventoryStore(db), afterId: null, limit: 1000, shortlist: 10, now: () => NOW, codeSha: "0".repeat(40), target: "local", secrets: [FAKE_KEY], ...extra });

describe("company-profile candidate inventory (read-only planner)", () => {
  it("accepts only read-only flags and refuses write, canary and selection flags", () => {
    expect(inventory.parseInventoryOptions(["--limit", "500", "--out", "../x.json"])).toEqual({ limit: 500, afterId: null, shortlist: 10, out: "../x.json" });
    expect(inventory.parseInventoryOptions(["--limit", "1", "--after-id", CO.tieA.toUpperCase(), "--shortlist", "25", "--out", "o.json"])).toMatchObject({ afterId: CO.tieA, shortlist: 25 });
    const refused: Array<[string[], RegExp]> = [
      [["--limit", "10", "--out", "o", "--write"], /read-only and does not accept --write/],
      [["--limit", "10", "--out", "o", "--production"], /does not accept --production/],
      [["--limit", "10", "--out", "o", "--company-ids", CO.tieA], /does not accept --company-ids/],
      [["--limit", "10", "--out", "o", "--plan-out", "p"], /does not accept --plan-out/],
      [["--limit", "10", "--out", "o", "everything"], /positional/],
      [["--out", "o"], /--limit must be/], [["--limit", "0", "--out", "o"], /--limit must be/], [["--limit", "1001", "--out", "o"], /--limit must be/],
      [["--limit", "10"], /--out/], [["--limit", "10", "--out", "o", "--after-id", "nope"], /--after-id must be/],
      [["--limit", "10", "--out", "o", "--shortlist", "26"], /--shortlist must be/], [["--limit", "10", "--limit", "5", "--out", "o"], /given twice/],
    ];
    for (const [argv, message] of refused) expect(() => inventory.parseInventoryOptions(argv), argv.join(" ")).toThrow(message);
  });

  it("classifies coverage with documented overlapping categories, separate row counts and zero writes", async () => {
    const db = await inventoryDb();
    try {
      const before = await snapshot(db);
      const store = pgInventoryStore(db);
      // Structural guarantees: the store has no write method and the builder takes no page fetcher.
      expect(Object.keys(store).sort()).toEqual(["activeJobCounts", "boards", "companiesAfter", "domainOwnerCounts", "rows"]);
      const report = await build(db, { store });
      expect(await snapshot(db)).toEqual(before);
      expect(report).toMatchObject({ read_only: true, writes: 0, crawled: false, authorizes_canary: false, window: { after_id: null, scanned: 13, next_cursor: null } });
      const cats = Object.fromEntries(report.companies.map((r) => [r.company_id, r.categories]));
      expect(cats[CO.bigNever]).toEqual(["missing_facts", "missing_leadership", "missing_news", "never_enriched", "stale"]);
      expect(cats[CO.staleConflict]).toEqual(["conflict"]);
      expect(cats[CO.fresh]).toEqual(["fresh_cache_hit"]);
      expect(cats[CO.cooling]).toEqual(["missing_leadership", "missing_news", "refresh_not_due", "stale"]);
      expect(cats[CO.noDomain]).toContain("missing_domain");
      expect(cats[CO.badDomain]).toContain("missing_domain");
      expect(cats[CO.dupA]).toContain("ambiguous_identity");
      expect(cats[CO.dupB]).toContain("ambiguous_identity");
      expect(cats[CO.disabledAts]).toContain("no_enabled_ats");
      expect(cats[CO.noAts]).toContain("no_enabled_ats");
      expect(cats[CO.badRows]).toEqual(["error"]);
      const disabled = report.companies.find((r) => r.company_id === CO.disabledAts)!;
      expect(disabled.ats).toEqual({ enabled: 0, disabled: 1, boards: [] });
      expect(report.counts.companies).toEqual({
        scanned: 13, eligible: 4, missing_domain: 2, ambiguous_identity: 2, no_enabled_ats: 2, fresh_cache_hit: 1, refresh_not_due: 1,
        stale: 10, conflict: 1, never_enriched: 9, missing_facts: 9, missing_leadership: 10, missing_news: 10, error: 1,
      });
      // Row counts are rows, not companies; the bad-rows company's unreadable rows are not counted.
      expect(report.counts.rows).toEqual({ company_profile_facts: 3, company_profile_leadership: 2, company_profile_news: 2, company_profile_refresh_state: 3 });
      expect(Object.keys(report.definitions)).toEqual(expect.arrayContaining(Object.keys(report.counts.companies)));
      // Inactive jobs are not counted.
      expect(report.companies.find((r) => r.company_id === CO.tieB)!.active_jobs).toBe(3);
      // Empty sections are coverage, never errors.
      expect(report.companies.filter((r) => r.categories.includes("error")).map((r) => r.company_id)).toEqual([CO.badRows]);
      expect(report.companies.find((r) => r.company_id === CO.badRows)!.error).toMatch(/next_refresh_at missing/);
    } finally { await db.close(); }
  });

  it("ranks by documented criteria with a stable UUID tie-break and never invents a domain", async () => {
    const db = await inventoryDb();
    try {
      const report = await build(db);
      expect(report.shortlist.map((s) => s.company_id)).toEqual([CO.bigNever, CO.tieA, CO.tieB, CO.staleConflict]);
      expect(report.shortlist[0]).toMatchObject({
        rank: 1, canonical_domain: "northwind-robotics.example", active_jobs: 9,
        reasons: ["9 active jobs", "missing facts, leadership, news", "never enriched", "enabled ATS evidence: greenhouse:slug-01"],
        proposed_source_urls: ["https://northwind-robotics.example/robots.txt", "https://northwind-robotics.example/", expect.stringMatching(/^up to 3 same-host/)],
        estimated_requests: { minimum: 2, maximum: 5, maximum_with_retries: 15 },
      });
      expect(report.shortlist[3].reasons).toContain("has a conflict to re-check");
      // Shuffled store order cannot change the ranking.
      const shuffled = await inventory.buildCompanyInventory({ store: { ...pgInventoryStore(db), boards: async (ids) => (await pgInventoryStore(db).boards(ids)).reverse() }, afterId: null, limit: 1000, shortlist: 10, now: () => NOW, codeSha: null, target: "local" });
      expect(shuffled.shortlist.map((s) => s.company_id)).toEqual(report.shortlist.map((s) => s.company_id));
      // The missing-domain company has the second most jobs but goes to the review queue with no guessed domain.
      expect(report.review_queue).toEqual([
        { company_id: CO.noDomain, name: "Nameonly Inc", canonical_domain: null, active_jobs: 7, reasons: ["missing_domain"] },
        { company_id: CO.badDomain, name: "Bad Domain", canonical_domain: "https://user@bad:8080/x", active_jobs: 0, reasons: ["missing_domain"] },
        { company_id: CO.dupA, name: "Twin One", canonical_domain: "twins.example", active_jobs: 0, reasons: ["ambiguous_identity"] },
        { company_id: CO.dupB, name: "Twin Two", canonical_domain: "www.twins.example", active_jobs: 0, reasons: ["ambiguous_identity"] },
      ]);
      expect(JSON.stringify(report.shortlist)).not.toMatch(/nameonly/i);
      expect(report.holds.map((h) => [h.company_id, h.reasons])).toEqual([
        [CO.fresh, ["fresh_cache_hit"]], [CO.cooling, ["refresh_not_due"]], [CO.disabledAts, ["no_enabled_ats"]], [CO.noAts, ["no_enabled_ats"]], [CO.badRows, ["error"]],
      ]);
      expect(inventory.inventoryDomain("Example.COM/path")).toBe("example.com");
      for (const bad of [null, "", "localhost", "user@x.example", "x.example:8443", "10.0.0.1", "-bad.example"]) expect(inventory.inventoryDomain(bad), String(bad)).toBeNull();
    } finally { await db.close(); }
  });

  it("pages with a resumable cursor: no company missed or repeated, and a fixed query count per page", async () => {
    const db = await inventoryDb();
    try {
      const full = await build(db);
      const seen: string[] = [];
      let cursor: string | null = null;
      let runs = 0;
      do {
        const calls: string[] = [];
        const page = await build(db, { store: pgInventoryStore(db, (m) => calls.push(m)), afterId: cursor, limit: 4 });
        seen.push(...page.companies.map((r) => r.company_id));
        expect(calls.filter((m) => m === "companiesAfter")).toHaveLength(1);
        expect(calls.filter((m) => m !== "companiesAfter")).toHaveLength(page.window.scanned ? 3 + TABLES.length : 0);
        cursor = page.window.next_cursor;
        if (cursor) expect(cursor).toBe(page.companies[page.companies.length - 1].company_id);
        runs++;
      } while (cursor && runs < 10);
      expect(runs).toBe(4);
      expect(seen).toEqual(full.companies.map((r) => r.company_id));
      expect(new Set(seen).size).toBe(13);
      // Resuming exactly at the end reports an empty window with no cursor.
      const end = await build(db, { afterId: ID(13), limit: 5 });
      expect(end.window).toEqual({ after_id: ID(13), limit: 5, scanned: 0, next_cursor: null });
      // A store that breaks cursor order is refused rather than producing a wrong cursor.
      const unordered = { ...pgInventoryStore(db), companiesAfter: async (a: string | null, l: number) => (await pgInventoryStore(db).companiesAfter(a, l)).reverse() };
      await expect(build(db, { store: unordered })).rejects.toThrow(/out of UUID order/);
      await expect(build(db, { limit: 0 })).rejects.toThrow(/limit/);
    } finally { await db.close(); }
  });

  it("redacts secrets and URLs from stored errors in the report and summary", async () => {
    const db = await inventoryDb();
    try {
      const report = await build(db);
      const text = JSON.stringify(report) + inventory.renderInventorySummary(report);
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain("https://cooling.example/ ");
      expect(report.companies.find((r) => r.company_id === CO.cooling)!.coverage.last_error).toBe("HTTP 503 from [external URL] apikey=[redacted]");
      const summary = inventory.renderInventorySummary(report);
      expect(summary).toContain("Suggestions are not permission");
      expect(summary).toContain(`| 1 | \`${CO.bigNever}\` | Northwind Robotics |`);
    } finally { await db.close(); }
  });

  it("writes the synthetic inventory fixtures byte-for-byte", async () => {
    const db = await inventoryDb();
    try {
      const report = await build(db);
      const json = `${JSON.stringify(report, null, 2)}\n`;
      const summary = inventory.renderInventorySummary(report);
      if (process.env.WRITE_COMPANY_PROFILE_FIXTURES === "1") {
        fs.writeFileSync(path.join(FIXTURES, "inventory-example.json"), json);
        fs.writeFileSync(path.join(FIXTURES, "inventory-example.summary.md"), summary);
      }
      expect(json).toBe(fs.readFileSync(path.join(FIXTURES, "inventory-example.json"), "utf8").replace(/\r\n/g, "\n"));
      expect(summary).toBe(fs.readFileSync(path.join(FIXTURES, "inventory-example.summary.md"), "utf8").replace(/\r\n/g, "\n"));
    } finally { await db.close(); }
  });
});

describe("suggestions never authorize a write", () => {
  it("an inventory report is not a canary plan, carries no write binding, and the old batch path still refuses production", async () => {
    const db = await inventoryDb();
    try {
      const report = await build(db);
      const asPlan = report as unknown as CanaryPlan;
      expect(() => canary.verifyCanaryPlan(asPlan, { targetProject: REF, companyIds: [CO.bigNever], maxCompanies: 1, confirmDigest: "a".repeat(64) })).toThrow(/Not a company-profile canary plan/);
      expect(report).not.toHaveProperty("plan_digest");
      expect(report).not.toHaveProperty("actions");
      for (const flag of ["--inventory", "--from-inventory", "--shortlist", "--limit", "--after-id"]) {
        expect(() => canary.parseCanaryOptions(["--production", "--target-project", REF, "--max-companies", "1", "--company-ids", CO.bigNever, "--plan-out", "p.json", flag, "x"])).toThrow(/does not accept/);
      }
      // A shortlist longer than the cap cannot be passed through: the canary still caps at 3 explicit IDs.
      const ids = report.shortlist.map((s) => s.company_id).join(",");
      expect(() => canary.parseCanaryOptions(["--production", "--target-project", REF, "--max-companies", "3", "--company-ids", ids, "--plan-out", "p.json"])).toThrow(/over --max-companies 3/);
      expect(isAllowedCompanyProfileWriteTarget(`https://${REF}.supabase.co`, "production", REF)).toBe(false);
    } finally { await db.close(); }
  });
});

describe("read-only schema preflight", () => {
  const stripped = PREFLIGHT.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");

  it("contains no DDL, DML or transaction control", () => {
    expect(stripped).not.toMatch(/\b(insert|update|delete|create|alter|drop|grant|revoke|truncate|comment|copy|call|do|begin|commit|set)\b(?!\s*\()/i);
    expect(stripped.match(/\bselect\b/gi)!.length).toBeGreaterThan(5);
  });

  it("passes every check on the migrated schema and flags each gap on an unmigrated one", async () => {
    const migrated = await inventoryDb();
    const bare = await inventoryDb({ migrate: false });
    try {
      const run = async (db: PGlite) => (await db.exec(PREFLIGHT.split(/^-- 2\. Exact row counts.*$/m)[0])).at(-1)!.rows as Array<{ section: string; check_name: string; ok: boolean; detail: string }>;
      const good = await run(migrated);
      expect(good.length).toBeGreaterThan(60);
      expect(good.filter((r) => !r.ok)).toEqual([]);
      const counts = (await migrated.exec(PREFLIGHT.split(/^-- 2\. Exact row counts.*$/m)[1])).at(-1)!.rows;
      expect(counts).toEqual([
        { table_name: "company_profile_facts", row_count: 3 }, { table_name: "company_profile_leadership", row_count: 2 },
        { table_name: "company_profile_news", row_count: 2 }, { table_name: "company_profile_refresh_state", row_count: 4 },
      ]);
      const missing = await run(bare);
      expect(missing.filter((r) => r.section === "1 table").every((r) => !r.ok && r.detail === "missing")).toBe(true);
      expect(missing.filter((r) => r.check_name.startsWith("company_profile_")).every((r) => !r.ok)).toBe(true);
      expect(missing.filter((r) => r.section === "5 function" || r.section === "6 function grant").every((r) => !r.ok)).toBe(true);
      // A drifted column (wrong nullability) is caught, not just a missing table.
      await migrated.exec("ALTER TABLE public.company_profile_news ALTER COLUMN published_at DROP NOT NULL; GRANT SELECT ON public.company_profile_news TO anon;");
      const drifted = (await run(migrated)).filter((r) => !r.ok).map((r) => r.check_name);
      expect(drifted).toEqual(["company_profile_news.published_at", "public.company_profile_news: no anon/authenticated read, service_role read/write"]);
    } finally { await migrated.close(); await bare.close(); }
  });
});

describe("canary plan review summary", () => {
  it("renders the reviewed fixture plan with provenance, zero-yield reasons and non-atomic warnings, byte-for-byte", () => {
    const plan = JSON.parse(fs.readFileSync(path.join(FIXTURES, "canary-plan.json"), "utf8")) as CanaryPlan;
    const summary = renderCanaryPlanSummary(plan);
    if (process.env.WRITE_COMPANY_PROFILE_FIXTURES === "1") fs.writeFileSync(path.join(FIXTURES, "canary-plan.summary.md"), summary);
    expect(summary).toBe(fs.readFileSync(path.join(FIXTURES, "canary-plan.summary.md"), "utf8").replace(/\r\n/g, "\n"));
    expect(summary).toContain(`Plan digest: \`${plan.plan_digest}\``);
    expect(summary).toContain("**Not atomic.**");
    expect(summary).toContain("not that the owner approved it");
    expect(summary).toContain("Outcome: **cache_hit**");
    expect(summary).toContain("Outcome: **no_ats_evidence**");
    for (const source of plan.sources) expect(summary).toContain(source.sha256);
  });
});

describe("news publication dates", () => {
  it("keeps a real past publication date and rejects invalid or future ones", () => {
    const extract = (html: string) => extractOfficialCompanyPage({ html, pageUrl: fixture.affirm.pageUrl, canonicalDomain: fixture.affirm.canonicalDomain, companyName: fixture.affirm.companyName, retrievedAt: "2026-11-22T00:00:00Z", atsBoards: [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }] }).news;
    expect(extract(fixture.affirm.html)).toEqual([expect.objectContaining({ headline: "Company update", publishedAt: "2026-10-01T00:00:00.000Z" })]);
    expect(extract(fixture.affirm.html.replace('"datePublished":"2026-10-01"', '"datePublished":"2026-11-22T20:00:00Z"'))).toHaveLength(1);
    expect(extract(fixture.affirm.html.replace('"datePublished":"2026-10-01"', '"datePublished":"2027-06-01"'))).toEqual([]);
    expect(extract(fixture.affirm.html.replace('"datePublished":"2026-10-01"', '"datePublished":"last week"'))).toEqual([]);
    expect(extract(fixture.affirm.html.replace('"datePublished":"2026-10-01",', ""))).toEqual([]);
  });
});
