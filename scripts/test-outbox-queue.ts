/**
 * Offline test for the outbox / SKIP LOCKED queue (Database rows "SKIP LOCKED
 * work queue" and "Queue / outbox table"). Covers src/lib/queue/outbox.ts with a
 * fake Supabase client, and static checks of migration 20261107c_outbox_queue.sql
 * against the helper's RPC names and argument names. The migration is NOT APPLIED;
 * live SQL behavior (locking, lease expiry) is unproven here.
 * Run: npx tsx scripts/test-outbox-queue.ts
 */
import * as fs from "fs";
import { enqueueOutbox, claimOutboxBatch, ackOutbox, failOutbox } from "../src/lib/queue/outbox";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

function fake(result: any, err?: string) {
  const calls: Array<{ fn: string; args: any }> = [];
  return {
    calls,
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      return Promise.resolve(err ? { data: null, error: { message: err } } : { data: result, error: null });
    },
  };
}
async function rejects(p: Promise<unknown>): Promise<boolean> { try { await p; return false; } catch { return true; } }

async function main() {
  let c = fake("id-1");
  const id = await enqueueOutbox(c, { topic: "t", payload: { a: 1 }, maxAttempts: 3, dedupeKey: "k" });
  check("enqueue: calls outbox_enqueue with p_ args and returns id", id === "id-1" && c.calls[0].fn === "outbox_enqueue" && c.calls[0].args.p_topic === "t" && c.calls[0].args.p_max_attempts === 3 && c.calls[0].args.p_dedupe_key === "k");
  c = fake("id-2");
  await enqueueOutbox(c, { topic: "t", payload: undefined, maxAttempts: 1 });
  check("enqueue: no dedupe key omits p_dedupe_key, payload defaults to {}", !("p_dedupe_key" in c.calls[0].args) && JSON.stringify(c.calls[0].args.p_payload) === "{}");
  check("enqueue: maxAttempts required positive integer (no default)", await rejects(enqueueOutbox(fake("x"), { topic: "t", payload: {}, maxAttempts: 0 })) && await rejects(enqueueOutbox(fake("x"), { topic: "t", payload: {}, maxAttempts: undefined as any })) && await rejects(enqueueOutbox(fake("x"), { topic: "t", payload: {}, maxAttempts: 1.5 })));
  check("enqueue: empty topic rejected before any rpc", await rejects(enqueueOutbox(fake("x"), { topic: "", payload: {}, maxAttempts: 1 })));
  check("rpc error surfaces as thrown Error", await rejects(enqueueOutbox(fake(null, "boom"), { topic: "t", payload: {}, maxAttempts: 1 })));

  c = fake([{ id: "r1", status: "processing" }]);
  const rows = await claimOutboxBatch(c, { topic: "t", limit: 5, leaseSeconds: 60, worker: "w1" });
  check("claim: maps args and returns rows", rows.length === 1 && c.calls[0].fn === "outbox_claim_batch" && c.calls[0].args.p_limit === 5 && c.calls[0].args.p_lease_seconds === 60 && c.calls[0].args.p_worker === "w1");
  check("claim: null data gives empty list", (await claimOutboxBatch(fake(null), { topic: "t", limit: 1, leaseSeconds: 1, worker: "w" })).length === 0);
  check("claim: limit, lease and worker validated, no defaults", await rejects(claimOutboxBatch(fake([]), { topic: "t", limit: 0, leaseSeconds: 1, worker: "w" })) && await rejects(claimOutboxBatch(fake([]), { topic: "t", limit: 1, leaseSeconds: undefined as any, worker: "w" })) && await rejects(claimOutboxBatch(fake([]), { topic: "t", limit: 1, leaseSeconds: 1, worker: "" })));

  check("ack: true only when rpc returns true", (await ackOutbox(fake(true), "i", "w")) === true && (await ackOutbox(fake(false), "i", "w")) === false);
  c = fake("retry");
  check("fail: maps args, returns retry/dead/null", (await failOutbox(c, { id: "i", worker: "w", error: "e", retryDelaySeconds: 0 })) === "retry" && c.calls[0].args.p_retry_delay_seconds === 0 && (await failOutbox(fake("dead"), { id: "i", worker: "w", error: "e", retryDelaySeconds: 5 })) === "dead" && (await failOutbox(fake(null), { id: "i", worker: "w", error: "e", retryDelaySeconds: 5 })) === null);
  check("fail: retryDelaySeconds required non-negative integer", await rejects(failOutbox(fake("retry"), { id: "i", worker: "w", error: "e", retryDelaySeconds: -1 })) && await rejects(failOutbox(fake("retry"), { id: "i", worker: "w", error: "e", retryDelaySeconds: undefined as any })));

  // Static checks against the real DDL.
  const sql = fs.readFileSync("supabase/migrations/20261107c_outbox_queue.sql", "utf8");
  const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  check("migration: NOT APPLIED header + record-migration command", /STATUS: NOT APPLIED/.test(sql) && /record-migration\.cjs 20261107c_outbox_queue/.test(sql));
  check("migration: claim uses FOR UPDATE SKIP LOCKED", /FOR UPDATE SKIP LOCKED/.test(code));
  const fnNames = ["outbox_enqueue", "outbox_claim_batch", "outbox_ack", "outbox_fail"];
  const helperSrc = fs.readFileSync("src/lib/queue/outbox.ts", "utf8");
  check("helper RPC names all exist as functions in the DDL", fnNames.every((n) => new RegExp(`CREATE OR REPLACE FUNCTION public\\.${n}\\(`).test(code) && helperSrc.indexOf(`"${n}"`) !== -1));
  const argsUsed = ["p_topic", "p_payload", "p_max_attempts", "p_dedupe_key", "p_limit", "p_lease_seconds", "p_worker", "p_id", "p_error", "p_retry_delay_seconds"];
  check("helper argument names all declared in the DDL", argsUsed.every((a) => new RegExp(`\\b${a}\\s+(TEXT|JSONB|INTEGER|UUID)`).test(code) && helperSrc.indexOf(a) !== -1));
  check("migration: every function is SECURITY DEFINER with pinned search_path", (code.match(/SECURITY DEFINER/g) || []).length === 4 && (code.match(/SET search_path = public/g) || []).length === 4);
  check("migration: each function revoked from PUBLIC/anon/authenticated and granted to service_role only", fnNames.every((n) => new RegExp(`REVOKE ALL ON FUNCTION public\\.${n}\\([^)]*\\) FROM PUBLIC, anon, authenticated`).test(code) && new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\([^)]*\\) TO service_role`).test(code)));
  check("migration: RLS on and table locked to service_role", /ENABLE ROW LEVEL SECURITY/.test(code) && /REVOKE ALL ON public\.outbox FROM PUBLIC, anon, authenticated/.test(code) && /GRANT ALL ON public\.outbox TO service_role/.test(code));
  check("migration: status check values match the TS type", ["pending", "processing", "done", "dead"].every((s) => code.indexOf(`'${s}'`) !== -1) && /status\s+IN \('pending', 'processing', 'done', 'dead'\)/.test(code));
  check("migration: no baked-in numeric defaults for attempts, lease or delay", !/max_attempts\s+INTEGER\s+NOT NULL\s+DEFAULT/.test(code) && !/p_(max_attempts|lease_seconds|retry_delay_seconds|limit)\s+INTEGER\s+DEFAULT/.test(code));
  check("migration: rollback block drops all four functions, indexes and table", fnNames.every((n) => new RegExp(`--\\s+DROP FUNCTION IF EXISTS public\\.${n}\\(`).test(sql)) && /--\s+DROP TABLE IF EXISTS public\.outbox;/.test(sql) && /--\s+DROP INDEX IF EXISTS public\.outbox_claim_idx/.test(sql));
  check("helper: no network or mail code", !/fetch\(|resend|nodemailer/i.test(helperSrc));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
