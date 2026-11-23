import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueCompanyLogos } from "../logoQueue";

// Disposable PGlite DB with BOTH logo migrations (each applied twice): owner review state (holds, keep-initials,
// rejected image hashes) must survive every automatic path - TS ingest enqueue, Python ingest RPC, sweep claim,
// manifest claim, retries, lease expiry, concurrent workers, the verification pass and late commits.

const SB = "https://proj.supabase.co";
const read = (f: string) => fs.readFileSync(path.resolve(__dirname, `../../../../supabase/migrations/${f}.sql`), "utf8");
const CONTRACT = read("20261122_company_logo_contract");
const REVIEW = read("20261123_company_logo_review_state");
const HOSTED = `${SB}/storage/v1/object/public/company-logos/`;

// Appen and Glossier ids, hashes and reasons as recorded in the #698 review (evidence 5f61f24b / 4be15678).
const APPEN = "c89af545-4a0d-463d-bcad-f15e796bdfe8";
const GLOSSIER = "44f03f3c-899b-488c-a589-cb20c4081cf7";
const APPEN_SHA = "57677de07919ebf8437ed532471f09c1573fc872787665eb5cd97f4a4fefb821";
const GLOSSIER_SHA = "186020c47f9bb6aa6cbd8b18ee7824d1644342a8366fe84456bc147aa76c6cca";
const NEW = "dddddddd-0000-4000-8000-000000000001"; // unreviewed company arriving through ingest
const OK = "eeeeeeee-0000-4000-8000-000000000002"; // unreviewed company with a hosted logo
const OK_SHA = "b".repeat(64);

let db: PGlite;
const q = async <T = any>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const asRole = async <T = any>(role: string, sql: string, p: unknown[] = []) => {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await q<T>(sql, p);
  } finally {
    await db.exec("RESET ROLE");
  }
};
const claim = (ids: string[] | null = null, lease = 600) => q<{ id: string; claim_token: string }>("SELECT * FROM claim_company_logo_batch(50, $1, $2, $3::uuid[])", [SB, lease, ids]);
const coverage = async () => (await q<{ c: Record<string, number> }>("SELECT company_logo_coverage($1) AS c", [SB]))[0].c;
const sbClient = () => ({
  rpc: async (fn: string, args: Record<string, unknown>) => {
    try {
      if (fn === "enqueue_company_logos") return { data: (await q<{ n: number }>("SELECT enqueue_company_logos($1::uuid[], $2) AS n", [args.p_ids, args.p_origin]))[0].n, error: null };
      if (fn === "company_logo_coverage") return { data: await coverage(), error: null };
    } catch (e) {
      return { data: null, error: { message: String(e) } };
    }
    return { data: null, error: { code: "PGRST202", message: "missing" } };
  },
});

beforeEach(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SB;
  db = new PGlite();
  // Mirrors Supabase: service_role bypasses RLS and has table grants on companies/jobs.
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, domain text, careers_url text, ats_type text, logo_url text);
    CREATE TABLE public.jobs (id serial PRIMARY KEY, company_id uuid, status text, is_active boolean);
    GRANT ALL ON public.companies, public.jobs TO service_role;`);
  await db.query(
    `INSERT INTO companies (id, name, slug, logo_url) VALUES
       ($1, 'Appen', 'appen', 'https://i0.wp.com/crowdgen.com/wp-content/uploads/2026/08/crowdgen-site-icon-512.png'),
       ($2, 'Glossier', 'glossier', 'https://www.glossier.com/cdn/shop/files/favicon-light_180x180.webp'),
       ($3, 'Newco', 'newco', NULL),
       ($4, 'Okco', 'okco', $5)`,
    [APPEN, GLOSSIER, NEW, OK, `${HOSTED}${OK}/${OK_SHA}.png`]
  );
  await db.exec(`INSERT INTO jobs (company_id, status, is_active) VALUES
    ('${APPEN}','active',true),('${GLOSSIER}','active',true),('${NEW}','active',true),('${OK}','active',true)`);
  for (const sql of [CONTRACT, REVIEW, CONTRACT, REVIEW]) await db.exec(sql); // old + new, twice: idempotent
  await db.exec("UPDATE companies SET logo_status = 'hosted' WHERE id = '" + OK + "'");
});

describe("reviewed #698 exclusions are seeded from the review records, generically", () => {
  it("Appen and Glossier are held with the recorded reasons and rejected hashes, once", async () => {
    const holds = await q("SELECT company_id, decision, reason, reviewed_by FROM company_logo_reviews WHERE cleared_at IS NULL ORDER BY reason DESC");
    expect(holds).toEqual([
      { company_id: APPEN, decision: "hold", reason: "white mark invisible on light tile", reviewed_by: "owner review of #698 (evidence 5f61f24b)" },
      { company_id: GLOSSIER, decision: "hold", reason: "faint white logo on light tile", reviewed_by: "owner review of #698 (evidence 4be15678)" },
    ]);
    const hashes = await q("SELECT company_id, sha256 FROM company_logo_rejected_hashes ORDER BY company_id");
    expect(hashes).toEqual([{ company_id: GLOSSIER, sha256: GLOSSIER_SHA }, { company_id: APPEN, sha256: APPEN_SHA }]);
  });

  it("a hold cleared by a reviewer is not re-created when the migration is re-run", async () => {
    await q("SELECT set_company_logo_review($1, 'clear', 'reviewed again: allow repair', 'owner')", [APPEN]);
    await db.exec(REVIEW);
    expect(await q("SELECT 1 FROM company_logo_reviews WHERE company_id = $1 AND cleared_at IS NULL", [APPEN])).toHaveLength(0);
  });

  it("a fresh database without those companies seeds nothing (no orphan rows)", async () => {
    const fresh = new PGlite();
    await fresh.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, domain text, careers_url text, ats_type text, logo_url text);
      CREATE TABLE public.jobs (id serial PRIMARY KEY, company_id uuid, status text, is_active boolean);`);
    await fresh.exec(CONTRACT);
    await fresh.exec(REVIEW);
    expect((await fresh.query("SELECT * FROM company_logo_reviews")).rows).toHaveLength(0);
  });
});

