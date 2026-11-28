/**
 * failedEvents guards for the record-only razorpay_verify source (v2/v4 contract).
 * Real recordFailedEvent + replayFailedEvents over an in-memory failed_events store:
 * no DB, no network, no production data.
 *
 * GUARD 1 (re-entry): a repeated verify failure of the SAME payment refreshes
 * payload/error/last_attempt_at in place; attempts, status and next_retry_at are NEVER
 * touched, so user retries can never dead-letter the record.
 * GUARD 2 (replay dispatch): replay SKIPS razorpay_verify rows (pending, attempts
 * unchanged, reported as skipped/record-only); it can never dead-letter them.
 * Both guards are keyed exactly on source === "razorpay_verify"; every other source keeps
 * exactly today's behavior (pinned here as the control).
 */
import { describe, it, expect } from "vitest";
import { recordFailedEvent, replayFailedEvents } from "@/lib/events/failedEvents";

// ---------- in-memory failed_events (+ webhook_events) store ----------
function makeStore() {
  const failed: any[] = [];
  const webhookEvents: any[] = [];
  let seq = 0;

  function from(table: string) {
    const rows = table === "failed_events" ? failed : table === "webhook_events" ? webhookEvents : null;
    if (!rows) throw new Error(`unexpected table ${table}`);
    let filters: Array<[string, string, any]> = [];
    let pendingUpdate: any = null;
    let orderCol: string | null = null;
    let limitN: number | null = null;
    const match = () =>
      rows.filter((r) =>
        filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : op === "neq" ? r[c] !== v : true))
      );
    const run = () => {
      let out = match();
      if (orderCol) out = [...out].sort((a, b) => (a[orderCol!] < b[orderCol!] ? -1 : 1));
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    };
    const builder: any = {
      select: (_cols?: string) => builder,
      eq: (c: string, v: any) => {
        filters.push(["eq", c, v]);
        return builder;
      },
      neq: (c: string, v: any) => {
        filters.push(["neq", c, v]);
        return builder;
      },
      order: (col: string) => {
        orderCol = col;
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      update: (u: any) => {
        pendingUpdate = u;
        return builder;
      },
      upsert: async (obj: any) => {
        rows.push({ ...obj });
        return { error: null };
      },
      insert: (obj: any) => {
        const row = { ...obj, id: `fe_${++seq}` };
        rows.push(row);
        return { select: () => ({ maybeSingle: async () => ({ data: { id: row.id }, error: null }) }) };
      },
      maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
      then: (resolve: any) => {
        if (pendingUpdate) {
          const matched = match();
          for (const m of matched) Object.assign(m, pendingUpdate);
          return Promise.resolve({ data: null, error: null, count: matched.length }).then(resolve);
        }
        return Promise.resolve({ data: run(), error: null }).then(resolve);
      },
    };
    return builder;
  }

  return { client: { from }, failed, webhookEvents };
}

const verifyInput = (n = 1) => ({
  source: "razorpay_verify",
  eventId: "verify:test:pay_1",
  payload: { order_id: "order_test_abc123", user_id: "u1", mode: "test", plan_code: "monthly", addon_code: null },
  error: `fulfilment failure #${n}`,
});

describe("guard 1: razorpay_verify re-entry refreshes in place, never dead-letters", () => {
  it("first failure inserts a pending record-only row", async () => {
    const { client, failed } = makeStore();
    const res = await recordFailedEvent({ ...verifyInput(), supabaseClient: client });
    expect(res.ok).toBe(true);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ source: "razorpay_verify", status: "pending", attempts: 1 });
  });

  it("re-recording the SAME payment refreshes payload/error/last_attempt_at only", async () => {
    const { client, failed } = makeStore();
    await recordFailedEvent({ ...verifyInput(1), supabaseClient: client });
    const before = { ...failed[0] };
    await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
    const res = await recordFailedEvent({ ...verifyInput(2), payload: { ...verifyInput(2).payload, fresh: true }, supabaseClient: client });

    expect(res.ok).toBe(true);
    expect(res.idempotent).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.status).toBe("pending");
    expect(failed).toHaveLength(1); // still one row, not a duplicate
    expect(failed[0].error).toBe("fulfilment failure #2"); // refreshed
    expect(failed[0].payload.fresh).toBe(true); // refreshed
    expect(failed[0].last_attempt_at > before.last_attempt_at).toBe(true); // refreshed
    expect(failed[0].attempts).toBe(before.attempts); // UNTOUCHED
    expect(failed[0].status).toBe(before.status); // UNTOUCHED
    expect(failed[0].next_retry_at).toBe(before.next_retry_at); // UNTOUCHED
    expect(failed[0].first_failed_at).toBe(before.first_failed_at); // UNTOUCHED
  });

  it("5+ recordings of the same payment still leave the row pending (never auto-dead)", async () => {
    const { client, failed } = makeStore();
    for (let i = 1; i <= 7; i++) {
      await recordFailedEvent({ ...verifyInput(i), supabaseClient: client });
    }
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("pending");
    expect(failed[0].attempts).toBe(1);
  });

  it("replayed rows keep the existing early-return: nothing is touched", async () => {
    const { client, failed } = makeStore();
    await recordFailedEvent({ ...verifyInput(), supabaseClient: client });
    failed[0].status = "replayed";
    const before = { ...failed[0] };
    await new Promise((r) => setTimeout(r, 5));
    const res = await recordFailedEvent({ ...verifyInput(9), supabaseClient: client });
    expect(res).toMatchObject({ ok: true, status: "replayed", idempotent: true });
    expect(failed[0]).toEqual(before); // no field changed at all
  });

  it("control: other sources keep today's behavior (attempts increment, dead at 5)", async () => {
    const { client, failed } = makeStore();
    const input = { source: "razorpay_webhook", eventId: "evt_1", payload: { order_id: "o1" }, error: "x" };
    await recordFailedEvent({ ...input, supabaseClient: client });
    for (let i = 0; i < 4; i++) {
      await recordFailedEvent({ ...input, supabaseClient: client });
    }
    expect(failed).toHaveLength(1);
    expect(failed[0].attempts).toBe(5);
    expect(failed[0].status).toBe("dead"); // existing auto-dead behavior pinned for other sources
  });
});

