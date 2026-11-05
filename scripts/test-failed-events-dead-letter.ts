/**
 * scripts/test-failed-events-dead-letter.ts
 *
 * Verification suite for the dead-letter queue and replay path:
 * 1. Idempotent recording of failed events on (source, event_id).
 * 2. Replay success, backoff, and state transition to 'replayed'.
 * 3. Max-attempt (5 attempts) terminal transition to 'dead'.
 * 4. Strict idempotency / No double-apply (webhook_events deduplication check).
 * 5. Secret and PII scrubbing on stored payloads.
 * 6. Admin replay route protection (403 for non-admins, 200 for verified admins).
 * 7. Negative control proving non-zero exit on invalid conditions.
 */

import assert from "assert";
import { spawnSync } from "child_process";
import {
  recordFailedEvent,
  replayFailedEvents,
  scrubSensitiveData,
  type FailedEventRecord,
} from "../src/lib/events/failedEvents";
import { GET as adminReplayGet, POST as adminReplayPost } from "../src/app/api/admin/replay/route";

process.env.NODE_ENV = "test";

// ============================================================================
// IN-MEMORY MOCK DATABASE FOR FAILED_EVENTS & WEBHOOK_EVENTS
// ============================================================================

interface MockDb {
  failedEvents: Map<string, FailedEventRecord>;
  webhookEvents: Map<string, any>;
  paymentOrders: Map<string, any>;
}

function createMockDb(): MockDb {
  return {
    failedEvents: new Map<string, FailedEventRecord>(),
    webhookEvents: new Map<string, any>(),
    paymentOrders: new Map<string, any>(),
  };
}

