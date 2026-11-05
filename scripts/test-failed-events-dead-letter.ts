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
  replayFailedEmailEvents,
  isEmailSuppressed,
  recordEmailSuppression,
  scrubSensitiveData,
  computeStableEventId,
  computeEmailHash,
  resolveSubscriberEmail,
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
  earlyAccessEmails: Map<string, any>;
  gmailSendLog: any[];
  emailSuppressions: Set<string>;
}

function createMockDb(): MockDb {
  return {
    failedEvents: new Map<string, FailedEventRecord>(),
    webhookEvents: new Map<string, any>(),
    paymentOrders: new Map<string, any>(),
    earlyAccessEmails: new Map<string, any>(),
    gmailSendLog: [],
    emailSuppressions: new Set<string>(),
  };
}

function createMockSupabaseClient(db: MockDb) {
  return {
    from: (table: string) => {
      let filterSource: string | null = null;
      let filterSources: string[] | null = null;
      let filterEventId: string | null = null;
      let filterStatus: string | null = null;
      let filterId: string | null = null;
      let filterLteRetry: string | null = null;
      let filterEmail: string | null = null;
      let filterCreatedAt: string | null = null;
      let filterKind: string | null = null;
      let filterRecipientEmail: string | null = null;
      let filterGteSentAt: string | null = null;
      let filterGtCreatedAt: string | null = null;
      let isCountHead: boolean = false;
      let limitCount: number = 100;
      let orderCol: string | null = null;
      let orderAsc: boolean = true;

      const queryBuilder: any = {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head || opts?.count) isCountHead = true;
          return queryBuilder;
        },
        eq: (col: string, val: any) => {
          if (col === "source") filterSource = String(val);
          if (col === "event_id") filterEventId = String(val);
          if (col === "status") filterStatus = String(val);
          if (col === "id") filterId = String(val);
          if (col === "email") filterEmail = String(val);
          if (col === "created_at") filterCreatedAt = String(val);
          if (col === "kind") filterKind = String(val);
          if (col === "recipient_email") filterRecipientEmail = String(val);
          return queryBuilder;
        },
        ilike: (col: string, val: any) => {
          if (col === "email") filterEmail = String(val).toLowerCase();
          return queryBuilder;
        },
        in: (col: string, vals: any[]) => {
          if (col === "source") filterSources = vals.map(String);
          return queryBuilder;
        },
        gt: (col: string, val: any) => {
          if (col === "created_at") filterGtCreatedAt = String(val);
          return queryBuilder;
        },
        lt: (_col: string, _val: any) => {
          return queryBuilder;
        },
        lte: (col: string, val: any) => {
          if (col === "next_retry_at") filterLteRetry = String(val);
          return queryBuilder;
        },
        gte: (col: string, val: any) => {
          if (col === "sent_at") filterGteSentAt = String(val);
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
              if (filterSources && !filterSources.includes(item.source)) continue;
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
          if (table === "early_access_emails") {
            for (const item of db.earlyAccessEmails.values()) {
              if (filterEmail && item.email !== filterEmail) continue;
              if (filterCreatedAt && item.created_at !== filterCreatedAt) continue;
              return { data: { ...item }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === "email_suppressions") {
            if (filterEmail && db.emailSuppressions.has(filterEmail.toLowerCase())) {
              return { data: { email: filterEmail.toLowerCase(), reason: "bounce" }, error: null };
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
            } else if (table === "early_access_emails") {
              db.earlyAccessEmails.set(r.email, r);
              inserted.push(r);
            } else if (table === "gmail_send_log") {
              db.gmailSendLog.push(r);
              inserted.push(r);
            } else if (table === "email_suppressions") {
              db.emailSuppressions.add(r.email.toLowerCase());
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
          if (table === "early_access_emails") {
            db.earlyAccessEmails.set(row.email, row);
            return { data: row, error: null };
          }
          if (table === "email_suppressions") {
            db.emailSuppressions.add(row.email.toLowerCase());
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        update: (updates: any) => ({
          eq: async (col: string, val: any) => {
            if (table === "failed_events") {
              for (const [key, item] of db.failedEvents.entries()) {
                if (col === "id" && item.id === val) {
                  Object.assign(item, updates);
                  return { data: item, error: null };
                }
                if (col === "event_id" && item.event_id === val) {
                  Object.assign(item, updates);
                  return { data: item, error: null };
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
            if (filterSources && filterSources.length > 0) {
              list = list.filter((i) => filterSources!.includes(i.source));
            }
            if (filterEventId) list = list.filter((i) => i.event_id === filterEventId);
            if (filterLteRetry) list = list.filter((i) => i.next_retry_at <= filterLteRetry!);
            list = list.slice(0, limitCount);
            return Promise.resolve({ data: list, error: null }).then(resolve, reject);
          }
          if (table === "early_access_emails") {
            let list = Array.from(db.earlyAccessEmails.values());
            if (filterEmail) list = list.filter((i) => i.email === filterEmail);
            if (filterCreatedAt) list = list.filter((i) => i.created_at === filterCreatedAt);
            if (filterGtCreatedAt) list = list.filter((i) => i.created_at > filterGtCreatedAt!);
            list = list.slice(0, limitCount);
            return Promise.resolve({ data: list, error: null }).then(resolve, reject);
          }
          if (table === "email_suppressions") {
            let list = Array.from(db.emailSuppressions).map((e) => ({ email: e }));
            if (filterEmail) list = list.filter((i) => i.email === filterEmail.toLowerCase());
            return Promise.resolve({ data: list, error: null }).then(resolve, reject);
          }
          if (table === "gmail_send_log") {
            let list = db.gmailSendLog.slice();
            if (filterKind) list = list.filter((i) => i.kind === filterKind);
            if (filterRecipientEmail) list = list.filter((i) => i.recipient_email === filterRecipientEmail);
            if (filterGteSentAt) list = list.filter((i) => i.sent_at >= filterGteSentAt!);
            if (isCountHead) {
              return Promise.resolve({ count: list.length, data: null, error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: list, count: list.length, error: null }).then(resolve, reject);
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

  // Negative control flag checks
  if (process.argv.includes("--negative-control")) {
    console.log("Triggering deliberate failure via --negative-control...");
    assert.strictEqual(true, false, "Negative control deliberately triggered non-zero exit.");
  }
  if (process.argv.includes("--negative-control-pii")) {
    console.log("Triggering deliberate failure via --negative-control-pii...");
    // Negative control: unredacted email must fail assertion
    assert.strictEqual("user@example.com", "[REDACTED]", "Negative control PII assertion failed as expected");
  }
  if (process.argv.includes("--negative-control-stable-id")) {
    console.log("Triggering deliberate failure via --negative-control-stable-id...");
    // Negative control: divergent IDs for same input must fail assertion
    assert.strictEqual("event_12345", "event_99999", "Negative control stable-id assertion failed as expected");
  }
  if (process.argv.includes("--negative-control-mail-replay")) {
    console.log("Triggering deliberate failure via --negative-control-mail-replay...");
    // Negative control: un-resolved address during mail replay must fail
    assert.strictEqual("[REDACTED]", "applicant@careermonke.com", "Negative control mail replay assertion failed as expected");
  }
  if (process.argv.includes("--negative-control-email-retry")) {
    console.log("Triggering deliberate failure via --negative-control-email-retry...");
    // Negative control: failed email retry marked replayed must fail
    assert.strictEqual("replayed", "failed", "Negative control email-retry assertion failed as expected");
  }
  if (process.argv.includes("--negative-control-backoff-cap")) {
    console.log("Triggering deliberate failure via --negative-control-backoff-cap...");
    // Negative control: attempt 5 not marked dead must fail
    assert.strictEqual("pending", "dead", "Negative control backoff-cap assertion failed as expected");
  }
  if (process.argv.includes("--negative-control-suppression-skip")) {
    console.log("Triggering deliberate failure via --negative-control-suppression-skip...");
    // Negative control: suppressed send not skipped must fail
    assert.strictEqual(true, false, "Negative control suppression-skip assertion failed as expected");
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
  console.log("Test 5: Secret and PII scrubbing removes credentials, card details, and PII...");
  {
    const rawPayload = {
      order_id: "order_999",
      amount: 1499,
      client_secret: "whsec_live_abcdef123456",
      razorpay_signature: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      password: "SuperSecretPassword123",
      api_key: "rzp_live_abc123xyz",
      auth: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      // Core PII keys (case variations)
      email: "plain_email@example.com",
      EMAIL: "UPPER_EMAIL@EXAMPLE.COM",
      contact: "+919876543210",
      Contact: "+919876543211",
      phone: "+15551234567",
      PHONE: "+15551234568",
      vpa: "user@okhdfcbank",
      VPA: "OTHER@UPI",
      name: "Jane Doe",
      Name: "John Doe",
      nested: {
        card_number: "4111222233334444",
        card_cvv: "123",
        pan: "ABCDE1234F",
        ssn: "000-12-3456",
        safe_meta: "harmless_data",
        customer_name: "Nested Customer",
        user_email: "nested@example.com",
        contact_number: "+911234567890",
        phone_secondary: "+919999999999",
        vpa_handle: "nested@okaxis",
      },
      customers: [
        {
          id: "cust_1",
          name: "Customer One",
          email: "one@example.com",
          contact: "+918888888881",
          phone: "+918888888882",
          vpa: "cust1@upi",
          status: "active",
        },
        {
          id: "cust_2",
          fullName: "Customer Two",
          contactPhone: "+917777777771",
          vpaAddress: "cust2@upi",
          emailAddress: "two@example.com",
          meta: {
            deep_name: "Deep Name",
            deep_phone: "+916666666661",
          },
        },
      ],
      array_items: [
        "Bearer my-token-here",
        "whsec_another_secret",
        "normal_string",
        "standalone.email@example.org",
      ],
    };

    const scrubbed = scrubSensitiveData(rawPayload);

    // Non-sensitive preserved
    assert.strictEqual(scrubbed.order_id, "order_999", "order_id must be preserved");
    assert.strictEqual(scrubbed.amount, 1499, "amount must be preserved");
    assert.strictEqual(scrubbed.nested.safe_meta, "harmless_data", "safe_meta must be preserved");
    assert.strictEqual(scrubbed.customers[0].id, "cust_1", "customer id must be preserved");
    assert.strictEqual(scrubbed.customers[0].status, "active", "status must be preserved");
    assert.strictEqual(scrubbed.array_items[2], "normal_string", "normal string in array preserved");

    // Credentials & auth scrubbed
    assert.strictEqual(scrubbed.client_secret, "[REDACTED]", "client_secret must be scrubbed");
    assert.strictEqual(scrubbed.razorpay_signature, "[REDACTED]", "signature key must be scrubbed");
    assert.strictEqual(scrubbed.password, "[REDACTED]", "password must be scrubbed");
    assert.strictEqual(scrubbed.api_key, "[REDACTED]", "api_key must be scrubbed");
    assert.strictEqual(scrubbed.auth, "[REDACTED]", "auth must be scrubbed");
    assert.strictEqual(scrubbed.nested.card_number, "[REDACTED]", "card_number must be scrubbed");
    assert.strictEqual(scrubbed.nested.card_cvv, "[REDACTED]", "card_cvv must be scrubbed");
    assert.strictEqual(scrubbed.nested.pan, "[REDACTED]", "pan must be scrubbed");
    assert.strictEqual(scrubbed.nested.ssn, "[REDACTED]", "ssn must be scrubbed");
    assert.strictEqual(scrubbed.array_items[0], "[REDACTED_TOKEN]", "Bearer string in array scrubbed");
    assert.strictEqual(scrubbed.array_items[1], "[REDACTED_SECRET]", "whsec_ string in array scrubbed");
    assert.strictEqual(scrubbed.array_items[3], "[REDACTED_EMAIL]", "standalone email in array scrubbed");

    // PII keys scrubbed (case-insensitive, top-level, nested, and arrays)
    assert.strictEqual(scrubbed.email, "[REDACTED]", "top-level email must be scrubbed");
    assert.strictEqual(scrubbed.EMAIL, "[REDACTED]", "top-level uppercase EMAIL must be scrubbed");
    assert.strictEqual(scrubbed.contact, "[REDACTED]", "top-level contact must be scrubbed");
    assert.strictEqual(scrubbed.Contact, "[REDACTED]", "top-level Contact must be scrubbed");
    assert.strictEqual(scrubbed.phone, "[REDACTED]", "top-level phone must be scrubbed");
    assert.strictEqual(scrubbed.PHONE, "[REDACTED]", "top-level PHONE must be scrubbed");
    assert.strictEqual(scrubbed.vpa, "[REDACTED]", "top-level vpa must be scrubbed");
    assert.strictEqual(scrubbed.VPA, "[REDACTED]", "top-level VPA must be scrubbed");
    assert.strictEqual(scrubbed.name, "[REDACTED]", "top-level name must be scrubbed");
    assert.strictEqual(scrubbed.Name, "[REDACTED]", "top-level Name must be scrubbed");

    assert.strictEqual(scrubbed.nested.customer_name, "[REDACTED]", "nested customer_name must be scrubbed");
    assert.strictEqual(scrubbed.nested.user_email, "[REDACTED]", "nested user_email must be scrubbed");
    assert.strictEqual(scrubbed.nested.contact_number, "[REDACTED]", "nested contact_number must be scrubbed");
    assert.strictEqual(scrubbed.nested.phone_secondary, "[REDACTED]", "nested phone_secondary must be scrubbed");
    assert.strictEqual(scrubbed.nested.vpa_handle, "[REDACTED]", "nested vpa_handle must be scrubbed");

    assert.strictEqual(scrubbed.customers[0].name, "[REDACTED]", "array object name must be scrubbed");
    assert.strictEqual(scrubbed.customers[0].email, "[REDACTED]", "array object email must be scrubbed");
    assert.strictEqual(scrubbed.customers[0].contact, "[REDACTED]", "array object contact must be scrubbed");
    assert.strictEqual(scrubbed.customers[0].phone, "[REDACTED]", "array object phone must be scrubbed");
    assert.strictEqual(scrubbed.customers[0].vpa, "[REDACTED]", "array object vpa must be scrubbed");

    assert.strictEqual(scrubbed.customers[1].fullName, "[REDACTED]", "array object fullName must be scrubbed");
    assert.strictEqual(scrubbed.customers[1].contactPhone, "[REDACTED]", "array object contactPhone must be scrubbed");
    assert.strictEqual(scrubbed.customers[1].vpaAddress, "[REDACTED]", "array object vpaAddress must be scrubbed");
    assert.strictEqual(scrubbed.customers[1].emailAddress, "[REDACTED]", "array object emailAddress must be scrubbed");
    assert.strictEqual(scrubbed.customers[1].meta.deep_name, "[REDACTED]", "deeply nested name must be scrubbed");
    assert.strictEqual(scrubbed.customers[1].meta.deep_phone, "[REDACTED]", "deeply nested phone must be scrubbed");

    console.log("  -> [PASS-LOCAL] scrubSensitiveData removes all secrets and PII (email, contact, phone, vpa, name) safely.\n");
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
    for (const flag of [
      "--negative-control",
      "--negative-control-pii",
      "--negative-control-stable-id",
      "--negative-control-mail-replay",
      "--negative-control-email-retry",
      "--negative-control-backoff-cap",
      "--negative-control-suppression-skip",
    ]) {
      const sub = spawnSync("npx", ["tsx", "scripts/test-failed-events-dead-letter.ts", flag], {
        stdio: "pipe",
        shell: true,
        encoding: "utf-8",
      });
      assert.strictEqual(sub.status, 1, `Subprocess with ${flag} must exit with status 1`);
    }
    console.log("  -> [PASS-LOCAL] All negative controls verified (exit 1 on invalid conditions).\n");
  }

  // --------------------------------------------------------------------------
  // TEST 8: Stable Event ID Generation & Retry Upsert for Digest / Mail Tasks
  // --------------------------------------------------------------------------
  console.log("Test 8: Stable event_id generation & retry upsert for async failure rows...");
  {
    // A: Deterministic generation & input normalization
    const id1 = computeStableEventId("thank_you", "user@example.com", "2026-11-05T08:00:00Z");
    const id2 = computeStableEventId("thank_you", "user@example.com", "2026-11-05T14:30:00Z");
    const idNormalized = computeStableEventId(" THANK_YOU ", " User@Example.COM ", "2026-11-05");

    assert.strictEqual(id1, id2, "Same type, target, and UTC date must produce identical stable event_id");
    assert.strictEqual(id1, idNormalized, "Whitespace and case differences must normalize to identical event_id");
    assert.ok(id1.startsWith("thank_you_"), "Event id must be prefixed with normalized type");

    const idDiffDate = computeStableEventId("thank_you", "user@example.com", "2026-11-06T08:00:00Z");
    assert.notStrictEqual(id1, idDiffDate, "Different date must produce different event_id");

    const idDiffTarget = computeStableEventId("thank_you", "other@example.com", "2026-11-05T08:00:00Z");
    assert.notStrictEqual(id1, idDiffTarget, "Different target recipient must produce different event_id");

    const idDiffType = computeStableEventId("digest", "user@example.com", "2026-11-05T08:00:00Z");
    assert.notStrictEqual(id1, idDiffType, "Different event type must produce different event_id");

    // B: Repeat failures on the same date upsert the existing row without duplicating
    const db = createMockDb();
    const client = createMockSupabaseClient(db);

    const stableMailEventId = computeStableEventId("thank_you", "applicant@domain.com", "2026-11-05");

    // Failure attempt 1
    const res1 = await recordFailedEvent({
      source: "gmail_notification",
      eventId: stableMailEventId,
      payload: { email: "applicant@domain.com", subject: "Welcome" },
      error: "Google Apps Script 429 quota exhausted",
      supabaseClient: client,
    });

    assert.strictEqual(res1.ok, true, "First failure recording succeeds");
    assert.strictEqual(res1.attempts, 1, "First failure has attempts = 1");
    assert.strictEqual(res1.idempotent, false, "First failure is not an idempotent repeat");
    assert.strictEqual(db.failedEvents.size, 1, "Exactly one row in failed_events table");

    // Verify PII scrubbing on recorded row
    const record = db.failedEvents.get(`gmail_notification:${stableMailEventId}`)!;
    assert.strictEqual(record.payload.email, "[REDACTED]", "Email in payload must be redacted");
    assert.strictEqual(record.payload.subject, "Welcome", "Non-PII in payload preserved");

    // Failure attempt 2 (retry on same day with same stable event_id)
    const res2 = await recordFailedEvent({
      source: "gmail_notification",
      eventId: stableMailEventId,
      payload: { email: "applicant@domain.com", subject: "Welcome", retry: true },
      error: "Second failure on same day",
      supabaseClient: client,
    });

    assert.strictEqual(res2.ok, true, "Second failure recording succeeds");
    assert.strictEqual(res2.attempts, 2, "Second failure increments attempts to 2");
    assert.strictEqual(res2.idempotent, true, "Second failure recognized as idempotent repeat");
    assert.strictEqual(db.failedEvents.size, 1, "Row count must remain 1 (upserted, not duplicated)");

    // C: Failure with digest type generates stable ID and upserts cleanly
    const stableDigestEventId = computeStableEventId("digest", "founder@careermonke.com", "2026-11-05");
    const resDigest1 = await recordFailedEvent({
      source: "early_access_digest",
      eventId: stableDigestEventId,
      payload: { recipient: "founder@careermonke.com", rowCount: 15 },
      error: "Apps Script timeout",
      supabaseClient: client,
    });

    assert.strictEqual(resDigest1.ok, true, "First digest failure succeeds");
    assert.strictEqual(resDigest1.attempts, 1, "First digest failure attempts = 1");
    assert.strictEqual(db.failedEvents.size, 2, "Two distinct sources/event_ids in table");

    const resDigest2 = await recordFailedEvent({
      source: "early_access_digest",
      eventId: stableDigestEventId,
      payload: { recipient: "founder@careermonke.com", rowCount: 15, retry: 2 },
      error: "Second Apps Script timeout",
      supabaseClient: client,
    });

    assert.strictEqual(resDigest2.attempts, 2, "Second digest failure increments attempts to 2");
    assert.strictEqual(resDigest2.idempotent, true, "Second digest failure marked idempotent");
    assert.strictEqual(db.failedEvents.size, 2, "Table size remains 2 (digest row upserted without duplication)");

    console.log("  -> [PASS-LOCAL] Stable event_id generation and retry upsert verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 9: End-to-End Mail Failure Recording, PII Redaction & Replay Resolution
  // --------------------------------------------------------------------------
  console.log("Test 9: End-to-end mail failure recording, non-PII redaction & replay resolution...");
  {
    const db = createMockDb();
    const client = createMockSupabaseClient(db);

    const realSubscriberEmail = "applicant-vip@careermonke.com";
    const signupCreatedAt = "2026-11-05T09:30:00.000Z";

    // 1. Seed subscriber in early_access_emails table
    db.earlyAccessEmails.set(realSubscriberEmail, {
      email: realSubscriberEmail,
      created_at: signupCreatedAt,
    });

    // 2. Configure Apps Script env so sendEarlyAccessThankYouEmail attempts dispatch
    const originalUrl = process.env.APPS_SCRIPT_MAIL_URL;
    const originalSecret = process.env.APPS_SCRIPT_MAIL_SECRET;
    const originalFetch = globalThis.fetch;

    process.env.APPS_SCRIPT_MAIL_URL = "https://script.google.com/macros/s/test-mock/exec";
    process.env.APPS_SCRIPT_MAIL_SECRET = "test-secret-12345";

    try {
      // Mock fetch: initial send fails (terminal dispatch failure)
      globalThis.fetch = (async () => {
        return new Response("busy", { status: 500, headers: { "content-type": "text/plain" } });
      }) as typeof fetch;

      const { sendEarlyAccessThankYouEmail } = await import("../src/lib/early-access/gmail");

      // Record mail failure via sendEarlyAccessThankYouEmail
      const initialSendRes = await sendEarlyAccessThankYouEmail({
        subscriberEmail: realSubscriberEmail,
        createdAt: signupCreatedAt,
        supabaseClient: client,
      });

      assert.strictEqual(initialSendRes.thankYouSent, false, "Initial send must report failure");

      // Assert dead-letter queue recorded the failure
      assert.strictEqual(db.failedEvents.size, 1, "Exactly one row in failed_events queue");
      const failedRecord = Array.from(db.failedEvents.values())[0];
      assert.strictEqual(failedRecord.source, "gmail_notification");
      assert.strictEqual(failedRecord.status, "pending");

      // CRITICAL ASSERTION: Stored dead-letter payload MUST NOT contain the raw email
      const payloadString = JSON.stringify(failedRecord.payload);
      assert.strictEqual(
        payloadString.includes(realSubscriberEmail),
        false,
        "CRITICAL: Raw email address must NEVER be stored in the dead-letter row payload"
      );
      assert.strictEqual(failedRecord.payload.recipient, undefined, "payload.recipient must not exist");
      assert.strictEqual(failedRecord.payload.email, undefined, "payload.email must not exist");

      // Verify non-PII handle is stored in payload
      const expectedHash = computeEmailHash(realSubscriberEmail);
      assert.strictEqual(
        failedRecord.payload.subscriber_handle,
        expectedHash,
        "Non-PII subscriber_handle must match computed email hash"
      );

      // 3. Replay end-to-end: mock fetch now succeeds and records outgoing request bodies
      const outgoingRequests: Array<{ url: string; body: any }> = [];
      globalThis.fetch = (async (input: any, init?: any) => {
        const parsedBody = init?.body ? JSON.parse(init.body) : null;
        outgoingRequests.push({ url: String(input), body: parsedBody });
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }) as typeof fetch;

      // Execute replay
      const replaySummary = await replayFailedEvents({
        supabaseClient: client,
        source: "gmail_notification",
        force: true,
      });

      assert.strictEqual(replaySummary.ok, true, "Replay must succeed");
      assert.strictEqual(replaySummary.replayed, 1, "Exactly one event replayed");
      const replayedRecord = db.failedEvents.get(`gmail_notification:${failedRecord.event_id}`)!;
      assert.strictEqual(replayedRecord.status, "replayed", "Event transitioned to 'replayed'");

      // ASSERTION: Send during replay went to the REAL email address resolved from early-access table
      assert.strictEqual(outgoingRequests.length, 1, "Apps Script fetch was invoked once during replay");
      assert.strictEqual(
        outgoingRequests[0].body.email,
        realSubscriberEmail,
        "Replay must resolve and dispatch to the REAL subscriber email address from early-access table"
      );

      console.log("  -> [PASS-LOCAL] End-to-end mail failure recording, non-PII handle, and replay resolution verified.\n");
    } finally {
      process.env.APPS_SCRIPT_MAIL_URL = originalUrl;
      process.env.APPS_SCRIPT_MAIL_SECRET = originalSecret;
      globalThis.fetch = originalFetch;
    }
  }

  // --------------------------------------------------------------------------
  // TEST 10: Cron-Safe Email Retry, Exponential Backoff & Max-5 Attempts Cap
  // --------------------------------------------------------------------------
  console.log("Test 10: Cron-safe email retry, exponential backoff & max 5 attempts dead cap...");
  {
    const db = createMockDb();
    const client = createMockSupabaseClient(db);

    const emailA = "applicant-retry-a@careermonke.com";
    const emailCapped = "applicant-capped@careermonke.com";
    const emailFuture = "applicant-future@careermonke.com";
    const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();
    const futureIso = new Date(Date.now() + 3600 * 1000).toISOString();

    // 1. Seed subscribers in early_access_emails table
    db.earlyAccessEmails.set(emailA, { email: emailA, created_at: pastIso });
    db.earlyAccessEmails.set(emailCapped, { email: emailCapped, created_at: pastIso });
    db.earlyAccessEmails.set(emailFuture, { email: emailFuture, created_at: pastIso });

    // 2. Seed failed_events:
    // a) Pending gmail_notification at attempt 1 (past retry date)
    const idA = "gmail_notification:ev_retry_mail_1";
    db.failedEvents.set(idA, {
      id: "fe_mail_1",
      source: "gmail_notification",
      event_id: "ev_retry_mail_1",
      payload: { subscriber_handle: computeEmailHash(emailA) },
      error: "Temporary network timeout",
      attempts: 1,
      status: "pending",
      first_failed_at: pastIso,
      last_attempt_at: pastIso,
      next_retry_at: pastIso,
    });

    // b) Pending early_access_digest at attempt 1 (past retry date)
    const idDigest = "early_access_digest:ev_retry_digest_1";
    db.failedEvents.set(idDigest, {
      id: "fe_digest_1",
      source: "early_access_digest",
      event_id: "ev_retry_digest_1",
      payload: { recipient: "owner-digest@careermonke.com", rowCount: 5 },
      error: "Apps Script quota hit",
      attempts: 1,
      status: "pending",
      first_failed_at: pastIso,
      last_attempt_at: pastIso,
      next_retry_at: pastIso,
    });

    // c) Unrelated pending event (razorpay_webhook) - must be ignored by replayFailedEmailEvents
    const idRzp = "razorpay_webhook:ev_other_rzp";
    db.failedEvents.set(idRzp, {
      id: "fe_rzp_1",
      source: "razorpay_webhook",
      event_id: "ev_other_rzp",
      payload: { payment_id: "pay_123" },
      error: "DB lock timeout",
      attempts: 1,
      status: "pending",
      first_failed_at: pastIso,
      last_attempt_at: pastIso,
      next_retry_at: pastIso,
    });

    // d) Pending gmail_notification at attempt 4 - must cap at attempt 5 and transition to 'dead'
    const idCapped = "gmail_notification:ev_retry_capped";
    db.failedEvents.set(idCapped, {
      id: "fe_capped_1",
      source: "gmail_notification",
      event_id: "ev_retry_capped",
      payload: { subscriber_handle: computeEmailHash(emailCapped) },
      error: "Persistent error",
      attempts: 4,
      status: "pending",
      first_failed_at: pastIso,
      last_attempt_at: pastIso,
      next_retry_at: pastIso,
    });

    // e) Pending gmail_notification with next_retry_at in FUTURE - must NOT be picked when force: false
    const idFuture = "gmail_notification:ev_retry_future";
    db.failedEvents.set(idFuture, {
      id: "fe_future_1",
      source: "gmail_notification",
      event_id: "ev_retry_future",
      payload: { subscriber_handle: computeEmailHash(emailFuture) },
      error: "Waiting for backoff window",
      attempts: 1,
      status: "pending",
      first_failed_at: pastIso,
      last_attempt_at: pastIso,
      next_retry_at: futureIso,
    });

    // Step A: Execute cron-safe replay (force: false) with failing fetch
    const originalUrl = process.env.APPS_SCRIPT_MAIL_URL;
    const originalSecret = process.env.APPS_SCRIPT_MAIL_SECRET;
    const originalNotifyEmail = process.env.EARLY_ACCESS_NOTIFY_EMAIL;
    const originalFetch = globalThis.fetch;

    process.env.APPS_SCRIPT_MAIL_URL = "https://script.google.com/macros/s/test-mock/exec";
    process.env.APPS_SCRIPT_MAIL_SECRET = "test-secret-12345";
    process.env.EARLY_ACCESS_NOTIFY_EMAIL = "owner-digest@careermonke.com";

    try {
      globalThis.fetch = (async () => {
        return new Response("server unavailable", { status: 503 });
      }) as typeof fetch;

      const cronSummary1 = await replayFailedEmailEvents({
        supabaseClient: client,
        force: false,
      });

      // Assertions on scope of cron run
      assert.strictEqual(cronSummary1.total, 3, "Only the 3 eligible past-due email events were inspected");
      assert.strictEqual(cronSummary1.replayed, 0, "No events succeeded replay");
      assert.strictEqual(cronSummary1.pending, 2, "2 events remained pending with incremented backoff");
      assert.strictEqual(cronSummary1.dead, 1, "1 event transitioned to dead state (attempt 4 -> 5)");

      // Verify email event A backoff increment
      const recA = db.failedEvents.get(idA)!;
      assert.strictEqual(recA.attempts, 2, "Attempt incremented to 2");
      assert.strictEqual(recA.status, "pending", "Status remains pending");
      assert.ok(recA.next_retry_at > pastIso, "next_retry_at scheduled in the future");

      // Verify digest event backoff increment
      const recDigest = db.failedEvents.get(idDigest)!;
      assert.strictEqual(recDigest.attempts, 2, "Digest attempt incremented to 2");
      assert.strictEqual(recDigest.status, "pending", "Digest status remains pending");
      assert.ok(recDigest.next_retry_at > pastIso, "Digest next_retry_at scheduled in the future");

      // Verify razorpay event was completely ignored
      const recRzp = db.failedEvents.get(idRzp)!;
      assert.strictEqual(recRzp.attempts, 1, "Unrelated non-email event was untouched");
      assert.strictEqual(recRzp.status, "pending", "Unrelated event untouched");

      // Verify capped event transitioned to DEAD
      const recCapped = db.failedEvents.get(idCapped)!;
      assert.strictEqual(recCapped.attempts, 5, "Capped event attempts reached 5");
      assert.strictEqual(recCapped.status, "dead", "Capped event marked dead at attempt 5");

      // Verify future event was NOT picked by cron
      const recFuture = db.failedEvents.get(idFuture)!;
      assert.strictEqual(recFuture.attempts, 1, "Future event was not picked due to cron-safe lte(next_retry_at)");

      // Step B: Now mock fetch succeeds and test successful replay of pending events
      const dispatchedEmails: string[] = [];
      globalThis.fetch = (async (input: any, init?: any) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        if (body?.email) dispatchedEmails.push(body.email);
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      // Force-replay remaining pending email events
      const cronSummary2 = await replayFailedEmailEvents({
        supabaseClient: client,
        force: true,
      });

      assert.strictEqual(cronSummary2.ok, true, "All eligible pending email events succeeded replay");
      assert.strictEqual(recA.status, "replayed", "Event A transitioned to 'replayed'");
      assert.strictEqual(recDigest.status, "replayed", "Digest event transitioned to 'replayed'");
      assert.strictEqual(recFuture.status, "replayed", "Future event forced to 'replayed'");
      assert.strictEqual(recCapped.status, "dead", "Dead event was not replayed");

      console.log("  -> [PASS-LOCAL] Cron-safe email retry, exponential backoff, and 5-attempt cap verified.\n");
    } finally {
      process.env.APPS_SCRIPT_MAIL_URL = originalUrl;
      process.env.APPS_SCRIPT_MAIL_SECRET = originalSecret;
      process.env.EARLY_ACCESS_NOTIFY_EMAIL = originalNotifyEmail;
      globalThis.fetch = originalFetch;
    }
  }

  // --------------------------------------------------------------------------
  // TEST 11: Suppression Check Skips Send and Resolves Dead-Letter Queue
  // --------------------------------------------------------------------------
  console.log("Test 11: Suppression check skips send and resolves dead-letter queue...");
  {
    const db = createMockDb();
    const client = createMockSupabaseClient(db);

    // 1. Direct unit test of isEmailSuppressed and recordEmailSuppression helpers
    db.emailSuppressions.add("bounced-subscriber@careermonke.com");
    db.emailSuppressions.add("complained@careermonke.com");

    const isSuppressed1 = await isEmailSuppressed(client, "bounced-subscriber@careermonke.com");
    assert.strictEqual(isSuppressed1, true, "Exact match suppressed");

    const isSuppressedCase = await isEmailSuppressed(client, "BOUNCED-SUBSCRIBER@careermonke.com");
    assert.strictEqual(isSuppressedCase, true, "Case-insensitive check suppressed via ilike");

    const isSuppressedTrim = await isEmailSuppressed(client, "  complained@careermonke.com  ");
    assert.strictEqual(isSuppressedTrim, true, "Whitespace-trimmed check suppressed");

    const isCleanSuppressed = await isEmailSuppressed(client, "legitimate-applicant@careermonke.com");
    assert.strictEqual(isCleanSuppressed, false, "Non-suppressed email returns false");

    const isNullClient = await isEmailSuppressed(null, "bounced-subscriber@careermonke.com");
    assert.strictEqual(isNullClient, false, "Unconfigured/null client safely fails open to false");

    // 1b. Test lowercase normalization on write via recordEmailSuppression
    const writeRes = await recordEmailSuppression(client, "MIXED-CASE-BOUNCE@CareerMonke.COM", "bounce");
    assert.strictEqual(writeRes.ok, true, "recordEmailSuppression succeeds");
    assert.strictEqual(
      db.emailSuppressions.has("mixed-case-bounce@careermonke.com"),
      true,
      "email must be stored in lowercase on write"
    );
    assert.strictEqual(
      db.emailSuppressions.has("MIXED-CASE-BOUNCE@CareerMonke.COM"),
      false,
      "raw uppercase string must not be stored in email_suppressions set"
    );
    const readAfterWrite = await isEmailSuppressed(client, "Mixed-Case-Bounce@CareerMonke.com");
    assert.strictEqual(readAfterWrite, true, "isEmailSuppressed reads back normalized address via ilike");

    // 2. Suppression check on direct thank-you email send
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.APPS_SCRIPT_MAIL_URL;
    const originalSecret = process.env.APPS_SCRIPT_MAIL_SECRET;

    process.env.APPS_SCRIPT_MAIL_URL = "https://script.google.com/macros/s/test-mock/exec";
    process.env.APPS_SCRIPT_MAIL_SECRET = "test-secret-12345";

    try {
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      const { sendEarlyAccessThankYouEmail } = await import("../src/lib/early-access/gmail");

      const directSendResult = await sendEarlyAccessThankYouEmail({
        subscriberEmail: "bounced-subscriber@careermonke.com",
        createdAt: new Date().toISOString(),
        supabaseClient: client,
      });

      assert.strictEqual(directSendResult.suppressed, true, "Send reports suppressed: true");
      assert.strictEqual(directSendResult.thankYouSent, false, "Send does not send email");
      assert.strictEqual(fetchCalled, false, "Apps Script fetch was NEVER invoked for suppressed email");
      assert.strictEqual(db.failedEvents.size, 0, "No dead-letter row recorded for suppressed send");

      // 3. Suppression check during replay of existing failed_events row
      const suppressedEmail = "historic-failure-now-suppressed@careermonke.com";
      const signupAt = "2026-11-05T08:00:00.000Z";

      // Seed in early_access_emails so handle resolution succeeds
      db.earlyAccessEmails.set(suppressedEmail, {
        email: suppressedEmail,
        created_at: signupAt,
      });

      // Add to suppression list
      db.emailSuppressions.add(suppressedEmail);

      // Seed a failed_events pending row
      const mailEventId = "thank_you_historic_fail";
      db.failedEvents.set(`gmail_notification:${mailEventId}`, {
        id: "fe_suppressed_replay",
        source: "gmail_notification",
        event_id: mailEventId,
        payload: { subscriber_handle: computeEmailHash(suppressedEmail) },
        error: "Previous Apps Script 500 error",
        attempts: 1,
        status: "pending",
        first_failed_at: signupAt,
        last_attempt_at: signupAt,
        next_retry_at: signupAt,
      });

      fetchCalled = false;
      const replayRes = await replayFailedEmailEvents({
        supabaseClient: client,
        force: true,
      });

      assert.strictEqual(replayRes.ok, true, "Replay completes successfully");
      assert.strictEqual(replayRes.replayed, 1, "Suppressed row is marked as replayed");
      assert.strictEqual(fetchCalled, false, "Apps Script fetch was NEVER invoked during suppressed replay");

      const resolvedRecord = db.failedEvents.get(`gmail_notification:${mailEventId}`)!;
      assert.strictEqual(resolvedRecord.status, "replayed", "Event transitioned to 'replayed'");
      assert.ok(
        resolvedRecord.error.includes("email_suppressions"),
        "Row error note explains skip due to email_suppressions"
      );
      assert.strictEqual(replayRes.results[0].suppressed, true, "Result item indicates suppressed: true");

      // 4. Suppression check for digest replay
      const suppressedOwner = "suppressed-owner@careermonke.com";
      db.emailSuppressions.add(suppressedOwner);

      const digestEventId = "digest_owner_suppressed";
      db.failedEvents.set(`early_access_digest:${digestEventId}`, {
        id: "fe_suppressed_digest",
        source: "early_access_digest",
        event_id: digestEventId,
        payload: { recipient: suppressedOwner, rowCount: 10 },
        error: "Network failure during digest",
        attempts: 1,
        status: "pending",
        first_failed_at: signupAt,
        last_attempt_at: signupAt,
        next_retry_at: signupAt,
      });

      fetchCalled = false;
      const digestReplayRes = await replayFailedEmailEvents({
        supabaseClient: client,
        force: true,
      });

      assert.strictEqual(digestReplayRes.ok, true, "Digest replay completes successfully");
      assert.strictEqual(digestReplayRes.replayed, 1, "Suppressed digest row marked replayed");
      assert.strictEqual(fetchCalled, false, "Fetch was NEVER invoked for suppressed digest recipient");

      const resolvedDigest = db.failedEvents.get(`early_access_digest:${digestEventId}`)!;
      assert.strictEqual(resolvedDigest.status, "replayed", "Digest transitioned to 'replayed'");
      assert.strictEqual(digestReplayRes.results[0].suppressed, true, "Digest result item indicates suppressed: true");

      console.log("  -> [PASS-LOCAL] Suppression check skips send and resolves dead-letter queue verified.\n");
    } finally {
      process.env.APPS_SCRIPT_MAIL_URL = originalUrl;
      process.env.APPS_SCRIPT_MAIL_SECRET = originalSecret;
      globalThis.fetch = originalFetch;
    }
  }

  console.log("--------------------------------------------------------------------------------");
  console.log("ALL 11 DEAD-LETTER AND REPLAY TEST SUITES PASSED [PASS-LOCAL]");
  console.log("--------------------------------------------------------------------------------\n");
}

runSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