describe("guard 2: replay never touches razorpay_verify (record-only) and cannot starve", () => {
  it("unscoped replay excludes razorpay_verify at SELECTION time: row untouched, not in the batch", async () => {
    const { client, failed } = makeStore();
    await recordFailedEvent({ ...verifyInput(), supabaseClient: client });
    const before = { ...failed[0] };

    const summary = await replayFailedEvents({ supabaseClient: client, force: true });
    expect(summary.ok).toBe(true);
    expect(summary.total).toBe(0); // not even selected: no starvation and no dispatch contact
    expect(summary.skipped).toBe(0);
    expect(failed[0]).toEqual(before); // row completely untouched
  });

  it("starvation regression: a backlog of old record-only rows cannot crowd a replayable row out of the batch", async () => {
    const { client, failed } = makeStore();
    // 30 record-only rows, all OLDER than the replayable webhook row; default batch limit is 25.
    for (let i = 0; i < 30; i++) {
      await recordFailedEvent({
        ...verifyInput(i),
        eventId: `verify:test:pay_${i}`,
        supabaseClient: client,
      });
      failed[failed.length - 1].first_failed_at = new Date(Date.now() - (60 - i) * 60e3).toISOString();
    }
    await recordFailedEvent({
      source: "razorpay_webhook",
      eventId: "evt_wh_starve",
      payload: { p_provider_order_id: "order_test_abc123", p_user_id: "u1", p_expected_mode: "test" },
      error: "webhook fulfil failed",
      supabaseClient: client,
    });

    const summary = await replayFailedEvents({
      supabaseClient: client,
      force: true,
      webhookFulfillHandler: async () => ({ success: true }),
    });

    expect(summary.total).toBe(1); // only the replayable row is in the batch
    expect(summary.replayed).toBe(1);
    expect(failed.find((r) => r.source === "razorpay_webhook")!.status).toBe("replayed");
    expect(failed.filter((r) => r.source === "razorpay_verify").every((r) => r.status === "pending" && r.attempts === 1)).toBe(true);
  });

  it("explicit source=razorpay_verify request: selected, then skipped in-loop as record-only (never dead-lettered)", async () => {
    const { client, failed } = makeStore();
    await recordFailedEvent({ ...verifyInput(), supabaseClient: client });
    const before = { ...failed[0] };

    const summary = await replayFailedEvents({ supabaseClient: client, force: true, source: "razorpay_verify" });
    expect(summary.ok).toBe(true);
    expect(summary.total).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.replayed).toBe(0);
    expect(summary.dead).toBe(0);
    expect(summary.results[0]).toMatchObject({ source: "razorpay_verify", status: "pending", attempts: 1 });
    expect(failed[0]).toEqual(before); // row completely untouched
  });

  it("control: a razorpay_webhook row replays exactly as today alongside a record-only row", async () => {
    const { client, failed } = makeStore();
    await recordFailedEvent({ ...verifyInput(), supabaseClient: client });
    await recordFailedEvent({
      source: "razorpay_webhook",
      eventId: "evt_wh_1",
      payload: { p_provider_order_id: "order_test_abc123", p_user_id: "u1", p_expected_mode: "test" },
      error: "webhook fulfil failed",
      supabaseClient: client,
    });

    const summary = await replayFailedEvents({
      supabaseClient: client,
      force: true,
      webhookFulfillHandler: async () => ({ success: true }),
    });

    expect(summary.total).toBe(1); // verify row excluded at selection
    expect(summary.replayed).toBe(1); // razorpay_webhook
    const verifyRow = failed.find((r) => r.source === "razorpay_verify")!;
    const webhookRow = failed.find((r) => r.source === "razorpay_webhook")!;
    expect(verifyRow.status).toBe("pending");
    expect(verifyRow.attempts).toBe(1);
    expect(webhookRow.status).toBe("replayed"); // existing replay path unchanged
  });
});
