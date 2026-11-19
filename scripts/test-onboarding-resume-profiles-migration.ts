/**
 * scripts/test-onboarding-resume-profiles-migration.ts
 *
 * Real-Postgres (PGlite) test for 20261119_onboarding_resume_profiles.sql:
 *  - applies schema.sql + every earlier migration (incl. 20261118), then this one twice (idempotent)
 *  - anon/authenticated cannot write; anon cannot read; service_role can write
 *  - an owner reads only their own parsed profile
 *  - constraints: owner-folder source path, status/source/reason consistency, size cap, object shape
 *  - deleting the upload pointer (or the account) deletes the parsed profile
 *  - preflight refuses when 20261118 is missing, and refuses a foreign pre-existing table
 *  - guarded rollback renames (keeps rows), is re-runnable
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_stat_statements } from "@electric-sql/pglite/contrib/pg_stat_statements";
import assert from "assert";
import fs from "fs";
import path from "path";

const MIGRATION = "20261119_onboarding_resume_profiles.sql";
const PARENT = "20261118_onboarding_resume_uploads.sql";
const SKIPPED = new Set(["20261108a_pg_cron_scheduled_jobs.sql"]);
const DIR = "supabase/migrations";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  [PASS] ${name}`);
}

async function boot(opts: { withParent: boolean }): Promise<PGlite> {
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
    if (f === PARENT && !opts.withParent) continue;
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
  const lines = text
    .slice(start)
    .split("\n")
    .filter((l) => l.startsWith("-- ") && !/^-- (ROLLBACK|Keeps the rows|=)/.test(l));
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

async function withFixture(name: string, opts: { withParent: boolean }, fn: (pg: PGlite) => Promise<void>) {
  const pg = await boot(opts);
  try {
    await fn(pg);
  } finally {
    await pg.close();
  }
}

const PROFILE = `'{"jobTitles":["Data Analyst"],"skills":["SQL","Python"],"yearsOfExperience":3}'::jsonb`;

async function main() {
  console.log("Onboarding resume profiles migration (PGlite)");

  await withFixture("happy path", { withParent: true }, async (pg) => {
    await pg.exec(migrationSql());
    await pg.exec(migrationSql());
    ok("applies cleanly and re-applies (idempotent)");

    const priv = await pg.query(`
      SELECT r,
        has_table_privilege(r, 'public.onboarding_resume_profiles', 'SELECT') AS sel,
        has_table_privilege(r, 'public.onboarding_resume_profiles', 'INSERT') AS ins,
        has_table_privilege(r, 'public.onboarding_resume_profiles', 'UPDATE') AS upd,
        has_table_privilege(r, 'public.onboarding_resume_profiles', 'DELETE') AS del,
        has_table_privilege(r, 'public.onboarding_resume_profiles', 'TRUNCATE') AS trn
      FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
    const by = Object.fromEntries(priv.rows.map((r: any) => [r.r, r]));
    assert.deepEqual([by.anon.sel, by.anon.ins, by.anon.upd, by.anon.del, by.anon.trn], [false, false, false, false, false]);
    assert.deepEqual([by.authenticated.sel, by.authenticated.ins, by.authenticated.upd, by.authenticated.del, by.authenticated.trn], [true, false, false, false, false]);
    assert.deepEqual([by.service_role.ins, by.service_role.upd, by.service_role.del, by.service_role.trn], [true, true, true, true]);
    ok("verify query: anon nothing, authenticated SELECT only, service_role writes and truncates");

    await pg.exec(`INSERT INTO auth.users(id,email) VALUES ('${U1}','a@x.dev'),('${U2}','b@x.dev')`);
    await asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_uploads(user_id,storage_path,file_name,mime_type,size_bytes)
      VALUES ('${U1}','${U1}/onboarding/a.pdf','a.pdf','application/pdf',10),('${U2}','${U2}/onboarding/b.pdf','b.pdf','application/pdf',10)`);
    await asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_profiles(user_id,source_storage_path,parse_status,parse_source,profile)
      VALUES ('${U1}','${U1}/onboarding/a.pdf','parsed','rules',${PROFILE})`);
    await asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_profiles(user_id,source_storage_path,parse_status,failure_reason)
      VALUES ('${U2}','${U2}/onboarding/b.pdf','failed','scanned_pdf')
      ON CONFLICT (user_id) DO UPDATE SET parse_status = excluded.parse_status`);
    ok("service_role can insert and upsert parsed and failed rows");

    // Atomic RPC: save_onboarding_resume_profile
    const rpcOk = await asRole(pg, "service_role", null, `SELECT public.save_onboarding_resume_profile(
      '${U1}'::uuid, '${U1}/onboarding/a.pdf', 'parsed', 'rules', NULL, ${PROFILE}
    ) AS ok`);
    assert.equal(rpcOk.rows[0].ok, true);

    // Stale path returns false atomically
    const rpcStale = await asRole(pg, "service_role", null, `SELECT public.save_onboarding_resume_profile(
      '${U1}'::uuid, '${U1}/onboarding/stale.pdf', 'parsed', 'rules', NULL, ${PROFILE}
    ) AS ok`);
    assert.equal(rpcStale.rows[0].ok, false);

    await denied(
      asRole(pg, "authenticated", U1, `SELECT public.save_onboarding_resume_profile(
        '${U1}'::uuid, '${U1}/onboarding/a.pdf', 'parsed', 'rules', NULL, ${PROFILE}
      )`),
      "authenticated execute save_onboarding_resume_profile"
    );
    await denied(
      asRole(pg, "anon", null, `SELECT public.save_onboarding_resume_profile(
        '${U1}'::uuid, '${U1}/onboarding/a.pdf', 'parsed', 'rules', NULL, ${PROFILE}
      )`),
      "anon execute save_onboarding_resume_profile"
    );
    ok("atomic save_onboarding_resume_profile: service_role can execute, checks pointer, anon/auth denied");

    await denied(
      asRole(pg, "authenticated", U1, `INSERT INTO public.onboarding_resume_profiles(user_id,source_storage_path,parse_status,parse_source)
        VALUES ('${U1}','${U1}/onboarding/z.pdf','parsed','ai') ON CONFLICT (user_id) DO NOTHING`),
      "authenticated insert"
    );
    await denied(asRole(pg, "authenticated", U1, `UPDATE public.onboarding_resume_profiles SET profile='{}'`), "authenticated update");
    await denied(asRole(pg, "authenticated", U1, `DELETE FROM public.onboarding_resume_profiles`), "authenticated delete");
    await denied(asRole(pg, "anon", null, `SELECT * FROM public.onboarding_resume_profiles`), "anon select");
    ok("authenticated insert/upsert/update/delete and anon select are denied");

    const own = await asRole(pg, "authenticated", U1, `SELECT user_id FROM public.onboarding_resume_profiles`);
    assert.deepEqual(own.rows.map((r: any) => r.user_id), [U1]);
    const none = await asRole(pg, "authenticated", "33333333-3333-4333-8333-333333333333", `SELECT user_id FROM public.onboarding_resume_profiles`);
    assert.equal(none.rows.length, 0);
    ok("owner reads only their own row; other users read nothing");

    const bad: Array<[string, string]> = [
      [`'${U2}/onboarding/x.pdf','parsed','rules','{}'::jsonb,NULL`, "foreign folder path"],
      [`'${U1}/onboarding/a.pdf','parsed',NULL,'{}'::jsonb,NULL`, "parsed without source"],
      [`'${U1}/onboarding/a.pdf','failed',NULL,'{}'::jsonb,NULL`, "failed without reason"],
      [`'${U1}/onboarding/a.pdf','parsed','rules','{}'::jsonb,'no_text'`, "parsed with reason"],
      [`'${U1}/onboarding/a.pdf','parsed','rules','[]'::jsonb,NULL`, "array profile"],
      [`'${U1}/onboarding/a.pdf','parsed','rules',jsonb_build_object('x', repeat('a', 40000)),NULL`, "oversized profile"],
      [`'${U1}/onboarding/a.pdf','done','rules','{}'::jsonb,NULL`, "unknown status"],
    ];
    for (const [vals, label] of bad) {
      await assert.rejects(
        asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_profiles(user_id,source_storage_path,parse_status,parse_source,profile,failure_reason)
          VALUES ('${U1}',${vals}) ON CONFLICT (user_id) DO UPDATE SET source_storage_path=excluded.source_storage_path,
          parse_status=excluded.parse_status, parse_source=excluded.parse_source, profile=excluded.profile, failure_reason=excluded.failure_reason`),
        /check constraint/i,
        label
      );
    }
    ok("check constraints reject foreign path, inconsistent status, non-object and oversized profile");

    await assert.rejects(
      asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_profiles(user_id,source_storage_path,parse_status,parse_source)
        VALUES ('33333333-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333333/onboarding/a.pdf','parsed','ai')`),
      /foreign key/i
    );
    ok("a profile requires an upload pointer row");

    await asRole(pg, "service_role", null, `DELETE FROM public.onboarding_resume_uploads WHERE user_id='${U2}'`);
    await pg.exec(`DELETE FROM auth.users WHERE id='${U1}'`);
    const left = await pg.query(`SELECT count(*)::int AS n FROM public.onboarding_resume_profiles`);
    assert.equal(left.rows[0].n, 0);
    ok("profile is deleted with the upload pointer and with the account");

    await pg.exec(`INSERT INTO auth.users(id,email) VALUES ('${U1}','a@x.dev')`);
    await asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_uploads(user_id,storage_path,file_name,mime_type,size_bytes)
      VALUES ('${U1}','${U1}/onboarding/c.pdf','c.pdf','application/pdf',10)`);
    await asRole(pg, "service_role", null, `INSERT INTO public.onboarding_resume_profiles(user_id,source_storage_path,parse_status,parse_source,profile)
      VALUES ('${U1}','${U1}/onboarding/c.pdf','parsed','ai',${PROFILE})`);
    await pg.exec(rollbackSql());
    await pg.exec(rollbackSql());
    const after = await pg.query(`SELECT to_regclass('public.onboarding_resume_profiles') AS t,
      to_regclass('public.onboarding_resume_profiles_rolled_back_20261119') AS r,
      to_regclass('public.onboarding_resume_uploads') AS parent`);
    assert.equal(after.rows[0].t, null);
    assert.ok(after.rows[0].r);
    assert.ok(after.rows[0].parent);
    const kept = await pg.query(`SELECT count(*)::int AS n FROM public.onboarding_resume_profiles_rolled_back_20261119`);
    assert.equal(kept.rows[0].n, 1);
    ok("guarded rollback: renames (keeps rows), parent untouched, re-runnable");
  });

  await withFixture("missing parent", { withParent: false }, async (pg) => {
    await refuses(pg, /onboarding_resume_uploads is missing/, "missing parent");
    ok("preflight refuses when 20261118 is not applied");
  });

  await withFixture("foreign table", { withParent: true }, async (pg) => {
    await pg.exec(`CREATE TABLE public.onboarding_resume_profiles (user_id uuid primary key)`);
    await refuses(pg, /not created by this migration/, "foreign table");
    ok("preflight refuses a foreign pre-existing table");
  });

  await withFixture("inherited truncate helper role", { withParent: true }, async (pg) => {
    await pg.exec(`
      CREATE ROLE truncator_helper NOLOGIN;
      GRANT truncator_helper TO authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRUNCATE ON TABLES TO truncator_helper;
    `);
    await refuses(pg, /post-check: role authenticated still holds TRUNCATE/i, "inherited truncate");
    ok("post-check catches TRUNCATE privilege inherited through another role");
  });

  console.log(`\nAll ${passed} checks passed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
