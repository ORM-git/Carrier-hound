/**
 * scripts/test-resumes-direct-write-block.ts
 *
 * Real-Postgres (PGlite) integration test for migration 20261116d: authenticated clients must not
 * INSERT into public.resumes. Applies supabase/schema.sql plus EVERY migration in order (only
 * 20261108a_pg_cron_scheduled_jobs.sql is skipped: pg_cron does not exist in PGlite), then acts as
 * `authenticated` with PostgREST-style claims (SET ROLE + request.jwt.claim.sub), the way Supabase
 * does for a user JWT. No mocks, no service-role shortcuts for the denied cases.
 */
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_stat_statements } from "@electric-sql/pglite/contrib/pg_stat_statements";
import assert from "assert";
import fs from "fs";
import path from "path";

const MIGRATION = "20261116d_resumes_block_direct_writes.sql";
const SKIPPED = new Set(["20261108a_pg_cron_scheduled_jobs.sql"]);
const FREE = "11111111-1111-4111-8111-111111111111";
const PRO = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

let passed = 0;
function ok(name: string) { passed++; console.log(`  [PASS] ${name}`); }

async function asUser(pg: PGlite, uid: string, sql: string, params: any[] = []) {
  await pg.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await pg.query(sql, params); }
  finally { await pg.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);"); }
}
async function asService(pg: PGlite, sql: string, params: any[] = []) {
  await pg.exec("SET ROLE service_role;");
  try { return await pg.query(sql, params); } finally { await pg.exec("RESET ROLE;"); }
}
async function denied(p: Promise<any>, label: string) {
  try { await p; } catch (e: any) {
    assert.ok(/permission denied|row-level security/i.test(e.message), `${label}: unexpected error ${e.message}`);
    return e.message as string;
  }
  assert.fail(`${label}: expected permission/RLS denial but the statement succeeded`);
}

async function snapshot(pg: PGlite, title: string) {
  const pol = await pg.query(`SELECT policyname, permissive, roles::text, cmd, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='resumes' ORDER BY policyname`);
  const gr = await pg.query(`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='resumes' AND grantee IN ('anon','authenticated','service_role') ORDER BY 1,2`);
  console.log(`\n-- ${title}: pg_policies (public.resumes)`);
  console.table(pol.rows);
  console.log(`-- ${title}: role_table_grants (anon/authenticated/service_role)`);
  console.log(gr.rows.map((r: any) => `${r.grantee}:${r.privilege_type}`).join(", "));
}

