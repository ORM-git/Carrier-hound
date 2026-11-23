// The real Supabase inventory adapter against a simulated PostgREST server that caps every response at a few rows.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";
import { buildCompanyInventory } from "../inventory";
import { INVENTORY_COUNT_CONCURRENCY, mapWithConcurrency, readComplete, supabaseInventoryStore } from "../inventoryStore";

type Row = Record<string, unknown>;
const NOW = new Date("2026-11-22T10:00:00.000Z");
const ID = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function dataset(): Record<string, Row[]> {
  const companies: Row[] = [
    { id: ID(1), name: "Acme", canonical_domain: "acme.example" },
    ...Array.from({ length: 9 }, (_, i) => ({ id: ID(i + 2), name: `Co ${i + 2}`, canonical_domain: `co${i + 2}.example` })),
    { id: ID(11), name: "Not Acme", canonical_domain: "notacme.example" },          // ilike decoy, different identity
    { id: ID(12), name: "Acme Evil", canonical_domain: "acme.example.evil" },       // ilike decoy, different identity
    { id: ID(13), name: "Acme Holdings", canonical_domain: "HTTPS://WWW.ACME.example/jobs" }, // same identity, past the first page
  ];
  const boards: Row[] = [
    // Acme's enabled board sorts after three disabled ones: a capped first page would show no ATS evidence.
    ...[1, 2, 3].map((n) => ({ id: `b0000000-0000-4000-8000-00000000000${n}`, company_id: ID(1), enabled: false, ats_type: "lever", slug: `old-${n}`, careers_url: null })),
    { id: "b0000000-0000-4000-8000-000000000004", company_id: ID(1), enabled: true, ats_type: "greenhouse", slug: "acme", careers_url: "https://boards.greenhouse.io/acme" },
    ...companies.slice(1).map((c, i) => ({ id: `b1000000-0000-4000-8000-${String(i).padStart(12, "0")}`, company_id: c.id, enabled: true, ats_type: "greenhouse", slug: `s${i}`, careers_url: null })),
  ];
  const jobs: Row[] = [];
  const jobCounts: Record<number, number> = { 2: 6, 3: 6, 4: 2, 5: 1 };
  for (const [n, count] of Object.entries(jobCounts)) for (let i = 0; i < count; i++) jobs.push({ id: `j-${n}-${i}`, company_id: ID(Number(n)), status: "active", is_active: true });
  jobs.push({ id: "j-2-x", company_id: ID(2), status: "expired", is_active: false });
  const keys = ["overview", "website", "headquarters", "founded_year", "employee_count_range", "linkedin_url", "twitter_url"];
  const facts: Row[] = keys.map((k) => ({ company_id: ID(4), fact_key: k, fact_value: `v-${k}`, source_url: "https://co4.example/about", source_kind: "official_site", observed_at: null, fact_status: "fresh", conflict_value: null, conflict_source_url: null, conflict_source_kind: null, conflict_retrieved_at: null, conflict_observed_at: null, retrieved_at: daysAgo(2) }));
  // Co 4's fourth leader (past the first page) is 60 days old, so the profile is stale only if every row is read.
  const leadership: Row[] = [1, 2, 3, 4].map((n) => ({ id: `e0000000-0000-4000-8000-00000000000${n}`, company_id: ID(4), name: `Leader ${n}`, role: "CEO", role_as_of: null, source_url: "https://co4.example/about/team", retrieved_at: daysAgo(n === 4 ? 60 : 2) }));
  const news: Row[] = [1, 2, 3, 4, 5].map((n) => ({ id: `f0000000-0000-4000-8000-00000000000${n}`, company_id: ID(4), headline: `News ${n}`, published_at: daysAgo(10 + n), source_url: `https://co4.example/news/${n}`, excerpt: null, retrieved_at: daysAgo(2) }));
  const refresh: Row[] = [{ company_id: ID(4), status: "fresh", last_attempted_at: daysAgo(2), last_succeeded_at: daysAgo(2), next_refresh_at: daysAgo(-5), last_error: null }];
  return { companies, company_boards: boards, jobs, company_profile_facts: facts, company_profile_leadership: leadership, company_profile_news: news, company_profile_refresh_state: refresh };
}

interface ServerOptions {
  cap: number;
  countDelayMs?: number;
  failCountFor?: string;
  dropCount?: string;                                  // table whose responses omit Content-Range
  shortRead?: { table: string; atOffset: number };     // return an empty page from this offset (a lying cap)
  repeatPage?: string;                                 // ignore the offset for this table (a server repeating a page)
  onPage?: (table: string, offset: number, tables: Record<string, Row[]>) => void;
}

