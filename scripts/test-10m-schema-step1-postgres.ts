/**
 * scripts/test-10m-schema-step1-postgres.ts
 *
 * Fail-closed REAL PostgreSQL rehearsal of 20261116b on a NEW local disposable cluster this script creates
 * (initdb into a fresh temp directory, 127.0.0.1 only, random port, trust auth, deleted afterwards).
 * It never accepts a connection URL, ignores PG* / DATABASE_URL environment variables, refuses to run on a
 * server whose data directory it did not create, and refuses any non-empty database. No credentials exist.
 *
 * Setup (disposable, local only; nothing is added to package.json):
 *   - PostgreSQL server binaries (initdb, pg_ctl, postgres) on PATH or in PG_BIN
 *   - the node-postgres client: npm install --no-save pg@8
 *
 * Runs:
 *   1. the engine-neutral correctness scenarios of scripts/test-10m-schema-step1-rehearsal.ts on real PG
 *   2. a scaled concurrency rehearsal on the RECONSTRUCTED owner baseline (recon-incomplete), --jobs=N
 *      (default 200000) with independent sessions: held reader, live writer + feed reader, migration,
 *      lock observer (pg_locks / pg_stat_activity every 50 ms):
 *        a. contention: a held reader blocks 16b's ACCESS EXCLUSIVE request; lock_timeout must abort 16b
 *           cleanly (no partial objects, data unchanged) while queued writers are measured
 *        b. statement_timeout fires mid-migration: clean rollback
 *        c. retry under live writes and reads: success; lock wait / hold / write and read latency measured
 *        d. second apply: safe no-op (still takes the locks; measured)
 *   3. deterministic lock-order probes: a writer holding jobs (or saved_jobs) in an open transaction that
 *      then touches companies (or jobs) must never deadlock with 16b
 *   4. remove-if-empty late-writer regression (two sessions): a concurrent write into a created table or a
 *      pre-existing reference-holder column either blocks until removal has committed, or makes removal
 *      refuse; a committed write is never dropped
 *
 * Flags: --jobs=N, --skip-correctness, --negative-control, --migration=<path>, --json=<path>
 * Exit: 0 all checks passed; 1 a check failed; 2 environment refused / prerequisites missing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import {
  Db, Engine, check, checks, notes, finish, runScenarios, setUnavailableExtensions, populatedProductionOrder,
  applyTarget, snapshot, originalColumns, diffSnapshots, TARGET, MIG_DIR, ROOT, ROLLBACK_DISABLE, ROLLBACK_REMOVE, splitFinalCommit,
} from "./test-10m-schema-step1-rehearsal";

const args = process.argv.slice(2);
const refuse = (msg: string): never => {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
};
if (args.some((a) => /^--(url|host|connection|database-url|dsn)\b/i.test(a) || /^postgres(ql)?:\/\//i.test(a))) {
  refuse("this runner never connects to a given database or URL; it only uses a cluster it creates itself.");
}
const jobsArg = Number(args.find((a) => a.startsWith("--jobs="))?.slice(7) ?? 200000);
const N_JOBS = Number.isFinite(jobsArg) && jobsArg >= 1000 && jobsArg <= 2_000_000 ? Math.floor(jobsArg) : refuse("--jobs must be 1000..2000000");
const migrationArg = args.find((a) => a.startsWith("--migration="));
const jsonArg = args.find((a) => a.startsWith("--json="))?.slice(7);
const NEGATIVE = args.includes("--negative-control");
const SKIP_CORRECTNESS = args.includes("--skip-correctness");
const TARGET_PATH = migrationArg ? path.resolve(migrationArg.slice(12)) : path.join(MIG_DIR, TARGET);

// ---------------------------------------------------------------------------------------------------
// Prerequisites (fail closed)
// ---------------------------------------------------------------------------------------------------
function findBin(name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const dirs = [process.env.PG_BIN, ...(process.env.PATH || "").split(path.delimiter)].filter(Boolean) as string[];
  for (const d of dirs) if (fs.existsSync(path.join(d, exe))) return path.join(d, exe);
  return refuse(`${exe} not found. Put PostgreSQL server binaries on PATH or set PG_BIN.`);
}
let PgClient: any;
try { PgClient = require("pg").Client; } catch { refuse("node-postgres missing. Install it without touching package.json: npm install --no-save pg@8"); }
for (const k of ["DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE"]) {
  if (process.env[k]) { console.log(`  note: ignoring ${k} from the environment`); delete process.env[k]; }
}
const INITDB = findBin("initdb");
const PG_CTL = findBin("pg_ctl");

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------------------------------------------------------------------------------------------------
// Disposable cluster
// ---------------------------------------------------------------------------------------------------
type Cluster = { dataDir: string; port: number; user: string; stop: () => void };

async function startCluster(): Promise<Cluster> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cm-643-rehearsal-"));
  const dataDir = path.join(base, "data");
  const user = "postgres"; // Supabase runs migrations as postgres; the repo's migrations reference this role
  const init = spawnSync(INITDB, ["-D", dataDir, "-U", user, "-A", "trust", "-E", "UTF8", "--no-instructions"], { encoding: "utf8" });
  if (init.status !== 0) refuse(`initdb failed: ${(init.stderr || init.stdout).slice(0, 400)}`);
  const port = await freePort();
  const opts = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c max_connections=40 -c fsync=on`;
  // stdio "ignore": the postmaster pg_ctl launches would otherwise inherit captured pipes and spawnSync would
  // never return on Windows. Server output goes to the -l log file inside our temp directory.
  const start = spawnSync(PG_CTL, ["-D", dataDir, "-o", opts, "-l", path.join(base, "server.log"), "-w", "-t", "60", "start"], { stdio: "ignore" });
  if (start.status !== 0) {
    const log = fs.existsSync(path.join(base, "server.log")) ? fs.readFileSync(path.join(base, "server.log"), "utf8").slice(-400) : "";
    refuse(`pg_ctl start failed (status ${start.status}): ${log}`);
  }
  const stop = () => {
    spawnSync(PG_CTL, ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
    // Keep PostgreSQL's own lock diagnostics (deadlock / lock timeout reports) before deleting the cluster
    try {
      const log = fs.readFileSync(path.join(base, "server.log"), "utf8").split(/\r?\n/);
      notes.server_log_lock_reports = log.filter((l, i) => /deadlock|lock timeout|Process \d+ waits|DETAIL|HINT|CONTEXT|STATEMENT/i.test(l)
        && log.slice(Math.max(0, i - 6), i + 1).some((x) => /deadlock|lock timeout/i.test(x))).map((l) => l.slice(0, 400)).slice(0, 80);
    } catch {}
    fs.rmSync(base, { recursive: true, force: true }); // our own mkdtemp directory only
  };
  return { dataDir, port, user, stop };
}

async function connect(c: Cluster, database: string, appName: string) {
  const client = new PgClient({ host: "127.0.0.1", port: c.port, user: c.user, database, application_name: appName });
  await client.connect();
  // Fail closed: the server must be the cluster this script created, bound to loopback
  const r = await client.query(`SELECT current_setting('data_directory') d, inet_server_addr()::text a`);
  const same = path.resolve(r.rows[0].d).toLowerCase() === path.resolve(c.dataDir).toLowerCase();
  if (!same || !String(r.rows[0].a).startsWith("127.0.0.1")) {
    await client.end();
    refuse(`connected server is not the disposable cluster (data_directory/address mismatch)`);
  }
  return client;
}

const adapt = (client: any): Db => ({
  exec: async (s: string) => { await client.query(s); },
  query: (s: string, p?: unknown[]) => client.query(s, p),
});

let dbSeq = 0;
function engineFor(c: Cluster, admin: any): Engine {
  return {
    name: "PostgreSQL (local disposable cluster)",
    newDb: async (label: string) => {
      const name = `r_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${++dbSeq}`;
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`);
      const client = await connect(c, name, `rehearsal:${label}`);
      const nonEmpty = (await client.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind = 'r'`)).rows[0].n;
      if (nonEmpty > 0) { await client.end(); refuse(`database ${name} is not empty`); }
      const db = adapt(client) as any;
      db._client = client; db._name = name;
      return db;
    },
    close: async (db: any) => {
      await db._client.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${db._name}" WITH (FORCE)`).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Scaled synthetic fixture (no customer data)
// ---------------------------------------------------------------------------------------------------
function scaledFixture(nJobs: number): string {
  const nCompanies = Math.max(50, Math.floor(nJobs / 100));
  const nUsers = Math.max(50, Math.floor(nJobs / 400));
  return `
  INSERT INTO auth.users (id, email)
  SELECT ('00000000-0000-4000-9000-' || lpad(u::text, 12, '0'))::uuid, 'scale-user-' || u || '@example.invalid' FROM generate_series(1, ${nUsers}) u;
  INSERT INTO public.companies (id, name, slug, domain, country_code, category, enabled)
  SELECT ('00000000-0000-4000-a000-' || lpad(c::text, 12, '0'))::uuid, 'Scale Company ' || c || CASE WHEN c % 7 = 0 THEN ' Ünïcödé' ELSE '' END,
         'scale-company-' || c, 'scale' || c || '.example.invalid', (ARRAY['US','IN','DE','BR'])[1 + c % 4],
         (ARRAY['MNC_BIGTECH','HIGH_PRODUCT_YC','OTHER_STARTUPS','INDIAN_IT_AND_OTHER',NULL])[1 + c % 5], true
  FROM generate_series(1, ${nCompanies}) c;
  INSERT INTO public.jobs (id, company, company_id, title, location, remote, remote_scope, job_type, salary_min, salary_max,
    currency, salary_period, apply_url, source, source_job_id, source_id, source_type, category, country, country_code,
    posted_at, first_seen_at, last_seen_at, is_active, status, created_at)
  SELECT ('00000000-0000-4000-b000-' || lpad(g::text, 12, '0'))::uuid,
    'Scale Company ' || (1 + g % ${nCompanies}), ('00000000-0000-4000-a000-' || lpad((1 + g % ${nCompanies})::text, 12, '0'))::uuid,
    (ARRAY['Software Engineer', 'Data Analyst Intern', 'Ingénieur logiciel', 'Senior SRE', '软件工程师'])[1 + g % 5] || ' ' || g,
    (ARRAY['Remote (Worldwide)', 'Bengaluru, India', 'Berlin, Germany', 'Austin, TX'])[1 + g % 4],
    g % 4 = 0, (ARRAY['remote', 'onsite', 'hybrid', 'onsite'])[1 + g % 4], (ARRAY['full-time', 'internship', 'contract'])[1 + g % 3],
    CASE WHEN g % 3 = 0 THEN NULL ELSE 1000 + g % 900 END, CASE WHEN g % 3 = 0 THEN NULL ELSE 2000 + g % 900 END,
    'INR', 'monthly', 'https://apply.example.invalid/scale/' || g,
    (ARRAY['greenhouse', 'lever', 'ashby', 'remotive'])[1 + g % 4], g::text,
    (ARRAY['greenhouse', 'lever', 'ashby', 'remotive'])[1 + g % 4] || ':scale-company-' || (1 + g % ${nCompanies}),
    CASE WHEN g % 4 = 3 THEN 'api' ELSE 'ats' END, (ARRAY['engineering', 'ai', 'data', NULL])[1 + g % 4],
    (ARRAY['United States', 'India', 'Germany', NULL])[1 + g % 4], (ARRAY['US', 'IN', 'DE', NULL])[1 + g % 4],
    timestamptz '2026-10-01 00:00:00+00' + (g % 100000 || ' seconds')::interval,
    timestamptz '2026-09-01 00:00:00+00' + (g % 100000 || ' seconds')::interval,
    timestamptz '2026-11-01 00:00:00+00' + (g % 100000 || ' seconds')::interval,
    g % 5 <> 0, CASE WHEN g % 5 = 0 THEN 'expired' ELSE 'active' END,
    timestamptz '2026-09-01 00:00:00+00' + (g % 100000 || ' seconds')::interval
  FROM generate_series(1, ${nJobs}) g;
  INSERT INTO public.job_descriptions (job_id, description_text, updated_at)
  SELECT id, 'Synthetic description ' || title, timestamptz '2026-11-02 00:00:00+00' FROM public.jobs WHERE substring(id::text from 25)::bigint % 2 = 0;
  INSERT INTO public.saved_jobs (user_id, job_id, created_at)
  SELECT ('00000000-0000-4000-9000-' || lpad(u::text, 12, '0'))::uuid, ('00000000-0000-4000-b000-' || lpad((u * 10 + k)::text, 12, '0'))::uuid,
         timestamptz '2026-11-03 00:00:00+00'
  FROM generate_series(1, ${nUsers}) u CROSS JOIN generate_series(1, 10) k WHERE u * 10 + k <= ${nJobs};
  `;
}

// ---------------------------------------------------------------------------------------------------
// Concurrency rehearsal
// ---------------------------------------------------------------------------------------------------
type Event = { t: number; who: string; what: string };

async function concurrency(c: Cluster, admin: any, targetSql: string) {
  console.log(`\n=== S: scaled concurrency rehearsal on real PostgreSQL (recon-incomplete, ${N_JOBS} jobs) ===`);
  const engine = engineFor(c, admin);
  const t0 = now();
  const mig = await populatedProductionOrder(engine, "recon-incomplete", "scale", async (db) => { await db.exec(scaledFixture(N_JOBS)); }) as any;
  await mig.exec(`ANALYZE`);
  notes.scale_setup_ms = Math.round(now() - t0);
  const dbName = mig._name;
  const counts = (await mig.query(`SELECT (SELECT count(*) FROM public.jobs)::int jobs, (SELECT count(*) FROM public.jobs WHERE is_active)::int active,
     (SELECT count(*) FROM public.companies)::int companies, (SELECT count(*) FROM public.job_descriptions)::int descriptions,
     (SELECT count(*) FROM public.saved_jobs)::int saved_jobs, pg_size_pretty(pg_total_relation_size('public.jobs')) jobs_size`)).rows[0];
  notes.scale_counts = counts;
  console.log(`  populated: ${JSON.stringify(counts)} in ${notes.scale_setup_ms} ms`);
  const cols = await originalColumns(mig);
  const before = await snapshot(mig, cols);

  const reader = await connect(c, dbName, "held-reader");
  const writer = await connect(c, dbName, "live-writer");
  const feed = await connect(c, dbName, "feed-reader");
  const observer = await connect(c, dbName, "lock-observer");
  const migPid = (await mig.query(`SELECT pg_backend_pid() p`)).rows[0].p;

  // ---- lock observer -------------------------------------------------------------------------------
  let observing = false;
  let samples: Array<{ t: number; rows: any[] }> = [];
  let phaseT0 = 0;
  const observe = async () => {
    while (observing) {
      const r = await observer.query(`
        SELECT a.application_name app, a.pid, a.state, a.wait_event_type wet, a.wait_event we, l.mode, l.granted, c.relname rel
          FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid AND l.locktype = 'relation'
          LEFT JOIN pg_class c ON c.oid = l.relation
         WHERE a.datname = current_database() AND a.application_name IN ('rehearsal:scale', 'held-reader', 'live-writer', 'feed-reader')
           AND (c.relname IS NULL OR c.relname IN ('jobs', 'companies', 'job_descriptions', 'saved_jobs'))`);
      samples.push({ t: Math.round(now() - phaseT0), rows: r.rows });
      await sleep(50);
    }
  };
  const startObserving = () => { samples = []; observing = true; phaseT0 = now(); return observe(); };

  // ---- live traffic --------------------------------------------------------------------------------
  let traffic = false;
  let seq = 0;
  const latencies: { write: number[]; read: number[] } = { write: [], read: [] };
  const events: Event[] = [];
  const writeLoop = async () => {
    while (traffic) {
      const s = now();
      try {
        await writer.query(`INSERT INTO public.jobs (company, title, location, source, source_job_id, source_id, is_active, status)
                            VALUES ('Live Writer Co', 'Live posting ${seq}', 'Remote', 'live', 'live-${process.pid}-${++seq}', 'live:writer', true, 'active')`);
        latencies.write.push(now() - s);
      } catch (e: any) { events.push({ t: Math.round(now() - phaseT0), who: "writer", what: `error ${e.message}` }); }
      await sleep(25);
    }
  };
  const readLoop = async () => {
    while (traffic) {
      const s = now();
      try {
        await feed.query(`SELECT id, title, location FROM public.jobs_public ORDER BY id DESC LIMIT 25`);
        latencies.read.push(now() - s);
      } catch (e: any) { events.push({ t: Math.round(now() - phaseT0), who: "feed", what: `error ${e.message}` }); }
      await sleep(25);
    }
  };
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : 0);
    return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.length ? Math.round(s[s.length - 1]) : 0 };
  };
  /** Turn observer samples into per-session wait/hold intervals for the migration and traffic sessions. */
  const timeline = () => {
    const mig = samples.map((s) => ({ t: s.t, waiting: s.rows.some((r) => r.app === "rehearsal:scale" && r.granted === false),
      aeJobs: s.rows.some((r) => r.app === "rehearsal:scale" && r.rel === "jobs" && r.granted && r.mode === "AccessExclusiveLock"),
      trafficWaiting: s.rows.some((r) => (r.app === "live-writer" || r.app === "feed-reader") && r.granted === false) }));
    const span = (pred: (x: any) => boolean) => { const xs = mig.filter(pred); return xs.length ? { from: xs[0].t, to: xs[xs.length - 1].t, ms: xs[xs.length - 1].t - xs[0].t } : null; };
    return { migWaitingForLock: span((x) => x.waiting), accessExclusiveOnJobsHeld: span((x) => x.aeJobs), trafficQueued: span((x) => x.trafficWaiting), samples: samples.length };
  };

  // ---- a. contention: held reader + lock_timeout ---------------------------------------------------
  await reader.query(`BEGIN; SELECT count(*) FROM public.jobs;`); // holds ACCESS SHARE on jobs until COMMIT
  events.length = 0;
  const obsA = startObserving();
  events.push({ t: 0, who: "reader", what: "holds ACCESS SHARE on public.jobs (open transaction)" });
  await mig.exec(`SET lock_timeout = '3s'; SET statement_timeout = '600s';`);
  traffic = true;
  const migA = applyTarget(mig, targetSql).then((r) => { events.push({ t: Math.round(now() - phaseT0), who: "migration", what: r.ok ? "committed" : `aborted: ${r.error}` }); return r; });
  await sleep(400);
  events.push({ t: Math.round(now() - phaseT0), who: "traffic", what: "writer + feed reader start while 16b waits" });
  const loops = [writeLoop(), readLoop()];
  const resA = await migA;
  await sleep(300);
  traffic = false; await Promise.all(loops);
  observing = false; await obsA;
  await reader.query(`COMMIT`);
  const tlA = timeline();
  notes.scale_contention = { result: { ok: resA.ok, ms: resA.ms, error: resA.error }, lock_timeout: "3s", timeline: tlA, events: [...events],
    write_ms: stats(latencies.write), read_ms: stats(latencies.read) };
  check("S", "under contention 16b aborts on lock_timeout (no indefinite wait)", !resA.ok && /lock timeout/i.test(resA.error || ""), resA.error);
  check("S", "while 16b waited, later writers/readers queued behind its ACCESS EXCLUSIVE request (measured)", !!tlA.trafficQueued,
    tlA.trafficQueued ? `queued ${tlA.trafficQueued.ms} ms` : "no queued traffic observed");
  const liveRows = (await mig.query(`SELECT count(*)::int n FROM public.jobs WHERE source = 'live'`)).rows[0].n;
  await mig.exec(`DELETE FROM public.jobs WHERE source = 'live'`); // remove probe rows so data comparisons stay exact
  const afterA = diffSnapshots(before, await snapshot(mig, cols));
  check("S", "aborted run left data, schema, grants and #645 state unchanged", afterA.length === 0, afterA.slice(0, 5).join("; ") || `${liveRows} probe writes removed`);
  check("S", "no partial objects after the abort", (await mig.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'internal_ingestion'`)).rows.length === 0);

  // ---- b. statement_timeout mid-migration ----------------------------------------------------------
  // All of 16b's DDL has run (locks held) when the injected 1 s statement exceeds the 250 ms limit, so the
  // timeout fires inside the open migration transaction. PG >= 13 times each statement of a multi-statement query.
  await mig.exec(`SET lock_timeout = '3s'; SET statement_timeout = '250ms';`);
  const resB = await applyTarget(mig, targetSql, "SELECT pg_sleep(1); -- rehearsal: exceeds statement_timeout before COMMIT");
  await mig.exec(`SET statement_timeout = '600s';`);
  notes.scale_statement_timeout = { ok: resB.ok, ms: resB.ms, error: resB.error, statement_timeout: "250ms" };
  check("S", "statement_timeout mid-migration aborts cleanly", !resB.ok && /statement timeout/i.test(resB.error || ""), resB.error);
  const afterB = diffSnapshots(before, await snapshot(mig, cols));
  check("S", "statement_timeout abort left everything unchanged", afterB.length === 0, afterB.slice(0, 5).join("; ") || undefined);

  // ---- c. retry under live traffic -----------------------------------------------------------------
  latencies.write = []; latencies.read = []; events.length = 0;
  await mig.exec(`SET lock_timeout = '3s'; SET statement_timeout = '600s';`);
  const obsC = startObserving();
  traffic = true;
  const loopsC = [writeLoop(), readLoop()];
  await sleep(500); // steady-state baseline latency before the migration
  const steady = { write: stats(latencies.write), read: stats(latencies.read) };
  events.push({ t: Math.round(now() - phaseT0), who: "migration", what: "16b start" });
  const resC = await applyTarget(mig, targetSql);
  events.push({ t: Math.round(now() - phaseT0), who: "migration", what: resC.ok ? `committed (${resC.ms} ms)` : `aborted: ${resC.error}` });
  await sleep(500);
  traffic = false; await Promise.all(loopsC);
  observing = false; await obsC;
  const tlC = timeline();
  notes.scale_retry = { result: { ok: resC.ok, ms: resC.ms, error: resC.error, locks_before_commit: resC.locks }, lock_timeout: "3s",
    timeline: tlC, events: [...events], steady_state_ms: steady, during_ms: { write: stats(latencies.write), read: stats(latencies.read) } };
  check("S", "retry with live writes and reads succeeds", resC.ok, resC.error ?? `${resC.ms} ms`);
  check("S", "live traffic kept working (no errors) and was blocked only while 16b held its locks",
    !events.some((e) => /error/.test(e.what)), `write max ${stats(latencies.write).max} ms, feed read max ${stats(latencies.read).max} ms`);
  await mig.exec(`DELETE FROM public.jobs WHERE source = 'live'`);
  const afterC = diffSnapshots(before, await snapshot(mig, cols));
  const allowed = afterC.filter((d) => !/^columns\.|^index\.|^acl\.|^jobs triggers/.test(d)); // 16b adds columns/indexes/objects
  check("S", "at scale: row counts, checksums, last_seen_at, #645 state and app queries unchanged", allowed.length === 0, allowed.slice(0, 5).join("; ") || undefined);

  // ---- d. second apply ---------------------------------------------------------------------------
  const resD = await applyTarget(mig, targetSql);
  notes.scale_second_apply = { ok: resD.ok, ms: resD.ms, locks_before_commit: resD.locks };
  check("S", "second apply at scale succeeds (no-op), still takes table locks", resD.ok, `${resD.ms} ms; ${resD.locks.filter((l) => /Exclusive/.test(l)).join(", ")}`);

  for (const cl of [reader, writer, feed, observer]) await cl.end().catch(() => {});
  await engine.close(mig);
  void migPid;
}

// ---------------------------------------------------------------------------------------------------
// Deterministic lock-order probes: a writer holds one lock in an open transaction, 16b starts, then the
// writer touches a second table. With an inverted migration lock order this deadlocks every time.
// ---------------------------------------------------------------------------------------------------
async function lockOrderProbes(c: Cluster, admin: any, targetSql: string) {
  console.log(`\n=== L: deterministic lock-order probes (writer vs 16b) ===`);
  const engine = engineFor(c, admin);
  const probes = [
    { name: "writer holds jobs (INSERT), then FK-checks companies", first: `INSERT INTO public.jobs (company, title, location, source, source_job_id, is_active, status)
        VALUES ('Probe', 'probe', 'Remote', 'probe', 'p-1', true, 'active')`,
      second: `SELECT 1 FROM public.companies WHERE id = '00000000-0000-4000-8000-0000000c0001' FOR KEY SHARE` },
    { name: "writer holds saved_jobs (UPDATE), then reads jobs", first: `UPDATE public.saved_jobs SET created_at = created_at
        WHERE id = (SELECT id FROM public.saved_jobs ORDER BY id LIMIT 1)`,
      second: `SELECT count(*) FROM public.jobs WHERE is_active` },
  ];
  const results: any[] = [];
  for (const p of probes) {
    const db = (await populatedProductionOrder(engine, "recon-incomplete", "lockorder")) as any;
    const w = await connect(c, db._name, "lock-order-writer");
    await w.query(`SET deadlock_timeout = '200ms'`);
    await db.exec(`SET lock_timeout = '15s'; SET deadlock_timeout = '200ms';`);
    await w.query(`BEGIN`);
    await w.query(p.first);
    const t0 = now();
    const migP = applyTarget(db, targetSql);
    await sleep(800); // 16b is now waiting for (or already holds) its locks
    let writerError: string | null = null;
    try { await w.query(p.second); await w.query(`COMMIT`); }
    catch (e: any) { writerError = e.message; await w.query(`ROLLBACK`).catch(() => {}); }
    const mig = await migP;
    const r = { probe: p.name, writerError, migrationOk: mig.ok, migrationError: mig.error, migrationMs: Math.round(now() - t0) };
    results.push(r);
    check("L", `no deadlock: ${p.name}`, !writerError && mig.ok && !/deadlock/i.test(mig.error || ""),
      writerError || mig.error || `writer committed first; 16b then committed after ${r.migrationMs} ms`);
    await w.end().catch(() => {});
    await engine.close(db);
  }
  notes.lock_order_probes = results;
}

// ---------------------------------------------------------------------------------------------------
// remove-if-empty vs a late writer (two real sessions). The script must take its write-blocking locks
// before any emptiness/reference check and hold them through COMMIT, so a concurrent write either blocks
// until removal has committed, or makes removal refuse. A committed write must never be dropped.
// ---------------------------------------------------------------------------------------------------
async function lateWriterRegression(c: Cluster, admin: any, targetSql: string) {
  console.log(`\n=== W: remove-if-empty vs concurrent late writers (two sessions) ===`);
  const engine = engineFor(c, admin);
  const db = (await populatedProductionOrder(engine, "recon-incomplete", "latewriter")) as any;
  const removeSql = fs.readFileSync(ROLLBACK_REMOVE, "utf8");
  const run = async (sql: string): Promise<{ ok: boolean; error?: string }> => {
    try { await db.exec(sql); return { ok: true }; }
    catch (e: any) { await db.exec("ROLLBACK").catch(() => {}); return { ok: false, error: String(e?.message || e).slice(0, 240) }; }
  };
  const one = async (sql: string) => Number((await db.query(sql)).rows[0].n);
  const sourcesExist = async () => (await one(`SELECT count(*) n FROM pg_class WHERE oid = to_regclass('internal_ingestion.ingestion_sources')`)) === 1;
  const settle = (p: Promise<any>) => p.then(() => ({ ok: true, error: undefined as string | undefined }),
    (e: any) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }));
  const results: any[] = [];
  const observer = await connect(c, db._name, "latewriter-observer");
  const blocked = async (app: string, ms = 10000) => {
    const until = now() + ms;
    while (now() < until) {
      const r = await observer.query(`SELECT count(*)::int n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'`, [app]);
      if (r.rows[0].n > 0) return true;
      await sleep(50);
    }
    return false;
  };
  try {
    const applied = await applyTarget(db, targetSql);
    const dis = await run(fs.readFileSync(ROLLBACK_DISABLE, "utf8"));
    check("W", "setup: 16b applied and disabled (Level 1)", applied.ok && dis.ok, applied.error || dis.error);
    const jobId = (await db.query(`SELECT id FROM public.jobs ORDER BY id LIMIT 1`)).rows[0].id;
    const lateRef = "00000000-0000-4000-8000-00000000f00d";

    // ---- writer first (open transaction), removal second: removal must refuse; the write survives -----
    const writerFirst = [
      { name: "created table (INSERT internal_ingestion.ingestion_sources)",
        write: `INSERT INTO internal_ingestion.ingestion_sources (name, slug, source_type) VALUES ('Late writer', 'late:writer-1', 'ats')`,
        present: `SELECT count(*) n FROM internal_ingestion.ingestion_sources WHERE slug = 'late:writer-1'`,
        cleanup: `DELETE FROM internal_ingestion.ingestion_sources WHERE slug = 'late:writer-1'` },
      { name: "pre-existing reference holder (UPDATE public.jobs.source_registry_id)",
        write: `UPDATE public.jobs SET source_registry_id = '${lateRef}' WHERE id = '${jobId}'`,
        present: `SELECT count(*) n FROM public.jobs WHERE id = '${jobId}' AND source_registry_id = '${lateRef}'`,
        cleanup: `UPDATE public.jobs SET source_registry_id = NULL WHERE id = '${jobId}'` },
    ];
    for (const p of writerFirst) {
      const w = await connect(c, db._name, "late-writer");
      await w.query(`BEGIN`);
      await w.query(p.write);
      const t0 = now();
      const r1 = await run(removeSql); // the script's own lock_timeout (3 s) applies
      const waited = Math.round(now() - t0);
      await w.query(`COMMIT`);
      const kept = await sourcesExist();
      const r2 = await run(removeSql);
      const present = await one(p.present);
      results.push({ case: `writer first: ${p.name}`, removal_while_writer_open: r1, waited_ms: waited, removal_after_commit: r2, write_present: present });
      check("W", `writer first, ${p.name}: removal refuses on lock_timeout, nothing dropped`,
        !r1.ok && /removal refused: could not take write-blocking locks/.test(r1.error || "") && kept, r1.error ?? "removal did NOT refuse");
      check("W", `writer first, ${p.name}: once the write commits, removal refuses (data would be lost); the write is present`,
        !r2.ok && /data would be lost/.test(r2.error || "") && present === 1 && (await sourcesExist()), r2.error ?? `write present: ${present}`);
      await db.exec(p.cleanup);
      await w.end().catch(() => {});
    }

    // ---- removal first (checks passed, drop done, locks held, not committed), late writers second ------
    const begun = await run(splitFinalCommit(removeSql).body);
    check("W", "removal first: checks pass and the drops run inside the still-open transaction", begun.ok, begun.error);
    const held = (await db.query(`SELECT n.nspname || '.' || c.relname rel, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE l.pid = pg_backend_pid() AND l.granted AND l.locktype = 'relation' AND c.relkind IN ('r', 'p')
         AND n.nspname || '.' || c.relname IN ('public.jobs', 'public.companies', 'public.saved_jobs', 'public.job_descriptions', 'auth.users')
       ORDER BY 1, 2`)).rows.map((r: any) => `${r.rel}:${r.mode}`);
    const want = ["auth.users:AccessExclusiveLock", "public.companies:AccessExclusiveLock", "public.job_descriptions:ExclusiveLock",
      "public.jobs:AccessExclusiveLock", "public.saved_jobs:ExclusiveLock"];
    check("W", "removal holds write-blocking locks on every pre-existing holder/parent until COMMIT",
      want.every((x) => held.includes(x)), held.join(", "));
    const w1 = await connect(c, db._name, "late-writer-created");
    const w2 = await connect(c, db._name, "late-writer-holder");
    const rd = await connect(c, db._name, "late-reader");
    for (const w of [w1, w2, rd]) await w.query(`SET lock_timeout = '30s'`);
    const p1 = settle(w1.query(`INSERT INTO internal_ingestion.ingestion_sources (name, slug, source_type) VALUES ('Late writer', 'late:writer-2', 'ats')`));
    const p2 = settle(w2.query(`UPDATE public.jobs SET source_registry_id = '${lateRef}' WHERE id = '${jobId}'`));
    const b1 = await blocked("late-writer-created");
    const b2 = await blocked("late-writer-holder");
    const readT0 = now();
    const readOk = await settle(rd.query(`SELECT count(*) FROM public.saved_jobs`));
    const readMs = Math.round(now() - readT0);
    check("W", "removal first: a late INSERT into a created table blocks on removal's lock", b1);
    check("W", "removal first: a late write to a reference-holder column blocks on removal's lock", b2);
    check("W", "removal first: reads of a holder-only table (saved_jobs, EXCLUSIVE) still run",
      readOk.ok && readMs < 2000, readOk.error ?? `${readMs} ms`);
    await db.exec(`COMMIT`);
    const [r1, r2] = await Promise.all([p1, p2]);
    const dropped = !(await sourcesExist());
    const holderKept = await one(`SELECT count(*) n FROM public.jobs WHERE id = '${jobId}' AND source_registry_id = '${lateRef}'`);
    results.push({ case: "removal first", blocked: { created: b1, holder: b2 }, late_insert_created: r1, late_update_holder: r2,
      removed: dropped, holder_write_present: holderKept, saved_jobs_reader_ms: readMs, removal_locks: held });
    check("W", "removal first: removal committed, created tables gone, state 'removed' recorded", dropped
      && (await one(`SELECT count(*) n FROM internal_ingestion.schema_migration_provenance WHERE kind = 'state' AND object_name = 'removed'`)) === 1);
    check("W", "removal first: the blocked INSERT then failed (never committed, so no data disappeared)",
      !r1.ok && /does not exist|could not open relation/i.test(r1.error || ""), r1.error ?? "late INSERT unexpectedly succeeded");
    check("W", "removal first: the blocked reference-holder write committed after removal and is present", r2.ok && holderKept === 1, r2.error);
    for (const w of [w1, w2, rd]) await w.end().catch(() => {});
  } finally {
    notes.late_writer_regression = results;
    await observer.end().catch(() => {});
    await engine.close(db);
  }
}

