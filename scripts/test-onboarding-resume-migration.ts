/**
 * scripts/test-onboarding-resume-migration.ts
 *
 * Real-Postgres (PGlite) test for 20261118_onboarding_resume_uploads.sql:
 *  - applies schema.sql + every earlier migration, then this one (twice: idempotent)
 *  - bucket row and storage.objects policies are byte-for-byte unchanged
 *  - anon/authenticated cannot write the table or execute the orphan finder; service_role can
 *  - an owner can read only their own row
 *  - preflight REFUSES any client INSERT/UPDATE path that can reach resumes/<uid>/onboarding/
 *    (owner-folder policies, inherited roles, OR-escapes, UPDATE USING, RLS off) and PASSES
 *    policies that provably exclude the prefix; also refuses a foreign/incompatible
 *    pre-existing table, a foreign/incompatible pre-existing function
 *  - guarded rollback only touches objects carrying this migration's marker and keeps the data
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_stat_statements } from "@electric-sql/pglite/contrib/pg_stat_statements";
import assert from "assert";
import fs from "fs";
import path from "path";

const MIGRATION = "20261118_onboarding_resume_uploads.sql";
const SKIPPED = new Set(["20261108a_pg_cron_scheduled_jobs.sql"]);
const DIR = "supabase/migrations";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  [PASS] ${name}`);
}

async function boot(): Promise<PGlite> {
  const pg = new PGlite({ extensions: { pg_trgm, unaccent, pg_stat_statements } });
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS storage; CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE TABLE auth.users (id uuid primary key, email text, raw_user_meta_data jsonb, created_at timestamptz default now());
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticator NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('role', true) $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner uuid, created_at timestamptz default now());
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array(name,'/') $$;
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    GRANT SELECT ON storage.objects TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  await pg.exec(fs.readFileSync("supabase/schema.sql", "utf8"));
  await pg.exec("ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS category text, ADD COLUMN IF NOT EXISTS country text;");
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql") && f < MIGRATION).sort();
  for (const f of files) {
    if (SKIPPED.has(f)) continue;
    try {
      await pg.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
    } catch (e: any) {
      await pg.exec("ROLLBACK").catch(() => {});
      assert.ok(!/resume|storage|launch_scope|account_delete|rate_limit/i.test(f), `unexpected failure in ${f}: ${e.message}`);
    }
  }
  return pg;
}

const migrationSql = () => fs.readFileSync(path.join(DIR, MIGRATION), "utf8");

function rollbackSql(): string {
  const text = migrationSql();
  const start = text.indexOf("-- ROLLBACK (guarded");
  const lines = text.slice(start).split("\n").filter((l) => l.startsWith("-- ") && !/^-- (ROLLBACK|migration's|touches|=)/.test(l));
  return lines.map((l) => l.slice(3)).join("\n");
}

async function refuses(pg: PGlite, pattern: RegExp, label: string) {
  try {
    await pg.exec(migrationSql());
  } catch (e: any) {
    await pg.exec("ROLLBACK").catch(() => {});
    assert.match(e.message, pattern, `${label}: wrong error ${e.message}`);
    return;
  }
  assert.fail(`${label}: migration should have been refused`);
}

async function asRole(pg: PGlite, role: string, uid: string | null, sql: string) {
  await pg.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false);`);
  try {
    return await pg.query(sql);
  } finally {
    await pg.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
  }
}

async function denied(p: Promise<any>, label: string) {
  try {
    await p;
  } catch (e: any) {
    assert.match(e.message, /permission denied|row-level security/i, `${label}: ${e.message}`);
    return;
  }
  assert.fail(`${label}: expected denial`);
}

/** Per-fixture lifecycle: boot a fresh PGlite, run the test, always close it before the next fixture. */
let openInstances = 0;
async function withFixture(name: string, fn: (pg: PGlite) => Promise<void>) {
  assert.equal(openInstances, 0, `${name}: previous PGlite fixture was not closed`);
  const pg = await boot();
  openInstances++;
  try {
    await fn(pg);
  } finally {
    await pg.close();
    openInstances--;
    assert.ok(pg.closed, `${name}: PGlite instance did not close`);
  }
}

