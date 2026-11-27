// Historical visible-listing identity model, NOT the current /api/stats retained-row metric.
// Current metric integration: retainedMetricIdentityContract.test.ts. This suite retains identity DDL coverage.
// What a visible-listing day count can guarantee, on real Postgres (PGlite) with the
// REAL identity DDL from the migrations and the REAL write-column lists of both active ingestion paths.
//
// Proven here:
//  - created_at is never written by ingestion (Python engine db_columns; scripts/ingest.ts row payload),
//    so a refresh/update of an older job keeps its first-seen day and is not re-counted.
//  - A re-sent (source_id, source_job_id) or apply_url cannot create a second row.
// Qualified here (NOT proven as canonical dedupe):
//  - jobs_public is a plain projection (no DISTINCT) and dedupe_hash is advisory (#643): the same role
//    posted on two boards with different apply URLs is two rows and counts twice; a role re-posted under a
//    new board id counts again. This local model is "visible listings created during the UTC date".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";
import { HIDDEN_SOURCE_TYPE } from "@/lib/jobs/sourcePolicy";

vi.setConfig({ testTimeout: 30000 }); // each test starts a fresh in-process Postgres

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// Real DDL, taken from the migrations rather than retyped.
const APPLY_URL_UNIQUE = /CREATE UNIQUE INDEX jobs_apply_url_unique\s+ON public\.jobs \(apply_url\)\s+WHERE apply_url IS NOT NULL;/.exec(
  read("supabase/migrations/20261001_ingestion_pipeline.sql")
)![0];
const BOARD_ID_UNIQUE = /'(CREATE UNIQUE INDEX idx_jobs_source_id_source_job_id_uniq ON public\.jobs USING btree \(source_id, source_job_id\) WHERE \(\(source_id IS NOT NULL\) AND \(source_job_id IS NOT NULL\)\))'/.exec(
  read("supabase/migrations/20261116e_repair_642_concurrent_indexes.sql")
)![1];
const VIEW_WHERE = /FROM public\.jobs\s*\n\s*WHERE (is_active = true OR status = 'active');/.exec(
  read("supabase/migrations/20261116d_repair_642_identity_and_similarity_safety.sql")
)![1];

// Columns each active ingestion path writes (taken from the source).
const PY_DB_COLUMNS = Array.from(
  /db_columns = \{([\s\S]*?)\}/.exec(read("scripts/scraper/engine.py"))![1].matchAll(/"([a-z_]+)"/g),
  (m) => m[1]
);
const TS_ROW_BLOCK = /const jobsPayload = batchChunk\.map\(\(j\) => \{([\s\S]*?)return row;/.exec(read("scripts/ingest.ts"))![1];

let db: PGlite;
const TODAY = "2026-11-25";

async function insert(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  return db.query(
    `insert into public.jobs (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id, created_at`,
    cols.map((c) => row[c])
  );
}
/** Historical visible-listing model only: not the current route, timezone or retained-row semantics. */
async function visibleIdentityCount(day = TODAY) {
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from public.jobs_public
     where (source_type is null or source_type <> $1) and is_active = true and status = 'active'
       and created_at >= $2::date and created_at < ($2::date + 1)`,
    [HIDDEN_SOURCE_TYPE, day]
  );
  return r.rows[0].n;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create table public.jobs (
      id uuid primary key default gen_random_uuid(),
      title text not null, company text not null,
      apply_url text, source text, source_type text, source_id text, source_job_id text, dedupe_hash text,
      is_active boolean default true, status text default 'active',
      created_at timestamptz default now(), last_seen_at timestamptz default now(), posted_at timestamptz
    );
    ${APPLY_URL_UNIQUE}
    ${BOARD_ID_UNIQUE};
    create view public.jobs_public as select * from public.jobs where ${VIEW_WHERE};
  `);
});

// Release each in-process Postgres instance. Keeping one per test alive exhausts the worker.
afterEach(async () => {
  await db?.close();
});

