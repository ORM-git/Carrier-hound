/**
 * scripts/test-16a-rollback-concurrency.ts
 *
 * Two-session late-writer test for supabase/scripts/rollback-20261116a.sql on a NEW local disposable
 * PostgreSQL cluster this script creates (initdb into a fresh temp dir, 127.0.0.1 only, random port, trust
 * auth, deleted afterwards). It never accepts a connection URL and ignores PG* / DATABASE_URL.
 *
 * Setup (local only; nothing is added to package.json):
 *   - PostgreSQL server binaries (initdb, pg_ctl) on PATH or in PG_BIN
 *   - node-postgres reachable by require("pg") (e.g. NODE_PATH=<dir>/node_modules)
 *
 * Scenarios (jobs.canonical_domain is the 16a-added, still-empty column; the late writer writes a non-NULL
 * value into it):
 *   S1 writer first, commits within lock_timeout  -> rollback waits, then sees the data and KEEPS the column
 *   S2 writer first, holds past lock_timeout      -> rollback refuses, nothing changed; the write commits
 *   S3 rollback first, writer arrives in the check-to-drop window -> writer waits; rollback drops the empty
 *      column; the writer's statement then fails (column gone). No committed value is ever dropped.
 *   S4 read-then-write writer that already holds a read lock -> deadlock or wait, resolved by PostgreSQL;
 *      either the rollback refuses or the writer's uncommitted transaction aborts; no committed value lost
 *   N  negative control: the same S3 race with the script's lock block removed MUST lose the committed
 *      value (proves the test sees the race the lock closes)
 *
 * Exit: 0 all checks passed; 1 a check failed; 2 environment refused / prerequisites missing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";

const refuse = (msg: string): never => {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
};
if (process.argv.slice(2).some((a) => /^--(url|host|connection|database-url|dsn)\b/i.test(a) || /^postgres(ql)?:\/\//i.test(a))) {
  refuse("this test never connects to a given database; it only uses a cluster it creates itself.");
}
for (const k of ["DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE"]) delete process.env[k];

function findBin(name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const dirs = [process.env.PG_BIN, ...(process.env.PATH || "").split(path.delimiter)].filter(Boolean) as string[];
  for (const d of dirs) if (fs.existsSync(path.join(d, exe))) return path.join(d, exe);
  return refuse(`${exe} not found. Put PostgreSQL server binaries on PATH or set PG_BIN.`);
}
let PgClient: any;
try { PgClient = require("pg").Client; } catch { refuse("node-postgres missing: npm install --no-save pg@8 (or set NODE_PATH)"); }
const INITDB = findBin("initdb");
const PG_CTL = findBin("pg_ctl");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261116a_high_volume_ingestion_schema.sql"), "utf8");
const ROLLBACK = fs.readFileSync(path.join(ROOT, "supabase/scripts/rollback-20261116a.sql"), "utf8");
const WINDOW_MARK = "-- [check-to-drop window]";
const LOCK_BLOCK = /-- \[lock:begin\][\s\S]*?-- \[lock:end\]/;
if (!ROLLBACK.includes(WINDOW_MARK) || !LOCK_BLOCK.test(ROLLBACK)) refuse("rollback script markers missing");
/** The shipped rollback with a pause injected between the emptiness check and DROP COLUMN of jobs.canonical_domain. */
const withWindow = (sql: string, secs: number) =>
  sql.replace(WINDOW_MARK, `IF r.t = 'jobs' AND r.col = 'canonical_domain' THEN PERFORM pg_sleep(${secs}); END IF; ${WINDOW_MARK}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

type Cluster = { dataDir: string; port: number; stop: () => void };
async function startCluster(): Promise<Cluster> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cm-16a-rollback-"));
  const dataDir = path.join(base, "data");
  const init = spawnSync(INITDB, ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-instructions"], { encoding: "utf8" });
  if (init.status !== 0) refuse(`initdb failed: ${(init.stderr || init.stdout).slice(0, 300)}`);
  const port = await freePort();
  const opts = `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c deadlock_timeout=200ms`;
  const start = spawnSync(PG_CTL, ["-D", dataDir, "-o", opts, "-l", path.join(base, "server.log"), "-w", "-t", "60", "start"], { stdio: "ignore" });
  if (start.status !== 0) refuse(`pg_ctl start failed (status ${start.status})`);
  return {
    dataDir, port,
    stop: () => {
      spawnSync(PG_CTL, ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
      fs.rmSync(base, { recursive: true, force: true }); // our own mkdtemp directory only
    },
  };
}

async function connect(c: Cluster, database: string, app: string) {
  const client = new PgClient({ host: "127.0.0.1", port: c.port, user: "postgres", database, application_name: app });
  await client.connect();
  const r = await client.query(`SELECT current_setting('data_directory') d, inet_server_addr()::text a`);
  if (path.resolve(r.rows[0].d).toLowerCase() !== path.resolve(c.dataDir).toLowerCase() || !String(r.rows[0].a).startsWith("127.0.0.1")) {
    await client.end();
    refuse("connected server is not the disposable cluster");
  }
  client.on("error", () => {});
  return client;
}

const settle = (p: Promise<any>) => p.then(() => ({ ok: true, error: "" }), (e: any) => ({ ok: false, error: String(e?.message || e).slice(0, 220) }));

let seq = 0;
async function freshDb(c: Cluster, admin: any) {
  const name = `rb16a_${++seq}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  const db = await connect(c, name, "setup");
  await db.query(`
    CREATE TABLE public.companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text UNIQUE NOT NULL);
    CREATE TABLE public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, company text NOT NULL,
      company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL, remote boolean DEFAULT false, is_active boolean DEFAULT true);
    INSERT INTO public.companies (name, slug) SELECT 'Co ' || g, 'co-' || g FROM generate_series(1, 20) g;
    INSERT INTO public.jobs (title, company, company_id) SELECT 'Job ' || g, 'Co', (SELECT id FROM public.companies ORDER BY slug LIMIT 1)
      FROM generate_series(1, 2000) g;`);
  await db.query(MIGRATION);
  const marked = (await db.query(`SELECT count(*)::int n FROM pg_attribute WHERE attrelid = 'public.jobs'::regclass
     AND attname = 'canonical_domain' AND col_description(attrelid, attnum) = 'added by 20261116a'`)).rows[0].n;
  if (marked !== 1) refuse("setup: 16a did not add/mark jobs.canonical_domain");
  const jobId = (await db.query(`SELECT id FROM public.jobs ORDER BY id LIMIT 1`)).rows[0].id;
  await db.end();
  return { name, jobId };
}

