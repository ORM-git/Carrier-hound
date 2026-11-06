/**
 * Bounce intake (Backend sheet rank 32: Bounce Handling).
 *
 * Converts detected bounces into suppression entries, closing the loop:
 *   poll-inbound-replies.ts (rank 14) classifies bounce_suspect rows into
 *   public.inbound_replies -> this script extracts the failed recipient and
 *   records it in public.email_suppressions (reason 'bounce') via the same
 *   recordEmailSuppression helper the unsubscribe flow uses (upsert on
 *   email, normalized lowercase).
 *
 * Safety rules:
 *   - suppresses ONLY when exactly one candidate recipient address parses
 *     from the bounce excerpt; ambiguous or unparsable rows are marked
 *     processed and logged for manual review - never auto-suppressed;
 *   - never suppresses the sender mailbox itself or daemon/noreply
 *     addresses;
 *   - exits 0 with a clear message when public.inbound_replies does not
 *     exist yet (pre-activation, same convention as poll-inbound-replies);
 *   - exits 2 on missing env or hard query errors (cron surfaces it).
 *
 * Usage: npx tsx scripts/bounce-intake-cron.ts
 * Env:   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from "@supabase/supabase-js";
import { recordEmailSuppression } from "../src/lib/events/failedEvents";

const MAX_ROWS_PER_RUN = 50;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EXCLUDED_LOCAL = /^(mailer-daemon|postmaster|noreply|no-reply)@/i;

/**
 * Extracts the single failed recipient from a bounce excerpt, or null when
 * the parse is not unambiguous. Exported for the policy test.
 */
export function extractBounceRecipient(
  excerpt: string,
  senderMailbox?: string
): string | null {
  if (!excerpt) return null;
  const candidates = new Set<string>();
  for (const match of excerpt.matchAll(EMAIL_RE)) {
    const addr = match[0].toLowerCase();
    if (EXCLUDED_LOCAL.test(addr)) continue;
    if (senderMailbox && addr === senderMailbox.toLowerCase()) continue;
    candidates.add(addr);
  }
  if (candidates.size !== 1) return null;
  return [...candidates][0];
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("Supabase env not configured; cannot run bounce intake.");
    process.exit(2);
  }
  const client = createClient(url, key);
  const senderMailbox = process.env.GMAIL_SENDER_EMAIL || undefined;

  const { data: rows, error } = await client
    .from("inbound_replies")
    .select("id,subject,body_excerpt")
    .eq("kind", "bounce_suspect")
    .is("processed_at", null)
    .order("received_at", { ascending: true })
    .limit(MAX_ROWS_PER_RUN);

  if (error) {
    if (/does not exist|undefined table|42P01/i.test(error.message)) {
      console.log(
        "public.inbound_replies not present yet (migration 20261106j not applied) - bounce intake inactive, exiting green."
      );
      return;
    }
    console.error(`inbound_replies query failed: ${error.message}`);
    process.exit(2);
  }

  let suppressed = 0;
  let review = 0;
  for (const row of rows ?? []) {
    const recipient = extractBounceRecipient(
      `${row.subject ?? ""}\n${row.body_excerpt ?? ""}`,
      senderMailbox
    );
    if (recipient) {
      const res = await recordEmailSuppression(client, recipient, "bounce");
      if (res.ok) {
        suppressed++;
        console.log(`suppressed ${recipient} (bounce, inbound_replies ${row.id})`);
      } else {
        console.error(`suppression failed for ${recipient}: ${res.error}`);
      }
    } else {
      review++;
      console.log(`no unambiguous recipient in inbound_replies ${row.id} - marked for review, NOT suppressed`);
    }
    const { error: markErr } = await client
      .from("inbound_replies")
      .update({ processed_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("processed_at", null);
    if (markErr) {
      console.error(`failed to mark ${row.id} processed: ${markErr.message}`);
    }
  }

  console.log(`bounce intake: ${suppressed} suppressed, ${review} marked for review, ${(rows ?? []).length} rows processed.`);
}

const isMain = process.argv[1] && process.argv[1].endsWith("bounce-intake-cron.ts");
if (isMain) {
  main().catch((err) => {
    console.error("[BOUNCE-INTAKE-ERROR]", err);
    process.exit(2);
  });
}