describe("historical visible-listing identity guarantees (real DDL, real write columns)", () => {
  it("neither active ingestion path writes created_at", () => {
    expect(PY_DB_COLUMNS.length).toBeGreaterThan(20);
    expect(PY_DB_COLUMNS).not.toContain("created_at");
    expect(PY_DB_COLUMNS).toContain("last_seen_at");
    expect(TS_ROW_BLOCK).not.toMatch(/created_at/);
  });

  it("a refresh of yesterday's job (Python update columns) keeps created_at and is not counted today", async () => {
    const { rows } = await insert({
      title: "Engineer", company: "Acme", apply_url: "https://a.example/1", source_type: "greenhouse",
      source_id: "gh:acme", source_job_id: "1", created_at: "2026-11-24T10:00:00Z",
    });
    const before = rows[0] as any;
    // An update shaped like the engine's PATCH: only db_columns, never created_at.
    const patch = { title: "Engineer II", last_seen_at: "2026-11-25T09:00:00Z", is_active: true, status: "active" };
    expect(Object.keys(patch).every((k) => PY_DB_COLUMNS.includes(k))).toBe(true);
    await db.query("update public.jobs set title = $1, last_seen_at = $2 where id = $3", [patch.title, patch.last_seen_at, before.id]);
    const after = (await db.query<any>("select created_at from public.jobs where id = $1", [before.id])).rows[0];
    expect(new Date(after.created_at).toISOString()).toBe(new Date(before.created_at).toISOString());
    expect(await visibleIdentityCount()).toBe(0);
  });

  it("re-sending the same board id or apply_url cannot add a second row", async () => {
    await insert({ title: "Engineer", company: "Acme", apply_url: "https://a.example/1", source_type: "greenhouse", source_id: "gh:acme", source_job_id: "1", created_at: "2026-11-25T08:00:00Z" });
    await expect(insert({ title: "Engineer", company: "Acme", apply_url: "https://a.example/other", source_type: "greenhouse", source_id: "gh:acme", source_job_id: "1", created_at: "2026-11-25T09:00:00Z" })).rejects.toThrow(/duplicate key/);
    await expect(insert({ title: "Engineer", company: "Acme", apply_url: "https://a.example/1", source_type: "lever", source_id: "lv:acme", source_job_id: "x9", created_at: "2026-11-25T09:00:00Z" })).rejects.toThrow(/duplicate key/);
    expect(await visibleIdentityCount()).toBe(1);
  });

  it("QUALIFICATION: the same role on two boards (different apply URLs) is two rows and counts twice", async () => {
    const role = { title: "Engineer", company: "Acme", dedupe_hash: "same-role", created_at: "2026-11-25T08:00:00Z" };
    await insert({ ...role, apply_url: "https://boards.greenhouse.io/acme/1", source_type: "greenhouse", source_id: "gh:acme", source_job_id: "1" });
    await insert({ ...role, apply_url: "https://jobs.lever.co/acme/abc", source_type: "lever", source_id: "lv:acme", source_job_id: "abc" });
    expect(await visibleIdentityCount()).toBe(2); // dedupe_hash is advisory; jobs_public has no DISTINCT
  });

  it("QUALIFICATION: a role re-posted under a new board id is a new row first seen today", async () => {
    await insert({ title: "Engineer", company: "Acme", apply_url: "https://a.example/1", source_type: "greenhouse", source_id: "gh:acme", source_job_id: "1", created_at: "2026-11-20T08:00:00Z", is_active: false, status: "expired" });
    await insert({ title: "Engineer", company: "Acme", apply_url: "https://a.example/2", source_type: "greenhouse", source_id: "gh:acme", source_job_id: "2", created_at: "2026-11-25T08:00:00Z" });
    expect(await visibleIdentityCount()).toBe(1);
  });

  it("hidden-source rows and inactive rows are excluded; NULL source_type is kept", async () => {
    await insert({ title: "A", company: "X", apply_url: "https://x/1", source_type: null, created_at: "2026-11-25T01:00:00Z" });
    await insert({ title: "B", company: "X", apply_url: "https://x/2", source_type: HIDDEN_SOURCE_TYPE, created_at: "2026-11-25T01:00:00Z" });
    await insert({ title: "C", company: "X", apply_url: "https://x/3", source_type: "ats", is_active: false, status: "expired", created_at: "2026-11-25T01:00:00Z" });
    expect(await visibleIdentityCount()).toBe(1);
  });
});