describe("holds survive every automatic path", () => {
  it("TS ingest enqueue and the Python ingest RPC skip held companies but queue the new one", async () => {
    expect(await enqueueCompanyLogos(sbClient() as any, [APPEN, GLOSSIER, NEW])).toMatchObject({ status: "ok", enqueued: 1 });
    // Python posts exactly {p_ids, p_origin} to /rpc/enqueue_company_logos
    expect((await sbClient().rpc("enqueue_company_logos", { p_ids: [APPEN, GLOSSIER, NEW], p_origin: SB })).data).toBe(0);
    const st = await q("SELECT id, logo_status FROM companies WHERE id IN ($1, $2, $3) ORDER BY name", [APPEN, GLOSSIER, NEW]);
    expect(st).toEqual([{ id: APPEN, logo_status: null }, { id: GLOSSIER, logo_status: null }, { id: NEW, logo_status: "pending" }]);
  });

  it("sweep claims, manifest claims, due retries and expired leases never return a held company", async () => {
    expect((await claim()).map((r) => r.id)).toEqual([NEW]);
    expect(await claim([APPEN, GLOSSIER])).toEqual([]); // a reviewed manifest listing them still can't claim them
    await q("UPDATE companies SET logo_claimed_until = now() - interval '1 second'"); // every lease expires
    expect((await claim()).map((r) => r.id)).toEqual([NEW]);
    // held companies stay unclaimable even if their row looks due (failed + past backoff, set before the hold)
    await q("SELECT set_company_logo_review($1, 'clear', 'test setup', 'owner')", [APPEN]);
    await q("UPDATE companies SET logo_status = 'failed', logo_next_attempt_at = now() - interval '1 minute' WHERE id = $1", [APPEN]);
    await q("SELECT set_company_logo_review($1, 'hold', 'held again', 'owner')", [APPEN]);
    expect((await claim()).map((r) => r.id)).not.toContain(APPEN);
  });

  it("two concurrent workers: neither gets a held company, one gets the new company", async () => {
    await enqueueCompanyLogos(sbClient() as any, [APPEN, GLOSSIER, NEW]);
    const [a, b] = await Promise.all([claim(), claim()]);
    expect([...a, ...b].map((r) => r.id)).toEqual([NEW]);
  });

  it("a hold placed while a worker holds the lease: its conditional commit misses and a blind write is refused", async () => {
    const [c] = await claim();
    await q("SELECT set_company_logo_review($1, 'hold', 'owner review in progress', 'owner')", [NEW]);
    const committed = await q("UPDATE companies SET logo_url = $1, logo_status = 'hosted' WHERE id = $2 AND logo_claim_token = $3 RETURNING id", [`${HOSTED}${NEW}/${"c".repeat(64)}.png`, NEW, c.claim_token]);
    expect(committed).toHaveLength(0); // the hold released the lease token
    await expect(q("UPDATE companies SET logo_url = $1 WHERE id = $2", [`${HOSTED}${NEW}/${"c".repeat(64)}.png`, NEW])).rejects.toThrow(/under owner review/);
  });

  it("the verification pass (service_role) cannot mark a held company pending; failure records are refused too", async () => {
    await expect(asRole("service_role", "UPDATE companies SET logo_status = 'pending', logo_failure_reason = 'hosted-broken: http-404' WHERE id = $1", [APPEN])).rejects.toThrow(/under owner review/);
    await expect(asRole("service_role", "UPDATE companies SET logo_status = 'missing', logo_url = NULL WHERE id = $1", [GLOSSIER])).rejects.toThrow(/under owner review/);
    // leases and unrelated columns are not blocked
    await asRole("service_role", "UPDATE companies SET logo_claimed_until = NULL, domain = 'crowdgen.com' WHERE id = $1", [APPEN]);
    expect((await q("SELECT logo_url FROM companies WHERE id = $1", [APPEN]))[0].logo_url).toMatch(/crowdgen-site-icon/);
  });
});