async function main() {
  const pg = new PGlite({ extensions: { pg_trgm, unaccent, pg_stat_statements } });
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS storage; CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE TABLE auth.users (id uuid primary key, email text, raw_user_meta_data jsonb, created_at timestamptz default now());
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticator NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('role', true) $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    CREATE TABLE storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner uuid);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array(name,'/') $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    -- Supabase grants new public tables to these roles by default; mirror that.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  await pg.exec(fs.readFileSync("supabase/schema.sql", "utf8"));
  // Production drift: jobs.category predates the migration history but is not in schema.sql.
  await pg.exec("ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS category text, ADD COLUMN IF NOT EXISTS country text;");

  const dir = "supabase/migrations";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const beforeFiles = files.filter((f) => f < MIGRATION);
  let applied = 0;
  const failed: string[] = [];
  for (const f of beforeFiles) {
    if (SKIPPED.has(f)) continue;
    try { await pg.exec(fs.readFileSync(path.join(dir, f), "utf8")); applied++; }
    catch (e: any) { await pg.exec("ROLLBACK").catch(() => {}); failed.push(`${f} :: ${String(e.message).slice(0, 120)}`); }
  }
  console.log(`Applied ${applied} pre-existing migrations (skipped: ${[...SKIPPED].join(", ")})`);
  failed.forEach((f) => console.log(`  [pre-existing drift, not applied] ${f}`));
  // Only migrations that depend on prod objects outside this repo (jobs/jobs_public drift) may fail;
  // nothing that touches resumes, subscriptions, payments or storage may.
  failed.forEach((f) => assert.ok(!/resume|subscription|payment|billing|account_delete|launch_scope/i.test(f.split(" :: ")[0]), `unexpected migration failure: ${f}`));
  assert.ok(applied >= 60, `too few migrations applied: ${applied}`);
  await snapshot(pg, "BEFORE 20261116d");

  // ---- Prove the hole exists before the fix (this is the self-check baseline) ----
  await pg.exec(`INSERT INTO auth.users(id,email) VALUES ('${FREE}','free@x.dev'),('${PRO}','pro@x.dev'),('${OTHER}','other@x.dev')`);
  const hole = await asUser(pg, FREE, `INSERT INTO public.resumes(user_id,file_name,storage_path) VALUES ($1,'a.pdf',$2) RETURNING id`, [FREE, `${FREE}/a.pdf`]);
  assert.ok(hole.rows[0].id, "baseline: direct insert must succeed BEFORE the migration (proves the hole)");
  ok("BEFORE migration: authenticated direct INSERT succeeds (the hole is real)");
  await asService(pg, `DELETE FROM public.resumes`);

  // ---- Apply the fix, twice (idempotency) ----
  const sql = fs.readFileSync(path.join(dir, MIGRATION), "utf8");
  await pg.exec(sql);
  await pg.exec(sql);
  ok("migration applies twice without error (idempotent)");
  await snapshot(pg, "AFTER 20261116d");

  // Later migrations must not re-open the table.
  for (const f of files.filter((f) => f > MIGRATION)) await pg.exec(fs.readFileSync(path.join(dir, f), "utf8"));

  const ins = (uid: string, owner: string) =>
    asUser(pg, uid, `INSERT INTO public.resumes(user_id,file_name,storage_path) VALUES ($1,'x.pdf',$2)`, [owner, `${owner}/x.pdf`]);

  // Free user: under limit (0 rows), at limit (seeded rows by service role) and Pro: all denied.
  await denied(ins(FREE, FREE), "free under limit");
  ok("free user under the limit: direct INSERT denied");
  await asService(pg, `INSERT INTO public.resumes(user_id,file_name,storage_path) VALUES ($1,'seed.pdf',$2)`, [FREE, `${FREE}/seed.pdf`]);
  await denied(ins(FREE, FREE), "free at limit");
  ok("free user at the limit: direct INSERT denied");
  await pg.exec(`INSERT INTO public.subscriptions(user_id,status,plan_id,current_period_end) VALUES ('${PRO}','active','monthly', now() + interval '30 days')`).catch(() => {});
  await denied(ins(PRO, PRO), "pro user");
  ok("Pro user: direct INSERT also denied (creation is server-only)");
  await denied(ins(FREE, OTHER), "other user's id");
  ok("inserting a row with someone else's user_id: denied");

  // Upsert and update bypass attempts
  await denied(
    asUser(pg, FREE, `INSERT INTO public.resumes(id,user_id,file_name,storage_path) VALUES (gen_random_uuid(),$1,'u.pdf','p') ON CONFLICT (id) DO UPDATE SET file_name='u'`, [FREE]),
    "upsert",
  );
  ok("upsert (INSERT .. ON CONFLICT DO UPDATE): denied");
  await denied(asUser(pg, FREE, `UPDATE public.resumes SET user_id = $1 WHERE user_id = $2`, [OTHER, FREE]), "re-point user_id");
  ok("UPDATE changing user_id to another user: denied");

  // Owner SELECT / UPDATE / DELETE keep working; other users' rows stay invisible.
  await asService(pg, `INSERT INTO public.resumes(user_id,file_name,storage_path) VALUES ($1,'other.pdf',$2)`, [OTHER, `${OTHER}/other.pdf`]);
  const sel = await asUser(pg, FREE, `SELECT file_name FROM public.resumes`);
  assert.deepStrictEqual(sel.rows.map((r: any) => r.file_name), ["seed.pdf"]);
  ok("owner SELECT works and only returns own rows");
  const upd = await asUser(pg, FREE, `UPDATE public.resumes SET file_name='renamed.pdf' WHERE user_id = $1`, [FREE]);
  assert.strictEqual(upd.affectedRows, 1);
  ok("owner UPDATE of own row works");
  const updOther = await asUser(pg, FREE, `UPDATE public.resumes SET file_name='hacked' WHERE user_id = $1`, [OTHER]);
  assert.strictEqual(updOther.affectedRows, 0);
  ok("UPDATE of another user's row affects 0 rows");
  const delOther = await asUser(pg, FREE, `DELETE FROM public.resumes WHERE user_id = $1`, [OTHER]);
  assert.strictEqual(delOther.affectedRows, 0);
  const del = await asUser(pg, FREE, `DELETE FROM public.resumes WHERE user_id = $1`, [FREE]);
  assert.strictEqual(del.affectedRows, 1);
  ok("owner DELETE works, another user's rows are untouched");

  // Server path still works (service role, user_id from verified session).
  const svc = await asService(pg, `INSERT INTO public.resumes(user_id,file_name,storage_path) VALUES ($1,'svc.pdf',$2) RETURNING id`, [FREE, `${FREE}/svc.pdf`]);
  assert.ok(svc.rows[0].id);
  ok("service_role INSERT (server route path) still works");

  // anon can do nothing
  await pg.exec("SET ROLE anon;");
  await denied(pg.query(`INSERT INTO public.resumes(user_id,file_name,storage_path) VALUES ('${FREE}','a','b')`), "anon insert");
  await denied(pg.query(`SELECT * FROM public.resumes`), "anon select");
  await pg.exec("RESET ROLE;");
  ok("anon: INSERT and SELECT denied");

  // ---- Self-check: restore the OLD policy + grant, the direct-insert check must now FAIL ----
  await pg.exec(`
    GRANT INSERT ON public.resumes TO authenticated;
    CREATE POLICY "Users can manage own resumes" ON public.resumes FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  `);
  let detected = false;
  try { await denied(ins(FREE, FREE), "self-check"); } catch { detected = true; }
  assert.ok(detected, "self-check: with the old policy restored the denial assertion must FAIL");
  ok("SELF-CHECK: with the old insert policy restored, the direct-insert test fails (as it should)");
  await pg.exec(sql); // revert
  await denied(ins(FREE, FREE), "after revert");
  ok("SELF-CHECK reverted: migration re-applied, direct INSERT denied again");

  console.log(`\nRESUMES DIRECT-WRITE BLOCK: ${passed} passed, 0 failed`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
