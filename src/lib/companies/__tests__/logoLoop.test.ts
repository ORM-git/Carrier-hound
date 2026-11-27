import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eligibleLogoUrl } from "../logoEligibility";
import { enqueueCompanyLogos } from "../logoQueue";
import { repairCompanyLogo, type ClaimedCompany, type LogoRepairDeps } from "../logoRepair";
import { makePng } from "./pngFixture";

// End-to-end loop on real SQL (PGlite + the 20261122 migration): a NEW company arrives through the TS ingest
// and through the Python ingest's RPC call, is enqueued, leased, hosted under a content-hashed key and
// committed conditionally; failures retry later; two concurrent workers never double-process a company.

const SB = "https://proj.supabase.co";
const migration = (f: string) => fs.readFileSync(path.resolve(__dirname, `../../../../supabase/migrations/${f}.sql`), "utf8");
const MIGRATION = migration("20261122_company_logo_contract");
const REVIEW_MIGRATION = migration("20261123_company_logo_review_state");
const BYTES = makePng(64, 64, "real-company-mark");
const SHA = crypto.createHash("sha256").update(BYTES).digest("hex");
const TS_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const PY_ID = "bbbbbbbb-0000-4000-8000-000000000002";

let db: PGlite;
const store = new Map<string, Buffer>();
const one = async <T,>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SB;
});
// Close each disposable database, even after a failed assertion, so WASM instances do not accumulate.
afterEach(async () => {
  await db?.close();
});
beforeEach(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SB; // importing scripts/ingest loads .env.local, which repoints it
  store.clear();
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL, slug text UNIQUE NOT NULL, domain text, careers_url text, ats_type text, logo_url text);
    CREATE TABLE public.jobs (id serial PRIMARY KEY, company_id uuid, status text, is_active boolean, apply_url text, source_url text);`);
  await db.exec(MIGRATION);
  await db.exec(REVIEW_MIGRATION);
});

/** A supabase-js-shaped client whose rpc() runs the real SQL functions (what both ingest paths call). */
const sbClient = () => ({
  rpc: async (fn: string, args: Record<string, unknown>) => {
    try {
      if (fn === "enqueue_company_logos") return { data: (await one<{ n: number }>("SELECT enqueue_company_logos($1::uuid[], $2) AS n", [args.p_ids, args.p_origin]))[0].n, error: null };
      if (fn === "company_logo_coverage") return { data: (await one<{ c: unknown }>("SELECT company_logo_coverage($1) AS c", [args.p_origin]))[0].c, error: null };
      return { data: null, error: { code: "PGRST202", message: `Could not find the function ${fn}` } };
    } catch (e) {
      return { data: null, error: { message: String(e) } };
    }
  },
});

function deps(over: Partial<LogoRepairDeps> = {}): LogoRepairDeps {
  return {
    supabaseUrl: SB,
    resolve: vi.fn(async () => ({ imageUrl: "https://acme.com/apple-touch-icon.png", source: "homepage-icon" as const, domain: "acme.com", buffer: BYTES, contentType: "image/png", ext: "png", width: 180, height: 180 })),
    jobsFor: async () => [],
    knownDefaultHashes: new Set(),
    rejectedHashes: async (id) => new Set((await one<{ sha256: string }>("SELECT sha256 FROM company_logo_rejected_hashes WHERE company_id = $1 AND cleared_at IS NULL", [id])).map((r) => r.sha256)),
    companiesSharingHash: async (sha, id) => (await one<{ n: number }>("SELECT count(*)::int AS n FROM companies WHERE logo_hash = $1 AND id <> $2", [sha, id]))[0].n,
    upload: async (key, bytes) => (store.has(key) ? "exists" : (store.set(key, bytes), "created")),
    commitHosted: async (a) => {
      const r = await db.query(
        `UPDATE companies SET logo_url = $1, logo_status = 'hosted', logo_hash = $2, logo_source = $3, logo_attempts = 0, logo_next_attempt_at = NULL,
           domain = COALESCE(domain, $4), logo_claimed_until = NULL, logo_claim_token = NULL
         WHERE id = $5 AND logo_claim_token = $6 AND logo_url IS NOT DISTINCT FROM $7`,
        [a.logoUrl, a.sha256, a.source, a.domain, a.id, a.token, a.expectedLogoUrl]
      );
      return r.affectedRows === 1;
    },
    recordFailure: async (a) => {
      const r = await db.query(
        `UPDATE companies SET logo_status = $1, logo_failure_reason = $2, logo_attempts = $3, logo_next_attempt_at = $4,
           logo_url = CASE WHEN $5 THEN NULL ELSE logo_url END, logo_claimed_until = NULL, logo_claim_token = NULL
         WHERE id = $6 AND logo_claim_token = $7`,
        [a.status, a.reason, a.attempts, a.nextAttemptAt, a.clearLogoUrl, a.id, a.token]
      );
      return r.affectedRows === 1;
    },
    markAlreadyEligible: async () => undefined,
    now: () => new Date(),
    ...over,
  };
}

const claim = async (limit = 10, lease = 600) => one<ClaimedCompany>("SELECT * FROM claim_company_logo_batch($1, $2, $3)", [limit, SB, lease]);

describe("new company arrival through BOTH ingest paths -> hosted logo", () => {
  it("TS ingest: getOrCreateCompany inserts WITHOUT a logo_url and queues the new company", async () => {
    vi.resetModules();
    const inserts: any[] = [];
    const fake: any = {
      from: (table: string) => {
        const q: any = {
          select: () => q, limit: async () => ({ error: null }), eq: () => q,
          maybeSingle: async () => ({ data: null, error: null }),
          insert: (rows: any[]) => { inserts.push(...rows.map((r) => ({ table, ...r }))); return { select: () => ({ maybeSingle: async () => ({ data: { id: TS_ID }, error: null }) }) }; },
        };
        return q;
      },
    };
    // Non-literal path: run the real ingest module without pulling scripts/** into the app type-check.
    const ingestPath = "../../../../scripts/ingest";
    const ingest: any = await import(/* @vite-ignore */ ingestPath);
    await ingest.detectSchemaCapabilities(fake);
    const id = await ingest.getOrCreateCompany(fake, "Acme", "acme", "greenhouse", "https://boards.greenhouse.io/acme/jobs/1");
    expect(id).toBe(TS_ID);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).not.toHaveProperty("logo_url");
    expect(inserts[0]).not.toHaveProperty("domain");
    expect(ingest.pendingLogoRepairIds()).toContain(TS_ID);
  });

  it("both paths enqueue through the same SQL; the worker hosts the logo under a content-hashed key", async () => {
    await db.query("INSERT INTO companies (id, name, slug, ats_type) VALUES ($1,'Acme','acme','greenhouse'), ($2,'Pybrand','pybrand','lever')", [TS_ID, PY_ID]);
    // TS ingest path (logoQueue helper) and Python path (POST /rpc/enqueue_company_logos {p_ids}) - same function
    expect(await enqueueCompanyLogos(sbClient() as any, [TS_ID])).toMatchObject({ status: "ok", enqueued: 1, coverage: expect.objectContaining({ pending: expect.any(Number), orphan_links: 0 }) });
    expect((await sbClient().rpc("enqueue_company_logos", { p_ids: [PY_ID], p_origin: SB })).data).toBe(1);

    const claimed = await claim();
    expect(claimed.map((c) => c.id).sort()).toEqual([TS_ID, PY_ID].sort());
    // identical bytes for two companies would be a vendor mark: give the Python company its own image
    const d = deps();
    const outA = await repairCompanyLogo(claimed.find((c) => c.id === TS_ID)!, d);
    const outB = await repairCompanyLogo(claimed.find((c) => c.id === PY_ID)!, deps({
      resolve: async () => ({ imageUrl: "https://pybrand.io/icon.png", source: "homepage-icon", domain: "pybrand.io", buffer: makePng(48, 48, "pybrand-mark"), contentType: "image/png", ext: "png", width: 128, height: 128 }),
    }));
    expect([outA.status, outB.status]).toEqual(["repaired", "repaired"]);
    const rows = await one<{ id: string; logo_url: string; logo_status: string; domain: string }>("SELECT id, logo_url, logo_status, domain FROM companies ORDER BY id");
    for (const r of rows) {
      expect(r.logo_status).toBe("hosted");
      expect(eligibleLogoUrl(r.logo_url, SB)).toBe(r.logo_url);
    }
    expect(rows.find((r) => r.id === TS_ID)!.logo_url).toBe(`${SB}/storage/v1/object/public/company-logos/${TS_ID}/${SHA}.png`);
    expect(store.size).toBe(2);
    // nothing left to claim; re-enqueueing a hosted company is a no-op
    expect(await claim()).toHaveLength(0);
    expect(await enqueueCompanyLogos(sbClient() as any, [TS_ID, PY_ID])).toMatchObject({ status: "ok", enqueued: 0, coverage: expect.objectContaining({ eligible_hosted: 0 }) });
  });
});

describe("retries, duplicates and concurrency on real SQL", () => {
  beforeEach(async () => {
    await db.query("INSERT INTO companies (id, name, slug, logo_url) VALUES ($1,'Acme','acme','https://www.google.com/s2/favicons?domain=acme.com&sz=128')", [TS_ID]);
    await enqueueCompanyLogos(sbClient() as any, [TS_ID]);
  });

  it("a failed upload keeps the row unchanged except the backoff; the next due run hosts it once", async () => {
    const [c] = await claim();
    const out = await repairCompanyLogo(c, deps({ upload: async () => { throw new Error("503"); } }));
    expect(out.status).toBe("failed");
    let [row] = await one<any>("SELECT logo_url, logo_status, logo_attempts, logo_next_attempt_at > now() AS later FROM companies");
    expect(row).toMatchObject({ logo_status: "failed", logo_attempts: 1, later: true });
    expect(row.logo_url).toBeNull(); // the external favicon URL is never kept
    expect(await claim()).toHaveLength(0); // not due yet
    await db.query("UPDATE companies SET logo_next_attempt_at = now() - interval '1 second'");
    const [again] = await claim();
    expect((await repairCompanyLogo(again, deps())).status).toBe("repaired");
    [row] = await one<any>("SELECT logo_status, logo_attempts FROM companies");
    expect(row).toMatchObject({ logo_status: "hosted", logo_attempts: 0 });
  });

  it("committed-but-response-lost: the live object is kept and the row stays hosted", async () => {
    const [c] = await claim();
    const real = deps();
    const out = await repairCompanyLogo(c, deps({ commitHosted: async (a) => { await real.commitHosted(a); throw new Error("socket hang up"); } }));
    expect(out.reason).toMatch(/^db-update-failed/);
    const [row] = await one<any>("SELECT logo_url, logo_status FROM companies");
    expect(row.logo_status).toBe("hosted");
    expect(store.has(row.logo_url.split("/company-logos/")[1])).toBe(true); // the URL the row serves still exists
  });

  it("reclaimed lease: a stale worker cannot commit and does not delete the new holder's same-key object", async () => {
    const [stale] = await claim(10, 30);
    await db.query("UPDATE companies SET logo_claimed_until = now() - interval '1 second'"); // lease expired mid-work
    const [fresh] = await claim();
    expect(fresh.claim_token).not.toBe(stale.claim_token);
    expect((await repairCompanyLogo(fresh, deps())).status).toBe("repaired");
    const late = await repairCompanyLogo(stale, deps()); // same bytes -> same content-hashed key
    expect(late).toMatchObject({ status: "failed", reason: expect.stringMatching(/^db-update-skipped/) });
    const [row] = await one<any>("SELECT logo_url, logo_status FROM companies");
    expect(row.logo_status).toBe("hosted");
    expect(store.has(row.logo_url.split("/company-logos/")[1])).toBe(true);
  });

  it("two workers claiming at once: one lease wins, one upload, one commit", async () => {
    const [a, b] = await Promise.all([claim(5), claim(5)]);
    expect(a.length + b.length).toBe(1);
    const mine = [...a, ...b][0];
    const results = await Promise.all([
      repairCompanyLogo(mine, deps()),
      repairCompanyLogo({ ...mine, claim_token: "not-my-lease" }, deps()), // a stale/foreign worker
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["failed", "repaired"]);
    expect(store.size).toBe(1);
    const [row] = await one<any>("SELECT logo_status FROM companies");
    expect(row.logo_status).toBe("hosted");
  });

  it("an image already used by another company is rejected as a vendor/default mark", async () => {
    await db.query("INSERT INTO companies (id, name, slug, logo_url, logo_hash, logo_status) VALUES ($1,'Other','other',$2,$3,'hosted')", [PY_ID, `${SB}/storage/v1/object/public/company-logos/${PY_ID}/${SHA}.png`, SHA]);
    const [c] = await claim();
    const out = await repairCompanyLogo(c, deps());
    expect(out).toMatchObject({ status: "missing", reason: expect.stringMatching(/^shared-image/) });
    const [row] = await one<any>("SELECT logo_url, logo_status FROM companies WHERE id = $1", [TS_ID]);
    expect(row).toMatchObject({ logo_url: null, logo_status: "missing" });
  });
});

describe("no logo anywhere -> stable initials, not rescanned every run", () => {
  it("a new company with no verified source ends 'missing' with logo_url null and is not reclaimed until its backoff", async () => {
    await db.query("INSERT INTO companies (id, name, slug) VALUES ($1,'Nologo','nologo')", [TS_ID]);
    await enqueueCompanyLogos(sbClient() as any, [TS_ID]);
    const [c] = await claim();
    const out = await repairCompanyLogo(c, deps({ resolve: async () => null }));
    expect(out).toMatchObject({ status: "missing", reason: expect.stringMatching(/^no-source/) });
    const [row] = await one<any>("SELECT logo_url, logo_status, logo_next_attempt_at > now() + interval '30 minutes' AS later FROM companies");
    expect(row).toMatchObject({ logo_url: null, logo_status: "missing", later: true }); // UI renders initials
    for (let run = 0; run < 3; run++) expect(await claim()).toHaveLength(0); // later sweeps skip it
    // a later ingest seeing it again does not re-queue it either
    expect(await enqueueCompanyLogos(sbClient() as any, [TS_ID])).toMatchObject({ enqueued: 0 });
  });
});
