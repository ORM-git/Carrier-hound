/**
 * Backend sheet ranks 45/46/48/49 (posture guard, not new capability) -
 * locks in the reviewed concurrency/locking/backpressure posture so a
 * later refactor can't silently drop it. Every assertion names a real
 * code constant or call site verified on main and documented in
 * docs/concurrency-posture.md; nothing here introduces a threshold of
 * its own.
 *
 *   45 Pessimistic Locking: budget reserve and add-on consume RPCs keep
 *      their `for update` row locks.
 *   46 Distributed Locks: ai_concurrency_leases keeps its exclusive
 *      table lock, cap check, TTL, RLS revocation and service_role-only
 *      execute grants.
 *   48 Thread Safety: shared cross-request state stays inside atomic DB
 *      RPCs (guarded predicates + locked updates), not app-level
 *      read-modify-write.
 *   49 Backpressure: the global AI concurrency cap (default 25) stays
 *      wired with 429/503 + Retry-After rejection and quota rollback on
 *      every capacity-failure exit.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`PASS: ${label}`); }
  else { failed += 1; console.log(`FAIL: ${label}`); }
}
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function main(): void {
  // ---------- rank 45: pessimistic locking on quota/budget mutations ----------
  const budget = read("supabase/migrations/20261104a_global_ai_budget.sql");
  const consume = read("supabase/migrations/20261103d_consume_atomic_fn.sql");
  check(/from\s+public\.ai_global_budget_daily\s+where\s+period_date\s*=\s*p_period\s+for\s+update/i.test(budget),
    "45: budget reserve locks the daily row `for update` before evaluating the cap");
  check(/insert\s+into\s+public\.ai_global_budget_daily[\s\S]*on\s+conflict\s*\(period_date\)\s+do\s+nothing/i.test(budget),
    "45: budget reserve upserts the period row before locking it");
  check(/order\s+by\s+expires_at\s+asc\s+limit\s+1\s+for\s+update/i.test(consume),
    "45: add-on consume locks the chosen credit row `for update`");
  check(/sets_remaining\s*>\s*0/.test(consume),
    "45: add-on consume keeps the guarded `sets_remaining > 0` predicate");

  // ---------- rank 46: DB-backed distributed lease ----------
  check(/create\s+table\s+if\s+not\s+exists\s+public\.ai_concurrency_leases/i.test(budget),
    "46: ai_concurrency_leases table exists");
  check(/lock\s+table\s+public\.ai_concurrency_leases\s+in\s+exclusive\s+mode/i.test(budget),
    "46: acquire serializes count+insert with an exclusive table lock");
  check(/delete\s+from\s+public\.ai_concurrency_leases\s+where\s+expires_at\s*<=\s*now\(\)/i.test(budget),
    "46: acquire purges expired leases before counting");
  check(/if\s+v_count\s*<\s*p_cap\s+then/i.test(budget),
    "46: acquire inserts only under the cap");
  check(/revoke\s+all\s+on\s+table\s+public\.ai_concurrency_leases\s+from\s+public,\s*anon,\s*authenticated/i.test(budget),
    "46: lease table revoked from public/anon/authenticated");
  check(/grant\s+execute\s+on\s+function\s+public\.ai_concurrency_acquire\(text,\s*int,\s*int\)\s+to\s+service_role/i.test(budget),
    "46: acquire is service_role-only");
  check(/grant\s+execute\s+on\s+function\s+public\.ai_concurrency_release\(text\)\s+to\s+service_role/i.test(budget),
    "46: release is service_role-only");
  check(/alter\s+table\s+public\.ai_concurrency_leases\s+enable\s+row\s+level\s+security/i.test(budget),
    "46: lease table has RLS enabled");

  // ---------- rank 48: thread safety via atomic RPCs ----------
  const handler = read("src/lib/ai/serviceHandler.ts");
  check(/supabaseAdmin\.rpc\("ai_concurrency_acquire"/.test(handler),
    "48: AI handler acquires concurrency through the atomic RPC, not app-level counting");
  check(/rpcWithRetry\(\(\)\s*=>\s*supabaseAdmin\.rpc\("ai_concurrency_acquire"/.test(handler),
    "48: lease acquire goes through the retry wrapper (no manual lock bookkeeping)");
  check(!/globalThis\.[A-Za-z_]*lock/i.test(handler) && !/new\s+Mutex|new\s+Semaphore/.test(handler),
    "48: no in-process mutex/semaphore shared state in the AI handler");

  // ---------- rank 49: backpressure on the AI path ----------
  check(/DEFAULT_AI_GLOBAL_MAX_CONCURRENCY\s*=\s*25/.test(handler),
    "49: global AI concurrency cap default stays 25");
  check(/getRuntimeEnv\("AI_GLOBAL_MAX_CONCURRENCY"/.test(handler),
    "49: cap stays env-overridable via AI_GLOBAL_MAX_CONCURRENCY");
  check(/p_cap:\s*maxConcurrency/.test(handler),
    "49: handler passes its resolved cap to ai_concurrency_acquire");
  check(/statusCode:\s*429[\s\S]{0,400}AI_CONCURRENCY_CAP_REACHED/.test(handler),
    "49: saturation rejects with 429 AI_CONCURRENCY_CAP_REACHED");
  check(/statusCode:\s*503[\s\S]{0,400}AI_CONCURRENCY_SERVICE_UNAVAILABLE/.test(handler),
    "49: lease-store failure rejects with 503 AI_CONCURRENCY_SERVICE_UNAVAILABLE");
  check((handler.match(/"Retry-After":\s*"30"/g) || []).length >= 2,
    "49: both capacity rejections carry Retry-After: 30");
  check(/concurrency_saturated/.test(handler),
    "49: saturation fires the concurrency_saturated budget alert");
  const satIdx = handler.indexOf("AI_CONCURRENCY_CAP_REACHED");
  const satBlock = handler.slice(Math.max(0, satIdx - 600), satIdx);
  check(/settleBudget\(0\)/.test(satBlock) && /rollbackAllQuotas\(\)/.test(satBlock),
    "49: saturation releases the budget reservation and rolls back quota before rejecting");

  // ---------- doc sync ----------
  const doc = read("docs/concurrency-posture.md");
  for (const marker of [
    "for update",
    "ai_concurrency_leases",
    "exclusive",
    "service_role",
    "DEFAULT_AI_GLOBAL_MAX_CONCURRENCY = 25",
    "AI_CONCURRENCY_CAP_REACHED",
    "AI_CONCURRENCY_SERVICE_UNAVAILABLE",
    "concurrency_saturated",
    "settleBudget(0)",
    "rollbackAllQuotas()",
  ]) {
    check(doc.includes(marker), `doc: concurrency-posture.md records ${marker}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