describe("rejected image fingerprints", () => {
  it("can never be committed for that company, by versioned URL or by logo_hash, whoever writes", async () => {
    await q("SELECT set_company_logo_review($1, 'clear', 'reviewed again', 'owner')", [GLOSSIER]);
    await expect(asRole("service_role", "UPDATE companies SET logo_url = $1, logo_hash = $2, logo_status = 'hosted' WHERE id = $3", [`${HOSTED}${GLOSSIER}/${GLOSSIER_SHA}.webp`, GLOSSIER_SHA, GLOSSIER])).rejects.toThrow(/rejected by owner review/);
    await expect(q("UPDATE companies SET logo_url = $1, logo_hash = $2 WHERE id = $3", [`${HOSTED}${GLOSSIER}.png`, GLOSSIER_SHA.toUpperCase(), GLOSSIER])).rejects.toThrow(/rejected by owner review/);
    // a different (changed) image is fine once the hold is cleared
    await q("UPDATE companies SET logo_url = $1, logo_hash = $2, logo_status = 'hosted' WHERE id = $3", [`${HOSTED}${GLOSSIER}/${"d".repeat(64)}.png`, "d".repeat(64), GLOSSIER]);
  });

  it("are per company (another company may legitimately use those bytes) and clearing is an explicit reviewed op", async () => {
    await q("UPDATE companies SET logo_url = $1, logo_hash = $2 WHERE id = $3", [`${HOSTED}${NEW}/${APPEN_SHA}.png`, APPEN_SHA, NEW]);
    await q("SELECT set_company_logo_review($1, 'clear', 'reviewed again', 'owner')", [APPEN]);
    expect((await q("SELECT set_company_logo_hash_rejection($1, $2, 'clear', 'image fixed upstream', 'owner') AS n", [APPEN, APPEN_SHA]))[0].n).toBe(1);
    await q("UPDATE companies SET logo_url = $1, logo_hash = $2 WHERE id = $3", [`${HOSTED}${APPEN}/${APPEN_SHA}.png`, APPEN_SHA, APPEN]);
    const hist = await q("SELECT cleared_by, cleared_note FROM company_logo_rejected_hashes WHERE company_id = $1", [APPEN]);
    expect(hist).toEqual([{ cleared_by: "owner", cleared_note: "image fixed upstream" }]); // kept as history
  });
});

describe("keep-initials and approved decisions", () => {
  it("initials clears the logo (previous kept for rollback), is never enqueued or claimed, and is counted separately", async () => {
    await q("SELECT set_company_logo_review($1, 'initials', 'mark unreadable at card size', 'owner')", [OK]);
    expect(await q("SELECT logo_url, logo_status FROM companies WHERE id = $1", [OK])).toEqual([{ logo_url: null, logo_status: "missing" }]);
    expect((await q("SELECT previous_logo_url FROM company_logo_reviews WHERE company_id = $1 AND cleared_at IS NULL", [OK]))[0].previous_logo_url).toBe(`${HOSTED}${OK}/${OK_SHA}.png`);
    expect((await enqueueCompanyLogos(sbClient() as any, [OK])) as any).toMatchObject({ enqueued: 0 });
    expect((await claim()).map((r) => r.id)).not.toContain(OK);
    expect((await claim()).map((r) => r.id)).not.toContain(OK); // and not rescanned on later runs
    expect(await coverage()).toMatchObject({ companies_with_active_jobs: 4, eligible_hosted: 0, intentional_initials: 1, held: 2, approved: 0, missing_or_ineligible: 1 });
  });

  it("unreviewed companies are repairable but never counted as owner approvals; approved is explicit", async () => {
    expect(await coverage()).toMatchObject({ eligible_hosted: 1, held: 2, approved: 0, pending: 0, failed: 0 });
    await q("SELECT set_company_logo_review($1, 'approved', 'canary approved', 'owner')", [NEW]);
    expect((await claim()).map((r) => r.id)).toEqual([NEW]);
    expect(await coverage()).toMatchObject({ approved: 1 });
  });

  it("changing a decision keeps history; one active decision per company", async () => {
    await q("SELECT set_company_logo_review($1, 'approved', 'reviewed again: repair ok', 'owner')", [APPEN]);
    const rows = await q("SELECT decision, cleared_at IS NOT NULL AS cleared FROM company_logo_reviews WHERE company_id = $1 ORDER BY id", [APPEN]);
    expect(rows).toEqual([{ decision: "hold", cleared: true }, { decision: "approved", cleared: false }]);
    expect((await claim()).map((r) => r.id).sort()).toEqual([APPEN, NEW].sort());
  });
});

