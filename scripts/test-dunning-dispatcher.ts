/**
 * Offline regression test for src/lib/billing/dunningDispatcher.ts (audit BE #30).
 * Run: npx tsx scripts/test-dunning-dispatcher.ts
 */
import {
  dispatchQueuedDunningEmails,
  buildDunningEmailContent,
} from "../src/lib/billing/dunningDispatcher";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

class FakeQuery {
  private _updateObj: any = undefined;
  private _filters: any[] = [];
  constructor(private sb: FakeSupabase) {}
  select(_cols?: string) { return this; }
  eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; }
  is(col: string, val: any) { this._filters.push(["is", col, val]); return this; }
  order(_c: string, _o?: any) { return this; }
  limit(_n: number) { return this; }
  update(obj: any) { this._updateObj = obj; return this; }
  then(resolve: any, reject?: any) {
    Promise.resolve().then(() => {
      if (this._updateObj !== undefined) {
        this.sb.updates.push({ values: this._updateObj, filters: this._filters });
        resolve({ data: this.sb.stampData, error: null });
      } else {
        resolve({ data: this.sb.rows, error: null });
      }
    }).catch(reject);
  }
}

class FakeSupabase {
  rows: any[] = [];
  updates: any[] = [];
  stampData: any[] = [{ id: "x" }];
  from(_table: string) { return new FakeQuery(this); }
}

const MAILER = { url: "https://example.invalid/mail", secret: "s" };

function stubFetch(reply: string) {
  (globalThis as any).fetch = async () => new Response(reply, { status: 200 });
}

async function main() {
  // 1. Content builder includes grace text and escapes HTML
  {
    const c = buildDunningEmailContent({ gracePeriodEnd: "2026-11-13T00:00:00Z", failureReason: "card <declined>" });
    check("subject names the payment failure", /payment failed/i.test(c.subject));
    check("text body includes grace date", c.textBody.includes("Nov 2026") || c.textBody.includes("2026"));
    check("html escapes failure reason", c.htmlBody.includes("card &lt;declined&gt;") && !c.htmlBody.includes("<declined>"));
  }

  // 2. Missing mail env short-circuits
  {
    const sb = new FakeSupabase();
    sb.rows = [{ id: "1", metadata: { recipient_email: "a@b.c" } }];
    const s = await dispatchQueuedDunningEmails({ supabase: sb as any, mailer: null });
    check("missing mail env reported", s.missingMailEnv === true && s.scanned === 0);
  }

  // 3. Happy path: queued row sent and stamped conditionally
  {
    stubFetch("ok");
    const sb = new FakeSupabase();
    sb.rows = [{
      id: "row-1", user_id: "u1", provider: "razorpay", subscription_id: null,
      failure_reason: "declined", grace_period_expires_at: "2026-11-13T00:00:00Z",
      metadata: { recipient_email: "user@example.com" }, created_at: "2026-11-06T00:00:00Z",
    }];
    const s = await dispatchQueuedDunningEmails({ supabase: sb as any, mailer: MAILER, now: new Date("2026-11-06T12:00:00Z") });
    const stamp = sb.updates.find((u) => u.values.dunning_email_sent_at);
    check("one sent", s.sent === 1 && s.failed === 0);
    check("stamp is conditional on sent_at still null",
      !!stamp && stamp.filters.some((f: any[]) => f[0] === "is" && f[1] === "dunning_email_sent_at" && f[2] === null));
  }

  // 4. Mail failure leaves row queued and records attempt
  {
    stubFetch("busy");
    const sb = new FakeSupabase();
    sb.rows = [{
      id: "row-2", user_id: "u2", provider: "razorpay", subscription_id: null,
      failure_reason: null, grace_period_expires_at: null,
      metadata: { recipient_email: "user@example.com" }, created_at: "2026-11-06T00:00:00Z",
    }];
    const s = await dispatchQueuedDunningEmails({ supabase: sb as any, mailer: MAILER });
    const meta = sb.updates.find((u) => u.values.metadata?.dispatch_attempts === 1);
    check("failure counted, not stamped", s.failed === 1 && s.sent === 0 && !sb.updates.some((u) => u.values.dunning_email_sent_at));
    check("failure records dispatch_attempts", !!meta);
  }

  // 5. Missing recipient: queued flag cleared, no send
  {
    stubFetch("ok");
    const sb = new FakeSupabase();
    sb.rows = [{
      id: "row-3", user_id: "u3", provider: "razorpay", subscription_id: null,
      failure_reason: null, grace_period_expires_at: null,
      metadata: {}, created_at: "2026-11-06T00:00:00Z",
    }];
    const s = await dispatchQueuedDunningEmails({ supabase: sb as any, mailer: MAILER });
    const cleared = sb.updates.find((u) => u.values.dunning_email_queued === false && u.values.metadata?.dispatch_error === "missing_recipient");
    check("missing recipient skipped and dequeued", s.skippedNoRecipient === 1 && !!cleared);
  }

  // 6. Retry cap: row at max attempts is dequeued without sending
  {
    stubFetch("ok");
    const sb = new FakeSupabase();
    sb.rows = [{
      id: "row-4", user_id: "u4", provider: "razorpay", subscription_id: null,
      failure_reason: null, grace_period_expires_at: null,
      metadata: { recipient_email: "user@example.com", dispatch_attempts: 5 },
      created_at: "2026-11-06T00:00:00Z",
    }];
    const s = await dispatchQueuedDunningEmails({ supabase: sb as any, mailer: MAILER });
    const capped = sb.updates.find((u) => u.values.dunning_email_queued === false && u.values.metadata?.dispatch_error === "max_attempts");
    check("max-attempts row dequeued without sending", s.cappedOut === 1 && s.sent === 0 && !!capped);
  }

  // 7. "already" reply is stamped as sent
  {
    stubFetch("already");
    const sb = new FakeSupabase();
    sb.rows = [{
      id: "row-5", user_id: "u5", provider: "razorpay", subscription_id: null,
      failure_reason: null, grace_period_expires_at: null,
      metadata: { recipient_email: "user@example.com" }, created_at: "2026-11-06T00:00:00Z",
    }];
    const s = await dispatchQueuedDunningEmails({ supabase: sb as any, mailer: MAILER, now: new Date("2026-11-06T12:00:00Z") });
    const stamped = sb.updates.some((u) => u.values.dunning_email_sent_at);
    check("'already' reply stamped as sent", s.sent === 1 && s.failed === 0 && stamped);
  }

  // 8. Empty outbox is a no-op
  {
    stubFetch("ok");
    const sb = new FakeSupabase();
    const s = await dispatchQueuedDunningEmails({ supabase: sb as any, mailer: MAILER });
    check("empty outbox no-op", s.scanned === 0 && s.sent === 0 && s.failed === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
