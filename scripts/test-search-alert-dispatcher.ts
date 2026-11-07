/**
 * Offline test for Backend sheet rank 83 (search alerts dispatcher).
 * Covers the gate (off = no repo and no sender call), the required throttle,
 * throttle/suppression/dedupe, claim release on sender failure, per-alert
 * isolation, the Supabase claim helpers (fake client), and static checks on
 * migration 20261107b_search_alert_dispatches.sql (NOT APPLIED; live SQL and
 * real email delivery are unproven here).
 * Run: npx tsx scripts/test-search-alert-dispatcher.ts
 */
import * as fs from "fs";
import {
  dispatchSearchAlerts,
  isSearchAlertDispatchEnabled,
  claimJobsInDb,
  releaseJobsInDb,
  claimWindowInDb,
  releaseWindowInDb,
  SearchAlertRecord,
  DispatchRepository,
} from "../src/lib/alerts/searchAlertDispatcher";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const HOUR = 3600000;
const NOW = Date.parse("2026-11-07T12:00:00Z");
const ON = { SEARCH_ALERTS_DISPATCH_ENABLED: "1" };

function mkRepo(alerts: SearchAlertRecord[], matches: Record<string, string[]>, opts: { suppressed?: string[]; throwOn?: string } = {}) {
  const calls: string[] = [];
  const claimed: Record<string, string[]> = {};
  const repo: DispatchRepository = {
    async listActiveAlerts() { calls.push("list"); return alerts; },
    async findNewMatches(a) {
      calls.push("find:" + a.id);
      if (opts.throwOn === a.id) throw new Error("boom");
      return (matches[a.id] || []).map((id) => ({ id }));
    },
    async isSuppressed(email) { calls.push("supp:" + email); return (opts.suppressed || []).indexOf(email) !== -1; },
    async claimJobs(alertId, ids) {
      calls.push("claim:" + alertId);
      const have = claimed[alertId] || (claimed[alertId] = []);
      const fresh: string[] = [];
      ids.forEach((id) => { if (have.indexOf(id) === -1) { have.push(id); fresh.push(id); } });
      return fresh;
    },
    async releaseJobs(alertId, ids) {
      calls.push("release:" + alertId);
      claimed[alertId] = (claimed[alertId] || []).filter((x) => ids.indexOf(x) === -1);
    },
    async markSent(alertId) { calls.push("sent:" + alertId); },
  };
  return { repo, calls, claimed };
}
const A1: SearchAlertRecord = { id: "a1", userId: "u1", email: "a@x.com", lastSentAt: null };
const A2: SearchAlertRecord = { id: "a2", userId: "u2", email: "b@x.com", lastSentAt: null };