async function postgrest(tables: Record<string, Row[]>, options: ServerOptions) {
  const stats = { requests: 0, writes: 0, countInFlight: 0, maxCountInFlight: 0, countsStarted: 0 };
  const match = (row: Row, column: string, expr: string): boolean => {
    const [op, ...rest] = expr.split(".");
    const raw = rest.join(".");
    const value = row[column];
    if (op === "eq") return String(value) === raw;
    if (op === "gt") return String(value) > raw;
    if (op === "in") return raw.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(value));
    if (op === "ilike") return new RegExp(`^${raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(String(value ?? ""));
    throw new Error(`unsupported filter ${expr}`);
  };
  const server = http.createServer(async (req, res) => {
    stats.requests++;
    if (req.method !== "GET" && req.method !== "HEAD") { stats.writes++; res.writeHead(405).end(); return; }
    const url = new URL(req.url!, "http://x");
    const table = url.pathname.replace("/rest/v1/", "");
    let rows = [...(tables[table] || [])];
    for (const [key, expr] of Array.from(url.searchParams)) {
      if (["select", "order", "offset", "limit"].includes(key)) continue;
      if (key === "or") {
        const terms = expr.replace(/^\(|\)$/g, "").split(",").map((t: string): [string, string] => { const [col, ...r] = t.split("."); return [col, r.join(".")]; });
        rows = rows.filter((row) => terms.some(([col, e]) => match(row, col, e)));
      } else rows = rows.filter((row) => match(row, key, expr));
    }
    for (const spec of (url.searchParams.get("order") || "").split(",").filter(Boolean).reverse()) {
      const [col, dir] = spec.split(".");
      rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === "desc" ? -1 : 1));
    }
    const total = rows.length;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (req.method === "HEAD") {
      stats.countsStarted++;
      stats.countInFlight++;
      stats.maxCountInFlight = Math.max(stats.maxCountInFlight, stats.countInFlight);
      await new Promise((r) => setTimeout(r, options.countDelayMs ?? 0));
      stats.countInFlight--;
      if (options.failCountFor && url.searchParams.get("company_id") === `eq.${options.failCountFor}`) { res.writeHead(500, headers).end(JSON.stringify({ message: "statement timeout", code: "57014" })); return; }
      res.writeHead(200, { ...headers, "Content-Range": `*/${total}` }).end();
      return;
    }
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Math.min(Number(url.searchParams.get("limit") || total), options.cap);
    let page = rows.slice(options.repeatPage === table ? 0 : offset, (options.repeatPage === table ? 0 : offset) + limit);
    if (options.shortRead?.table === table && offset >= options.shortRead.atOffset) page = [];
    const select = (url.searchParams.get("select") || "*").split(",");
    const body = page.map((r) => (select[0] === "*" ? r : Object.fromEntries(select.map((c) => [c, r[c]]))));
    if (options.dropCount !== table) headers["Content-Range"] = page.length ? `${offset}-${offset + page.length - 1}/${total}` : `*/${total}`;
    options.onPage?.(table, offset, tables);
    res.writeHead(200, headers).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const client = createClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "local-test-key", { auth: { persistSession: false } });
  open.push(server);
  return { client, stats };
}

const open: http.Server[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r)))); });

const run = (client: Parameters<typeof supabaseInventoryStore>[0], extra: { afterId?: string | null; limit?: number } = {}) =>
  buildCompanyInventory({ store: supabaseInventoryStore(client), afterId: extra.afterId ?? null, limit: extra.limit ?? 1000, shortlist: 10, now: () => NOW, codeSha: null, target: "local" });

describe("Supabase inventory adapter: complete reads under a server row cap", () => {
  it("returns the same report under a 3-row cap as with no cap, with exact rows, ATS evidence, freshness and ownership", async () => {
    const capped = await postgrest(dataset(), { cap: 3 });
    const uncapped = await postgrest(dataset(), { cap: 100_000 });
    const report = await run(capped.client);
    expect(report).toEqual(await run(uncapped.client));
    expect(capped.stats.writes).toBe(0);
    const byId = Object.fromEntries(report.companies.map((r) => [r.company_id, r]));
    expect(report.window).toMatchObject({ scanned: 13, next_cursor: null });
    // ATS evidence past the first page of boards.
    expect(byId[ID(1)].ats).toMatchObject({ enabled: 1, disabled: 3 });
    // The same identity in another case/scheme/path form, on the second page of ownership candidates.
    expect(byId[ID(1)].categories).toContain("ambiguous_identity");
    expect(byId[ID(13)].categories).toContain("ambiguous_identity");
    expect(byId[ID(11)].categories).not.toContain("ambiguous_identity");
    expect(byId[ID(12)].categories).not.toContain("ambiguous_identity");
    // Every profile row counted; the stale fourth leader makes Co 4 stale rather than fresh.
    expect(byId[ID(4)].coverage).toMatchObject({ facts: 7, leadership: 4, news: 5 });
    expect(byId[ID(4)].freshness).toBe("stale");
    expect(report.counts.rows).toEqual({ company_profile_facts: 7, company_profile_leadership: 4, company_profile_news: 5, company_profile_refresh_state: 1 });
    // Inactive jobs are excluded; the tie between Co 2 and Co 3 breaks on UUID.
    expect(byId[ID(2)].active_jobs).toBe(6);
    expect(report.shortlist.slice(0, 4).map((s) => s.company_id)).toEqual([ID(2), ID(3), ID(4), ID(5)]);
    expect(report.review_queue.map((r) => r.company_id)).toEqual([ID(1), ID(13)]);
  });

  it("pages company windows through the cap with no company missed or repeated", async () => {
    const { client } = await postgrest(dataset(), { cap: 2 });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const window = await run(client, { afterId: cursor, limit: 5 });
      seen.push(...window.companies.map((r) => r.company_id));
      cursor = window.window.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(Array.from({ length: 13 }, (_, i) => ID(i + 1)));
  });

  it("refuses incomplete, shifting, duplicated, uncounted or failed reads instead of reporting partial data", async () => {
    const cases: Array<[string, ServerOptions, RegExp]> = [
      ["short read", { cap: 3, shortRead: { table: "company_profile_news", atOffset: 3 } }, /company_profile_news lookup: incomplete read, 3 of 5 rows/],
      ["no count", { cap: 3, dropCount: "company_boards" }, /ATS board lookup: no exact count returned/],
      ["rows added mid-read", { cap: 3, onPage: (t, o, tables) => { if (t === "company_profile_facts" && o === 0 && tables.company_profile_facts.length === 7) tables.company_profile_facts.push({ ...tables.company_profile_facts[0], fact_key: "zz_extra" }); } }, /row count changed during the read \(7 then 8\)/],
      ["rows removed mid-read", { cap: 3, onPage: (t, o, tables) => { if (t === "company_boards" && o === 0 && tables.company_boards.length > 10) tables.company_boards.pop(); } }, /ATS board lookup: row count changed during the read/],
      ["page repeated", { cap: 3, repeatPage: "company_profile_leadership" }, /company_profile_leadership lookup: duplicate row .* across pages/],
      ["count failure", { cap: 3, failCountFor: ID(3) }, /Active job count failed: HTTP 500/],
    ];
    for (const [name, options, message] of cases) {
      const { client, stats } = await postgrest(dataset(), options);
      await expect(run(client), name).rejects.toThrow(message);
      expect(stats.writes, name).toBe(0);
    }
  });

  it(`keeps at most ${INVENTORY_COUNT_CONCURRENCY} active-job counts in flight and stops starting new ones after a failure`, async () => {
    const ok = await postgrest(dataset(), { cap: 3, countDelayMs: 15 });
    await run(ok.client);
    expect(ok.stats.countsStarted).toBe(13);
    expect(ok.stats.maxCountInFlight).toBe(INVENTORY_COUNT_CONCURRENCY);
    const failing = await postgrest(dataset(), { cap: 3, countDelayMs: 15, failCountFor: ID(1) });
    await expect(run(failing.client)).rejects.toThrow(/Active job count failed/);
    expect(failing.stats.maxCountInFlight).toBeLessThanOrEqual(INVENTORY_COUNT_CONCURRENCY);
    expect(failing.stats.countsStarted).toBeLessThan(13);
  });

  it("bounds a single read and the concurrency helper", async () => {
    const page = async (from: number, to: number) => ({ data: Array.from({ length: Math.min(1, to - from + 1) }, (_, i) => ({ id: String(from + i) })), error: null, count: 50 });
    await expect(readComplete("Tiny cap", page, { key: (r) => r.id, maxRequests: 5 })).rejects.toThrow(/more than 5 requests/);
    expect(await readComplete("Tiny cap", page, { key: (r) => r.id, max: 3 })).toEqual([{ id: "0" }, { id: "1" }, { id: "2" }]);
    let inFlight = 0, peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return n * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
