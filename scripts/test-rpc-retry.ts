/**
 * Offline regression test for src/lib/db/rpcRetry.ts (audit DB #16).
 * Run: npx tsx scripts/test-rpc-retry.ts
 */
import { isDeadlockError, rpcWithRetry, DEADLOCK_SQLSTATE } from "../src/lib/db/rpcRetry";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

async function main() {
  // isDeadlockError classification
  check("sqlstate 40P01 detected", isDeadlockError({ code: "40P01", message: "deadlock detected" }));
  check("message-only deadlock detected", isDeadlockError({ message: "deadlock detected" }));
  check("details-text deadlock detected", isDeadlockError({ details: "Process 123 waits for ShareLock; deadlock detected" }));
  check("unique violation not a deadlock", !isDeadlockError({ code: "23505", message: "duplicate key value violates unique constraint" }));
  check("missing column not a deadlock", !isDeadlockError({ code: "42703", message: "column x does not exist" }));
  check("null not a deadlock", !isDeadlockError(null));
  check("exported sqlstate constant", DEADLOCK_SQLSTATE === "40P01");

  // rpcWithRetry behavior
  {
    let calls = 0;
    const res = await rpcWithRetry(async () => {
      calls++;
      return calls === 1
        ? { data: null, error: { code: "40P01", message: "deadlock detected" } }
        : { data: { ok: true }, error: null };
    }, { baseDelayMs: 0 });
    check("deadlock then success retries once", calls === 2 && res.error === null && (res.data as any).ok === true);
  }
  {
    let calls = 0;
    const res = await rpcWithRetry(async () => {
      calls++;
      return { data: { ok: true }, error: null };
    }, { baseDelayMs: 0 });
    check("success on first attempt does not retry", calls === 1 && res.error === null);
  }
  {
    let calls = 0;
    const res = await rpcWithRetry(async () => {
      calls++;
      return { data: null, error: { code: "23505", message: "duplicate key" } };
    }, { baseDelayMs: 0 });
    check("non-deadlock error is not retried", calls === 1 && (res.error as any).code === "23505");
  }
  {
    let calls = 0;
    const res = await rpcWithRetry(async () => {
      calls++;
      return { data: null, error: { code: "40P01", message: "deadlock detected" } };
    }, { retries: 1, baseDelayMs: 0 });
    check("persistent deadlock returns last error after retries exhausted", calls === 2 && (res.error as any).code === "40P01");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