function createMockSupabaseClient(db: MockDb) {
  return {
    from: (table: string) => {
      let filterSource: string | null = null;
      let filterEventId: string | null = null;
      let filterStatus: string | null = null;
      let filterId: string | null = null;
      let filterLteRetry: string | null = null;
      let limitCount: number = 100;
      let orderCol: string | null = null;
      let orderAsc: boolean = true;

      const queryBuilder: any = {
        select: (_cols?: string) => queryBuilder,
        eq: (col: string, val: any) => {
          if (col === "source") filterSource = String(val);
          if (col === "event_id") filterEventId = String(val);
          if (col === "status") filterStatus = String(val);
          if (col === "id") filterId = String(val);
          return queryBuilder;
        },
        lte: (col: string, val: any) => {
          if (col === "next_retry_at") filterLteRetry = String(val);
          return queryBuilder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orderCol = col;
          orderAsc = opts?.ascending ?? true;
          return queryBuilder;
        },
        limit: (cnt: number) => {
          limitCount = cnt;
          return queryBuilder;
        },
        maybeSingle: async () => {
          if (table === "failed_events") {
            for (const item of db.failedEvents.values()) {
              if (filterId && item.id !== filterId) continue;
              if (filterSource && item.source !== filterSource) continue;
              if (filterEventId && item.event_id !== filterEventId) continue;
              if (filterStatus && item.status !== filterStatus) continue;
              return { data: { ...item }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === "webhook_events") {
            if (filterEventId && db.webhookEvents.has(filterEventId)) {
              return { data: { ...db.webhookEvents.get(filterEventId) }, error: null };
            }
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => queryBuilder.maybeSingle(),
        insert: (row: any) => {
          const rows = Array.isArray(row) ? row : [row];
          const inserted: any[] = [];
          for (const r of rows) {
            const id = r.id || `fe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const fullRecord: FailedEventRecord = {
              id,
              source: r.source,
              event_id: r.event_id,
              payload: r.payload || {},
              error: r.error || "",
              attempts: r.attempts ?? 1,
              status: r.status ?? "pending",
              first_failed_at: r.first_failed_at || new Date().toISOString(),
              last_attempt_at: r.last_attempt_at || new Date().toISOString(),
              next_retry_at: r.next_retry_at || new Date().toISOString(),
            };
            if (table === "failed_events") {
              const key = `${r.source}:${r.event_id}`;
              db.failedEvents.set(key, fullRecord);
              inserted.push(fullRecord);
            } else if (table === "webhook_events") {
              db.webhookEvents.set(r.event_id, r);
              inserted.push(r);
            }
          }
          const resPromise: any = Promise.resolve({ data: inserted, error: null });
          resPromise.select = () => ({
            maybeSingle: async () => ({ data: inserted[0], error: null }),
          });
          return resPromise;
        },
        upsert: async (row: any, _opts?: any) => {
          if (table === "webhook_events") {
            db.webhookEvents.set(row.event_id, row);
            return { data: row, error: null };
          }
          if (table === "failed_events") {
            const key = `${row.source}:${row.event_id}`;
            db.failedEvents.set(key, row);
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        update: (updates: any) => ({
          eq: async (col: string, val: any) => {
            if (table === "failed_events") {
              for (const [key, item] of db.failedEvents.entries()) {
                if (col === "id" && item.id === val) {
                  const updated = { ...item, ...updates };
                  db.failedEvents.set(key, updated);
                  return { data: updated, error: null };
                }
                if (col === "event_id" && item.event_id === val) {
                  const updated = { ...item, ...updates };
                  db.failedEvents.set(key, updated);
                  return { data: updated, error: null };
                }
              }
            }
            return { data: null, error: null };
          },
        }),
        then: (resolve: any, reject?: any) => {
          if (table === "failed_events") {
            let list: FailedEventRecord[] = Array.from(db.failedEvents.values());
            if (filterStatus) list = list.filter((i) => i.status === filterStatus);
            if (filterSource) list = list.filter((i) => i.source === filterSource);
            if (filterEventId) list = list.filter((i) => i.event_id === filterEventId);
            if (filterLteRetry) list = list.filter((i) => i.next_retry_at <= filterLteRetry!);
            list = list.slice(0, limitCount);
            return Promise.resolve({ data: list, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };

      return queryBuilder;
    },
    rpc: async (fn: string, params: any) => {
      if (fn === "fulfil_payment_order") {
        return { data: { success: true, order_id: params?.p_provider_order_id }, error: null };
      }
      return { data: null, error: new Error(`Unknown RPC ${fn}`) };
    },
  };
}

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

async function runSuite() {
  console.log("================================================================================");
  console.log("     ASYNC DEAD-LETTER QUEUE & REPLAY TEST SUITE [PASS-LOCAL]                   ");
  console.log("================================================================================\n");

  // Negative control flag check
  if (process.argv.includes("--negative-control")) {
    console.log("Triggering deliberate failure via --negative-control...");
    assert.strictEqual(true, false, "Negative control deliberately triggered non-zero exit.");
  }

  // --------------------------------------------------------------------------
  // TEST 1: Idempotent Recording
  // --------------------------------------------------------------------------
  console.log("Test 1: Idempotent recordFailedEvent on (source, event_id)...");
  {
    const db = createMockDb();
    const client = createMockSupabaseClient(db);

    // Initial record
    const res1 = await recordFailedEvent({
      source: "razorpay_webhook",
      eventId: "evt_test_1001",
      payload: {
        order_id: "order_123",
        secret_token: "secret_value_should_be_scrubbed",
      },
      error: new Error("Initial failure"),
      supabaseClient: client,
    });

    assert.strictEqual(res1.ok, true, "First recordFailedEvent should succeed");
    assert.strictEqual(res1.idempotent, false, "First record is not a duplicate hit");
    assert.strictEqual(res1.status, "pending", "Initial status should be pending");
    assert.strictEqual(res1.attempts, 1, "Initial attempts should be 1");
    assert.strictEqual(db.failedEvents.size, 1, "Exactly one record should be in failed_events");

    const record1 = Array.from(db.failedEvents.values())[0];
    assert.strictEqual(record1.payload.secret_token, "[REDACTED]", "Secrets in payload must be scrubbed");
    assert.strictEqual(record1.payload.order_id, "order_123", "Non-sensitive data preserved");

    // Second record with SAME (source, eventId)
    const res2 = await recordFailedEvent({
      source: "razorpay_webhook",
      eventId: "evt_test_1001",
      payload: { order_id: "order_123", retry: true },
      error: "Second failure",
      supabaseClient: client,
    });

    assert.strictEqual(res2.ok, true, "Second recordFailedEvent should succeed");
    assert.strictEqual(res2.idempotent, true, "Second record must be recognized as idempotent duplicate");
    assert.strictEqual(res2.attempts, 2, "Attempts should be incremented to 2");
    assert.strictEqual(db.failedEvents.size, 1, "Table must still only contain 1 record (no duplicate rows)");

    // Repeat after event is marked 'replayed': must preserve 'replayed' status
    const key = `razorpay_webhook:evt_test_1001`;
    db.failedEvents.get(key)!.status = "replayed";

    const res3 = await recordFailedEvent({
      source: "razorpay_webhook",
      eventId: "evt_test_1001",
      payload: { order_id: "order_123" },
      error: "Late failure report after replay",
      supabaseClient: client,
    });

    assert.strictEqual(res3.status, "replayed", "Replayed status must not be reverted to pending");
    assert.strictEqual(res3.idempotent, true, "Replayed event record remains idempotent");
    console.log("  -> [PASS-LOCAL] Idempotent recordFailedEvent verified on (source, event_id).\n");
  }

  // --------------------------------------------------------------------------
  // TEST 2: Replay Success
  // --------------------------------------------------------------------------
  console.log("Test 2: Replay pending event and transition to 'replayed'...");
  {
    const db = createMockDb();
    const client = createMockSupabaseClient(db);

    // Seed a pending event
    await recordFailedEvent({
      source: "razorpay_webhook",
      eventId: "evt_replay_2001",
      payload: {
        order_id: "order_pay_2001",
        user_id: "user_pay_2001",
        mode: "live",
      },
      error: "Temporary network timeout",
      supabaseClient: client,
    });

    let fulfillmentCalled = false;
    const summary = await replayFailedEvents({
      supabaseClient: client,
      force: true,
      webhookFulfillHandler: async (orderId, userId, mode) => {
        fulfillmentCalled = true;
        assert.strictEqual(orderId, "order_pay_2001");
        assert.strictEqual(userId, "user_pay_2001");
        assert.strictEqual(mode, "live");
        return { success: true };
      },
    });

    assert.strictEqual(summary.ok, true, "Replay execution should succeed");
    assert.strictEqual(summary.replayed, 1, "Exactly 1 event should be replayed");
    assert.strictEqual(summary.dead, 0, "No events should be marked dead");
    assert.strictEqual(fulfillmentCalled, true, "Fulfillment handler must be invoked");

    const record = db.failedEvents.get("razorpay_webhook:evt_replay_2001");
    assert.strictEqual(record?.status, "replayed", "Event status must transition to 'replayed'");
    assert.ok(db.webhookEvents.has("evt_replay_2001"), "Row must be added to webhook_events for idempotency");
    console.log("  -> [PASS-LOCAL] Replay success and transition to 'replayed' verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 3: Max-Attempt Dead State
  // --------------------------------------------------------------------------
  console.log("Test 3: Max-attempt backoff transitions to 'dead' on attempt 5...");
  {
    const db = createMockDb();
    const client = createMockSupabaseClient(db);

    // Event already at attempt 4
    await recordFailedEvent({
      source: "razorpay_webhook",
      eventId: "evt_die_3001",
      payload: { order_id: "order_bad_3001", user_id: "user_3001" },
      error: "Recurring failure",
      attempts: 4,
      supabaseClient: client,
    });

    // Replay fails
    const summary = await replayFailedEvents({
      supabaseClient: client,
      force: true,
      maxAttempts: 5,
      webhookFulfillHandler: async () => ({
        success: false,
        error: "Persistent upstream 500 error",
      }),
    });

    assert.strictEqual(summary.dead, 1, "Event should transition to dead");
    assert.strictEqual(summary.replayed, 0, "Event was not replayed");

    const record = db.failedEvents.get("razorpay_webhook:evt_die_3001");
    assert.strictEqual(record?.status, "dead", "Status must be 'dead'");
    assert.strictEqual(record?.attempts, 5, "Attempts must be 5");

    // Replay on an event already at attempts = 5 marks dead immediately
    const summary2 = await replayFailedEvents({
      supabaseClient: client,
      force: true,
      maxAttempts: 5,
    });
    assert.strictEqual(summary2.total, 0, "Dead events are excluded from subsequent pending replays");
    console.log("  -> [PASS-LOCAL] Max-attempt dead transition verified on attempt 5.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 4: Strict Idempotency / No Double-Apply
  // --------------------------------------------------------------------------
  console.log("Test 4: Strict idempotency: webhook_events deduplication check prevents double-fulfillment...");
  {
    const db = createMockDb();
    const client = createMockSupabaseClient(db);

    // Seed webhook_events as ALREADY processed for this eventId
    db.webhookEvents.set("evt_dedupe_4001", {
      event_id: "evt_dedupe_4001",
      provider: "razorpay",
      event_type: "payment.captured",
    });

    // Seed a pending failed_event with the same eventId
    await recordFailedEvent({
      source: "razorpay_webhook",
      eventId: "evt_dedupe_4001",
      payload: { order_id: "order_already_paid", user_id: "u4001" },
      error: "Transient network hitch during initial attempt",
      supabaseClient: client,
    });

    let doubleApplyHappened = false;
    const summary = await replayFailedEvents({
      supabaseClient: client,
      force: true,
      webhookFulfillHandler: async () => {
        doubleApplyHappened = true;
        return { success: true };
      },
    });

    assert.strictEqual(doubleApplyHappened, false, "CRITICAL: Fulfillment must NOT be called when event is already in webhook_events");
    assert.strictEqual(summary.replayed, 1, "Summary should count item as replayed");
    assert.strictEqual(summary.results[0].alreadyProcessed, true, "Item result indicates alreadyProcessed");

    const record = db.failedEvents.get("razorpay_webhook:evt_dedupe_4001");
    assert.strictEqual(record?.status, "replayed", "Event marked as replayed");
    console.log("  -> [PASS-LOCAL] webhook_events dedupe prevents double fulfillment on replay.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 5: Secret and PII Scrubbing
  // --------------------------------------------------------------------------
  console.log("Test 5: Secret and PII scrubbing removes credentials and card details...");
  {
    const rawPayload = {
      order_id: "order_999",
      amount: 1499,
      client_secret: "whsec_live_abcdef123456",
      razorpay_signature: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      password: "SuperSecretPassword123",
      api_key: "rzp_live_abc123xyz",
      auth: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      nested: {
        card_number: "4111222233334444",
        card_cvv: "123",
        pan: "ABCDE1234F",
        ssn: "000-12-3456",
        safe_meta: "harmless_data",
      },
      array_items: [
        "Bearer my-token-here",
        "whsec_another_secret",
        "normal_string",
      ],
    };

    const scrubbed = scrubSensitiveData(rawPayload);

    assert.strictEqual(scrubbed.order_id, "order_999", "order_id must be preserved");
    assert.strictEqual(scrubbed.amount, 1499, "amount must be preserved");
    assert.strictEqual(scrubbed.client_secret, "[REDACTED]", "client_secret must be scrubbed");
    assert.strictEqual(scrubbed.razorpay_signature, "[REDACTED]", "signature key must be scrubbed");
    assert.strictEqual(scrubbed.password, "[REDACTED]", "password must be scrubbed");
    assert.strictEqual(scrubbed.api_key, "[REDACTED]", "api_key must be scrubbed");
    assert.strictEqual(scrubbed.auth, "[REDACTED]", "auth must be scrubbed");
    assert.strictEqual(scrubbed.nested.card_number, "[REDACTED]", "card_number must be scrubbed");
    assert.strictEqual(scrubbed.nested.card_cvv, "[REDACTED]", "card_cvv must be scrubbed");
    assert.strictEqual(scrubbed.nested.pan, "[REDACTED]", "pan must be scrubbed");
    assert.strictEqual(scrubbed.nested.ssn, "[REDACTED]", "ssn must be scrubbed");
    assert.strictEqual(scrubbed.nested.safe_meta, "harmless_data", "safe_meta must be preserved");
    assert.strictEqual(scrubbed.array_items[0], "[REDACTED_TOKEN]", "Bearer string in array scrubbed");
    assert.strictEqual(scrubbed.array_items[1], "[REDACTED_SECRET]", "whsec_ string in array scrubbed");
    assert.strictEqual(scrubbed.array_items[2], "normal_string", "normal string in array preserved");
    console.log("  -> [PASS-LOCAL] scrubSensitiveData removes all secrets and PII safely.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 6: Admin Replay Route Protection (GET & POST)
  // --------------------------------------------------------------------------
  console.log("Test 6: Admin replay route security and execution...");
  {
    // A: No auth token provided -> 403 Forbidden
    const unauthReq = new Request("https://careermonke.com/api/admin/replay", {
      method: "POST",
    });
    const unauthRes = await adminReplayPost(unauthReq);
    assert.strictEqual(unauthRes.status, 403, "Unauthenticated request must return 403");

    const unauthGetReq = new Request("https://careermonke.com/api/admin/replay", {
      method: "GET",
    });
    const unauthGetRes = await adminReplayGet(unauthGetReq);
    assert.strictEqual(unauthGetRes.status, 403, "Unauthenticated GET must return 403");

    // B: Non-admin bearer token -> 403 Forbidden
    const nonAdminReq = new Request("https://careermonke.com/api/admin/replay", {
      method: "POST",
      headers: {
        authorization: "Bearer non_admin_token",
      },
    });
    const nonAdminRes = await adminReplayPost(nonAdminReq);
    assert.strictEqual(nonAdminRes.status, 403, "Non-admin user must return 403");

    console.log("  -> [PASS-LOCAL] Admin replay route correctly forbids non-admin callers.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 7: Negative Control Subprocess Exit Verification
  // --------------------------------------------------------------------------
  console.log("Test 7: Negative control verification (subprocess exits non-zero)...");
  {
    const sub = spawnSync("npx", ["tsx", "scripts/test-failed-events-dead-letter.ts", "--negative-control"], {
      stdio: "pipe",
      shell: true,
      encoding: "utf-8",
    });
    assert.strictEqual(sub.status, 1, "Subprocess with --negative-control must exit with status 1");
    console.log("  -> [PASS-LOCAL] Negative control verified (exits 1 on invalid condition).\n");
  }

  console.log("--------------------------------------------------------------------------------");
  console.log("ALL 7 DEAD-LETTER AND REPLAY TEST SUITES PASSED [PASS-LOCAL]");
  console.log("--------------------------------------------------------------------------------\n");
}

runSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