async function main() {
  console.log("Onboarding resume uploads migration (PGlite)");

  // ---------- happy path ----------
  await withFixture("happy path", async (pg) => {
  const bucketBefore = await pg.query(`SELECT row_to_json(b)::text AS j FROM storage.buckets b WHERE id='resumes'`);
  const policiesBefore = await pg.query(
    `SELECT string_agg(policyname||cmd||coalesce(qual,'')||coalesce(with_check,''), '|' ORDER BY policyname) AS j FROM pg_policies WHERE schemaname='storage'`
  );
  assert.equal(bucketBefore.rows.length, 1, "earlier migrations must have created the resumes bucket");

  await pg.exec(migrationSql());
  await pg.exec(migrationSql());
  ok("applies cleanly and re-applies (idempotent)");

  const bucketAfter = await pg.query(`SELECT row_to_json(b)::text AS j FROM storage.buckets b WHERE id='resumes'`);
  const policiesAfter = await pg.query(
    `SELECT string_agg(policyname||cmd||coalesce(qual,'')||coalesce(with_check,''), '|' ORDER BY policyname) AS j FROM pg_policies WHERE schemaname='storage'`
  );
  assert.deepEqual(bucketAfter.rows, bucketBefore.rows);
  assert.deepEqual(policiesAfter.rows, policiesBefore.rows);
  ok("resumes bucket row and storage.objects policies unchanged");

  const priv = await pg.query(`
    SELECT r,
      has_table_privilege(r, 'public.onboarding_resume_uploads', 'INSERT') AS ins,
      has_table_privilege(r, 'public.onboarding_resume_uploads', 'UPDATE') AS upd,
      has_table_privilege(r, 'public.onboarding_resume_uploads', 'DELETE') AS del,
      has_function_privilege(r, 'public.list_onboarding_resume_orphans(interval,integer)', 'EXECUTE') AS exe
    FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
  const byRole = Object.fromEntries(priv.rows.map((r: any) => [r.r, r]));
  for (const role of ["anon", "authenticated"]) {
    assert.deepEqual([byRole[role].ins, byRole[role].upd, byRole[role].del, byRole[role].exe], [false, false, false, false], role);
  }
  assert.deepEqual([byRole.service_role.ins, byRole.service_role.upd, byRole.service_role.del, byRole.service_role.exe], [true, true, true, true]);
  ok("verify query: client write false, service write true");

  await pg.exec(`INSERT INTO auth.users(id,email) VALUES ('${U1}','a@x.dev'),('${U2}','b@x.dev')`);
  await asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_uploads(user_id,storage_path,file_name,mime_type,size_bytes)
    VALUES ('${U1}','${U1}/onboarding/a.pdf','a.pdf','application/pdf',10),('${U2}','${U2}/onboarding/b.pdf','b.pdf','application/pdf',10)`);
  ok("service_role can insert pointer rows");

  await denied(
    asRole(pg, "authenticated", U1, `INSERT INTO public.onboarding_resume_uploads(user_id,storage_path,file_name,mime_type,size_bytes)
      VALUES ('${U1}','${U1}/onboarding/z.pdf','z.pdf','application/pdf',1) ON CONFLICT (user_id) DO NOTHING`),
    "authenticated insert"
  );
  await denied(asRole(pg, "authenticated", U1, `UPDATE public.onboarding_resume_uploads SET file_name='x'`), "authenticated update");
  await denied(asRole(pg, "authenticated", U1, `DELETE FROM public.onboarding_resume_uploads`), "authenticated delete");
  await denied(asRole(pg, "authenticated", U1, `SELECT * FROM public.list_onboarding_resume_orphans()`), "authenticated execute");
  await denied(asRole(pg, "anon", null, `SELECT * FROM public.onboarding_resume_uploads`), "anon select");
  ok("authenticated/anon: insert, upsert, update, delete, execute all denied");

  const own = await asRole(pg, "authenticated", U1, `SELECT user_id FROM public.onboarding_resume_uploads`);
  assert.deepEqual(own.rows.map((r: any) => r.user_id), [U1]);
  ok("owner reads only their own row");

  await pg.exec(`INSERT INTO storage.objects(bucket_id,name,created_at) VALUES
    ('resumes','${U1}/onboarding/a.pdf', now() - interval '2 hours'),
    ('resumes','${U1}/onboarding/orphan.pdf', now() - interval '2 hours'),
    ('resumes','${U1}/onboarding/fresh.pdf', now()),
    ('resumes','${U1}/other.pdf', now() - interval '2 hours')`);
  const orphans = await asRole(pg, "service_role", null, `SELECT object_name FROM public.list_onboarding_resume_orphans()`);
  assert.deepEqual(orphans.rows.map((r: any) => r.object_name), [`${U1}/onboarding/orphan.pdf`]);
  ok("orphan finder lists only unreferenced, older-than-1h onboarding objects");

  await assert.rejects(
    asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_uploads(user_id,storage_path,file_name,mime_type,size_bytes)
      VALUES ('${U2}','${U1}/onboarding/steal.pdf','s.pdf','application/pdf',1) ON CONFLICT (user_id) DO UPDATE SET storage_path=excluded.storage_path`),
    /check constraint/i
  );
  ok("check constraint pins storage_path to the owner's folder");

  // Guarded rollback: keeps data, removes only marked objects, safe to run twice.
  await pg.exec(rollbackSql());
  await pg.exec(rollbackSql());
  const after = await pg.query(`SELECT to_regclass('public.onboarding_resume_uploads') AS t,
    to_regclass('public.onboarding_resume_uploads_rolled_back_20261118') AS r,
    to_regprocedure('public.list_onboarding_resume_orphans(interval,integer)') AS f`);
  assert.equal(after.rows[0].t, null);
  assert.ok(after.rows[0].r);
  assert.equal(after.rows[0].f, null);
  const kept = await pg.query(`SELECT count(*)::int AS n FROM public.onboarding_resume_uploads_rolled_back_20261118`);
  assert.equal(kept.rows[0].n, 2);
  const bucketPostRollback = await pg.query(`SELECT row_to_json(b)::text AS j FROM storage.buckets b WHERE id='resumes'`);
  assert.deepEqual(bucketPostRollback.rows, bucketBefore.rows);
  ok("guarded rollback: renames (keeps rows), drops marked function, bucket untouched, re-runnable");
  });

  // ---------- refusals ----------
  await withFixture("refusal fixture 1", async (p) => {
    await p.exec(`CREATE POLICY "sneaky_resume_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'resumes')`);
    await refuses(p, /unexpected client write policy.*sneaky_resume_insert/, "sneaky policy");
    await p.exec(`DROP POLICY "sneaky_resume_insert" ON storage.objects;
      CREATE POLICY "any_bucket_update" ON storage.objects FOR UPDATE TO public USING (true)`);
    await refuses(p, /unexpected client write policy.*any_bucket_update/, "bucketless policy");
    const exists = await p.query(`SELECT to_regclass('public.onboarding_resume_uploads') AS t`);
    assert.equal(exists.rows[0].t, null, "refused migration must leave nothing behind");
    ok("preflight refuses unexpected client INSERT/UPDATE policy (with details) and rolls back");
  });
  await withFixture("refusal fixture 2", async (p) => {
    // Owner-folder policies (the shape earlier migrations used) reach <uid>/onboarding/: refuse, by shape not name.
    const REACH = /unexpected client write policy.*can reach resumes/;
    await p.exec(`CREATE POLICY "Owner can insert own resume files" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text)`);
    await refuses(p, /Owner can insert own resume files/, "owner-folder insert policy");
    await p.exec(`DROP POLICY "Owner can insert own resume files" ON storage.objects;
      CREATE POLICY "Owner can update own resume files" ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text)
      WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text)`);
    await refuses(p, /Owner can update own resume files/, "owner-folder update policy");
    await p.exec(`DROP POLICY "Owner can update own resume files" ON storage.objects`);

    // Same name as a formerly allow-listed policy, but the body reaches onboarding/: still refused.
    await p.exec(`CREATE POLICY "Users can upload their own resume" ON storage.objects FOR INSERT TO anon
      WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text)`);
    await refuses(p, /Users can upload their own resume/, "allow-listed name, reaching body");
    await p.exec(`DROP POLICY "Users can upload their own resume" ON storage.objects`);

    // Inherited role: policy granted to a role that authenticated is a member of.
    await p.exec(`CREATE ROLE resume_writers NOLOGIN; GRANT resume_writers TO authenticated;
      CREATE POLICY "group_resume_insert" ON storage.objects FOR INSERT TO resume_writers
      WITH CHECK (bucket_id = 'resumes')`);
    await refuses(p, /group_resume_insert/, "policy inherited via another role");
    await p.exec(`DROP POLICY "group_resume_insert" ON storage.objects`);

    // Exclusion hidden behind a top-level OR proves nothing.
    await p.exec(`CREATE POLICY "or_escape" ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'resumes' AND ((storage.foldername(name))[2] <> 'onboarding' OR auth.uid() IS NOT NULL))`);
    await refuses(p, /or_escape/, "OR around the exclusion");
    await p.exec(`DROP POLICY "or_escape" ON storage.objects`);

    // UPDATE: WITH CHECK excludes onboarding but USING still reaches existing onboarding objects.
    await p.exec(`CREATE POLICY "update_using_reaches" ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'resumes')
      WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[2] <> 'onboarding')`);
    await refuses(p, /update_using_reaches/, "UPDATE USING reaches onboarding");
    await p.exec(`DROP POLICY "update_using_reaches" ON storage.objects`);

    // ALL policy with no WITH CHECK falls back to USING, which reaches onboarding.
    await p.exec(`CREATE POLICY "all_cmd" ON storage.objects FOR ALL TO public USING (bucket_id = 'resumes')`);
    await refuses(p, REACH, "ALL policy to PUBLIC");
    await p.exec(`DROP POLICY "all_cmd" ON storage.objects`);

    // RLS off with a client grant is a write path.
    await p.exec(`ALTER TABLE storage.objects DISABLE ROW LEVEL SECURITY; GRANT INSERT ON storage.objects TO authenticated`);
    await refuses(p, /RLS disabled/, "RLS disabled");
    await p.exec(`REVOKE INSERT ON storage.objects FROM authenticated; ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY`);

    const exists = await p.query(`SELECT to_regclass('public.onboarding_resume_uploads') AS t`);
    assert.equal(exists.rows[0].t, null, "refused migration must leave nothing behind");
    ok("preflight refuses owner-folder, inherited-role, OR-escaped, UPDATE-USING, ALL and RLS-off write paths");
  });
  await withFixture("refusal fixture 3", async (p) => {
    // Policies that provably exclude onboarding/ (or another bucket, or non-client roles) pass.
    await p.exec(`
      CREATE POLICY "owner_insert_not_onboarding" ON storage.objects FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[1] = auth.uid()::text
                    AND (storage.foldername(name))[2] <> 'onboarding');
      CREATE POLICY "owner_update_not_onboarding" ON storage.objects FOR UPDATE TO authenticated
        USING (bucket_id = 'resumes' AND (storage.foldername(name))[2] IS DISTINCT FROM 'onboarding')
        WITH CHECK (bucket_id = 'resumes' AND (storage.foldername(name))[2] <> 'onboarding');
      CREATE POLICY "other_bucket_insert" ON storage.objects FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'avatars');
      CREATE POLICY "service_only_any" ON storage.objects FOR ALL TO service_role USING (true);
      CREATE POLICY "restrictive_any" ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
        WITH CHECK (true);`);
    const before = await p.query(`SELECT string_agg(policyname||coalesce(qual,'')||coalesce(with_check,''), '|' ORDER BY policyname) AS j FROM pg_policies WHERE schemaname='storage'`);
    await p.exec(migrationSql());
    const t = await p.query(`SELECT to_regclass('public.onboarding_resume_uploads') AS t, current_setting('search_path') AS sp`);
    assert.ok(t.rows[0].t, "migration should apply when every client write policy excludes onboarding/");
    const after = await p.query(`SELECT string_agg(policyname||coalesce(qual,'')||coalesce(with_check,''), '|' ORDER BY policyname) AS j FROM pg_policies WHERE schemaname='storage'`);
    assert.deepEqual(after.rows, before.rows, "storage policies must be unchanged");
    ok("preflight passes policies that provably exclude onboarding/, other buckets, service_role and restrictive ones");
  });
  await withFixture("refusal fixture 4", async (p) => {
    await p.exec(`CREATE TABLE public.onboarding_resume_uploads (user_id uuid primary key, storage_path text)`);
    await refuses(p, /not created by this migration/, "foreign table");
    await p.exec(`COMMENT ON TABLE public.onboarding_resume_uploads IS 'created-by:20261118_onboarding_resume_uploads'`);
    await refuses(p, /incompatible columns/, "incompatible table");
    ok("preflight refuses a foreign or incompatible existing table");
  });
  await withFixture("refusal fixture 5", async (p) => {
    await p.exec(`CREATE FUNCTION public.list_onboarding_resume_orphans(p_limit integer) RETURNS SETOF text LANGUAGE sql AS $$ SELECT 'x' $$`);
    await refuses(p, /incompatible or foreign public\.list_onboarding_resume_orphans/, "foreign function");
    ok("preflight refuses an incompatible or foreign existing function");
  });
  await withFixture("refusal fixture 6", async (p) => {
    await p.exec(`CREATE TABLE public.onboarding_resume_uploads_x (id int)`);
    await p.exec(rollbackSql());
    await p.exec(`CREATE TABLE public.onboarding_resume_uploads (id int)`);
    await p.exec(rollbackSql());
    const still = await p.query(`SELECT to_regclass('public.onboarding_resume_uploads') AS t`);
    assert.ok(still.rows[0].t, "rollback must not touch an unmarked table");
    ok("guarded rollback skips objects this migration did not create");
  });

  console.log(`\nALL ${passed} onboarding resume migration checks passed [PASS-LOCAL]`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
