import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = fs.readFileSync(path.resolve(__dirname, "../../../../supabase/migrations/20261122_company_logo_contract.sql"), "utf8");
const HOSTED = "https://proj.supabase.co/storage/v1/object/public/company-logos/";
const ids = { hosted: "00000000-0000-4000-8000-000000000001", nul: "00000000-0000-4000-8000-000000000002", ext: "00000000-0000-4000-8000-000000000003", backoff: "00000000-0000-4000-8000-000000000004", idle: "00000000-0000-4000-8000-000000000005" };

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, domain text, careers_url text, ats_type text, logo_url text);
    CREATE TABLE public.jobs (id serial PRIMARY KEY, company_id uuid, status text, is_active boolean);
  `);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // idempotent
  await db.query(
    `INSERT INTO companies (id, name, slug, logo_url, logo_status, logo_next_attempt_at) VALUES
      ($1,'Hosted','hosted',$6,'hosted',NULL),
      ($2,'Null','null',NULL,NULL,NULL),
      ($3,'External','external','https://www.google.com/s2/favicons?domain=x.com',NULL,NULL),
      ($4,'Backoff','backoff',NULL,'failed', now() + interval '1 hour'),
      ($5,'Idle','idle',NULL,'missing', now() - interval '1 minute')`,
    [ids.hosted, ids.nul, ids.ext, ids.backoff, ids.idle, `${HOSTED}${ids.hosted}.png`]
  );
  // active jobs: external 3, null 2, hosted 1, plus 2 orphan links
  await db.exec(`INSERT INTO jobs (company_id, status, is_active) VALUES
    ('${ids.ext}','active',true),('${ids.ext}','active',true),('${ids.ext}','active',true),
    ('${ids.nul}','active',true),('${ids.nul}','active',true),('${ids.hosted}','active',true),
    (NULL,'active',true),('00000000-0000-4000-8000-0000000000ff','active',true),('${ids.ext}','closed',false)`);
  return db;
}

describe("20261122_company_logo_contract migration (PGlite)", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await setup();
  });
  afterEach(async () => { await db?.close(); });

  it("claims only due companies, active-job order first, with a lease and token", async () => {
    const { rows } = await db.query<{ id: string; claim_token: string }>("SELECT * FROM claim_company_logo_batch(10, 'https://proj.supabase.co', 600)");
    expect(rows.map((r) => r.id)).toEqual([ids.ext, ids.nul, ids.idle]); // hosted skipped, backoff not due yet
    expect(rows.every((r) => /^[0-9a-f-]{36}$/.test(r.claim_token))).toBe(true);
    // a second worker gets nothing while the lease is held
    const again = await db.query("SELECT * FROM claim_company_logo_batch(10, 'https://proj.supabase.co', 600)");
    expect(again.rows).toHaveLength(0);
    // an expired lease can be reclaimed
    await db.query("UPDATE companies SET logo_claimed_until = now() - interval '1 second' WHERE id = $1", [ids.nul]);
    const reclaimed = await db.query<{ id: string }>("SELECT * FROM claim_company_logo_batch(10, 'https://proj.supabase.co', 600)");
    expect(reclaimed.rows.map((r) => r.id)).toEqual([ids.nul]);
  });

  it("refuses an empty, zero, unlimited or oversized cap", async () => {
    for (const bad of ["NULL", "0", "-1", "201"]) {
      await expect(db.query(`SELECT * FROM claim_company_logo_batch(${bad}, 'https://proj.supabase.co', 600)`)).rejects.toThrow(/p_limit must be between 1 and 200/);
    }
    await expect(db.query("SELECT * FROM claim_company_logo_batch(5, 'https://proj.supabase.co', 5)")).rejects.toThrow(/p_lease_seconds/);
    await expect(db.query("SELECT * FROM claim_company_logo_batch(5, 'proj.supabase.co', 600)")).rejects.toThrow(/p_origin/);
  });

  it("restricts a manifest-driven claim to the listed ids, even hosted or backed-off ones", async () => {
    const { rows } = await db.query<{ id: string }>("SELECT * FROM claim_company_logo_batch(5, 'https://proj.supabase.co', 600, $1::uuid[])", [[ids.backoff, ids.hosted]]);
    expect(rows.map((r) => r.id).sort()).toEqual([ids.hosted, ids.backoff].sort());
  });

  it("enqueue marks only ineligible companies pending and never resets an active backoff", async () => {
    const { rows } = await db.query<{ n: number }>("SELECT enqueue_company_logos($1::uuid[], 'https://proj.supabase.co') AS n", [[ids.hosted, ids.nul, ids.ext, ids.backoff]]);
    expect(rows[0].n).toBe(2);
    const st = await db.query<{ id: string; logo_status: string | null }>("SELECT id, logo_status FROM companies ORDER BY id");
    const by = Object.fromEntries(st.rows.map((r) => [r.id, r.logo_status]));
    expect(by[ids.hosted]).toBe("hosted");
    expect(by[ids.nul]).toBe("pending");
    expect(by[ids.ext]).toBe("pending");
    expect(by[ids.backoff]).toBe("failed");
    const none = await db.query<{ n: number }>("SELECT enqueue_company_logos(NULL, 'https://proj.supabase.co') AS n");
    expect(none.rows[0].n).toBe(0);
  });

  it("reports coverage counts including orphan job links", async () => {
    const { rows } = await db.query<{ c: Record<string, number> }>(`SELECT company_logo_coverage('https://proj.supabase.co') AS c`);
    expect(rows[0].c).toMatchObject({ companies_with_active_jobs: 3, eligible_hosted: 1, missing_or_ineligible: 2, orphan_links: 2 });
  });

  it("eligibility is the same strict rule as logoEligibility.ts: this origin, this bucket, id-scoped raster key", async () => {
    const ok = async (url: string) => (await db.query<{ e: boolean }>(`SELECT company_logo_eligible($1, 'https://proj.supabase.co') AS e`, [url])).rows[0].e;
    const id = ids.hosted, sha = "a".repeat(64);
    expect(await ok(`${HOSTED}${id}.png`)).toBe(true);
    expect(await ok(`${HOSTED}${id}/${sha}.webp`)).toBe(true);
    for (const bad of [
      `https://other.supabase.co/storage/v1/object/public/company-logos/${id}.png`, // foreign project
      `https://evil.example/x/https://proj.supabase.co/storage/v1/object/public/company-logos/${id}.png`, // substring trick
      `${HOSTED}${id}.svg`, `${HOSTED}acme.png`, `${HOSTED}${id}.png?v=1`, `${HOSTED}${id}/short.png`,
      "https://www.google.com/s2/favicons?domain=x.com",
    ]) expect(await ok(bad)).toBe(false);
  });

  it("a verified-broken (pending) hosted logo is claimable and not counted healthy", async () => {
    await db.query("UPDATE companies SET logo_status = 'pending' WHERE id = $1", [ids.hosted]);
    const { rows } = await db.query<{ c: Record<string, number> }>(`SELECT company_logo_coverage('https://proj.supabase.co') AS c`);
    expect(rows[0].c).toMatchObject({ eligible_hosted: 0, missing_or_ineligible: 3, pending: 1 });
    const claimed = await db.query<{ id: string; logo_status: string }>(`SELECT * FROM claim_company_logo_batch(10, 'https://proj.supabase.co', 600)`);
    expect(claimed.rows.find((r) => r.id === ids.hosted)?.logo_status).toBe("pending");
  });

  it("a hosted URL from another project is ineligible for enqueue, claim and coverage", async () => {
    await db.query("UPDATE companies SET logo_url = $1, logo_status = NULL WHERE id = $2", [`https://other.supabase.co/storage/v1/object/public/company-logos/${ids.hosted}.png`, ids.hosted]);
    const { rows } = await db.query<{ c: Record<string, number> }>(`SELECT company_logo_coverage('https://proj.supabase.co') AS c`);
    expect(rows[0].c.eligible_hosted).toBe(0);
    const n = await db.query<{ n: number }>(`SELECT enqueue_company_logos($1::uuid[], 'https://proj.supabase.co') AS n`, [[ids.hosted]]);
    expect(n.rows[0].n).toBe(1);
  });

  it("rejects an unknown logo_status and keeps run caps bounded", async () => {
    await expect(db.query("UPDATE companies SET logo_status = 'guessed' WHERE id = $1", [ids.nul])).rejects.toThrow();
    await expect(db.query("INSERT INTO company_logo_runs (trigger, cap) VALUES ('sweep', 0)")).rejects.toThrow();
    await expect(db.query("INSERT INTO company_logo_runs (trigger, cap) VALUES ('sweep', 40)")).resolves.toBeTruthy();
  });
});
