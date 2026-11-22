/** Disposable in-memory schema rehearsal only; never connects to Supabase. */
import fs from "node:fs";
import path from "node:path";

async function main() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.companies(id uuid PRIMARY KEY, name text);
      CREATE TABLE public.jobs(id uuid PRIMARY KEY, company_id uuid, posted_at timestamptz, status text, is_active boolean);
      INSERT INTO public.companies VALUES ('00000000-0000-0000-0000-000000000001','Acme'), ('00000000-0000-0000-0000-000000000002','Acme subsidiary');
      INSERT INTO public.jobs VALUES
        ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',now(),'active',true),
        ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',now(),'active',true),
        ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002',now(),'active',true),
        ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001',now(),'expired',false);`);
    const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20261122a_company_profile_data.sql"), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(`INSERT INTO public.company_profile_facts(company_id,fact_key,fact_value,source_url,source_kind,retrieved_at)
      VALUES ('00000000-0000-0000-0000-000000000001','overview','Acme','https://acme.example/about','official_site',now())
      ON CONFLICT(company_id,fact_key) DO UPDATE SET fact_value=excluded.fact_value;`);
    const profiles = await db.query<{ count: string }>("SELECT count(*)::text count FROM public.company_profile_facts");
    const matchingJobs = await db.query<{ id: string }>(`SELECT id FROM public.jobs WHERE company_id='00000000-0000-0000-0000-000000000001' AND id<>'10000000-0000-0000-0000-000000000001' AND status='active' AND is_active=true`);
    const access = await db.query<{ anon_select: boolean; service_write: boolean; rls: boolean }>(`SELECT has_table_privilege('anon','public.company_profile_facts','SELECT') anon_select,
      has_table_privilege('service_role','public.company_profile_facts','INSERT') service_write,
      (SELECT relrowsecurity FROM pg_class WHERE oid='public.company_profile_facts'::regclass) rls`);
    if (profiles.rows[0].count !== "1" || matchingJobs.rows.length !== 1 || access.rows[0].anon_select || !access.rows[0].service_write || !access.rows[0].rls) {
      throw new Error(`Schema rehearsal failed: ${JSON.stringify({ profiles: profiles.rows, matchingJobs: matchingJobs.rows, access: access.rows })}`);
    }
    console.log("Company profile schema rehearsal passed (migration reapply, idempotent fact upsert, canonical active-job scope, RLS/grants). No network database used.");
  } finally { await db.close(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