async function main() {
  check("flag parsing: off by default", !isSearchAlertDispatchEnabled(undefined) && !isSearchAlertDispatchEnabled({}) && !isSearchAlertDispatchEnabled({ SEARCH_ALERTS_DISPATCH_ENABLED: "0" }));
  check("flag parsing: 1 and true", isSearchAlertDispatchEnabled({ SEARCH_ALERTS_DISPATCH_ENABLED: "1" }) && isSearchAlertDispatchEnabled({ SEARCH_ALERTS_DISPATCH_ENABLED: "true" }));

  // Disabled: nothing is touched.
  let sends = 0;
  const off = mkRepo([A1], { a1: ["j1"] });
  const r0 = await dispatchSearchAlerts({ env: {}, repo: off.repo, sender: async () => { sends++; return true; }, minIntervalMs: HOUR, now: () => NOW });
  check("disabled: status disabled", r0.status === "disabled");
  check("disabled: repo untouched and sender never called", off.calls.length === 0 && sends === 0);

  // Enabled but no throttle configured.
  const nt = mkRepo([A1], { a1: ["j1"] });
  const r1 = await dispatchSearchAlerts({ env: ON, repo: nt.repo, sender: async () => { sends++; return true; }, now: () => NOW });
  check("no throttle: refuses, no repo call, no send", r1.status === "no-throttle-configured" && nt.calls.length === 0 && sends === 0);
  const nt2 = await dispatchSearchAlerts({ env: ON, repo: nt.repo, sender: async () => true, minIntervalMs: 0, now: () => NOW });
  check("zero or invalid throttle also refuses", nt2.status === "no-throttle-configured");

  // Happy path + dedupe across runs.
  const hp = mkRepo([A1], { a1: ["j1", "j2", "j1"] });
  const sentJobs: string[][] = [];
  const sender = async (_a: SearchAlertRecord, jobs: any[]) => { sentJobs.push(jobs.map((j) => j.id)); return true; };
  const r2 = await dispatchSearchAlerts({ env: ON, repo: hp.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("send: one message, deduped ids", r2.status === "ran" && r2.sent === 1 && sentJobs.length === 1 && sentJobs[0].join(",") === "j1,j2");
  const r3 = await dispatchSearchAlerts({ env: ON, repo: hp.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("re-run: same jobs are not sent again", r3.sent === 0 && r3.noNewJobs === 1 && sentJobs.length === 1);

  // Throttle.
  const th = mkRepo([{ ...A1, lastSentAt: new Date(NOW - HOUR / 2).toISOString() }], { a1: ["j1"] });
  const r4 = await dispatchSearchAlerts({ env: ON, repo: th.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("throttle: inside window skipped before any lookup", r4.throttled === 1 && th.calls.join(",") === "list");
  const th2 = mkRepo([{ ...A1, lastSentAt: new Date(NOW - 2 * HOUR).toISOString() }], { a1: ["j1"] });
  const r5 = await dispatchSearchAlerts({ env: ON, repo: th2.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("throttle: outside window sends", r5.sent === 1);

  // Suppression.
  const sp = mkRepo([A1], { a1: ["j1"] }, { suppressed: ["a@x.com"] });
  const before = sentJobs.length;
  const r6 = await dispatchSearchAlerts({ env: ON, repo: sp.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("suppressed recipient: no lookup, no claim, no send", r6.suppressed === 1 && sentJobs.length === before && sp.calls.indexOf("claim:a1") === -1);

  // Sender failure releases claims, others continue.
  const fl = mkRepo([A1, A2], { a1: ["j1"], a2: ["j9"] });
  const r7 = await dispatchSearchAlerts({ env: ON, repo: fl.repo, sender: async (a) => a.id !== "a1", minIntervalMs: HOUR, now: () => NOW });
  check("sender false: failed counted, claims released, other alert still sent", r7.failed === 1 && r7.sent === 1 && fl.calls.indexOf("release:a1") !== -1 && (fl.claimed.a1 || []).length === 0);
  const fl2 = mkRepo([A1, A2], { a1: ["j1"], a2: ["j9"] });
  const r8 = await dispatchSearchAlerts({ env: ON, repo: fl2.repo, sender: async (a) => { if (a.id === "a1") throw new Error("smtp"); return true; }, minIntervalMs: HOUR, now: () => NOW });
  check("sender throws: isolated per alert", r8.failed === 1 && r8.sent === 1);
  const fl3 = mkRepo([A1, A2], { a1: ["j1"], a2: ["j9"] }, { throwOn: "a1" });
  const r9 = await dispatchSearchAlerts({ env: ON, repo: fl3.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("lookup throws: other alert still sent, no release of unclaimed", r9.failed === 1 && r9.sent === 1 && fl3.calls.indexOf("release:a1") === -1);
  const lf = mkRepo([A1], {});
  lf.repo.listActiveAlerts = async () => { throw new Error("db down"); };
  const r10 = await dispatchSearchAlerts({ env: ON, repo: lf.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("list failure: fails open with empty summary", r10.status === "ran" && r10.scanned === 0);

  // Supabase helpers with a fake client.
  const seen: any = {};
  const fakeSb = (err?: boolean) => ({
    from(t: string) {
      seen.table = t;
      const q: any = {
        upsert(rows: any[], o: any) { seen.rows = rows; seen.opts = o; return q; },
        select() { return Promise.resolve(err ? { data: null, error: { message: "x" } } : { data: [{ job_id: "j2" }], error: null }); },
        delete() { seen.del = true; return q; },
        eq(c: string, v: string) { seen.eq = [c, v]; return q; },
        in(c: string, v: string[]) { seen.in = [c, v]; return Promise.resolve({ error: err ? { message: "x" } : null }); },
      };
      return q;
    },
  });
  const got = await claimJobsInDb(fakeSb(), "a1", ["j1", "j2"]);
  check("claimJobsInDb: upsert ignoreDuplicates on the PK, returns inserted only", seen.table === "search_alert_dispatches" && seen.opts.onConflict === "alert_id,job_id" && seen.opts.ignoreDuplicates === true && got.join(",") === "j2" && seen.rows.length === 2);
  let threw = false; try { await claimJobsInDb(fakeSb(true), "a1", ["j1"]); } catch { threw = true; }
  check("claimJobsInDb: db error throws (dispatcher then skips the alert)", threw);
  await releaseJobsInDb(fakeSb(), "a1", ["j2"]);
  check("releaseJobsInDb: deletes by alert and job ids", seen.del === true && seen.eq[1] === "a1" && seen.in[1][0] === "j2");
  check("claim of empty list does not call the db", (await claimJobsInDb(fakeSb(), "a1", [])).length === 0);

  // Send window (follow-up, migration 20261107f).
  const wcalls: string[] = [];
  const held: Record<string, string> = {};
  const winRepo = (base: ReturnType<typeof mkRepo>) => {
    base.repo.claimWindow = async (id) => { wcalls.push("win:" + id); if (held[id]) return null; held[id] = "t1"; return "t1"; };
    base.repo.releaseWindow = async (id) => { wcalls.push("winrel:" + id); delete held[id]; };
    return base;
  };
  const w1 = winRepo(mkRepo([A1], { a1: ["j1"] }));
  const rw1 = await dispatchSearchAlerts({ env: ON, repo: w1.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("window: claimed before send, kept after success", rw1.sent === 1 && held.a1 === "t1" && wcalls.join(",") === "win:a1");
  const w2 = winRepo(mkRepo([A1], { a1: ["j2"] }));
  const sb = sentJobs.length;
  const rw2 = await dispatchSearchAlerts({ env: ON, repo: w2.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("window: held by another run = throttled, jobs released, nothing sent", rw2.throttled === 1 && rw2.sent === 0 && sentJobs.length === sb && w2.calls.indexOf("release:a1") !== -1);
  delete held.a1;
  const w3 = winRepo(mkRepo([A1], { a1: ["j3"] }));
  const rw3 = await dispatchSearchAlerts({ env: ON, repo: w3.repo, sender: async () => false, minIntervalMs: HOUR, now: () => NOW });
  check("window: sender false (definite) releases jobs and window", rw3.failed === 1 && w3.calls.indexOf("release:a1") !== -1 && held.a1 === undefined);
  const w4 = winRepo(mkRepo([A1], { a1: ["j4"] }));
  const rw4 = await dispatchSearchAlerts({ env: ON, repo: w4.repo, sender: async () => { throw new Error("timeout"); }, minIntervalMs: HOUR, now: () => NOW });
  check("window: sender throws (ambiguous) keeps job claims and window", rw4.failed === 1 && w4.calls.indexOf("release:a1") === -1 && held.a1 === "t1" && (w4.claimed.a1 || []).length === 1);
  delete held.a1;
  const w5 = winRepo(mkRepo([A1], { a1: ["j5"] }));
  w5.repo.markSent = async () => { throw new Error("db"); };
  const rw5 = await dispatchSearchAlerts({ env: ON, repo: w5.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("window: markSent failure still leaves the window claimed", rw5.sent === 1 && held.a1 === "t1");
  delete held.a1;
  const w6 = winRepo(mkRepo([A1], { a1: ["j6"] }));
  w6.repo.claimWindow = async () => { throw new Error("rpc down"); };
  const rw6 = await dispatchSearchAlerts({ env: ON, repo: w6.repo, sender, minIntervalMs: HOUR, now: () => NOW });
  check("window: claim error before send releases job claims", rw6.failed === 1 && rw6.sent === 0 && w6.calls.indexOf("release:a1") !== -1);
  const w7 = mkRepo([A1], { a1: ["j7"] });
  const sb7 = sentJobs.length;
  const rw7 = await dispatchSearchAlerts({ env: ON, repo: w7.repo, sender: async () => { throw new Error("x"); }, minIntervalMs: HOUR, now: () => NOW });
  check("no window methods: ambiguous throw still keeps claims", rw7.failed === 1 && w7.calls.indexOf("release:a1") === -1 && sentJobs.length === sb7);

  const rpcSeen: any = {};
  const rpcSb = (data: any, err?: boolean) => ({ rpc(fn: string, args: any) { rpcSeen.fn = fn; rpcSeen.args = args; return Promise.resolve({ data, error: err ? { message: "x" } : null }); } });
  const tok = await claimWindowInDb(rpcSb("2026-11-07T12:00:00.123456+00:00"), "a1", 90500);
  check("claimWindowInDb: rpc name, seconds rounded up, token returned", rpcSeen.fn === "claim_search_alert_window" && rpcSeen.args.p_min_interval_seconds === 91 && rpcSeen.args.p_alert_id === "a1" && tok === "2026-11-07T12:00:00.123456+00:00");
  check("claimWindowInDb: null means window held", (await claimWindowInDb(rpcSb(null), "a1", HOUR)) === null);
  let wt = false; try { await claimWindowInDb(rpcSb(null, true), "a1", HOUR); } catch { wt = true; }
  check("claimWindowInDb: rpc error throws", wt);
  await releaseWindowInDb(rpcSb(true), "a1", "tok");
  check("releaseWindowInDb: rpc name and args", rpcSeen.fn === "release_search_alert_window" && rpcSeen.args.p_claimed_at === "tok");

  // Static checks on migration 20261107f.
  const fsql = fs.readFileSync("supabase/migrations/20261107f_search_alert_send_windows.sql", "utf8");
  check("f migration: NOT APPLIED header + record-migration command", /STATUS: NOT APPLIED/.test(fsql) && /record-migration\.cjs 20261107f_search_alert_send_windows/.test(fsql));
  check("f migration: rpc names and arg names match the helpers", /FUNCTION public\.claim_search_alert_window\(\s*p_alert_id\s+UUID,\s*p_min_interval_seconds\s+INTEGER/.test(fsql) && /FUNCTION public\.release_search_alert_window\(\s*p_alert_id\s+UUID,\s*p_claimed_at\s+TIMESTAMPTZ/.test(fsql));
  check("f migration: atomic upsert with interval predicate, interval required (> 0 check)", /ON CONFLICT \(alert_id\) DO UPDATE/.test(fsql) && /WHERE w\.last_sent_at <= EXCLUDED\.last_sent_at - make_interval\(secs => p_min_interval_seconds\)/.test(fsql) && /p_min_interval_seconds <= 0/.test(fsql));
  check("f migration: no hard-coded interval number", !/interval\s+'\d/i.test(fsql.replace(/^--.*$/gm, "")));
  check("f migration: definer, pinned search_path, revoked, service_role only", (fsql.match(/SECURITY DEFINER/g) || []).length === 2 && (fsql.match(/SET search_path = public/g) || []).length === 2 && /REVOKE ALL ON FUNCTION public\.claim_search_alert_window\(UUID, INTEGER\) FROM PUBLIC, anon, authenticated/.test(fsql) && /GRANT EXECUTE ON FUNCTION public\.release_search_alert_window\(UUID, TIMESTAMPTZ\) TO service_role/.test(fsql));
  check("f migration: table RLS on and rollback block", /ALTER TABLE public\.search_alert_windows ENABLE ROW LEVEL SECURITY/.test(fsql) && /ROLLBACK/.test(fsql) && /DROP TABLE IF EXISTS public\.search_alert_windows/.test(fsql));

  // Static checks on the migration against the helper's contract.
  const sql = fs.readFileSync("supabase/migrations/20261107b_search_alert_dispatches.sql", "utf8");
  check("migration: NOT APPLIED header + record-migration command", /STATUS: NOT APPLIED/.test(sql) && /record-migration\.cjs 20261107b_search_alert_dispatches/.test(sql));
  check("migration: table, PK (alert_id, job_id) matches onConflict", /CREATE TABLE IF NOT EXISTS public\.search_alert_dispatches/.test(sql) && /PRIMARY KEY \(alert_id, job_id\)/.test(sql));
  check("migration: RLS on, revoked from PUBLIC/anon/authenticated, service_role only", /ENABLE ROW LEVEL SECURITY/.test(sql) && /REVOKE ALL ON public\.search_alert_dispatches FROM PUBLIC, anon, authenticated/.test(sql) && /GRANT ALL ON public\.search_alert_dispatches TO service_role/.test(sql));
  check("migration: rollback block present", /ROLLBACK/.test(sql) && /DROP TABLE IF EXISTS public\.search_alert_dispatches/.test(sql));
  check("migration: does not touch search_alerts", !/ALTER TABLE public\.search_alerts/i.test(sql));
  const src = fs.readFileSync("src/lib/alerts/searchAlertDispatcher.ts", "utf8");
  check("module: no network or mail import", !/fetch\(|resend|nodemailer|sendgrid/i.test(src.replace(/^\s*\*.*$/gm, "")));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
