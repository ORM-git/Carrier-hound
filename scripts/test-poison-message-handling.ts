/**
 * Poison message handling policy test (Backend sheet rank 36).
 *
 * A poison message is a failed event whose replay throws or fails every
 * time. The dead-letter replay path (src/lib/events/failedEvents.ts) must:
 *  1. Isolate it - one throwing event never aborts the replay batch.
 *  2. Terminate it - attempts increment per run with exponential backoff,
 *     and the event goes 'dead' at maxAttempts (5), never retried forever.
 *  3. Never pick 'dead' events up again (replay queries status='pending').
 *  4. Terminate config-poison too (unknown sources die at maxAttempts).
 * Existing suite test-failed-events-dead-letter.ts covers recording,
 * idempotency, scrubbing and the admin route; this suite covers the
 * poison-specific lifecycle and isolation semantics.
 * Run: npx tsx scripts/test-poison-message-handling.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { replayFailedEvents } from "../src/lib/events/failedEvents";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { console.log(`PASS: ${label}`); passed += 1; }
  else { console.error(`FAIL: ${label}`); failed += 1; }
}

// ---------------------------------------------------------------------------
// Minimal thenable mock of the supabase-js query builder, covering exactly
// the chains replayFailedEvents + isEmailSuppressed + resolveSubscriberEmail use.
// ---------------------------------------------------------------------------
type Row = Record<string, any>;

function makeClient(db: Record<string, Row[]>) {
  return {
    from: (table: string) => makeQuery(db, table),
  };
}

function makeQuery(db: Record<string, Row[]>, table: string) {
  const rows = () => db[table] || [];
  const filters: Array<(r: Row) => boolean> = [];
  let updateObj: Row | null = null;
  let limitN = Infinity;
  let orderCol: string | null = null;

  const run = (): Row[] => {
    let out = rows().filter((r) => filters.every((f) => f(r)));
    if (orderCol) {
      const col = orderCol;
      out = [...out].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
    }
    return out.slice(0, limitN);
  };

  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return q; },
    in: (c: string, vals: any[]) => { filters.push((r) => vals.includes(r[c])); return q; },
    ilike: (c: string, v: string) => {
      filters.push((r) => String(r[c] ?? "").toLowerCase() === String(v).toLowerCase());
      return q;
    },
    lte: (c: string, v: any) => { filters.push((r) => !r[c] || r[c] <= v); return q; },
    order: (c: string) => { orderCol = c; return q; },
    limit: (n: number) => { limitN = n; return q; },
    update: (obj: Row) => { updateObj = obj; return q; },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => {
      try {
        if (updateObj) {
          rows().filter((r) => filters.every((f) => f(r))).forEach((r) => Object.assign(r, updateObj));
          return resolve({ data: null, error: null });
        }
        return resolve({ data: run(), error: null });
      } catch (e) {
        if (reject) return reject(e);
        throw e;
      }
    },
  };
  return q;
}

let seq = 0;
function seedEvent(db: Record<string, Row[]>, over: Partial<Row>): Row {
  seq += 1;
  const row: Row = {
    id: `evt-${seq}`,
    source: "thank_you",
    event_id: `poison_test_${seq}`,
    payload: {},
    error: "seed",
    attempts: 1,
    status: "pending",
    first_failed_at: new Date(Date.now() - 600_000).toISOString(),
    last_attempt_at: new Date(Date.now() - 600_000).toISOString(),
    next_retry_at: new Date(Date.now() - 60_000).toISOString(), // due now
    ...over,
  };
  db.failed_events.push(row);
  return row;
}

async function main(): Promise<void> {
  // -- Static guards on the replay implementation -----------------------------
  const impl = readFileSync(join("src", "lib", "events", "failedEvents.ts"), "utf8");
  check(impl.includes('catch (reErr'), "replay loop wraps each event's execution in try/catch (batch isolation)");
  check(impl.includes('.eq("status", "pending")'), "replay only picks up status='pending' events (dead never re-queried)");
  check(impl.includes("Max retry attempts reached"), "events at maxAttempts are marked dead before any replay attempt");
  check(impl.includes("Math.pow(2, nextAttempt)"), "backoff stays exponential in attempts (2^n minutes, existing constant)");

  // -- 1. Isolation: one poison event never blocks the batch ------------------
  {
    const db: Record<string, Row[]> = { failed_events: [], email_suppressions: [], early_access_emails: [] };
    seedEvent(db, { event_id: "good_1", payload: { recipient: "good1@example.com" } });
    seedEvent(db, { event_id: "poison_1", payload: { recipient: "poison@example.com", poison: true } });
    seedEvent(db, { event_id: "good_2", payload: { recipient: "good2@example.com" } });
    const summary = await replayFailedEvents({
      supabaseClient: makeClient(db),
      sources: ["thank_you"],
      notificationHandler: async (p: any) => {
        if (p.poison) throw new Error("boom: handler crashed on poison payload");
        return { success: true };
      },
    });
    check(summary.ok === true, "isolation: replay run completes despite the throwing event");
    check(summary.replayed === 2, `isolation: the two healthy events replayed (got ${summary.replayed})`);
    check(summary.pending === 1, `isolation: the poison event stays pending for retry (got ${summary.pending})`);
    const poison = db.failed_events.find((r) => r.event_id === "poison_1")!;
    check(poison.status === "pending" && poison.attempts === 2, "isolation: poison attempts incremented to 2, still pending");
    check(Date.parse(poison.next_retry_at) > Date.now(), "isolation: poison backoff scheduled in the future");
    check(String(poison.error).includes("boom"), "isolation: poison error recorded without aborting the batch");
    const order = summary.results.map((r) => r.status).join(",");
    check(order === "replayed,pending,replayed", `isolation: batch order preserved around the poison event (${order})`);
  }

  // -- 2+3. Lifecycle: poison dies at maxAttempts and is never picked up again
  {
    const db: Record<string, Row[]> = { failed_events: [], email_suppressions: [], early_access_emails: [] };
    seedEvent(db, { event_id: "poison_lifecycle", payload: { recipient: "poison@example.com", poison: true } });
    const opts = {
      supabaseClient: makeClient(db),
      sources: ["thank_you"],
      force: true, // ignore next_retry_at gating to compress the lifecycle
      notificationHandler: async () => { throw new Error("always fails"); },
    };
    const seen: Array<[number, string]> = [];
    for (let runNum = 1; runNum <= 4; runNum++) {
      const s = await replayFailedEvents(opts);
      const row = db.failed_events[0];
      seen.push([row.attempts, row.status]);
      if (runNum < 4) {
        check(s.pending === 1 && row.status === "pending", `lifecycle run ${runNum}: still pending with attempts=${row.attempts}`);
        check(Date.parse(row.next_retry_at) > Date.now(), `lifecycle run ${runNum}: backoff pushed into the future`);
      }
    }
    check(seen.map(([a]) => a).join(",") === "2,3,4,5", `lifecycle: attempts climb monotonically 2,3,4,5 (got ${seen.map(([a]) => a).join(",")})`);
    check(db.failed_events[0].status === "dead", "lifecycle: poison event is dead at attempt 5 (maxAttempts)");
    check(String(db.failed_events[0].error).includes("always fails"), "lifecycle: terminal error preserved on the dead row");
    const after = await replayFailedEvents(opts);
    check(after.total === 0, `dead events are never picked up again (total=${after.total})`);
    check(db.failed_events[0].attempts === 5 && db.failed_events[0].status === "dead", "dead row untouched by later runs");
  }

  // -- 4. Config poison: unknown source terminates instead of looping --------
  {
    const db: Record<string, Row[]> = { failed_events: [], email_suppressions: [], early_access_emails: [] };
    seedEvent(db, { event_id: "unknown_1", source: "mystery_source", attempts: 4 });
    const s = await replayFailedEvents({ supabaseClient: makeClient(db), force: true });
    check(s.dead === 1 && db.failed_events[0].status === "dead", "unknown source dies at maxAttempts (no infinite pending)");
    check(String(db.failed_events[0].error).includes("Unknown source"), "unknown-source error recorded on the dead row");
  }

  // -- 5. Fail-open on unconfigured client ------------------------------------
  {
    const s = await replayFailedEvents({ supabaseClient: null });
    check(s.ok === false && typeof s.error === "string" && s.error.length > 0, "unconfigured client returns a structured error, never throws");
  }

  // -- Suite registration ------------------------------------------------------
  const runner = readFileSync(join("scripts", "suite-runner.ts"), "utf8");
  check(runner.includes('"scripts/test-poison-message-handling.ts"'), "suite registered in scripts/suite-runner.ts");

  console.log(`\n[PASS-LOCAL] ${passed} poison-message-handling checks passed${failed ? `; ${failed} FAILED` : ""}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("FAIL: poison-message suite threw", err);
  process.exit(1);
});