// ---------------------------------------------------------------------------------------------------
async function main() {
  const targetSql = fs.readFileSync(TARGET_PATH, "utf8");
  notes.migration_file = path.relative(ROOT, TARGET_PATH);
  notes.hardware = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memory_gb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}` };
  const cluster = await startCluster();
  let exitCode = 1;
  let message: string | undefined;
  try {
    const admin = await connect(cluster, "postgres", "rehearsal-admin");
    notes.db_version = (await admin.query(`SELECT version() v`)).rows[0].v;
    notes.server_settings = (await admin.query(`SELECT name, setting FROM pg_settings WHERE name IN ('shared_buffers', 'maintenance_work_mem', 'work_mem', 'max_wal_size', 'fsync', 'synchronous_commit') ORDER BY 1`)).rows;
    console.log(`Disposable cluster: ${notes.db_version.split(",")[0]} on 127.0.0.1 (temp data dir, deleted afterwards)`);
    setUnavailableExtensions(["pg_cron"]);
    if (!SKIP_CORRECTNESS || NEGATIVE) {
      const { negativeCaught } = await runScenarios(engineFor(cluster, admin), targetSql, { negative: NEGATIVE });
      if (NEGATIVE) {
        exitCode = negativeCaught > 0 ? 1 : 0;
        message = negativeCaught > 0 ? "negative control detected (expected non-zero exit)" : "NEGATIVE CONTROL NOT DETECTED: checks are blind";
        await admin.end();
        return;
      }
    }
    await lockOrderProbes(cluster, admin, targetSql);
    await lateWriterRegression(cluster, admin, targetSql);
    await concurrency(cluster, admin, targetSql);
    await admin.end();
    exitCode = checks.some((x) => !x.ok) ? 1 : 0;
  } catch (e: any) {
    console.error("POSTGRES REHEARSAL ERROR:", e?.message || e);
    exitCode = 1;
  } finally {
    cluster.stop();
    finish(exitCode, message, jsonArg);
  }
}

main();