describe("service-only mutation and validation", () => {
  it("clients cannot read or change review state; service_role reads only, and mutates only via the reviewed functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(asRole(role, "SELECT * FROM company_logo_reviews")).rejects.toThrow(/permission denied/);
      await expect(asRole(role, "SELECT * FROM company_logo_rejected_hashes")).rejects.toThrow(/permission denied/);
      await expect(asRole(role, `SELECT set_company_logo_review('${APPEN}', 'clear', 'x', 'y')`)).rejects.toThrow(/permission denied/);
      await expect(asRole(role, `SELECT set_company_logo_hash_rejection('${APPEN}', '${APPEN_SHA}', 'clear', 'x', 'y')`)).rejects.toThrow(/permission denied/);
    }
    expect(await asRole("service_role", "SELECT count(*)::int AS n FROM company_logo_reviews")).toEqual([{ n: 2 }]);
    await expect(asRole("service_role", "DELETE FROM company_logo_reviews")).rejects.toThrow(/permission denied/);
    await expect(asRole("service_role", "UPDATE company_logo_reviews SET cleared_at = now(), cleared_by = 'x'")).rejects.toThrow(/permission denied/);
    await expect(asRole("service_role", `INSERT INTO company_logo_rejected_hashes (company_id, sha256, reason, rejected_by) VALUES ('${NEW}', '${"e".repeat(64)}', 'x', 'y')`)).rejects.toThrow(/permission denied/);
    await asRole("service_role", "SELECT set_company_logo_review($1, 'hold', 'via the reviewed function', 'owner')", [NEW]);
    expect(await q("SELECT decision FROM company_logo_reviews WHERE company_id = $1 AND cleared_at IS NULL", [NEW])).toEqual([{ decision: "hold" }]);
  });

  it("refuses an unknown decision, a missing reason or reviewer, a bad hash or an unknown company", async () => {
    await expect(q(`SELECT set_company_logo_review('${NEW}', 'skip', 'r', 'o')`)).rejects.toThrow(/hold\|initials\|approved\|clear/);
    await expect(q(`SELECT set_company_logo_review('${NEW}', 'hold', '  ', 'o')`)).rejects.toThrow(/reason and a reviewer/);
    await expect(q(`SELECT set_company_logo_review('${NEW}', 'hold', 'r', NULL)`)).rejects.toThrow(/reason and a reviewer/);
    await expect(q(`SELECT set_company_logo_review('00000000-0000-4000-8000-0000000000ff', 'hold', 'r', 'o')`)).rejects.toThrow(/unknown company/);
    await expect(q(`SELECT set_company_logo_hash_rejection('${NEW}', 'abc', 'reject', 'r', 'o')`)).rejects.toThrow(/64 hex/);
    await expect(q(`SELECT set_company_logo_hash_rejection('${NEW}', '${"e".repeat(64)}', 'forget', 'r', 'o')`)).rejects.toThrow(/reject\|clear/);
  });
});

describe("rollback", () => {
  it("the documented rollback restores 20261122 behaviour and leaves every logo_url untouched", async () => {
    const before = await q("SELECT id, logo_url FROM companies ORDER BY id");
    await db.exec(CONTRACT); // step 1
    const step2 = REVIEW.slice(REVIEW.indexOf("-- Step 2:")).split("\n").filter((l) => /^--\s+DROP /.test(l)).map((l) => l.replace(/^--\s+/, ""));
    expect(step2.length).toBe(8);
    for (const sql of step2) await db.exec(sql);
    expect(await q("SELECT id, logo_url FROM companies ORDER BY id")).toEqual(before);
    expect((await q("SELECT to_regclass('public.company_logo_reviews') AS t"))[0].t).toBeNull();
    // back to the 20261122 rules: Appen is enqueueable again and coverage still works
    expect((await sbClient().rpc("enqueue_company_logos", { p_ids: [APPEN], p_origin: SB })).data).toBe(1);
    expect(await coverage()).toMatchObject({ companies_with_active_jobs: 4 });
    await db.exec(REVIEW); // and it can be re-applied afterwards
  });
});