async function state(c: Cluster, dbName: string, jobId: string) {
  const o = await connect(c, dbName, "observer");
  const col = (await o.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'canonical_domain'`)).rows[0].n === 1;
  const value = col ? (await o.query(`SELECT canonical_domain v FROM public.jobs WHERE id = $1`, [jobId])).rows[0].v : null;
  await o.end();
  return { columnExists: col, value };
}

async function waitingOnLock(c: Cluster, dbName: string, app: string, ms = 8000) {
  const o = await connect(c, dbName, "observer");
  const until = Date.now() + ms;
  try {
    while (Date.now() < until) {
      const r = await o.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'`, [app]);
      if (r.rows[0].n > 0) return true;
      await sleep(25);
    }
    return false;
  } finally { await o.end(); }
}

/** True once the rollback session is sleeping inside the injected check-to-drop window. */
async function inWindow(c: Cluster, dbName: string, app: string, ms = 8000) {
  const o = await connect(c, dbName, "observer");
  const until = Date.now() + ms;
  try {
    while (Date.now() < until) {
      const r = await o.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event = 'PgSleep'`, [app]);
      if (r.rows[0].n > 0) return true;
      await sleep(25);
    }
    return false;
  } finally { await o.end(); }
}

async function holdsAccessExclusive(c: Cluster, dbName: string, app: string, ms = 8000) {
  const o = await connect(c, dbName, "observer");
  const until = Date.now() + ms;
  try {
    while (Date.now() < until) {
      const r = await o.query(`SELECT count(*)::int n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.application_name = $1 AND l.granted AND l.mode = 'AccessExclusiveLock' AND l.relation = 'public.jobs'::regclass`, [app]);
      if (r.rows[0].n > 0) return true;
      await sleep(25);
    }
    return false;
  } finally { await o.end(); }
}

const VALUE = "late-writer.example";
const write = (jobId: string) => `UPDATE public.jobs SET canonical_domain = '${VALUE}' WHERE id = '${jobId}'`;

async function main() {
  const c = await startCluster();
  const admin = await connect(c, "postgres", "admin");
  try {
    // S1: writer first, commits within lock_timeout
    console.log("\n=== S1: writer holds an uncommitted write, commits within lock_timeout ===");
    {
      const { name, jobId } = await freshDb(c, admin);
      const w = await connect(c, name, "writer");
      await w.query("BEGIN"); await w.query(write(jobId));
      const rb = await connect(c, name, "rollback");
      const rbDone = settle(rb.query(ROLLBACK));
      check("S1 rollback waits for the writer's lock", await waitingOnLock(c, name, "rollback"));
      await w.query("COMMIT");
      const r = await rbDone;
      const s = await state(c, name, jobId);
      check("S1 rollback completes after the write commits", r.ok, r.error);
      check("S1 column kept and the committed value is intact", s.columnExists && s.value === VALUE, JSON.stringify(s));
      await rb.end(); await w.end();
    }

    // S2: writer first, holds past lock_timeout
    console.log("\n=== S2: writer holds an uncommitted write past lock_timeout (3s) ===");
    {
      const { name, jobId } = await freshDb(c, admin);
      const w = await connect(c, name, "writer");
      await w.query("BEGIN"); await w.query(write(jobId));
      const rb = await connect(c, name, "rollback");
      const r = await settle(rb.query(ROLLBACK));
      await w.query("COMMIT");
      const s = await state(c, name, jobId);
      check("S2 rollback refuses on lock_timeout", !r.ok && /rollback refused: could not take write-blocking locks/.test(r.error), r.error || "did not refuse");
      check("S2 nothing changed: column kept; the write then commits intact", s.columnExists && s.value === VALUE, JSON.stringify(s));
      await rb.end(); await w.end();
    }

    // S3: rollback first, writer arrives inside the check-to-drop window
    console.log("\n=== S3: rollback past its emptiness check, late writer arrives before DROP COLUMN ===");
    {
      const { name, jobId } = await freshDb(c, admin);
      const rb = await connect(c, name, "rollback");
      const rbDone = settle(rb.query(withWindow(ROLLBACK, 2)));
      check("S3 rollback is inside the check-to-drop window (jobs.canonical_domain found empty)", await inWindow(c, name, "rollback"));
      check("S3 rollback holds ACCESS EXCLUSIVE on jobs before the drop", await holdsAccessExclusive(c, name, "rollback"));
      const w = await connect(c, name, "writer");
      const wDone = settle(w.query(write(jobId)));
      check("S3 late writer is blocked (cannot commit between check and drop)", await waitingOnLock(c, name, "writer"));
      const r = await rbDone;
      const wr = await wDone;
      const s = await state(c, name, jobId);
      check("S3 rollback drops the column that was empty at the check", r.ok && !s.columnExists, r.error || JSON.stringify(s));
      check("S3 the late write never committed (fails after the drop): no committed value dropped", !wr.ok && /canonical_domain.*does not exist|column .* does not exist/.test(wr.error), wr.error || "writer committed!");
      await rb.end(); await w.end();
    }

    // S4: writer already holds a read lock, then writes while the rollback queues
    console.log("\n=== S4: read-then-write writer (holds ACCESS SHARE), rollback queued behind it ===");
    {
      const { name, jobId } = await freshDb(c, admin);
      const w = await connect(c, name, "writer");
      await w.query("BEGIN"); await w.query(`SELECT count(*) FROM public.jobs`);
      const rb = await connect(c, name, "rollback");
      const rbDone = settle(rb.query(ROLLBACK));
      check("S4 rollback waits behind the reader", await waitingOnLock(c, name, "rollback"));
      const wr = await settle(w.query(write(jobId)).then(() => w.query("COMMIT")));
      if (!wr.ok) await w.query("ROLLBACK").catch(() => {});
      const r = await rbDone;
      const s = await state(c, name, jobId);
      // PostgreSQL grants the writer's request ahead of the queued ACCESS EXCLUSIVE (it already holds a lock on the
      // table) or breaks a deadlock; either way both sessions finish and no committed value is lost.
      console.log(`  note S4 outcome: rollback ${r.ok ? "ok" : r.error} | writer ${wr.ok ? "committed" : wr.error}`);
      check("S4 a committed value is never dropped", !wr.ok || (s.columnExists && s.value === VALUE), JSON.stringify({ committed: wr.ok, ...s }));
      check("S4 a refused rollback changes nothing", r.ok || s.columnExists, JSON.stringify(s));
      await rb.end(); await w.end();
    }

    // S5: lock-mode choice. Rollback locks first; a read-then-write writer arrives inside the window.
    // ACCESS EXCLUSIVE (shipped): the writer's read already waits, no deadlock. SHARE ROW EXCLUSIVE variant:
    // the read passes, the write waits, then DROP COLUMN must upgrade to ACCESS EXCLUSIVE -> deadlock.
    for (const mode of ["ACCESS EXCLUSIVE", "SHARE ROW EXCLUSIVE"]) {
      console.log(`\n=== S5 (${mode}): rollback locked first, read-then-write writer in the window ===`);
      const { name, jobId } = await freshDb(c, admin);
      const sql = withWindow(ROLLBACK.replace("IN ACCESS EXCLUSIVE MODE", `IN ${mode} MODE`), 2);
      const rb = await connect(c, name, "rollback");
      const rbDone = settle(rb.query(sql));
      await inWindow(c, name, "rollback");
      const w = await connect(c, name, "writer");
      const wDone = settle((async () => {
        await w.query("BEGIN");
        await w.query(`SELECT count(*) FROM public.jobs`);
        await w.query(write(jobId));
        await w.query("COMMIT");
      })());
      const [r, wr] = await Promise.all([rbDone, wDone]);
      if (!wr.ok) await w.query("ROLLBACK").catch(() => {});
      const s = await state(c, name, jobId);
      const deadlock = /deadlock/i.test(r.error + wr.error);
      console.log(`  note S5 ${mode}: rollback ${r.ok ? "ok" : r.error} | writer ${wr.ok ? "committed" : wr.error}`);
      if (mode === "ACCESS EXCLUSIVE") check("S5 ACCESS EXCLUSIVE: no deadlock; rollback completes", !deadlock && r.ok, r.error || wr.error);
      else check("S5 SHARE ROW EXCLUSIVE variant deadlocks at the lock upgrade (why the script uses ACCESS EXCLUSIVE)", deadlock, r.error || wr.error || "no deadlock");
      check(`S5 ${mode}: a committed value is never dropped`, !wr.ok || (s.columnExists && s.value === VALUE), JSON.stringify({ committed: wr.ok, ...s }));
      await rb.end(); await w.end();
    }

    // N: negative control, same race as S3 without the lock block
    console.log("\n=== N (negative control): S3 race with the lock block removed must lose the committed value ===");
    {
      const { name, jobId } = await freshDb(c, admin);
      const rb = await connect(c, name, "rollback");
      const rbDone = settle(rb.query(withWindow(ROLLBACK.replace(LOCK_BLOCK, ""), 2)));
      check("N rollback is inside the check-to-drop window", await inWindow(c, name, "rollback"));
      const w = await connect(c, name, "writer");
      const wr = await settle(w.query(write(jobId)));
      const r = await rbDone;
      const s = await state(c, name, jobId);
      check("N without the lock the late write commits during the window and DROP COLUMN destroys it (race reproduced)",
        wr.ok && r.ok && !s.columnExists, JSON.stringify({ writer: wr, rollback: r, ...s }));
      await rb.end(); await w.end();
    }
  } finally {
    await admin.end().catch(() => {});
    c.stop();
  }
  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERROR:", e?.message || e); process.exit(1); });
